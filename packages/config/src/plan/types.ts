/**
 * Plan primitives and Effect-native validation types. The format and version
 * constants live in `./constants.js`, and the plan types are derived from the
 * public schema in `./schema.js`.
 * @module @eedsh/config/plan/types
 */
import { TaggedError } from 'effect/Data'
import type { ArrayFormatterIssue } from 'effect/ParseResult'

/** A JSON scalar. */
export type JsonPrimitive = string | number | boolean | null

/** A JSON value, including nested objects and arrays. */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

/** A JSON object with string keys. */
export type JsonObject = { [key: string]: JsonValue }

/** One located validation issue, as Effect's ArrayFormatter reports it. */
export type PlanIssue = ArrayFormatterIssue

/** Thrown by `defineProfile` and `assertPlan` when a plan is invalid. */
export class PlanValidationError extends TaggedError('PlanValidationError')<{
  readonly issues: readonly PlanIssue[]
  readonly message: string
}> {}
