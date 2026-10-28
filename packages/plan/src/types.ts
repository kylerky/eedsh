/**
 * Plan primitives. The format and version constants live in `./constants.js`,
 * and the plan types are derived from the public schema in `./schema.js`.
 * @module @eedsh/plan/types
 */

/** A JSON scalar. */
export type JsonPrimitive = string | number | boolean | null

/** A JSON value, including nested objects and arrays. */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

/** A JSON object with string keys. */
export type JsonObject = { [key: string]: JsonValue }
