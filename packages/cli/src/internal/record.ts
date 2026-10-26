/**
 * Tagged-error record narrowing for CLI diagnostics. Foreign JSON is read with
 * `internal/schema-readers`; this guard exists only to inspect an unknown
 * thrown value's `_tag` and fields without treating it as external data. It
 * accepts any non-null non-array object, including class instances; the config
 * package's prototype-strict guard is intentionally different.
 * @module @eedsh/cli/internal/record
 */
import * as Predicate from 'effect/Predicate'

/**
 * Read a caught tagged error as a record, when it is a non-null, non-array
 * object.
 * @param value - the value to narrow.
 * @returns the value as a record, or undefined when it is not one.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return Predicate.isObject(value) ? (value as Record<string, unknown>) : undefined
}
