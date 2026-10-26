/**
 * The prototype-strict object guard used at the plan and JSON boundaries. It
 * is deliberately stronger than the CLI's record guard: class instances and
 * other non-plain objects must be rejected before schema decoding.
 * @module @eedsh/config/plan/plain-object
 */

/**
 * Whether a value is a plain JSON-style object.
 * @param value - the value to check.
 * @returns whether it is non-null, non-array, and has Object.prototype or null.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
