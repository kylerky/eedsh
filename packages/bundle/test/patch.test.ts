import { describe, expect, it } from 'vitest'
import * as api from '../src/index'

describe('bundle patch authoring', () => {
  it('builds an ordered patch list from every authoring method', () => {
    const patch = api.defineBundlePatch((builder) => {
      builder
        .insert({ id: 'a', name: 'a' })
        .insert([{ id: 'b', name: 'b' }])
        .override('c', { marker: true })
        .disable('d')
        .enable('e')
        .raw({ id: 'f', disabled: null })
    })

    expect(patch).toEqual([
      { insert: [{ id: 'a', name: 'a' }] },
      { insert: [{ id: 'b', name: 'b' }] },
      { id: 'c', config: { marker: true } },
      { id: 'd', disabled: true },
      { id: 'e', disabled: false },
      { id: 'f', disabled: null },
    ])
  })

  it('builds group entries with isolate and ordered children', () => {
    expect(
      api.group('group-row', { name: 'cordis:group', isolate: { label: true } }, [
        { id: 'child-a', name: 'a' },
        { id: 'child-b', name: 'b' },
      ]),
    ).toEqual({
      id: 'group-row',
      name: 'cordis:group',
      group: true,
      isolate: { label: true },
      config: [
        { id: 'child-a', name: 'a' },
        { id: 'child-b', name: 'b' },
      ],
    })
  })

  it('builds a reserved expression node', () => {
    expect(api.js("ctx.get('profileContext')")).toEqual({
      $eedsh: { expr: "ctx.get('profileContext')" },
    })
  })

  it('does not expose profile or bundle lifecycle concepts', () => {
    for (const symbol of [
      'defineConfig',
      'bundle',
      'definePreset',
      'selectPreset',
      'dshVersion',
      'LayerBuilder',
    ]) {
      expect(symbol in api, symbol).toBe(false)
    }
  })
})
