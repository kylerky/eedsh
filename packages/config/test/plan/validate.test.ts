import {
  defineProfile,
  PLAN_FORMAT,
  PLAN_VERSION,
  type PlanIssue,
  PlanValidationError,
  validatePlan,
} from '@eedsh/config'
import * as Either from 'effect/Either'
import type * as ParseResult from 'effect/ParseResult'
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

function leftOf(value: unknown): PlanValidationError {
  const result = validatePlan(value)
  if (Either.isRight(result)) throw new Error('expected validation to fail')
  return result.left
}

function issuesOf(value: unknown): readonly PlanIssue[] {
  return leftOf(value).issues
}

function rightOf(value: unknown) {
  const result = validatePlan(value)
  if (Either.isLeft(result)) throw new Error(result.left.message)
  return result.right
}

describe('validatePlan', () => {
  it('returns a right value for a valid plan', () => {
    const result = validatePlan(plan())
    expect(Either.isRight(result)).toBe(true)
    const value = Either.getOrThrow(result)
    expect(value.format).toBe(PLAN_FORMAT)
    expect(value.version).toBe(PLAN_VERSION)
    expect(value.profile.name).toBe('work')
  })

  it('returns a tagged validation error for an invalid plan', () => {
    const error = leftOf(plan({ dsh: 'latest' }))
    expect(error).toBeInstanceOf(PlanValidationError)
    expect(error).toBeInstanceOf(Error)
    expect(error._tag).toBe('PlanValidationError')
    expect(error.message).toContain('invalid eedsh profile plan')
    expect(Array.isArray(error.issues)).toBe(true)
  })

  it('reports ArrayFormatter issues with a tag, a path array, a message, and no code', () => {
    const issues = issuesOf(plan({ layers: [layer('base', [{ insert: [{ id: 'row' }] }])] }))
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.map((issue) => issue.path)).toContainEqual([
      'layers',
      0,
      'patches',
      0,
      'insert',
      0,
    ])
    for (const issue of issues) {
      const native: ParseResult.ArrayFormatterIssue = issue
      expect(typeof native._tag).toBe('string')
      expect(Array.isArray(native.path)).toBe(true)
      expect(typeof native.message).toBe('string')
      expect(native.message.length).toBeGreaterThan(0)
      expect('code' in native).toBe(false)
    }
  })

  it('deduplicates identical issues from union branches', () => {
    const issues = issuesOf(plan({ bundles: [{}] }))
    const keys = issues.map((issue) => JSON.stringify([issue._tag, issue.path, issue.message]))
    expect(new Set(keys).size).toBe(keys.length)
    const kindIssues = issues.filter(
      (issue) => JSON.stringify(issue.path) === JSON.stringify(['bundles', 0, 'kind']),
    )
    expect(kindIssues).toHaveLength(1)
  })

  it('returns a detached plan', () => {
    const config = { nested: { enabled: true } }
    const input = plan({ layers: [layer('base', [{ id: 'row', config }])] })
    const value = rightOf(input)
    expect(value).not.toBe(input)
    expect(value.layers[0]?.patches[0]?.config).not.toBe(config)
    config.nested.enabled = false
    const detached = value.layers[0]?.patches[0]?.config as {
      nested: { enabled: boolean }
    }
    expect(detached.nested.enabled).toBe(true)
  })

  it('uses an empty path array for a root failure', () => {
    const issues = issuesOf('not-a-plan')
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.map((issue) => issue.path)).toContainEqual([])
  })
})

describe('defineProfile authoring boundary', () => {
  it('throws the tagged error synchronously', () => {
    expect(() => defineProfile({ name: '', dsh: '0.2.1-rc.2', bundles: [] })).toThrow(
      PlanValidationError,
    )
    try {
      defineProfile({ name: '', dsh: '0.2.1-rc.2', bundles: [] })
    } catch (error) {
      expect(error).toBeInstanceOf(PlanValidationError)
      expect((error as PlanValidationError)._tag).toBe('PlanValidationError')
      expect(Array.isArray((error as PlanValidationError).issues)).toBe(true)
    }
  })

  it('returns plain data synchronously for a valid plan', () => {
    const value = defineProfile({ name: 'work', dsh: '0.2.1-rc.2', bundles: [] })
    expect(value.format).toBe(PLAN_FORMAT)
    expect(value.profile.name).toBe('work')
    expect(value).not.toBeInstanceOf(Promise)
  })
})
