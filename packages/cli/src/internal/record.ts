/**
 * Record narrowing shared by CLI modules that read foreign JSON and tagged
 * errors. The guard accepts any non-null non-array object, including class
 * instances; the config package's prototype-strict guard is intentionally
 * different.
 * @module @eedsh/cli/internal/record
 */
import * as Predicate from 'effect/Predicate'

/**
 * Read a value as a record, when it is a non-null, non-array object.
 * @param value - the value to narrow.
 * @returns the value as a record, or undefined when it is not one.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return Predicate.isObject(value) ? (value as Record<string, unknown>) : undefined
}
