/**
 * The one failure vocabulary the CLI edge reports. Each package publishes the
 * closed union it can report; this module composes them with the CLI's own
 * tagged failures, the native platform and schema errors, and a single wrapper
 * for a value that crossed a promise boundary without a project tag.
 *
 * Diagnostics are matched by tag, never by class identity: a config project can
 * hold a different copy of `@eedsh/config`, so its tagged failures must be
 * recognized structurally.
 * @module @eedsh/cli/command/errors
 */
import type { ConfigFailure } from '@eedsh/config'
import type { PlanFailure } from '@eedsh/plan'
import { Data } from 'effect'
import * as PlatformError from 'effect/PlatformError'
import * as Schema from 'effect/Schema'
import type { ConfigError } from '../config'
import type { InitError } from '../init'
import type {
  CheckFailure,
  DshFailure,
  DshResolveFailure,
  OwnershipRecordInvalid,
  PackageInstallFailure,
  PreflightFailure,
  ProvisionFailure,
  SpawnFailure,
  SyncLocked,
} from '../internal/effect/errors'
import type { PreviewError } from '../repl/preview'
import type { ReplSessionError } from '../repl/session'
import type { AmbiguousProfile, UnknownProfile } from '../selection'

/**
 * A failure that reached the CLI across an exception boundary without a project
 * tag. It keeps the message and the original cause so the diagnostic is not
 * lost, and it stays distinguishable from every tagged domain failure.
 */
export class UnexpectedFailure extends Data.TaggedError('UnexpectedFailure')<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** Every failure a command can report at the CLI edge. */
export type EedshError =
  | PlanFailure
  | ConfigFailure
  | ConfigError
  | InitError
  | CheckFailure
  | SpawnFailure
  | PackageInstallFailure
  | PreflightFailure
  | SyncLocked
  | DshFailure
  | DshResolveFailure
  | OwnershipRecordInvalid
  | ProvisionFailure
  | UnknownProfile
  | AmbiguousProfile
  | ReplSessionError
  | PreviewError
  | PlatformError.PlatformError
  | UnexpectedFailure

/** The tags {@link asEedshError} recognizes without class identity. */
const ERROR_TAGS: ReadonlySet<string> = new Set<string>([
  'InvalidConfigValue',
  'ConfigError',
  'InitError',
  'CheckFailure',
  'SpawnFailure',
  'PackageInstallFailure',
  'PreflightFailure',
  'SyncLocked',
  'DshFailure',
  'DshResolveFailure',
  'OwnershipRecordInvalid',
  'ProvisionFailure',
  'UnknownProfile',
  'AmbiguousProfile',
  'ReplSessionError',
  'PreviewError',
  'ResolutionError',
  'PresetDefinitionError',
  'SourceDeclarationError',
  'UnexpectedFailure',
])

/**
 * Convert a value that crossed an exception boundary into the CLI's failure
 * union. Schema and platform failures are recognized by their own guards; a
 * tagged failure is recognized by its stable tag because it may come from
 * another copy of its package; anything else becomes an unexpected failure.
 * @param value - the caught or rejected value.
 * @returns a failure the reporter can render.
 */
export function asEedshError(value: unknown): EedshError {
  if (Schema.isSchemaError(value) || PlatformError.isPlatformError(value)) return value
  if (typeof value === 'object' && value !== null) {
    const tag = (value as { _tag?: unknown })._tag
    if (typeof tag === 'string' && ERROR_TAGS.has(tag)) return value as EedshError
  }
  return new UnexpectedFailure({
    message: value instanceof Error ? value.message : String(value),
    cause: value,
  })
}
