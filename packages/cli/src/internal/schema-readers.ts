/**
 * Schema-backed readers for foreign JSON. Tolerant readers keep the valid
 * siblings of a malformed array or record and fall back only at the boundary
 * they name; strict callers decode directly instead of using these helpers.
 * @module @eedsh/cli/internal/schema-readers
 */
import { Effect, Option, Schema } from 'effect'

/** One dependency entry in a pnpm lockfile importer. */
export interface LockfileEntry {
  readonly specifier?: string
  readonly version?: string
}

/**
 * Wrap a schema with its named fallback. The fallback applies only when the
 * whole value fails to decode; inner schemas may recover individual entries.
 */
function tolerant<A>(schema: Schema.Codec<A>, fallback: A): Schema.Codec<A> {
  return schema.pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(fallback))))
}

/** A string element whose wrong or absent value is dropped by its container. */
const lenientString = tolerant(Schema.UndefinedOr(Schema.String), undefined)

const stringArraySchema = tolerant(Schema.Array(lenientString), [])
const stringRecordSchema = tolerant(Schema.Record(Schema.String, lenientString), {})
const recordSchema = tolerant(Schema.Record(Schema.String, Schema.Unknown), {})
const optionalStringSchema = tolerant(Schema.optional(Schema.String), undefined)

function decodeOption<A>(schema: Schema.Codec<A>, value: unknown): Option.Option<A> {
  return Schema.decodeUnknownOption(schema)(value)
}

/**
 * Read a string array, dropping every non-string entry.
 * @param value - the value to read.
 * @returns the string entries, or an empty array when the value is not an array.
 */
export function readStringArray(value: unknown): string[] {
  const decoded = decodeOption(stringArraySchema, value)
  if (Option.isNone(decoded)) return []
  return decoded.value.filter((item): item is string => item !== undefined)
}

/**
 * Read a string record, dropping every non-string value.
 * @param value - the value to read.
 * @returns the string entries, or an empty record when the value is not an object.
 */
export function readStringRecord(value: unknown): Record<string, string> {
  const decoded = decodeOption(stringRecordSchema, value)
  if (Option.isNone(decoded)) return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(decoded.value)) {
    if (item !== undefined) out[key] = item
  }
  return out
}

/**
 * Read a record with arbitrary values.
 * @param value - the value to read.
 * @returns the record, or an empty record when the value is not an object.
 */
export function readRecord(value: unknown): Record<string, unknown> {
  const decoded = decodeOption(recordSchema, value)
  if (Option.isNone(decoded)) return {}
  return { ...decoded.value }
}

/**
 * Read a string that may be absent.
 * @param value - the value to read.
 * @returns the string, or undefined when it is missing or not a string.
 */
export function readOptionalString(value: unknown): string | undefined {
  const decoded = decodeOption(optionalStringSchema, value)
  return Option.isSome(decoded) ? decoded.value : undefined
}

/**
 * Read a package version with the caller's fallback.
 * @param value - the value to read.
 * @param fallback - the version to use when the value is missing or not a string.
 * @returns the version, or the fallback.
 */
export function readVersion(value: unknown, fallback: string): string {
  const decoded = decodeOption(tolerant(Schema.String, fallback), value)
  return Option.isSome(decoded) ? decoded.value : fallback
}

/**
 * Read one lockfile entry, keeping each valid field independently.
 * @param value - the value to read.
 * @returns the entry fields that decoded, or an empty entry for a non-object.
 */
export function readLockfileEntry(value: unknown): LockfileEntry {
  const record = readRecord(value)
  const specifier = readOptionalString(record.specifier)
  const version = readOptionalString(record.version)
  return {
    ...(specifier === undefined ? {} : { specifier }),
    ...(version === undefined ? {} : { version }),
  }
}
