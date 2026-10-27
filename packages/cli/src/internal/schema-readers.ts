/**
 * Schema-backed readers for foreign JSON. Tolerant readers keep the valid
 * siblings of a malformed array or record and fall back only at the boundary
 * they name; strict callers decode directly instead of using these helpers.
 * @module @eedsh/cli/internal/schema-readers
 */
import { Effect, Option, Schema } from 'effect'

/** One dependency entry in a pnpm lockfile importer. */
export interface LockfileEntry {
  readonly specifier: Option.Option<string>
  readonly version: Option.Option<string>
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
 * @returns the string, or None when it is missing or not a string.
 */
export function readOptionalString(value: unknown): Option.Option<string> {
  return decodeOption(Schema.String, value)
}

/**
 * Read a package version that may be absent.
 * @param value - the value to read.
 * @returns the version, or None when it is missing or not a string.
 */
export function readVersion(value: unknown): Option.Option<string> {
  return readOptionalString(value)
}

/**
 * Read one lockfile entry, keeping each valid field independently.
 * @param value - the value to read.
 * @returns the entry fields that decoded, with absent fields as None.
 */
export function readLockfileEntry(value: unknown): LockfileEntry {
  const record = readRecord(value)
  return {
    specifier: readOptionalString(record.specifier),
    version: readOptionalString(record.version),
  }
}
