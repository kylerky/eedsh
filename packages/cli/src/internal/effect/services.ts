/**
 * Service tags for the Effect island: package installation, the pinned DSH
 * installation, and preflight composition. File access is the core
 * `effect/FileSystem` service, and child processes are the core
 * `effect/process` spawner, so the pipeline has no hand-written Node seam.
 * @module @eedsh/cli/internal/effect/services
 */
import type { ProfilePlan } from '@eedsh/plan'
import { Context, type Effect } from 'effect'
import type * as PlatformError from 'effect/PlatformError'
import type { GeneratedBundle } from '../../materialize/generated-bundle'
import type {
  DshResolveFailure,
  PackageInstallFailure,
  PreflightFailure,
  SyncLocked,
} from './errors'

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

/** The pinned DSH installation. */
export interface DshInstallationShape {
  /** Installed DSH version, used as the generation's runtime provenance. */
  readonly version: string
  /** Absolute path of the DSH package.json (the first bundle-resolution anchor). */
  readonly installAnchor: string
  /** Absolute path of the DSH launcher script. */
  readonly binPath: string
  /** Read the ordered patch lists a selected bundle contributes. */
  resolveBundlePatches(
    packageName: string,
    profileDir: string,
  ): Effect.Effect<readonly Record<string, unknown>[], DshResolveFailure>
}

/** DSH installation service tag. */
export const DshInstallation = Context.Service<DshInstallationShape>('eedsh/DshInstallation')

/** Inputs for preflight composition. */
export interface PreflightInput {
  plan: ProfilePlan
  profileDir: string
  generated: GeneratedBundle
  strict: boolean
  /** Attribute warnings to their source layers. */
  explain: boolean
}

/** Preflight output. */
export interface PreflightResult {
  warnings: string[]
}

/** Preflight composition service. */
export interface PreflightShape {
  check(input: PreflightInput): Effect.Effect<PreflightResult, PreflightFailure>
}

/** Preflight service tag. */
export const Preflight = Context.Service<PreflightShape>('eedsh/Preflight')
