import {
  type DefineProfileInput,
  defineProfile,
  type PlanPatch,
  type ProfileDefinition,
  type ProfilePlan,
  validatePlan,
} from '@eedsh/config'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

/**
 * Compile-time assertions. The function is never called; the
 * `@ts-expect-error` directives must be used, or typecheck fails.
 */
function assertDerivedShape(plan: ProfilePlan, patch: PlanPatch): void {
  // @ts-expect-error plan properties are readonly
  plan.profile = { name: 'other' }
  // @ts-expect-error plan arrays are readonly
  plan.layers = []
  // @ts-expect-error layer properties are readonly
  plan.layers[0]!.id = 'other'
  // @ts-expect-error patch entries are readonly
  patch.id = 'other'
  // @ts-expect-error patch payloads are opaque values
  patch.config.selected
  // @ts-expect-error a readonly plan is not assignable to a mutable plan shape
  const mutable: { dsh: string; layers: { id: string; patches: unknown[] }[] } = plan
  void mutable
}
void assertDerivedShape

/** The public validation signature carries Effect's native Result and SchemaError. */
const validateSignature: (value: unknown) => Result.Result<ProfilePlan, Schema.SchemaError> =
  validatePlan
void validateSignature

/** Authoring returns a detached descriptor synchronously. */
const defineSignature: (input: DefineProfileInput) => ProfileDefinition = defineProfile
void defineSignature

describe('derived plan types', () => {
  it('derives the public plan from the schema', () => {
    const value: ProfilePlan = {
      format: 'eedsh/profile-plan',
      version: 1,
      profile: { name: 'work' },
      dsh: '0.2.1-rc.2',
      bundles: [{ kind: 'generated' }],
      layers: [],
      packages: {},
    }
    expect(value.profile.name).toBe('work')
  })

  it('fails with a native schema error', () => {
    const result = validatePlan({})
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(Schema.isSchemaError(result.failure)).toBe(true)
      expect(result.failure._tag).toBe('SchemaError')
    }
  })
})
