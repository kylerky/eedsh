import { type DefineProfileInput, defineProfile, type ProfilePlan } from '@eedsh/config'
import * as Result from 'effect/Result'

/**
 * Unwrap synchronous authoring for tests that need a plan value. Production
 * config modules export the Result directly; only tests need the unwrapped plan.
 */
export function planOf(input: DefineProfileInput): ProfilePlan {
  const result = defineProfile(input)
  if (Result.isFailure(result)) throw new Error(result.failure.message)
  return result.success
}
