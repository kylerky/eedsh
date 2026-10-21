/**
 * Effect-native plan validation. {@link decodePlan} is the strict single decode
 * entry point, {@link validatePlan} turns its failure into a tagged error with
 * located ArrayFormatter issues, and {@link assertPlan} is the synchronous
 * authoring boundary.
 * @module @eedsh/config/plan/validate
 */
import * as Either from 'effect/Either'
import * as ParseResult from 'effect/ParseResult'
import * as Schema from 'effect/Schema'
import { type ProfilePlan, ProfilePlanSchema } from './schema'
import { type PlanIssue, PlanValidationError } from './types'

const decode = Schema.decodeUnknownEither(ProfilePlanSchema, {
  errors: 'all',
  onExcessProperty: 'error',
})

/**
 * Decode an unknown value as a profile plan with the strict options the plan
 * contract needs: every issue is reported and undeclared fields are rejected.
 * Decoding the raw {@link ProfilePlanSchema} without these options is more
 * lenient, so frontends should use this entry point.
 * @param value - the candidate plan.
 * @returns the decoded plan, or Effect's native parse error.
 */
export function decodePlan(value: unknown): Either.Either<ProfilePlan, ParseResult.ParseError> {
  return decode(value)
}

function describePath(path: ReadonlyArray<PropertyKey>): string {
  let text = ''
  for (const segment of path) {
    if (typeof segment === 'number') text += `[${segment}]`
    else text += text === '' ? String(segment) : `.${String(segment)}`
  }
  return text
}

function summarize(issues: readonly PlanIssue[]): string {
  if (issues.length === 0) return 'invalid eedsh profile plan'
  const shown = issues
    .slice(0, 5)
    .map((issue) => {
      const location = describePath(issue.path)
      return location === '' ? issue.message : `${location}: ${issue.message}`
    })
    .join('; ')
  const more = issues.length > 5 ? ` (${issues.length - 5} more)` : ''
  return `invalid eedsh profile plan: ${shown}${more}`
}

function dedupe(issues: readonly PlanIssue[]): PlanIssue[] {
  const seen = new Set<string>()
  const unique: PlanIssue[] = []
  for (const issue of issues) {
    const key = JSON.stringify([issue._tag, issue.path, issue.message])
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(issue)
  }
  return unique
}

/**
 * Validate an unknown value as a profile plan.
 * @param value - the candidate plan.
 * @returns the detached plan, or a tagged error carrying located issues.
 */
export function validatePlan(value: unknown): Either.Either<ProfilePlan, PlanValidationError> {
  const decoded = decodePlan(value)
  if (Either.isLeft(decoded)) {
    const issues = dedupe(ParseResult.ArrayFormatter.formatErrorSync(decoded.left))
    return Either.left(new PlanValidationError({ issues, message: summarize(issues) }))
  }
  return Either.right(structuredClone(decoded.right))
}

/**
 * Validate and return a detached plan, or throw the tagged error.
 * @param value - the candidate plan.
 * @returns the validated plan.
 * @throws {PlanValidationError} when the plan is invalid.
 */
export function assertPlan(value: unknown): ProfilePlan {
  const result = validatePlan(value)
  if (Either.isLeft(result)) throw result.left
  return result.right
}
