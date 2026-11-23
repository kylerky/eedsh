/**
 * The test composition root: one helper builds a `CliServices` layer from the
 * capabilities a test wants to fake, and `runCli` runs one invocation through it.
 * A test replaces a capability by passing its service value; it never passes an
 * option bag to the CLI.
 */

import type { DshBridge } from '@eedsh/config'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect, type Exit, Layer } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'
import { ChildProcessSpawner } from 'effect/process'
import * as Result from 'effect/Result'
import { main } from '../../src/cli'
import { boundedCommandRunner } from '../../src/command-runner'
import type { BootstrapInput, BootstrappedDsh } from '../../src/dsh-bootstrap'
import { bootstrapDshInstallation } from '../../src/dsh-bootstrap'
import { loadDshBridge } from '../../src/dsh-bridge'
import {
  type DiscoverDshOptions,
  type DiscoveredDshInstallation,
  discoverDshInstallation,
  validateDshVersion,
} from '../../src/dsh-discovery'
import { defaultInstallationAnchorStore } from '../../src/installation-anchor'
import type { DshFailure, DshResolveFailure } from '../../src/internal/effect/errors'
import {
  bundleResolverLayer,
  commandRunnerLayer,
  configLoaderLayer,
  pnpmPackageManagerLayer,
  spawnerLayer,
  syncLockLayer,
} from '../../src/internal/effect/layer'
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
  Preflight,
  type PreflightShape,
  Spawner,
  SyncLock,
  type SyncLockShape,
  Watcher,
  type WatcherShape,
} from '../../src/internal/effect/services'
import { preflightLayer } from '../../src/preflight'
import type { SpawnLike } from '../../src/spawn'
import { defaultSpawn } from '../../src/spawn'
import { stopSignal, watchConfigDirectory } from '../../src/watch'
import type { fakeChildProcessSpawner } from './fakes'

/** The service value the fake child-process spawner provides. */
export type ChildProcessSpawnerService = ReturnType<typeof fakeChildProcessSpawner>['spawner']

/** The capabilities a test replaces; omitted ones are the live value. */
export interface CliOverrides {
  output?: OutputShape
  environment?: EnvironmentShape
  discovery?: DshDiscoveryShape
  configLoader?: ConfigLoaderShape
  bundleResolver?: BundleResolverShape
  watcher?: WatcherShape
  anchor?: InstallationAnchorShape
  commandRunner?: CommandRunnerShape
  spawner?: SpawnLike
  packageManager?: PackageManagerShape
  syncLock?: SyncLockShape
  preflight?: PreflightShape
  fileSystem?: FileSystem.FileSystem
  childProcessSpawner?: ChildProcessSpawnerService
  /** Extra layers to merge last, for a capability not covered above. */
  extra?: ReadonlyArray<Layer.Layer<CliServices>>
}

/** The live output sinks, used when a test does not capture them. */
const liveOutput: OutputShape = {
  stdout: (line) => {
    console.log(line)
  },
  stderr: (line) => {
    console.error(line)
  },
}

/** A layer fragment that replaces the invocation filesystem with the process filesystem. */
export const realFileSystem: Layer.Layer<CliServices> =
  NodeFileSystem.layer as Layer.Layer<CliServices>

/** The process filesystem service value, for callers that are not Effects. */
export async function realFileSystemValue(): Promise<FileSystem.FileSystem> {
  return await Effect.runPromise(
    Effect.service(FileSystem.FileSystem).pipe(Effect.provide(NodeFileSystem.layer)),
  )
}

/** Output sinks that record every line into two arrays. */
export function captureOutput(out: string[], err: string[]): OutputShape {
  return {
    stdout: (line) => {
      out.push(line)
    },
    stderr: (line) => {
      err.push(line)
    },
  }
}

/** The process filesystem: the live discovery and anchor store run on it. */
const processFileSystem: Layer.Layer<FileSystem.FileSystem> = NodeFileSystem.layer

/**
 * A command runner over the real child-process spawner, for the live defaults
 * that are not bound to a test's runner override.
 */
const processCommandRunner: CommandRunnerShape = (command, args, options) =>
  boundedCommandRunner(command, args, options).pipe(Effect.provide(NodeServices.layer))

