/**
 * Live service layers and the one production composition root. The platform
 * layer supplies the effect services every command runs on; each capability tag
 * has one live layer that delegates to the module that implements it, so a test
 * can replace any single capability without rebuilding the graph.
 * @module @eedsh/cli/internal/effect/layer
 */

import type { DshBridge } from '@eedsh/config'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect, Layer, Ref, Stream } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as PlatformError from 'effect/PlatformError'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Result from 'effect/Result'
import { boundedCommandRunner, pnpmInvocation, versionProbe } from '../../command-runner'
import { loadConfig } from '../../config'
import { bootstrapDshInstallation } from '../../dsh-bootstrap'
import { loadDshBridge } from '../../dsh-bridge'
import { discoverDshInstallation, validateDshVersion } from '../../dsh-discovery'
import { defaultInstallationAnchorStore } from '../../installation-anchor'
import { preflightLayer } from '../../preflight'
import { bundlePatchLayers, resolveDescriptors, resolveOne } from '../../resolve'
import { defaultSpawn, type SpawnLike } from '../../spawn'
import { watchConfigDirectory } from '../../watch'
import { posixSyncLock } from '../lock-posix'
import { win32SyncLock } from '../lock-win32'
import { DshFailure, DshResolveFailure, PackageInstallFailure } from './errors'
import {
  BundleResolver,
  type BundleResolverShape,
  type CliServices,
  CommandRunner,
  type CommandRunnerShape,
  ConfigLoader,
  type ConfigLoaderShape,
  DshDiscovery,
  type DshDiscoveryShape,
  Environment,
  type EnvironmentShape,
  InstallationAnchor,
  type InstallationAnchorShape,
  Output,
  type OutputShape,
  PackageManager,
  type PackageManagerShape,
  type PreflightShape,
  Spawner,
  SyncLock,
  type SyncLockShape,
  Watcher,
  type WatcherShape,
} from './services'

/**
 * Install profile dependencies with pnpm inside the profile directory. pnpm is
 * DSH's own package manager, so the profile layout stays what `dsh plugin`
 * and boot expect. stderr is collected for the diagnostic; a non-zero exit
 * fails the installation.
 */
function installWithPnpm(
  profileDir: string,
): Effect.Effect<
  void,
  PackageInstallFailure | PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.scoped(
    Effect.gen(function* () {
      const invocation = pnpmInvocation(['install'])
      const handle = yield* ChildProcess.make(invocation.command, [...invocation.args], {
        cwd: profileDir,
      })
      const [stderr, exitCode] = yield* Effect.all(
        [handle.stderr.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
        { concurrency: 'unbounded' },
      )
      if (Number(exitCode) !== 0) {
        return yield* Effect.fail(
          new PackageInstallFailure({
            profileDir,
            cause: new Error(`pnpm install exited with code ${String(exitCode)}: ${stderr.trim()}`),
          }),
        )
      }
    }),
  )
}

/** pnpm-backed package installation. */
export const pnpmPackageManagerLayer: Layer.Layer<
  PackageManagerShape,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(
  PackageManager,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const shape: PackageManagerShape = {
      install: (profileDir) =>
        Effect.provideService(
          installWithPnpm(profileDir),
          ChildProcessSpawner.ChildProcessSpawner,
          spawner,
        ).pipe(
          Effect.catch((cause) =>
            Effect.fail(
              cause instanceof PackageInstallFailure
                ? cause
                : new PackageInstallFailure({ profileDir, cause }),
            ),
          ),
        ),
    }
    return shape
  }),
)

/** Injectable platform implementations for tests and alternate hosts. */
export interface SyncLockPlatforms {
  readonly posix?: SyncLockShape
  readonly win32?: SyncLockShape
}

/**
 * Platform-selected kernel sync lock. Linux and macOS use their native flock,
 * Windows uses its named semaphore, and every other platform fails closed
 * before materialization.
 * @param platform - platform to select for; defaults to the running platform.
 * @param platforms - implementation overrides for tests.
 * @returns the sync lock layer.
 */
export function syncLockLayer(
  platform: NodeJS.Platform = process.platform,
  platforms: SyncLockPlatforms = {},
): Layer.Layer<SyncLockShape> {
  if (platform === 'linux' || platform === 'darwin') {
    return Layer.succeed(SyncLock, platforms.posix ?? posixSyncLock)
  }
  if (platform === 'win32') {
    return Layer.succeed(SyncLock, platforms.win32 ?? win32SyncLock)
  }
  return Layer.succeed(SyncLock, unsupportedSyncLock(platform))
}

