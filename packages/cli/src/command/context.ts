/**
 * The runtime context every `eedsh` subcommand runs against: the injected CLI
 * seams, the output sinks, the installation selected for one invocation, and the
 * service layer the materializer's program is provided with. The composition
 * root and every command adapter share these types instead of redeclaring them.
 * @module @eedsh/cli/command/context
 */

import type { ConfigProvenance, DshBridge } from '@eedsh/config'
import type { ProfilePlan } from '@eedsh/plan'
import * as NodeServices from '@effect/platform-node/NodeServices'
import type { Effect } from 'effect'
import { Layer } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import type * as Option from 'effect/Option'
import type { ChildProcessSpawner } from 'effect/process'
import type * as Result from 'effect/Result'
import type { CommandRunner } from '../command-runner'
import type { ConfigLoadFailure, LoadedConfig } from '../config'
import type { DiscoveredDshInstallation } from '../dsh'
import type { BootstrapInput, BootstrappedDsh } from '../dsh-bootstrap'
import type { InitService } from '../init'
import type { InstallationAnchorStore } from '../installation-anchor'
import type { DshFailure, DshResolveFailure } from '../internal/effect/errors'
import { liveServiceLayerFor } from '../internal/effect/layer'
import type {
  DshInstallationShape,
  PackageManagerShape,
  PreflightShape,
  SyncLockShape,
} from '../internal/effect/services'
import { preflightLayer } from '../preflight'
import type { SpawnLike } from '../spawn'
import type { WatchSession } from '../watch'

/** The services the materializer needs, built once per CLI run. */
export type CliService =
  | FileSystem.FileSystem
  | PackageManagerShape
  | DshInstallationShape
  | PreflightShape
  | SyncLockShape
  | ChildProcessSpawner.ChildProcessSpawner

/** A layer providing every CLI service. */
export type CliServiceLayer = Layer.Layer<CliService, DshResolveFailure, never>

/** Watch seam for `eedsh sync --watch`. */
export type WatchFactory = (dir: string, onChange: () => void) => Promise<WatchSession>

/** The discovery input a command passes to an injected seam. */
export interface DshDiscoveryInput {
  readonly explicit?: string | undefined
  readonly env: Record<string, string | undefined>
  readonly cwd: string
}

/** Overridable dependencies, for tests and embedders. */
export interface CliRunOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  stdout?: (line: string) => void
  stderr?: (line: string) => void
  /** Replace config evaluation. */
  loadConfig?: (
    configPath: string,
    evaluationNonce?: string,
  ) => Effect.Effect<LoadedConfig, ConfigLoadFailure>
  /** Replace the materializer's service layer. */
  services?: () => CliServiceLayer
  /** Replace DSH discovery. */
  discoverDsh?: (input: DshDiscoveryInput) => Result.Result<DiscoveredDshInstallation, DshFailure>
  /** Replace bridge loading; the default imports app-boot from the installation. */
  loadDshBridge?: (
    installation: DiscoveredDshInstallation,
  ) => Promise<Result.Result<DshBridge, DshFailure>>
  /** Replace the file system `doctor` inspects. */
  fileSystem?: () => Layer.Layer<FileSystem.FileSystem>
  /** Replace the launcher spawn. */
  spawn?: SpawnLike
  /** Replace the config-directory watcher. */
  watch?: WatchFactory
  /** Input stream for the interactive REPL (default: process.stdin). */
  replInput?: NodeJS.ReadableStream
  /** Output stream for REPL prompts and values (default: process.stdout). */
  replOutput?: NodeJS.WritableStream
  /** Stop watch mode when aborted. */
  signal?: AbortSignal
  /** Replace the narrow services `init` needs. */
  initServices?: () => Layer.Layer<InitService>
  /** Replace the machine-local installation anchor store. */
  installationAnchor?: InstallationAnchorStore
  /** Replace the bounded command runner used by setup paths. */
  commandRunner?: CommandRunner
  /** Replace the pnpm/npm installation bootstrap. */
  bootstrapDsh?: (input: BootstrapInput) => Result.Result<BootstrappedDsh, DshFailure>
}

/** The reporting context for the one diagnostic the runner emits. */
export interface FailureContext {
  sync: boolean
  explain: boolean
}

/** The output sinks, environment, and injected seams a subcommand runs against. */
export interface CommandRuntime {
  stdout: (line: string) => void
  stderr: (line: string) => void
  env: Record<string, string | undefined>
  cwd: string
  options: CliRunOptions
  /** The installation selected for this invocation, once discovery ran. */
  installation?: DiscoveredDshInstallation
  setFailureContext: (context: FailureContext | undefined) => void
}

export interface CommandContext extends CommandRuntime {
  configPath: string
  installation: DiscoveredDshInstallation
  plan: ProfilePlan
  /** The evaluated config's recorded provenance, when it has any. */
  provenance: ConfigProvenance | undefined
  /** Absolute directory of the evaluated config file. */
  configDir: string
  /** The `--profile` value the run was started with, for watch reruns. */
  profile: Option.Option<string>
}

export function defaultServices(installation: DiscoveredDshInstallation): CliServiceLayer {
  const live = liveServiceLayerFor(installation)
  return Layer.mergeAll(live, preflightLayer.pipe(Layer.provide(live))).pipe(
    Layer.provideMerge(NodeServices.layer),
  )
}
