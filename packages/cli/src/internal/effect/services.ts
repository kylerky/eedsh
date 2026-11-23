/**
 * Service tags for the CLI's effect boundary. Every external capability the
 * commands use — output sinks, the invocation environment, DSH discovery, config
 * evaluation, bundle resolution, watching, the installation anchor, the bounded
 * command runner, the launcher spawn, package installation, locking, and
 * preflight — is a tag here, so a test replaces a capability by providing a
 * layer and never by an option bag.
 * @module @eedsh/cli/internal/effect/services
 */
import type { ConfigProvenance, DshBridge } from '@eedsh/config'
import type { ProfilePlan } from '@eedsh/plan'
import type { InstallationAnchor as InstallationAnchorRecord } from '@eedsh/runtime/installation-anchor'
import { Context, type Effect } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import type * as Path from 'effect/Path'
import type * as PlatformError from 'effect/PlatformError'
import type { ChildProcessSpawner } from 'effect/process'
import type * as Result from 'effect/Result'
import type * as Stdio from 'effect/Stdio'
import type * as Terminal from 'effect/Terminal'
import type { CommandOptions, CommandResult } from '../../command-runner'
import type { ConfigLoadFailure, LoadedConfig } from '../../config'
import type { BootstrapInput, BootstrappedDsh } from '../../dsh-bootstrap'
import type { DiscoverDshOptions, DiscoveredDshInstallation } from '../../dsh-discovery'
import type { GeneratedBundle } from '../../materialize/generated-bundle'
import type { SpawnLike } from '../../spawn'
import type { WatchSession } from '../../watch'
import type {
  DshFailure,
  DshResolveFailure,
  PackageInstallFailure,
  PreflightFailure,
  SyncLocked,
} from './errors'

/** The two output sinks every command writes through. */
export interface OutputShape {
  /** Write one stdout line. */
  readonly stdout: (line: string) => void
  /** Write one stderr line. */
  readonly stderr: (line: string) => void
}

/** Output service tag. */
export const Output = Context.Service<OutputShape>('eedsh/Output')

/** The invocation's environment and working directory. */
export interface EnvironmentShape {
  /** The environment mapping the invocation resolves against. */
  readonly env: Record<string, string | undefined>
  /** Absolute working directory for relative paths. */
  readonly cwd: string
}

/** Environment service tag. */
export const Environment = Context.Service<EnvironmentShape>('eedsh/Environment')

/** Discovering, bootstrapping, and validating the selected DSH installation. */
export interface DshDiscoveryShape {
  /** Find one installation with the explicit precedence of discovery. */
  discover(input: DiscoverDshOptions): Result.Result<DiscoveredDshInstallation, DshFailure>
  /** Bootstrap an unresolved PATH launcher through pnpm or npm. */
  bootstrap(input: BootstrapInput): Result.Result<BootstrappedDsh, DshFailure>
  /** Reject an installation outside the supported range. */
  validate(
    installation: DiscoveredDshInstallation,
  ): Result.Result<DiscoveredDshInstallation, DshFailure>
}

/** DSH discovery service tag. */
export const DshDiscovery = Context.Service<DshDiscoveryShape>('eedsh/DshDiscovery')

/** Evaluation of the config module. */
export interface ConfigLoaderShape {
  /** Import and validate the config at an absolute path. */
  load(configPath: string, evaluationNonce?: string): Effect.Effect<LoadedConfig, ConfigLoadFailure>
}

/** Config loader service tag. */
export const ConfigLoader = Context.Service<ConfigLoaderShape>('eedsh/ConfigLoader')

/** Resolution of a selected installation's bundles. */
export interface BundleResolverShape {
  /** Load the composition bridge from the installation and install it. */
  loadBridge(installation: DiscoveredDshInstallation): Effect.Effect<DshBridge, DshFailure>
  /** Read the ordered patch layers one profile bundle contributes. */
  resolveBundlePatches(
    packageName: string,
    profileDir: string,
    installAnchor: string,
  ): Effect.Effect<readonly Record<string, unknown>[], DshResolveFailure>
}

