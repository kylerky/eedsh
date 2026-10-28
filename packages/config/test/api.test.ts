import {
  bundle,
  type DefineProfileInput,
  defineConfig,
  defineProfile,
  disable,
  enable,
  generated,
  group,
  insert,
  js,
  layer,
  override,
  type ProfileDefinition,
  raw,
} from '@eedsh/config'
import { PLAN_FORMAT, validatePlan } from '@eedsh/plan'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as SchemaIssue from 'effect/SchemaIssue'
import { describe, expect, it } from 'vitest'

describe('defineProfile', () => {
  it('returns a synchronous descriptor with defaults', () => {
    const definition = defineProfile({
      bundles: [bundle('@deepseek-ai/dsh-base')],
    })
    expect(definition).toEqual({
      bundles: [{ kind: 'bundle', name: '@deepseek-ai/dsh-base' }],
      layers: [],
      packages: {},
    })
    expect(definition).not.toBeInstanceOf(Promise)
  })

  it('copies the authored arrays and records', () => {
    const bundles = [bundle('@deepseek-ai/dsh-base'), generated()]
    const patches = [insert({ id: 'row', name: '@scope/plugin' })]
    const packages = { '@scope/plugin': 'link:../plugin' }
    const definition = defineProfile({
      bundles,
      layers: [layer('work', patches)],
      packages,
    })
    expect(definition.bundles).not.toBe(bundles)
    expect(definition.bundles).toEqual(bundles)
    expect(definition.layers).toHaveLength(1)
    expect(definition.layers[0]?.patches).toEqual(patches)
    expect(definition.layers[0]?.patches).not.toBe(patches)
    expect(definition.packages).not.toBe(packages)
    expect(definition.packages).toEqual(packages)
  })

  it('describes even an invalid profile without validating it', () => {
    const definition = defineProfile({
      bundles: [bundle('@eedsh/runtime')],
      layers: [layer('Not Safe', [])],
    })
    expect(definition.bundles).toEqual([{ kind: 'bundle', name: '@eedsh/runtime' }])
    expect(definition.layers).toEqual([{ id: 'Not Safe', patches: [] }])
  })

  it('keeps plan validation in @eedsh/plan and assertPlan absent', async () => {
    const definition = defineProfile({})
    expect(definition).toEqual({ bundles: [], layers: [], packages: {} })
    expect(Result.isSuccess(validatePlan({}))).toBe(false)
    const module = await import('@eedsh/config')
    expect('assertPlan' in module).toBe(false)
    expect('validatePlan' in module).toBe(false)
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
/** Authoring returns a detached descriptor synchronously. */
const defineSignature: (input: DefineProfileInput) => ProfileDefinition = defineProfile
void defineSignature

describe('defineConfig profile boundary', () => {
  it('stores the native failure Result synchronously', () => {
    const result = defineConfig({
      dsh: '0.2.1-rc.2',
      profiles: { work: defineProfile({ bundles: [bundle('@eedsh/runtime')] }) },
    })
    expect(Result.isSuccess(result)).toBe(true)
    expect(result).not.toBeInstanceOf(Promise)
    if (Result.isFailure(result)) return
    const profile = result.success.profiles.work
    expect(profile !== undefined && Result.isFailure(profile)).toBe(true)
    if (profile !== undefined && Result.isFailure(profile)) {
      expect(Schema.isSchemaError(profile.failure)).toBe(true)
      expect(profile.failure).toBeInstanceOf(Error)
      expect(profile.failure._tag).toBe('SchemaError')
      expect(SchemaIssue.isIssue(profile.failure.issue)).toBe(true)
    }
  })

  it('returns one plain plan per profile synchronously', () => {
    const result = defineConfig({
      dsh: '0.2.1-rc.2',
      profiles: { work: defineProfile({ bundles: [] }) },
    })
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isFailure(result)) return
    const profile = result.success.profiles.work
    expect(profile !== undefined && Result.isSuccess(profile)).toBe(true)
    if (profile !== undefined && Result.isSuccess(profile)) {
      expect(profile.success.format).toBe(PLAN_FORMAT)
      expect(profile.success.profile.name).toBe('work')
    }
  })
})
