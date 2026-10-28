/**
 * Effect-native plan validation. {@link validatePlan} is the strict decode
 * entry point and returns Effect's native result and schema error.
 * @module @eedsh/plan/validate
 */
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { type ProfilePlan, ProfilePlanSchema } from './schema'

const decode = Schema.decodeUnknownResult(ProfilePlanSchema, {
  errors: 'all',
  onExcessProperty: 'error',
})

/**
 * Validate an unknown value as a profile plan with the strict options the plan
 * contract needs: every issue is reported and undeclared fields are rejected.
 * Decoding the raw {@link ProfilePlanSchema} without these options is more
 * lenient, so frontends should use this entry point.
 * @param value - the candidate plan.
 * @returns the detached plan, or Effect's native schema error.
 */
export function validatePlan(value: unknown): Result.Result<ProfilePlan, Schema.SchemaError> {
  const decoded = decode(value)
  return Result.isFailure(decoded) ? decoded : Result.succeed(structuredClone(decoded.success))
}
