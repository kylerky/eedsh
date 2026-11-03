import { describe, expect, it } from 'vitest'
import { COMMAND_NAMES, type CompletionCatalogs, complete } from '../../src/repl/completion'

const catalogs: CompletionCatalogs = {
  commands: COMMAND_NAMES,
  profiles: ['work', 'home'],
  bundles: ['@deepseek-ai/dsh-base', '@scope/custom'],
  packages: ['@scope/plugin', '@scope/other'],
  rows: (bundle, root) => {
    if (root.profile === 'work') return ['profile-row']
    if (bundle === '@deepseek-ai/dsh-base') return ['preset-standard', 'timer']
    return []
  },
  presets: (bundle) => (bundle === '@deepseek-ai/dsh-base' ? ['standard', 'minimal'] : []),
}

function at(line: string) {
  return complete({ line, cursor: line.length, catalogs })
}

describe('command completion', () => {
  it('offers command names and filters by prefix', () => {
    expect(at('.he')).toEqual({ start: 0, hits: ['.help'] })
    expect(at('.s')).toEqual({ start: 0, hits: ['.sync'] })
    expect(at('').hits).toEqual([...COMMAND_NAMES])
    expect(at('.zz').hits).toEqual([])
  })

  it('offers sync values and profile arguments', () => {
    expect(at('.sync o').hits).toContain('on')
    expect(at('.sync of')).toEqual({ start: 6, hits: ['off'] })
    expect(at('.sync ').hits).toEqual(['on', 'off'])
    expect(at('.profile ho')).toEqual({ start: 9, hits: ['home'] })
    expect(at('.profile ').hits).toEqual(['work', 'home'])
    expect(at('.resolve ').hits).toEqual([])
  })
})

describe('chain method completion', () => {
  it('offers the bundle methods at a chain step', () => {
    const result = at("bundle('@deepseek-ai/dsh-base').")
    expect(result.start).toBe("bundle('@deepseek-ai/dsh-base').".length)
    for (const method of [
      'rows',
      'presets',
      'row',
      'preset',
      'version',
      'packageDir',
      'origin',
      'fromProfile',
      'fromPackageDir',
    ]) {
      expect(result.hits).toContain(method)
    }
  })

  it('filters methods by the typed prefix', () => {
    expect(at("bundle('@deepseek-ai/dsh-base').ro")).toEqual({
      start: "bundle('@deepseek-ai/dsh-base').".length,
      hits: ['row', 'rows'],
    })
    expect(at("bundle('@deepseek-ai/dsh-base').presets().").hits).toEqual([])
  })

  it('drops root methods once the chain is rooted', () => {
    const byProfile = at("bundle('@deepseek-ai/dsh-base').fromProfile('work').")
    expect(byProfile.hits).not.toContain('fromProfile')
    expect(byProfile.hits).not.toContain('fromPackageDir')
    expect(byProfile.hits).toContain('rows')
    const byDir = at("bundle('@deepseek-ai/dsh-base').fromPackageDir('../x').")
    expect(byDir.hits).not.toContain('fromProfile')
    expect(byDir.hits).not.toContain('fromPackageDir')
  })

  it('offers the preset-definition methods and their arguments', () => {
    const result = at("definePreset('ptc-fresh').")
    for (const method of [
      'children',
      'description',
      'from',
      'id',
      'name',
      'order',
      'rowId',
      'toJSON',
    ]) {
      expect(result.hits).toContain(method)
    }
    expect(at("definePreset('ptc-fresh').ch").hits).toEqual(['children'])
    expect(at("definePreset('ptc-fresh').from(installed).").hits).toContain('toJSON')
  })

  it('offers methods for rows, presets, the config view, and the profile view', () => {
    const row = at("bundle('@deepseek-ai/dsh-base').row('timer').")
    expect(row.hits).toContain('disable')
    expect(row.hits).toContain('override')
    expect(row.hits).toContain('toJSON')
    const preset = at("bundle('@deepseek-ai/dsh-base').preset('standard').")
    expect(preset.hits).toContain('rowId')
    expect(preset.hits).toContain('disable')
    expect(at('config.').hits).toEqual(['defaultProfile', 'profile', 'profiles'])
    expect(at('selectedProfile.').hits).toContain('plan')
    expect(at('selectedProfile.').hits).toContain('bundles')
    expect(at('plan.').hits).toContain('packages')
  })
})

describe('argument completion', () => {
  it('offers bundle names inside bundle()', () => {
    expect(at("bundle('")).toEqual({
      start: 7,
      hits: ["'@deepseek-ai/dsh-base'", "'@scope/custom'"],
    })
    expect(at("bundle('@scope")).toEqual({ start: 7, hits: ["'@scope/custom'"] })
  })

  it('offers profile names inside fromProfile() and config.profile()', () => {
    expect(at("bundle('@deepseek-ai/dsh-base').fromProfile('")).toEqual({
      start: 44,
      hits: ["'work'", "'home'"],
    })
    expect(at("config.profile('").hits).toEqual(["'work'", "'home'"])
  })

  it('offers row and preset ids for the resolved bundle root', () => {
    expect(at("bundle('@deepseek-ai/dsh-base').row('")).toEqual({
      start: 36,
      hits: ["'preset-standard'", "'timer'"],
    })
    expect(at("bundle('@deepseek-ai/dsh-base').preset('")).toEqual({
      start: 39,
      hits: ["'standard'", "'minimal'"],
    })
    expect(at("bundle('@deepseek-ai/dsh-base').fromProfile('work').row('")).toEqual({
      start: 56,
      hits: ["'profile-row'"],
    })
  })

  it('offers package names after plan.packages[', () => {
    expect(at("plan.packages['")).toEqual({
      start: 14,
      hits: ["'@scope/plugin'", "'@scope/other'"],
    })
  })
})

describe('containment', () => {
  it('returns no hits when a catalog throws', () => {
    const failing: CompletionCatalogs = {
      ...catalogs,
      rows: () => {
        throw new Error('resolution failed')
      },
    }
    const line = "bundle('@deepseek-ai/dsh-base').row('"
    expect(() => complete({ line, cursor: line.length, catalogs: failing })).not.toThrow()
    expect(complete({ line, cursor: line.length, catalogs: failing }).hits).toEqual([])
  })

  it('returns no hits for ordinary JavaScript expressions', () => {
    expect(at('const x = 1')).toEqual({ start: 10, hits: [] })
    expect(at('bundle')).toEqual({ start: 0, hits: [] })
  })
})