/** A discovery service that selects one installation for every invocation. */
export function fakeDshDiscovery(
  installation: DiscoveredDshInstallation,
  options: {
    bootstrap?: (
      input: BootstrapInput,
    ) => Effect.Effect<
      Result.Result<BootstrappedDsh, DshFailure>,
      PlatformError.PlatformError,
      FileSystem.FileSystem
    >
    validate?: (
      installation: DiscoveredDshInstallation,
    ) => Result.Result<DiscoveredDshInstallation, DshFailure>
    discover?: (
      input: DiscoverDshOptions,
    ) => Effect.Effect<
      Result.Result<DiscoveredDshInstallation, DshFailure>,
      PlatformError.PlatformError,
      FileSystem.FileSystem
    >
    /** The command runner the live bootstrap default uses. */
    runner?: CommandRunnerShape
  } = {},
): DshDiscoveryShape {
  const runner = options.runner ?? processCommandRunner
  return {
    discover: options.discover ?? (() => Effect.succeed(Result.succeed(installation))),
    bootstrap:
      options.bootstrap ??
      ((input) =>
        bootstrapDshInstallation({ ...input, runner }).pipe(Effect.provide(processFileSystem))),
    validate: options.validate ?? ((selected) => validateDshVersion(selected)),
  }
}

/**
 * A discovery service that runs the real discovery against the process
 * filesystem, as production does, with the given command runner.
 */
export function liveTestDshDiscovery(
  runner: CommandRunnerShape = processCommandRunner,
): DshDiscoveryShape {
  const onProcessFileSystem = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
    effect.pipe(Effect.provide(processFileSystem))
  return {
    discover: (input) => onProcessFileSystem(discoverDshInstallation({ ...input, runner })),
    bootstrap: (input) => onProcessFileSystem(bootstrapDshInstallation({ ...input, runner })),
    validate: (installation) => validateDshVersion(installation),
  }
}

/** The live discovery over the command runner in scope. */
const liveTestDshDiscoveryLayer: Layer.Layer<DshDiscoveryShape, never, CommandRunnerShape> =
  Layer.effect(
    DshDiscovery,
    Effect.gen(function* () {
      const runner = yield* CommandRunner
      return liveTestDshDiscovery(runner)
    }),
  )

/** The live anchor store over the process filesystem, as production does. */
export const liveTestInstallationAnchorStore: InstallationAnchorShape = {
  read: (env) => defaultInstallationAnchorStore.read(env).pipe(Effect.provide(processFileSystem)),
  write: (env, anchor) =>
    defaultInstallationAnchorStore.write(env, anchor).pipe(Effect.provide(processFileSystem)),
}

/** A bundle resolver that supplies fixed profile-bundle patches. */
export function fakeBundleResolver(
  options: {
    patches?: Record<string, unknown>[]
    resolveFailure?: DshResolveFailure
    loadBridge?: (
      installation: DiscoveredDshInstallation,
    ) => Promise<Result.Result<DshBridge, DshFailure>>
  } = {},
): BundleResolverShape {
  return {
    loadBridge:
      options.loadBridge === undefined
        ? (installation) =>
            Effect.promise(() => loadDshBridge(installation)).pipe(
              Effect.flatMap(Effect.fromResult),
            )
        : (installation) =>
            Effect.promise(() => options.loadBridge!(installation)).pipe(
              Effect.flatMap(Effect.fromResult),
            ),
    resolveBundlePatches: () =>
      options.resolveFailure === undefined
        ? Effect.succeed(options.patches ?? [])
        : Effect.fail(options.resolveFailure),
  }
}

/** A config loader built from a test's evaluation function. */
export function fakeConfigLoader(load: ConfigLoaderShape['load']): ConfigLoaderShape {
  return { load }
}

/** A watcher that uses a test's watch factory and stop signal. */
export function fakeWatcher(
  options: {
    signal?: AbortSignal
    watch?: (dir: string, onChange: () => void) => Promise<{ close(): Promise<void> }>
  } = {},
): WatcherShape {
  return {
    watch: options.watch ?? ((dir, onChange) => watchConfigDirectory({ dir, onChange })),
    stop: options.signal === undefined ? stopSignal(undefined) : stopSignal(options.signal),
  }
}

