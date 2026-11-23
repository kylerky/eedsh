/**
 * Live service layers and the one production composition root. The platform
 * layer supplies the effect services every command runs on; each capability tag
 * has one live layer that delegates to the module that implements it, so a test
 * can replace any single capability without rebuilding the graph.
 * @module @eedsh/cli/internal/effect/layer
 */
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect, Layer, Stream } from 'effect'
import * as PlatformError from 'effect/PlatformError'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { defaultCommandRunner, pnpmInvocation } from '../../command-runner'
import { loadConfig } from '../../config'
import { resolveBundleLayers } from '../../dsh'
import { bootstrapDshInstallation } from '../../dsh-bootstrap'
import { loadDshBridge } from '../../dsh-bridge'
import { discoverDshInstallation, validateDshVersion } from '../../dsh-discovery'
import { defaultInstallationAnchorStore } from '../../installation-anchor'
import { preflightLayer } from '../../preflight'
import { defaultSpawn, type SpawnLike } from '../../spawn'
import { stopSignal, watchConfigDirectory } from '../../watch'
import { posixSyncLock } from '../lock-posix'
import { win32SyncLock } from '../lock-win32'
import { PackageInstallFailure } from './errors'
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

/** Discovery, bootstrap, and validation of the selected DSH installation. */
export const dshDiscoveryLayer: Layer.Layer<DshDiscoveryShape> = Layer.succeed(DshDiscovery, {
  discover: (input) => discoverDshInstallation(input),
  bootstrap: (input) => bootstrapDshInstallation(input),
  validate: (installation) => validateDshVersion(installation),
})

/** Evaluation of the config module through tsx. */
export const configLoaderLayer: Layer.Layer<ConfigLoaderShape> = Layer.succeed(ConfigLoader, {
  load: (configPath, evaluationNonce) => loadConfig(configPath, evaluationNonce),
})

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

/** The DSH bridge and profile-bundle patch resolution. */
export const bundleResolverLayer: Layer.Layer<BundleResolverShape> = Layer.succeed(BundleResolver, {
  loadBridge: (installation) =>
    Effect.promise(() => loadDshBridge(installation)).pipe(Effect.flatMap(Effect.fromResult)),
  resolveBundlePatches: (packageName, profileDir, installAnchor) =>
    Effect.fromResult(resolveBundleLayers(packageName, profileDir, installAnchor)),
})

/** The chokidar-backed config-directory watcher and the signal stop. */
export const watcherLayer: Layer.Layer<WatcherShape> = Layer.succeed(Watcher, {
  watch: (dir, onChange) => watchConfigDirectory({ dir, onChange }),
  stop: stopSignal(undefined),
})

/** The machine-local installation anchor record. */
export const installationAnchorLayer: Layer.Layer<InstallationAnchorShape> = Layer.succeed(
  InstallationAnchor,
  defaultInstallationAnchorStore,
)

/** The bounded, fixed-argument command runner used by setup paths. */
export const commandRunnerLayer: Layer.Layer<CommandRunnerShape> = Layer.succeed(
  CommandRunner,
  defaultCommandRunner,
)

/** The streaming launcher spawn. */
export const spawnerLayer: Layer.Layer<SpawnLike> = Layer.succeed(Spawner, defaultSpawn)

/** The live preflight composition over the bundle resolver. */
export const livePreflightLayer: Layer.Layer<PreflightShape> = preflightLayer.pipe(
  Layer.provide(bundleResolverLayer),
)

const platformLayer = NodeServices.layer

const domainLayer = Layer.mergeAll(
  outputLayer,
  environmentLayer,
  dshDiscoveryLayer,
  configLoaderLayer,
  bundleResolverLayer,
  watcherLayer,
  installationAnchorLayer,
  commandRunnerLayer,
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
