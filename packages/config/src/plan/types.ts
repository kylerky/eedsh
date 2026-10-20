/**
 * Plan primitives and validation types. The format and version constants live
 * in `./constants.js`, and the plan types are derived from the public schema
 * in `./schema.js`.
 * @module @eedsh/config/plan/types
 */
import type { ProfilePlan } from './schema.js'

/** A JSON scalar. */
export type JsonPrimitive = string | number | boolean | null

/** A JSON value, including nested objects and arrays. */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

/** A JSON object with string keys. */
export type JsonObject = { [key: string]: JsonValue }

/** One validation failure with a stable code and a plan location. */
export interface PlanIssue {
  code: string
  path: string
  message: string
}

/** The result of validating an unknown value as a profile plan. */
export type PlanValidation = { ok: true; plan: ProfilePlan } | { ok: false; issues: PlanIssue[] }

/** Thrown by `defineProfile` and `assertPlan` when a plan is invalid. */
export class PlanValidationError extends Error {
  readonly issues: PlanIssue[]

  constructor(issues: PlanIssue[]) {
    const summary = issues
      .slice(0, 5)
      .map((issue) => `${issue.code} at ${issue.path}: ${issue.message}`)
      .join('; ')
    const more = issues.length > 5 ? ` (${issues.length - 5} more)` : ''
    super(`invalid eedsh profile plan: ${summary}${more}`)
    this.name = 'PlanValidationError'
    this.issues = issues
  }
}
