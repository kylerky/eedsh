import type { PlanIssue, PlanPatch, ProfilePlan } from '@eedsh/config'
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

  it('exposes native ArrayFormatter issues through the public issue type', () => {
    const issue: PlanIssue = { _tag: 'Type', path: ['dsh'], message: 'bad' }
    expect(issue.path).toEqual(['dsh'])
    expect(issue._tag).toBe('Type')
  })
})
