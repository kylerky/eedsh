/**
 * The provisioning record kept outside the working tree. It holds the resolved
 * commit, the preparation steps last run, and when they ran, so a reset inside
 * the checkout cannot destroy the state that decides whether to prepare again.
 * @module @eedsh/cli/provision/record
 */
import { dirname } from 'node:path'
import { Effect } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'
import * as Result from 'effect/Result'
import { writeFileAtomic } from '../internal/atomic-write'

/** The one provisioning record format this release reads and writes. */
export const SOURCE_RECORD_FORMAT = 1

/** The recorded provisioning state for one source. */
export interface SourceRecord {
  readonly format: number
  /** The declared package name. */
  readonly name: string
  /** The acquisition location as authored. */
  readonly from: string
  /** The git ref, when the declaration names one. */
  readonly ref?: string
  /** The resolved commit for a git source. */
  readonly commit?: string
  /** The preparation steps last run. */
  readonly prepare: readonly (readonly string[])[]
  /** When preparation last ran. */
  readonly preparedAt?: string
}

function isStep(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/**
 * Decode one parsed record. An unreadable or older record is treated as absent
 * so provisioning re-establishes the state instead of trusting it.
 * @param value - the parsed record value.
 * @returns the normalized record, or undefined.
 */
export function decodeSourceRecord(value: unknown): SourceRecord | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.format !== SOURCE_RECORD_FORMAT) return undefined
  if (typeof record.name !== 'string' || record.name === '') return undefined
  if (typeof record.from !== 'string' || record.from === '') return undefined
  if (record.ref !== undefined && (typeof record.ref !== 'string' || record.ref === ''))
    return undefined
  if (record.commit !== undefined && typeof record.commit !== 'string') return undefined
  if (!Array.isArray(record.prepare) || !record.prepare.every(isStep)) return undefined
  if (
    record.preparedAt !== undefined &&
    (typeof record.preparedAt !== 'string' || record.preparedAt === '')
  ) {
    return undefined
  }
  return {
    format: SOURCE_RECORD_FORMAT,
    name: record.name,
    from: record.from,
    ...(record.ref === undefined ? {} : { ref: record.ref as string }),
    ...(record.commit === undefined ? {} : { commit: record.commit as string }),
    prepare: (record.prepare as string[][]).map((step) => [...step]),
    ...(record.preparedAt === undefined ? {} : { preparedAt: record.preparedAt as string }),
  }
}

/**
 * Read one provisioning record. A missing record is undefined; a malformed one
 * is also undefined so the caller re-provisions.
 * @param fs - the platform file-system service.
 * @param path - the absolute record path.
 * @returns the record, or undefined.
 */
export function readSourceRecord(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<SourceRecord | undefined, PlatformError.PlatformError> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(path))) return undefined
    const text = yield* fs.readFileString(path)
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (cause) => cause,
    }).pipe(Effect.result)
    return Result.isSuccess(parsed) ? decodeSourceRecord(parsed.success) : undefined
  })
}

/**
 * Write one provisioning record atomically, owner-only.
 * @param fs - the platform file-system service.
 * @param path - the absolute record path.
 * @param record - the record to write.
 * @returns an effect that succeeds after the rename.
 */
export function writeSourceRecord(
  fs: FileSystem.FileSystem,
  path: string,
  record: SourceRecord,
): Effect.Effect<void, PlatformError.PlatformError> {
  return Effect.gen(function* () {
    yield* fs.makeDirectory(dirname(path), { recursive: true })
    yield* writeFileAtomic(fs, path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  })
}
