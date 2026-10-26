import {
  defineProfile,
  PLAN_FORMAT,
  PLAN_VERSION,
  type ProfilePlan,
  validatePlan,
} from '@eedsh/config'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as SchemaIssue from 'effect/SchemaIssue'
import { describe, expect, it } from 'vitest'
import { layer, plan } from '../support/plan'

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

function failureOf(value: unknown): Schema.SchemaError {
  const result = validatePlan(value)
  if (Result.isSuccess(result)) throw new Error('expected validation to fail')
  return result.failure
}

function successOf(value: unknown): ProfilePlan {
  const result = validatePlan(value)
  if (Result.isFailure(result)) throw new Error(result.failure.message)
  return result.success
}

function issuesOf(value: unknown) {
  return formatIssues(failureOf(value).issue).issues
}

describe('validatePlan', () => {
  it('returns a success value for a valid plan', () => {
    const result = validatePlan(plan())
    expect(Result.isSuccess(result)).toBe(true)
    const value = successOf(plan())
    expect(value.format).toBe(PLAN_FORMAT)
    expect(value.version).toBe(PLAN_VERSION)
    expect(value.profile.name).toBe('work')
  })

  it('fails with the native schema error', () => {
    const error = failureOf(plan({ dsh: 'latest' }))
    expect(Schema.isSchemaError(error)).toBe(true)
    expect(error).toBeInstanceOf(Error)
    expect(error._tag).toBe('SchemaError')
    expect(error.message.length).toBeGreaterThan(0)
    expect(SchemaIssue.isIssue(error.issue)).toBe(true)
  })

  it('reports located issues with the native message annotations', () => {
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
      expect(typeof issue.message).toBe('string')
      expect(issue.message.length).toBeGreaterThan(0)
    }
    expect(failureOf(plan({ dsh: 'latest' })).message).toContain('at [')
  })

  it('reports several violations together', () => {
    const error = failureOf(
      plan({
        dsh: 'latest',
        layers: [layer('Base')],
        packages: { '@eedsh/generated': 'link:./generated' },
      }),
    )
    const issues = formatIssues(error.issue).issues
    expect(issues.length).toBeGreaterThan(1)
    expect(error.message.split('\n').length).toBeGreaterThan(2)
  })

  it('rejects an undeclared field and identifies it', () => {
    const error = failureOf(plan({ unexpected: true }))
    expect(formatIssues(error.issue).issues.map((issue) => issue.path)).toContainEqual([
      'unexpected',
    ])
    expect(error.message).toContain('unexpected')
  })

  it('serializes through the native representation', () => {
    const error = failureOf(plan({ dsh: 'latest' }))
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      _tag: 'SchemaError',
      message: error.message,
    })
  })

  it('returns a detached plan', () => {
    const config = { nested: { enabled: true } }
    const input = plan({ layers: [layer('base', [{ id: 'row', config }])] })
    const value = successOf(input)
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
  it('returns the native failure Result synchronously', () => {
    const result = defineProfile({ name: '', dsh: '0.2.1-rc.2', bundles: [] })
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(Schema.isSchemaError(result.failure)).toBe(true)
      expect(result.failure).toBeInstanceOf(Error)
      expect(result.failure._tag).toBe('SchemaError')
      expect(SchemaIssue.isIssue(result.failure.issue)).toBe(true)
    }
    expect(result).not.toBeInstanceOf(Promise)
  })

  it('returns plain data synchronously for a valid plan', () => {
    const result = defineProfile({ name: 'work', dsh: '0.2.1-rc.2', bundles: [] })
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) {
      expect(result.success.format).toBe(PLAN_FORMAT)
      expect(result.success.profile.name).toBe('work')
    }
    expect(result).not.toBeInstanceOf(Promise)
  })
})