function unsupportedSyncLock(platform: NodeJS.Platform): SyncLockShape {
  return {
    acquire: (lockPath) =>
      Effect.fail(
        PlatformError.systemError({
          _tag: 'Unknown',
          module: 'SyncLock',
          method: 'syncLock',
          pathOrDescriptor: lockPath,
          description: `kernel-backed profile locking is not supported on ${platform}`,
        }),
      ),
  }
}

/** The process's own standard output and standard error. */
export const outputLayer: Layer.Layer<OutputShape> = Layer.succeed(Output, {
  stdout: (line) => {
    console.log(line)
  },
  stderr: (line) => {
    console.error(line)
  },
})

/** The invocation's environment and working directory. */
export const environmentLayer: Layer.Layer<EnvironmentShape> = Layer.succeed(Environment, {
  env: process.env,
  cwd: process.cwd(),
})

/**
 * Discovery, bootstrap, and validation of the selected DSH installation. The
 * layer captures the command runner so discovery's methods carry only the
 * FileSystem requirement; the default probe is bound to the invocation's
 * environment.
 */
export const dshDiscoveryLayer: Layer.Layer<DshDiscoveryShape, never, CommandRunnerShape> =
  Layer.effect(
    DshDiscovery,
    Effect.gen(function* () {
      const runner = yield* CommandRunner
      return {
        discover: (input) =>
          discoverDshInstallation({
            ...input,
            runner,
            probeVersion: input.probeVersion ?? versionProbe(runner, input.env),
          }),
        bootstrap: (input) => bootstrapDshInstallation({ ...input, runner }),
        validate: (installation) => validateDshVersion(installation),
      }
    }),
  )

/** Evaluation of the config module through tsx, over the invocation resolver. */
export const configLoaderLayer: Layer.Layer<
  ConfigLoaderShape,
  never,
  FileSystem.FileSystem | BundleResolverShape
> = Layer.effect(
  ConfigLoader,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const resolver = yield* BundleResolver
    return {
      load: (configPath, options) =>
        loadConfig(configPath, options).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(BundleResolver, resolver),
        ),
    }
  }),
)

/**
 * The kept `Result` → Effect seams. `Result` is the return type of pure
 * computation only; where such a value must enter a program it is converted
 * exactly once, and the complete inventory is:
 *
 * - `resolveBundleLayers` (../../dsh) — DSH's bridge API is synchronous and
 *   Result-returning, so its value enters through this layer. The resolver
 *   service owns the conversion until the resolution phase replaces it.
 * - `loadDshBridge` (../../dsh-bridge) — resolves to a `Result`, converted the
 *   same way by the resolver service.
 * - `parseGeneratedLayers` (../../preflight) — pure decode of generated files
 *   that were already read; preflight converts it.
 * - `runtimeLinkSpec` (../../command/version) — resolves the CLI's own runtime
 *   dependency; materialization converts it before provisioning.
 *
 * No other `Result` crosses into an Effect: a command branches on a pure
 * `Result` and reports it, or converts it to the error channel immediately.
 */

/**
 * The selected installation's bridge cache and bundle resolution. The layer
 * captures the file-system service once; each installation path loads its
 * bridge at most once per invocation, and no global state is installed.
 */
