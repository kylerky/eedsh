import { defineConfig, group, js, LayerBuilder } from '@eedsh/config'
import { PLAN_FORMAT, validatePlan } from '@eedsh/plan'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as SchemaIssue from 'effect/SchemaIssue'
import { describe, expect, it } from 'vitest'

describe('layer builder patches', () => {
  it('insert accepts one entry or many', () => {
    const layer = new LayerBuilder('inserts')
    layer.insert({ id: 'row', name: '@scope/plugin' })
    layer.insert([
      { id: 'a', name: 'a' },
      { id: 'b', name: 'b' },
    ])
    expect(layer.patches).toEqual([
      { insert: [{ id: 'row', name: '@scope/plugin' }] },
      {
        insert: [
          { id: 'a', name: 'a' },
          { id: 'b', name: 'b' },
        ],
      },
    ])
  })

  it('override replaces the whole config without merging', () => {
    const layer = new LayerBuilder('overrides').override('agent-default-model', {
      provider: 'x',
      model: 'y',
    })
    expect(layer.patches[0]).toEqual({
      id: 'agent-default-model',
      config: { provider: 'x', model: 'y' },
    })
    expect(Object.keys(layer.patches[0] as object)).toEqual(['id', 'config'])
  })

  it('disable and enable are disabled patches', () => {
    expect(new LayerBuilder('toggle').disable('row').patches).toEqual([
      { id: 'row', disabled: true },
    ])
    expect(new LayerBuilder('toggle').enable('row').patches).toEqual([
      { id: 'row', disabled: false },
    ])
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
    const patch = new LayerBuilder('groups')
      .insert(group('group-row', {}, [{ id: 'child', name: 'child' }]))
      .patches[0]
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
    const entry = new LayerBuilder('raws').raw({
      id: 'row',
      name: '@scope/plugin',
      inject: ['service'],
      extra: { a: 1 },
    }).patches[0]
    expect(entry).toEqual({
      id: 'row',
      name: '@scope/plugin',
      inject: ['service'],
      extra: { a: 1 },
    })
  })

  it('keeps patch order', () => {
    const value = new LayerBuilder('ordered')
      .disable('a')
      .enable('a')
      .override('b', { on: true })
    expect(value.id).toBe('ordered')
    expect(value.patches).toEqual([
      { id: 'a', disabled: true },
      { id: 'a', disabled: false },
      { id: 'b', config: { on: true } },
    ])
    expect(value.toJSON().patches).toEqual(value.patches)
  })
})

describe('defineConfig profile boundary', () => {
  it('stores the native failure Result synchronously', () => {
    const result = defineConfig()
      .dsh('0.2.1-rc.2')
      .profile('work', (profile) => profile.bundle('@eedsh/runtime'))
      .build()
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
    const result = defineConfig()
      .dsh('0.2.1-rc.2')
      .profile('work', (profile) => profile.bundle('@deepseek-ai/dsh-base'))
      .build()
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isFailure(result)) return
    const profile = result.success.profiles.work
    expect(profile !== undefined && Result.isSuccess(profile)).toBe(true)
    if (profile !== undefined && Result.isSuccess(profile)) {
      expect(profile.success.format).toBe(PLAN_FORMAT)
      expect(profile.success.profile.name).toBe('work')
    }
  })

  it('keeps plan validation in @eedsh/plan and assertPlan absent', async () => {
    expect(Result.isSuccess(validatePlan({}))).toBe(false)
    const module = await import('@eedsh/config')
    expect('assertPlan' in module).toBe(false)
    expect('validatePlan' in module).toBe(false)
  })
})
