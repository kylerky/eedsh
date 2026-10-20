import {
  canonicalJson,
  hashPlan,
  PLAN_FORMAT,
  PLAN_VERSION,
  type ProfilePlan,
  validatePlan,
} from '@eedsh/config'
import { describe, expect, it } from 'vitest'

const bundle = (name: string) => ({ kind: 'bundle', name })
const layer = (id: string, patches: unknown[] = []) => ({ id, patches })

function plan(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    format: PLAN_FORMAT,
    version: PLAN_VERSION,
    profile: { name: 'work' },
    dsh: '0.2.1-rc.2',
    bundles: [bundle('@deepseek-ai/dsh-base')],
    layers: [],
    packages: {},
    ...overrides,
  }
}

function issuesOf(value: unknown) {
  const result = validatePlan(value)
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected validation to fail')
  return result.issues
}

describe('profile plan validation', () => {
  it('accepts a minimal plan', () => {
    const result = validatePlan(plan())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.profile.name).toBe('work')
    expect(result.plan.dsh).toBe('0.2.1-rc.2')
    expect(result.plan.layers).toEqual([])
    expect(result.plan.packages).toEqual({})
  })

  it('round-trips a plan with nested config and expressions through JSON', () => {
    const original = plan({
      layers: [
        layer('base', [
          {
            insert: [
              {
                id: 'agent-default-model',
                name: '@deepseek-ai/dsh-agent-default-model',
                config: {
                  nested: { deep: [1, 2, { ok: true }] },
                  model: { $eedsh: { expr: "ctx.get('profileContext').name" } },
                },
              },
            ],
          },
        ]),
      ],
    })
    const parsed = JSON.parse(JSON.stringify(original))
    expect(parsed).toEqual(original)
    const result = validatePlan(parsed)
    expect(result.ok).toBe(true)
  })

  it('rejects a function value and names its location', () => {
    const issues = issuesOf(
      plan({
        layers: [layer('base', [{ id: 'timer', config: { fn: () => 1 } }])],
      }),
    )
    expect(issues.map((issue) => issue.code)).toContain('plan.unsupported_value')
    expect(issues.some((issue) => issue.path.includes('layers[0].patches[0].config.fn'))).toBe(true)
  })

  it('rejects a circular value', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const issues = issuesOf(plan({ layers: [layer('base', [{ id: 'timer', config: circular }])] }))
    expect(issues.map((issue) => issue.code)).toContain('plan.unsupported_value')
  })

  it('rejects a missing profile name', () => {
    const issues = issuesOf(plan({ profile: {} }))
    expect(issues.map((issue) => issue.code)).toContain('plan.missing_profile_name')
  })

  it('rejects empty, unsafe, and duplicate layer ids', () => {
    expect(issuesOf(plan({ layers: [layer('')] })).map((issue) => issue.code)).toContain(
      'plan.empty_layer_id',
    )
    expect(issuesOf(plan({ layers: [layer('../escape')] })).map((issue) => issue.code)).toContain(
      'plan.unsafe_layer_id',
    )
    const duplicateIssues = issuesOf(plan({ layers: [layer('base'), layer('base')] }))
    expect(duplicateIssues.map((issue) => issue.code)).toContain('plan.duplicate_layer_id')
    expect(duplicateIssues.some((issue) => issue.path === 'layers[1].id')).toBe(true)
  })

  it('rejects malformed expression nodes', () => {
    for (const value of [
      { $eedsh: { expr: 42 } },
      { $eedsh: { expr: 'ok', extra: true } },
      { $eedsh: 'not-an-expression' },
      { $eedsh: { expr: 'ok' }, sibling: true },
    ]) {
      const issues = issuesOf(plan({ layers: [layer('base', [{ id: 'timer', config: value }])] }))
      expect(issues.map((issue) => issue.code)).toContain('plan.invalid_expression')
    }
  })

  it('accepts a well-formed expression node', () => {
    const issues = validatePlan(
      plan({
        layers: [
          layer('base', [
            { id: 'timer', config: { $eedsh: { expr: "!ctx.get('profileContext')" } } },
          ]),
        ],
      }),
    )
    expect(issues.ok).toBe(true)
  })

  it('rejects duplicate generated markers', () => {
    const issues = issuesOf(
      plan({
        bundles: [bundle('@deepseek-ai/dsh-base'), { kind: 'generated' }, { kind: 'generated' }],
      }),
    )
    expect(issues.map((issue) => issue.code)).toContain('plan.duplicate_generated_marker')
  })

  it('preserves bundle order including the generated marker', () => {
    const bundles = [bundle('first'), { kind: 'generated' }, bundle('second')]
    const result = validatePlan(plan({ bundles }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.bundles).toEqual(bundles)
  })
})

describe('canonical plan hashing', () => {
  it('sorts object keys', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
  })

  it('is stable across key insertion order and changes with content', () => {
    const left = plan({ packages: { alpha: '1.0.0', beta: '2.0.0' } })
    const right = plan({ packages: { beta: '2.0.0', alpha: '1.0.0' } })
    const validatedLeft = validatePlan(left)
    const validatedRight = validatePlan(right)
    expect(validatedLeft.ok && validatedRight.ok).toBe(true)
    if (!validatedLeft.ok || !validatedRight.ok) return
    expect(hashPlan(validatedLeft.plan)).toBe(hashPlan(validatedRight.plan))
    const changed = validatePlan(plan({ dsh: '0.2.2-rc.1' }))
    expect(changed.ok).toBe(true)
    if (!changed.ok) return
    expect(hashPlan(changed.plan)).not.toBe(hashPlan(validatedLeft.plan))
  })

  it('produces a 64-character hex digest', () => {
    const validated = validatePlan(plan())
    expect(validated.ok).toBe(true)
    if (!validated.ok) return
    expect(hashPlan(validated.plan)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('profile plan typing', () => {
  it('exposes the plan shape through the public type', () => {
    const value: ProfilePlan['profile'] = { name: 'work' }
    expect(value.name).toBe('work')
  })
})
