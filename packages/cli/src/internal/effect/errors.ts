/**
 * Tagged failures for the materialization pipeline. Every failure carries a
 * stable `_tag` so callers can map it to an exit code and a diagnostic
 * without matching message text. File-operation failures surface as the
 * platform's own `PlatformError` instead of a project-defined type.
 * @module @eedsh/cli/internal/effect/errors
 */
import { Data } from 'effect'
import type * as PlatformError from 'effect/PlatformError'

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

/** Checking the config project could not run. */
export class CheckFailure extends Data.TaggedError('CheckFailure')<{
  readonly code: string
  readonly message: string
}> {}

/** The DSH launcher could not be started. */
export class SpawnFailure extends Data.TaggedError('SpawnFailure')<{
  readonly cause: unknown
}> {}

/** A DSH package or bundle could not be resolved. */
export class DshResolveFailure extends Data.TaggedError('DshResolveFailure')<{
  readonly packageName: string
  readonly cause: unknown
}> {}

/** Every failure the materializer can report. */
export type MaterializeError =
  | PlatformError.PlatformError
  | PackageInstallFailure
  | PreflightFailure
  | SyncLocked
  | DshResolveFailure