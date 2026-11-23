/**
 * The test composition root: one helper builds a `CliServices` layer from the
 * capabilities a test wants to fake, and `runCli` runs one invocation through it.
 * A test replaces a capability by passing its service value; it never passes an
 * option bag to the CLI.
 */

import type { DshBridge } from '@eedsh/config'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect, type Exit, Layer } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { ChildProcessSpawner } from 'effect/process'
import * as Result from 'effect/Result'
import { main } from '../../src/cli'
import { defaultCommandRunner } from '../../src/command-runner'
import { loadConfig } from '../../src/config'
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
  dshDiscoveryLayer,
  installationAnchorLayer,
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

/** A discovery service that selects one installation for every invocation. */
export function fakeDshDiscovery(
  installation: DiscoveredDshInstallation,
  options: {
    bootstrap?: (input: BootstrapInput) => Result.Result<BootstrappedDsh, DshFailure>
    validate?: (
      installation: DiscoveredDshInstallation,
    ) => Result.Result<DiscoveredDshInstallation, DshFailure>
    discover?: (input: DiscoverDshOptions) => Result.Result<DiscoveredDshInstallation, DshFailure>
  } = {},
): DshDiscoveryShape {
  return {
    discover: options.discover ?? (() => Result.succeed(installation)),
    bootstrap: options.bootstrap ?? ((input) => bootstrapDshInstallation(input)),
    validate: options.validate ?? ((selected) => validateDshVersion(selected)),
  }
}

/** A discovery service that runs the real discovery against a fixed environment. */
export function liveTestDshDiscovery(): DshDiscoveryShape {
  return {
    discover: (input) => discoverDshInstallation(input),
    bootstrap: (input) => bootstrapDshInstallation(input),
    validate: (installation) => validateDshVersion(installation),
  }
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
  const layers: Array<Layer.Layer<CliServices>> = [
    asCli(platform),
    asCli(dshDiscoveryLayer),
    asCli(configLoaderLayer),
    asCli(installationAnchorLayer),
    asCli(commandRunnerLayer),
    asCli(spawnerLayer),
    resolver,
    asCli(Layer.succeed(Output, overrides.output ?? liveOutput)),
    asCli(
      Layer.succeed(Environment, overrides.environment ?? { env: process.env, cwd: process.cwd() }),
    ),
    asCli(Layer.succeed(DshDiscovery, overrides.discovery ?? liveTestDshDiscovery())),
    asCli(Layer.succeed(ConfigLoader, overrides.configLoader ?? { load: loadConfig })),
    asCli(Layer.succeed(Watcher, overrides.watcher ?? fakeWatcher())),
    asCli(Layer.succeed(InstallationAnchor, overrides.anchor ?? defaultInstallationAnchorStore)),
    asCli(Layer.succeed(CommandRunner, overrides.commandRunner ?? defaultCommandRunner)),
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
