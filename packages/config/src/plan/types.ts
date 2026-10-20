/**
 * The versioned profile plan: a JSON-compatible projection of DSH's Loader
 * layer model. The plan is the contract between the typed authoring API and
 * the materializer; it contains no executable values.
 * @module @eedsh/config/plan/types
 */

/** Stable plan format identifier written into every plan. */
export const PLAN_FORMAT = 'eedsh/profile-plan'

/** Plan schema version; bumped only when the plan shape changes incompatibly. */
export const PLAN_VERSION = 1 as const

/** A JSON scalar. */
export type JsonPrimitive = string | number | boolean | null

/** A JSON value, including nested objects and arrays. */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

/** A JSON object with string keys. */
export type JsonObject = { [key: string]: JsonValue }

/**
 * A runtime expression: structured data carrying source text that DSH
 * evaluates at Loader activation. The plan stores this shape, never a
 * function; the emitter turns it into a YAML `!!js` scalar.
 */
export type ExpressionNode = {
  $eedsh: { expr: string }
}

/** A selected bundle, in authored order. */
export interface NamedBundle {
  kind: 'bundle'
  name: string
  /** Optional package specifier override for profile-local resolution. */
  source?: string
}

/** The positional marker for the generated bundle layer. */
export interface GeneratedBundle {
  kind: 'generated'
}

/** An ordered bundle selection or the single generated-layer marker. */
export type PlanBundle = NamedBundle | GeneratedBundle

/** One Loader patch entry, as JSON data. */
export type PlanPatch = JsonObject

/** An ordered list of patches sharing one layer id. */
export interface PlanLayer {
  /** Safe kebab-case identifier; also the emitted patch file name. */
  id: string
  /** Patches applied in order. */
  patches: PlanPatch[]
}

/** The validated profile plan. */
export interface ProfilePlan {
  format: typeof PLAN_FORMAT
  version: typeof PLAN_VERSION
  profile: { name: string }
  /** The exact DSH runtime pin the plan was authored against. */
  dsh: string
  /** Ordered bundle selections, optionally containing the generated marker. */
  bundles: PlanBundle[]
  /** Ordered generated patch layers. */
  layers: PlanLayer[]
  /** Profile-local package dependencies. */
  packages: Record<string, string>
}

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
