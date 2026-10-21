/**
 * Tagged failures for the materialization pipeline. Every failure carries a
 * stable `_tag` so callers can map it to an exit code and a diagnostic
 * without matching message text.
 * @module @eedsh/cli/internal/effect/errors
 */
import { Data } from 'effect'

/** A file operation failed. */
export class FileSystemFailure extends Data.TaggedError('FileSystemFailure')<{
  readonly operation: string
  readonly path: string
  readonly cause: unknown
}> {}

/** Installing profile packages failed. */
export class PackageInstallFailure extends Data.TaggedError('PackageInstallFailure')<{
  readonly profileDir: string
  readonly cause: unknown
}> {}

/** Preflight composition rejected the generation. */
export class PreflightFailure extends Data.TaggedError('PreflightFailure')<{
  readonly message: string
  readonly warnings: readonly string[]
}> {}

/**
 * Another sync run holds the profile lock. Kernel locks expose no portable
 * holder identity, so the diagnostic carries only the lock path.
 */
export class SyncLocked extends Data.TaggedError('SyncLocked')<{
  readonly lockPath: string
}> {}

/** A DSH package or bundle could not be resolved. */
export class DshResolveFailure extends Data.TaggedError('DshResolveFailure')<{
  readonly packageName: string
  readonly cause: unknown
}> {}

/** Every failure the materializer can report. */
export type MaterializeError =
  | FileSystemFailure
  | PackageInstallFailure
  | PreflightFailure
  | SyncLocked
  | DshResolveFailure
