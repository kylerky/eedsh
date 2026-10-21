/**
 * Service tags for the Effect island: file access, package installation, the
 * pinned DSH installation, and preflight composition. Node `fs`/`spawn` live
 * only inside the live layer implementations, so the pipeline stays testable
 * with plain test layers.
 * @module @eedsh/cli/internal/effect/services
 */
import type { ProfilePlan } from '@eedsh/config'
import { Context, type Effect } from 'effect'
import type { GeneratedBundle } from '../../materialize/generated-bundle'
import type {
  DshResolveFailure,
  FileSystemFailure,
  PackageInstallFailure,
  PreflightFailure,
} from './errors'

/** File operations the materializer needs. */
export interface FileSystemShape {
  exists(path: string): Effect.Effect<boolean, FileSystemFailure>
  readFile(path: string): Effect.Effect<string, FileSystemFailure>
  writeFileAtomic(path: string, content: string): Effect.Effect<void, FileSystemFailure>
  ensureDir(path: string): Effect.Effect<void, FileSystemFailure>
  remove(path: string): Effect.Effect<void, FileSystemFailure>
  rename(from: string, to: string): Effect.Effect<void, FileSystemFailure>
  /** Create a file only when it does not exist; returns whether it was created. */
  writeFileExclusive(path: string, content: string): Effect.Effect<boolean, FileSystemFailure>
}

/** File access service tag. */
export const FileSystem = Context.GenericTag<FileSystemShape>('eedsh/FileSystem')

/** Package installation service. */
export interface PackageManagerShape {
  install(profileDir: string): Effect.Effect<void, PackageInstallFailure>
}

/** Package installation service tag. */
export const PackageManager = Context.GenericTag<PackageManagerShape>('eedsh/PackageManager')

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
export const DshInstallation = Context.GenericTag<DshInstallationShape>('eedsh/DshInstallation')

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
export const Preflight = Context.GenericTag<PreflightShape>('eedsh/Preflight')