export const bundleResolverLayer: Layer.Layer<BundleResolverShape, never, FileSystem.FileSystem> =
  Layer.effect(
    BundleResolver,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const cache = yield* Ref.make(new Map<string, DshBridge>())
      const load = (installation: Parameters<BundleResolverShape['loadBridge']>[0]) =>
        Effect.gen(function* () {
          const known = (yield* Ref.get(cache)).get(installation.installAnchor)
          if (known !== undefined) return known
          const loaded = yield* Effect.promise(() => loadDshBridge(installation)).pipe(
            Effect.flatMap(Effect.fromResult),
          )
          yield* Ref.update(cache, (entries) =>
            new Map(entries).set(installation.installAnchor, loaded),
          )
          return loaded
        })
      const installed = (installAnchor: string) =>
        Effect.gen(function* () {
          const found = (yield* Ref.get(cache)).get(installAnchor)
          if (found !== undefined) return found
          return yield* Effect.fail(
            new DshFailure({
              code: 'dsh.bridge_unavailable',
              path: installAnchor,
              message: `no composition bridge is loaded for the selected DSH installation at ${installAnchor}`,
            }),
          )
        })
      const shape: BundleResolverShape = {
        loadBridge: load,
        resolve: (input) =>
          Effect.gen(function* () {
            const bridge = yield* load(input.installation)
            return yield* resolveDescriptors(fs, bridge, input.queries, {
              installation: input.installation,
              configDir: input.configDir,
              env: input.env,
            })
          }),
        resolveQuery: (input) =>
          Effect.gen(function* () {
            const bridge = yield* load(input.installation)
            return yield* resolveOne(fs, bridge, input.bundle, input.root, {
              installation: input.installation,
              configDir: input.configDir,
              env: input.env,
            })
          }),
        resolveBundlePatches: (packageName, profileDir, installAnchor) =>
          Effect.gen(function* () {
            const bridge = yield* installed(installAnchor).pipe(
              Effect.mapError((cause) => new DshResolveFailure({ packageName, cause })),
            )
            const result = bundlePatchLayers(bridge, packageName, profileDir, installAnchor)
            if (Result.isFailure(result)) {
              return yield* Effect.fail(
                new DshResolveFailure({ packageName, cause: result.failure }),
              )
            }
            return result.success
          }),
        composeEntries: (installAnchor) =>
          Effect.map(installed(installAnchor), (bridge) => bridge.composeEntries),
      }
      return shape
    }),
  )

/** The chokidar-backed config-directory watcher. */
export const watcherLayer: Layer.Layer<WatcherShape> = Layer.succeed(Watcher, {
  watch: (dir) => watchConfigDirectory(dir),
})

/** The machine-local installation anchor record. */
export const installationAnchorLayer: Layer.Layer<InstallationAnchorShape> = Layer.succeed(
  InstallationAnchor,
  defaultInstallationAnchorStore,
)

/**
 * The bounded, fixed-argument command runner used by setup paths. The layer
 * yields the child-process spawner once and provides it to every bounded run,
 * so the runner shape itself stays requirement-free.
 */
export const commandRunnerLayer: Layer.Layer<
  CommandRunnerShape,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(
  CommandRunner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return (command, args, options) =>
      Effect.provideService(
        boundedCommandRunner(command, args, options),
        ChildProcessSpawner.ChildProcessSpawner,
        spawner,
      )
  }),
)

/** The streaming launcher spawn. */
export const spawnerLayer: Layer.Layer<SpawnLike> = Layer.succeed(Spawner, defaultSpawn)

const platformLayer = NodeServices.layer

/** The live bundle resolver over the invocation filesystem. */
export const liveBundleResolverLayer: Layer.Layer<BundleResolverShape> = bundleResolverLayer.pipe(
  Layer.provide(platformLayer),
)

/** The live config loader over the invocation resolver. */
const liveConfigLoaderLayer: Layer.Layer<ConfigLoaderShape> = configLoaderLayer.pipe(
  Layer.provide(Layer.merge(platformLayer, liveBundleResolverLayer)),
)

/** The live preflight composition over the bundle resolver. */
export const livePreflightLayer: Layer.Layer<PreflightShape> = preflightLayer.pipe(
  Layer.provide(liveBundleResolverLayer),
)

/** The production command runner, bound to the platform's child-process spawner. */
const processCommandRunnerLayer = commandRunnerLayer.pipe(Layer.provide(platformLayer))

/** Live discovery over the production runner. */
const processDshDiscoveryLayer = dshDiscoveryLayer.pipe(Layer.provide(processCommandRunnerLayer))

const domainLayer = Layer.mergeAll(
  outputLayer,
  environmentLayer,
  processDshDiscoveryLayer,
  liveConfigLoaderLayer,
  liveBundleResolverLayer,
  watcherLayer,
  installationAnchorLayer,
  processCommandRunnerLayer,
  spawnerLayer,
  syncLockLayer(),
)

/**
 * The one production composition root: every platform and CLI service a
 * command can require, built once per process.
 */
export const liveCliServicesLayer: Layer.Layer<CliServices> = Layer.mergeAll(
  platformLayer,
  domainLayer,
  pnpmPackageManagerLayer.pipe(Layer.provide(platformLayer)),
  livePreflightLayer,
)
