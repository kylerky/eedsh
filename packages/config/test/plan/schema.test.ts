import {
  canonicalJson,
  hashPlan,
  PLAN_FORMAT,
  PLAN_VERSION,
  type ProfilePlan,
  ProfilePlanSchema,
} from '@eedsh/config'
import * as Either from 'effect/Either'
import * as ParseResult from 'effect/ParseResult'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

const bundle = (name: string) => ({ kind: 'bundle', name })
const layer = (id: string, patches: unknown[] = []) => ({ id, patches })

function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

/**
 * Decode through the public schema with the strict options a validator needs:
 * report every issue and reject keys the plan does not declare.
 */
const decode = Schema.decodeUnknownEither(ProfilePlanSchema, {
  errors: 'all',
  onExcessProperty: 'error',
})

function issuesOf(value: unknown): ReadonlyArray<ParseResult.ArrayFormatterIssue> {
  const result = decode(value)
  if (Either.isRight(result)) throw new Error('expected decoding to fail')
  return ParseResult.ArrayFormatter.formatErrorSync(result.left)
}

function pathsOf(value: unknown): ReadonlyArray<ReadonlyArray<PropertyKey>> {
  return issuesOf(value).map((issue) => issue.path)
}

describe('plan schema decoding', () => {
  it('decodes a minimal valid plan', () => {
    const result = decode(plan())
    expect(Either.isRight(result)).toBe(true)
    if (Either.isLeft(result)) return
    const value = result.right
    expect(value.format).toBe(PLAN_FORMAT)
    expect(value.version).toBe(PLAN_VERSION)
    expect(value.profile).toEqual({ name: 'work' })
    expect(value.dsh).toBe('0.2.1-rc.2')
    expect(value.bundles).toEqual([bundle('@deepseek-ai/dsh-base')])
    expect(value.layers).toEqual([])
    expect(value.packages).toEqual({})
  })

  it('decodes nested bundles, layers, patches, and packages', () => {
    const result = decode(
      plan({
        bundles: [bundle('@deepseek-ai/dsh-base'), { kind: 'generated' }, bundle('@scope/extra')],
        layers: [
          layer('base', [
            { insert: [{ id: 'timer', name: '@scope/timer' }] },
            { id: 'agent-default-model', config: { provider: 'deepseek' } },
          ]),
        ],
        packages: { '@scope/plugin': 'link:../plugin' },
      }),
    )
    expect(Either.isRight(result)).toBe(true)
    if (Either.isLeft(result)) return
    expect(result.right.layers[0]?.id).toBe('base')
    expect(result.right.layers[0]?.patches).toHaveLength(2)
    expect(result.right.packages).toEqual({ '@scope/plugin': 'link:../plugin' })
  })

  it('rejects wrong field types and identifies the field', () => {
    const cases: ReadonlyArray<[Record<string, unknown>, ReadonlyArray<PropertyKey>]> = [
      [{ version: '1' }, ['version']],
      [{ dsh: 1 }, ['dsh']],
      [{ layers: {} }, ['layers']],
      [{ profile: { name: 42 } }, ['profile', 'name']],
      [{ bundles: [{ kind: 'bundle', name: 'x', source: 3 }] }, ['bundles', 0, 'source']],
      [{ packages: { '@scope/plugin': 1 } }, ['packages', '@scope/plugin']],
    ]
    for (const [overrides, path] of cases) {
      const issues = issuesOf(plan(overrides))
      expect(issues.length).toBeGreaterThan(0)
      expect(issues.map((issue) => issue.path)).toContainEqual(path)
      expect(issues.every((issue) => issue.message.length > 0)).toBe(true)
    }
  })

  it('rejects unknown plan fields at every level', () => {
    const cases: ReadonlyArray<[Record<string, unknown>, ReadonlyArray<PropertyKey>]> = [
      [{ extra: true }, ['extra']],
      [{ profile: { name: 'work', extra: true } }, ['profile', 'extra']],
      [{ bundles: [{ kind: 'bundle', name: 'x', extra: true }] }, ['bundles', 0, 'extra']],
      [{ layers: [{ id: 'base', patches: [], extra: true }] }, ['layers', 0, 'extra']],
    ]
    for (const [overrides, path] of cases) {
      const issues = issuesOf(plan(overrides))
      expect(pathsOf(plan(overrides))).toContainEqual(path)
      expect(issues.some((issue) => issue._tag === 'Unexpected')).toBe(true)
    }
  })

  it('rejects missing required fields with their location', () => {
    const withoutDsh = plan()
    delete withoutDsh.dsh
    const withoutBundles = plan()
    delete withoutBundles.bundles
    const cases: ReadonlyArray<[Record<string, unknown>, ReadonlyArray<PropertyKey>]> = [
      [withoutDsh, ['dsh']],
      [withoutBundles, ['bundles']],
      [{ profile: {} }, ['profile', 'name']],
      [{ layers: [{ patches: [] }] }, ['layers', 0, 'id']],
    ]
    for (const [value, path] of cases) {
      const issues = issuesOf(value)
      expect(issues.map((issue) => issue.path)).toContainEqual(path)
      expect(issues.some((issue) => issue._tag === 'Missing' || issue._tag === 'Type')).toBe(true)
    }
  })
})

describe('canonical plan hashing', () => {
  it('sorts object keys', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
  })

  it('is stable across key insertion order and changes with content', () => {
    const left = decodeOrThrow(plan({ packages: { alpha: '1.0.0', beta: '2.0.0' } }))
    const right = decodeOrThrow(plan({ packages: { beta: '2.0.0', alpha: '1.0.0' } }))
    expect(hashPlan(left)).toBe(hashPlan(right))
    const changed = decodeOrThrow(plan({ dsh: '0.2.2-rc.1' }))
    expect(hashPlan(changed)).not.toBe(hashPlan(left))
  })

  it('produces a 64-character hex digest', () => {
    expect(hashPlan(decodeOrThrow(plan()))).toMatch(/^[0-9a-f]{64}$/)
  })
})

function decodeOrThrow(value: unknown): ProfilePlan {
  return Either.getOrThrow(decode(value))
}

describe('profile plan typing', () => {
  it('exposes the derived plan shape through the public type', () => {
    const value: ProfilePlan['profile'] = { name: 'work' }
    expect(value.name).toBe('work')
  })
})