/**
 * Build one CLI service layer. This is the shared base layer tests compose on:
 * omitted capabilities are the live values, and the layer is self-contained, so
 * `Effect.provide` needs nothing else.
 */
export function cliLayer(overrides: CliOverrides = {}): Layer.Layer<CliServices> {
  const platform = NodeServices.layer
  const asCli = <A, E, R>(layer: Layer.Layer<A, E, R>): Layer.Layer<CliServices> =>
    layer as Layer.Layer<CliServices>
  const resolver: Layer.Layer<CliServices> = asCli(
    overrides.bundleResolver === undefined
      ? bundleResolverLayer
      : Layer.succeed(BundleResolver, overrides.bundleResolver),
  )
  const spawner: Layer.Layer<CliServices> = asCli(
    overrides.childProcessSpawner === undefined
      ? platform
      : Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, overrides.childProcessSpawner),
  )
  const commandRunner: Layer.Layer<CliServices> = asCli(
    overrides.commandRunner === undefined
      ? commandRunnerLayer.pipe(Layer.provide(spawner))
      : Layer.succeed(CommandRunner, overrides.commandRunner),
  )
  const layers: Array<Layer.Layer<CliServices>> = [
    asCli(platform),
    commandRunner,
    asCli(
      overrides.discovery === undefined
        ? liveTestDshDiscoveryLayer.pipe(Layer.provide(commandRunner))
        : Layer.succeed(DshDiscovery, overrides.discovery),
    ),
    asCli(spawnerLayer),
    resolver,
    asCli(Layer.succeed(Output, overrides.output ?? liveOutput)),
    asCli(
      Layer.succeed(Environment, overrides.environment ?? { env: process.env, cwd: process.cwd() }),
    ),
    asCli(
      overrides.configLoader === undefined
        ? configLoaderLayer.pipe(Layer.provide(platform))
        : Layer.succeed(ConfigLoader, overrides.configLoader),
    ),
    asCli(Layer.succeed(Watcher, overrides.watcher ?? fakeWatcher())),
    asCli(Layer.succeed(InstallationAnchor, overrides.anchor ?? liveTestInstallationAnchorStore)),
    asCli(Layer.succeed(Spawner, overrides.spawner ?? defaultSpawn)),
    asCli(
      overrides.packageManager === undefined
        ? pnpmPackageManagerLayer.pipe(Layer.provide(platform))
        : Layer.succeed(PackageManager, overrides.packageManager),
    ),
    asCli(
      overrides.syncLock === undefined
        ? syncLockLayer()
        : Layer.succeed(SyncLock, overrides.syncLock),
    ),
    asCli(
      overrides.preflight === undefined
        ? preflightLayer.pipe(Layer.provide(resolver))
        : Layer.succeed(Preflight, overrides.preflight),
    ),
  ]
  if (overrides.fileSystem !== undefined) {
    layers.push(asCli(Layer.succeed(FileSystem.FileSystem, overrides.fileSystem)))
  }
  if (overrides.childProcessSpawner !== undefined) {
    layers.push(
      asCli(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, overrides.childProcessSpawner)),
    )
  }
  for (const extra of overrides.extra ?? []) layers.push(extra)
  return layers.reduce(
    (acc, layer) => Layer.merge(acc, layer),
    Layer.empty as Layer.Layer<CliServices>,
  )
}

/** Run one CLI invocation against a test layer and resolve its exit code. */
export function runCli(argv: readonly string[], overrides: CliOverrides = {}): Promise<number> {
  return Effect.runPromise(
    Effect.suspend(() => main(argv)).pipe(Effect.provide(cliLayer(overrides))),
  )
}

/** Run one CLI invocation and observe its exit. */
export function runCliExit(
  argv: readonly string[],
  overrides: CliOverrides = {},
): Promise<Exit.Exit<number, never>> {
  return Effect.runPromiseExit(
    Effect.suspend(() => main(argv)).pipe(Effect.provide(cliLayer(overrides))),
  )
}