/** Bundle resolver service tag. */
export const BundleResolver = Context.Service<BundleResolverShape>('eedsh/BundleResolver')

/** The config-directory watcher and the invocation's stop request. */
export interface WatcherShape {
  /** Watch a directory; resolves once the watcher is ready. */
  watch(dir: string, onChange: () => void): Promise<WatchSession>
  /** Completes when the current watch session should stop. */
  readonly stop: Effect.Effect<void>
}

/** Watcher service tag. */
export const Watcher = Context.Service<WatcherShape>('eedsh/Watcher')

/** The machine-local installation anchor record. */
export interface InstallationAnchorShape {
  /** Read the valid record for an environment, or undefined. */
  read(env: Record<string, string | undefined>): InstallationAnchorRecord | undefined
  /** Atomically write the record for an environment. */
  write(
    env: Record<string, string | undefined>,
    anchor: InstallationAnchorRecord,
  ): { readonly ok: true } | { readonly ok: false; readonly error: string }
}

/** Installation anchor service tag. */
export const InstallationAnchor = Context.Service<InstallationAnchorShape>(
  'eedsh/InstallationAnchor',
)

/** The bounded, fixed-argument command runner used by setup paths. */
export type CommandRunnerShape = (
  command: string,
  args: readonly string[],
  options?: CommandOptions,
) => CommandResult

/** Command runner service tag. */
export const CommandRunner = Context.Service<CommandRunnerShape>('eedsh/CommandRunner')

/** Spawner service tag: launches a streaming child process for run and check. */
export const Spawner = Context.Service<SpawnLike>('eedsh/Spawner')

/** A held profile sync lock; releasing it returns the lock to the kernel. */
export interface SyncLockHandle {
  release: Effect.Effect<void>
}

/** Kernel-backed serialization of materialization for one profile. */
export interface SyncLockShape {
  acquire(lockPath: string): Effect.Effect<SyncLockHandle, SyncLocked | PlatformError.PlatformError>
}

/** Sync lock service tag. */
export const SyncLock = Context.Service<SyncLockShape>('eedsh/SyncLock')

/** Package installation service. */
export interface PackageManagerShape {
  install(profileDir: string): Effect.Effect<void, PackageInstallFailure>
}

/** Package installation service tag. */
export const PackageManager = Context.Service<PackageManagerShape>('eedsh/PackageManager')

/** Inputs for preflight composition. */
export interface PreflightInput {
  plan: ProfilePlan
  profileDir: string
  generated: GeneratedBundle
  strict: boolean
  /** Attribute warnings to their source groups and authoring sites. */
  explain: boolean
  /** Absolute path of the DSH package.json the bundles resolve against. */
  installAnchor: string
  /** The evaluated config's recorded provenance, when it has any. */
  provenance?: ConfigProvenance
  /** Absolute directory of the evaluated config file, for relative sites. */
  configDir?: string
}

/** Preflight output. */
export interface PreflightResult {
  /** Raw warnings, or layer-attributed warnings when `explain` is enabled. */
  warnings: string[]
}

/** Preflight composition service. */
export interface PreflightShape {
  check(input: PreflightInput): Effect.Effect<PreflightResult, PreflightFailure>
}

/** Preflight service tag. */
export const Preflight = Context.Service<PreflightShape>('eedsh/Preflight')

/**
 * Every service a command program may require. The production layer provides
 * all of them; a test provides the subset it wants to fake and a base layer for
 * the rest. `Environment` here is the effect/cli environment bundle: file
 * access, paths, the terminal, stdio, and the child-process spawner.
 */
export type CliServices =
  | OutputShape
  | EnvironmentShape
  | DshDiscoveryShape
  | ConfigLoaderShape
  | BundleResolverShape
  | WatcherShape
  | InstallationAnchorShape
  | CommandRunnerShape
  | SpawnLike
  | PackageManagerShape
  | SyncLockShape
  | PreflightShape
  | FileSystem.FileSystem
  | Path.Path
  | Stdio.Stdio
  | Terminal.Terminal
  | ChildProcessSpawner.ChildProcessSpawner
