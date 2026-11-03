import {
  PLAN_FORMAT,
  PLAN_VERSION,
  type PlanSource,
  type ProfilePlan,
  validatePlan,
} from '@eedsh/plan'
import * as Result from 'effect/Result'

/** A profile plan input for tests that need a plan value directly. */
export interface TestPlanInput {
  name: string
  bundles?: readonly unknown[]
  layers?: readonly unknown[]
  packages?: Readonly<Record<string, string>>
  sources?: Readonly<Record<string, PlanSource>>
}

/**
 * Build and validate a plan value. Production configs author descriptors and a
 * config envelope; tests that exercise one plan build the plan document here.
 * @param input - profile identity and plan content.
 * @returns the validated plan.
 */
export function planOf(input: TestPlanInput): ProfilePlan {
  const result = validatePlan({
    format: PLAN_FORMAT,
    version: PLAN_VERSION,
    profile: { name: input.name },
    bundles: input.bundles ?? [],
    layers: input.layers ?? [],
    packages: input.packages ?? {},
    ...(input.sources === undefined ? {} : { sources: input.sources }),
  })
  if (Result.isFailure(result)) throw new Error(result.failure.message)
  return result.success
}
