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
  PlanValidationError,
  raw,
  validatePlan,
} from '@eedsh/config'
import * as Either from 'effect/Either'
import { describe, expect, it } from 'vitest'

const base = { name: 'work', dsh: '0.2.1-rc.2' }

describe('defineProfile', () => {
  it('produces a validated plan with defaults', () => {
    const plan = defineProfile({ ...base, bundles: [bundle('@deepseek-ai/dsh-base')] })
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
    const plan = defineProfile({
      ...base,
      bundles: [bundle('first'), generated(), bundle('second')],
    })
    expect(plan.bundles).toEqual([
      { kind: 'bundle', name: 'first' },
      { kind: 'generated' },
      { kind: 'bundle', name: 'second' },
    ])
  })

  it('rejects a missing profile name', () => {
    expect(() => defineProfile({ name: '', dsh: base.dsh, bundles: [] })).toThrow(
      PlanValidationError,
    )
  })

  it('rejects reserved bundle names', () => {
    for (const name of ['@eedsh/runtime', '@eedsh/generated']) {
      try {
        defineProfile({ ...base, bundles: [bundle(name)] })
        expect.unreachable('reserved bundle name must be rejected')
      } catch (error) {
        expect(error).toBeInstanceOf(PlanValidationError)
        const issues = (error as PlanValidationError).issues
        expect(issues.map((issue) => issue.path)).toContainEqual(['bundles', 0, 'name'])
        expect(issues.some((issue) => issue.message.includes('owned by the materializer'))).toBe(
          true,
        )
      }
    }
  })

  it('rejects reserved package names', () => {
    expect(() =>
      defineProfile({ ...base, bundles: [], packages: { '@eedsh/generated': 'link:./x' } }),
    ).toThrow(PlanValidationError)
  })

  it('rejects duplicate generated markers', () => {
    expect(() => defineProfile({ ...base, bundles: [generated(), generated()] })).toThrow(
      PlanValidationError,
    )
  })

  it('accepts expression nodes in layer config', () => {
    const plan = defineProfile({
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
    expect(Either.isRight(validatePlan(parsed))).toBe(true)
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
