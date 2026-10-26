import {
  bundle,
  defineProfile,
  disable,
  enable,
  generated,
  group,
  insert,
  js,
  layer,
  override,
  PLAN_FORMAT,
  PLAN_VERSION,
  raw,
  type DefineProfileInput,
  type ProfilePlan,
  validatePlan,
} from '@eedsh/config'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as SchemaIssue from 'effect/SchemaIssue'
import { describe, expect, it } from 'vitest'

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

function issuesOf(error: unknown) {
  return formatIssues((error as Schema.SchemaError).issue).issues
}

function planOf(input: DefineProfileInput): ProfilePlan {
  const result = defineProfile(input)
  if (Result.isFailure(result)) throw new Error(result.failure.message)
  return result.success
}

function failureOf(input: DefineProfileInput): Schema.SchemaError {
  const result = defineProfile(input)
  if (Result.isSuccess(result)) throw new Error('expected authoring to fail')
  return result.failure
}

const base = { name: 'work', dsh: '0.2.1-rc.2' }

describe('defineProfile', () => {
  it('produces a validated plan with defaults', () => {
    const plan = planOf({ ...base, bundles: [bundle('@deepseek-ai/dsh-base')] })
    expect(plan).toMatchObject({
      format: PLAN_FORMAT,
      version: PLAN_VERSION,
      profile: { name: 'work' },
      dsh: '0.2.1-rc.2',
      layers: [],
      packages: {},
    })
    expect(plan.bundles).toEqual([{ kind: 'bundle', name: '@deepseek-ai/dsh-base' }])
  })

  it('preserves the positional generated marker', () => {
    const plan = planOf({
      ...base,
      bundles: [bundle('first'), generated(), bundle('second')],
    })
    expect(plan.bundles).toEqual([
      { kind: 'bundle', name: 'first' },
      { kind: 'generated' },
      { kind: 'bundle', name: 'second' },
    ])
  })

  it('returns a failure Result for a missing profile name', () => {
    const error = failureOf({ name: '', dsh: base.dsh, bundles: [] })
    expect(Schema.isSchemaError(error)).toBe(true)
    expect(issuesOf(error).map((issue) => issue.path)).toContainEqual(['profile', 'name'])
  })

  it('rejects reserved bundle names', () => {
    for (const name of ['@eedsh/runtime', '@eedsh/generated']) {
      const error = failureOf({ ...base, bundles: [bundle(name)] })
      const issues = issuesOf(error)
      expect(issues.map((issue) => issue.path)).toContainEqual(['bundles', 0, 'name'])
      expect(issues.some((issue) => issue.message.includes('owned by the materializer'))).toBe(
        true,
      )
    }
  })

  it('rejects reserved package names', () => {
    const error = failureOf({
      ...base,
      bundles: [],
      packages: { '@eedsh/generated': 'link:./x' },
    })
    expect(issuesOf(error).map((issue) => issue.path)).toContainEqual(['packages', '@eedsh/generated'])
  })

  it('rejects duplicate generated markers', () => {
    const error = failureOf({ ...base, bundles: [generated(), generated()] })
    expect(issuesOf(error).some((issue) => issue.message.includes('generated marker'))).toBe(true)
  })

  it('accepts expression nodes in layer config', () => {
    const plan = planOf({
      ...base,
      bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
      layers: [
        layer('base', [
          override('plugin-manager', { selected: js("ctx.get('profileContext').name") }),
        ]),
      ],
    })
    const parsed = JSON.parse(JSON.stringify(plan))
    expect(parsed.layers[0].patches[0].config.selected).toEqual({
      $eedsh: { expr: "ctx.get('profileContext').name" },
    })
    expect(Result.isSuccess(validatePlan(parsed))).toBe(true)
  })

  it('returns a Promise-free Result and exposes no throwing helper', async () => {
    const result = defineProfile({ ...base, bundles: [] })
    expect(Result.isSuccess(result)).toBe(true)
    expect(result).not.toBeInstanceOf(Promise)
    const module = await import('@eedsh/config')
    expect('assertPlan' in module).toBe(false)
  })
})

describe('patch helpers', () => {
  it('insert accepts one entry or many', () => {
    const one = insert({ id: 'row', name: '@scope/plugin' })
    expect(one).toEqual({ insert: [{ id: 'row', name: '@scope/plugin' }] })
    const many = insert([
      { id: 'a', name: 'a' },
      { id: 'b', name: 'b' },
    ])
    expect(many).toEqual({
      insert: [
        { id: 'a', name: 'a' },
        { id: 'b', name: 'b' },
      ],
    })
  })

  it('override replaces the whole config without merging', () => {
    const patch = override('agent-default-model', { provider: 'x', model: 'y' })
    expect(patch).toEqual({
      id: 'agent-default-model',
      config: { provider: 'x', model: 'y' },
    })
    expect(Object.keys(patch)).toEqual(['id', 'config'])
  })

  it('disable and enable are disabled patches', () => {
    expect(disable('row')).toEqual({ id: 'row', disabled: true })
    expect(enable('row')).toEqual({ id: 'row', disabled: false })
  })

  it('group keeps the group flag, isolate map, and ordered children', () => {
    const entry = group(
      'group-row',
      { isolate: { label: { color: 'red' } }, name: '@scope/group' },
      [
        { id: 'child-a', name: 'a' },
        { id: 'child-b', name: 'b' },
      ],
    )
    expect(entry).toEqual({
      id: 'group-row',
      isolate: { label: { color: 'red' } },
      name: '@scope/group',
      group: true,
      config: [
        { id: 'child-a', name: 'a' },
        { id: 'child-b', name: 'b' },
      ],
    })
  })

  it('group entries can be inserted', () => {
    const patch = insert(group('group-row', {}, [{ id: 'child', name: 'child' }]))
    expect(patch).toEqual({
      insert: [
        {
          id: 'group-row',
          group: true,
          config: [{ id: 'child', name: 'child' }],
        },
      ],
    })
  })

  it('js builds the reserved expression node', () => {
    expect(js("ctx.get('profileContext') !== undefined")).toEqual({
      $eedsh: { expr: "ctx.get('profileContext') !== undefined" },
    })
  })

  it('raw preserves additional Loader patch fields', () => {
    const entry = raw({
      id: 'row',
      name: '@scope/plugin',
      inject: ['service'],
      extra: { a: 1 },
    })
    expect(entry).toEqual({
      id: 'row',
      name: '@scope/plugin',
      inject: ['service'],
      extra: { a: 1 },
    })
  })

  it('layer keeps patch order', () => {
    const value = layer('ordered', [disable('a'), enable('a'), override('b', { on: true })])
    expect(value.id).toBe('ordered')
    expect(value.patches.map((patch) => Object.keys(patch)[0])).toEqual(['id', 'id', 'id'])
    expect(value.patches[2]).toEqual({ id: 'b', config: { on: true } })
  })
})
