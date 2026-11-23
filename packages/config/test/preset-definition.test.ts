import {
  AuthoringDefect,
  authoringKind,
  bundle,
  defineConfig,
  definePreset,
  group,
  LayerBuilder,
  PresetChild,
  PresetChildren,
  PresetDefinition,
  PresetDefinitionError,
} from '@eedsh/config'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import { EXPRESSIVE_ROWS, resolutionTable, resolvedBundle } from './support/table'

const expressiveTable = resolutionTable(
  resolvedBundle('@fixture/expressive', EXPRESSIVE_ROWS, { version: '1.1.0' }),
)

function installedPreset() {
  return bundle('@fixture/expressive').preset('expressive')
}

function planOfDefinition(definition: PresetDefinition) {
  const built = defineConfig()
    .profile('work', (profile) => {
      profile.generated().layer('preset', (layer) => layer.insert(definition))
    })
    .build(expressiveTable)
  if (Result.isFailure(built)) throw built.failure
  const plan = built.success.profiles.work
  if (plan === undefined || Result.isFailure(plan)) throw plan?.failure
  return plan.success
}

describe('preset definition identity', () => {
  it('exposes a preset id, a derived row id, and the preset package name', () => {
    const definition = definePreset('ptc-fresh')
    expect(definition).toBeInstanceOf(PresetDefinition)
    expect(authoringKind(definition)).toBe('preset-definition')
    expect(definition.id).toBe('ptc-fresh')
    expect(definition.rowId).toBe('preset-ptc-fresh')
    expect(definition.toJSON()).toEqual({
      id: 'preset-ptc-fresh',
      name: '@deepseek-ai/dsh-agent-preset',
      config: { id: 'ptc-fresh', plugins: [] },
    })
  })

  it('uses an explicit row id instead of the derivation', () => {
    const definition = definePreset('ptc-fresh', { rowId: 'adapted-preset' })
    expect(definition.rowId).toBe('adapted-preset')
    expect(definition.toJSON().id).toBe('adapted-preset')
  })

  it('accepts display name, description, and order metadata', () => {
    const definition = definePreset('ptc-fresh')
      .name('Adapted PTC')
      .description('PTC for personal use')
      .order(2)
    expect(definition.toJSON().config).toEqual({
      id: 'ptc-fresh',
      name: 'Adapted PTC',
      description: 'PTC for personal use',
      order: 2,
      plugins: [],
    })
  })

  it('rejects an empty preset id with a tagged failure', () => {
    expect(() => definePreset('')).toThrowError(PresetDefinitionError)
    try {
      definePreset('   ')
    } catch (error) {
      expect(error).toBeInstanceOf(PresetDefinitionError)
      const failure = error as PresetDefinitionError
      expect(failure._tag).toBe('PresetDefinitionError')
      expect(failure.code).toBe('preset.invalid_id')
      expect(failure.message).toContain('preset id')
    }
  })
})

function resolvedDefinition(definition: PresetDefinition) {
  return definition.toJSON(expressiveTable)
}

function childIds(definition: PresetDefinition): unknown[] {
  const config = resolvedDefinition(definition).config as Record<string, unknown>
  return (config.plugins as Record<string, unknown>[]).map((entry) => entry.id)
}

function childAt(definition: PresetDefinition, index: number): Record<string, unknown> {
  const config = resolvedDefinition(definition).config as Record<string, unknown>
  return (config.plugins as Record<string, unknown>[])[index] as Record<string, unknown>
}

describe('nested child scope', () => {
  it('disables, enables, removes, and replaces one child at a time', () => {
    const definition = definePreset('adapted').from(installedPreset())
    definition.children((children) => {
      expect(children).toBeInstanceOf(PresetChildren)
      expect(children.child('tool-todo')).toBeInstanceOf(PresetChild)
      expect(children.child('tool-todo').disable()).toBeUndefined()
      expect(children.child('tool-web').enable()).toBeUndefined()
    })
    expect(childAt(definition, 1)).toMatchObject({ id: 'tool-todo', disabled: true })
    expect(childAt(definition, 0)).toMatchObject({ id: 'tool-web', disabled: false })

    definition.children((children) => {
      children.child('tool-todo').remove()
    })
    expect(childIds(definition)).toEqual(['tool-web'])

    definition.children((children) => {
      children.child('tool-web').replaceWith({ id: 'tool-lsp', name: '@deepseek-ai/dsh-tool-lsp' })
    })
    expect(childIds(definition)).toEqual(['tool-lsp'])
    expect(childAt(definition, 0)).toEqual({ id: 'tool-lsp', name: '@deepseek-ai/dsh-tool-lsp' })
  })

  it('appends, prepends, and inserts around one anchor', () => {
    const definition = definePreset('adapted').from(installedPreset())
    const appended = { id: 'tool-lsp', name: '@deepseek-ai/dsh-tool-lsp' }
    definition.children((children) => {
      expect(children.append(appended)).toBeUndefined()
      children.prepend({ id: 'first', name: '@fixture/first' })
      children.insertBefore('tool-web', { id: 'before-web', name: '@fixture/before' })
      children.insertAfter('tool-todo', { id: 'after-todo', name: '@fixture/after' })
    })
    expect(childIds(definition)).toEqual([
      'first',
      'before-web',
      'tool-web',
      'tool-todo',
      'after-todo',
      'tool-lsp',
    ])
  })

  it('returns the definition from the scope and ignores the callback return value', () => {
    const definition = definePreset('adapted')
    expect(
      definition.children(() => {
        return 'ignored'
      }),
    ).toBe(definition)
    expect(
      definition.children((children) => {
        children.append({ id: 'kept', name: '@fixture/kept' })
        return 42
      }),
    ).toBe(definition)
    expect(childIds(definition)).toEqual(['kept'])
  })

  it('addresses top-level children only, treating a group as one entry', () => {
    const definition = definePreset('adapted')
    definition.children((children) => {
      children.append(
        group('group-row', { name: '@fixture/group' }, [
          { id: 'nested-child', name: '@fixture/nested' },
        ]),
      )
      children.child('group-row').disable()
    })
    const groupEntry = childAt(definition, 0)
    expect(groupEntry).toMatchObject({ id: 'group-row', disabled: true, group: true })
    expect(() =>
      definition.children((children) => {
        children.child('nested-child')
      }),
    ).toThrowError(PresetDefinitionError)
  })

  it('accepts at most one entry per operation', () => {
    const definition = definePreset('adapted')
    definition.children((children) => {
      if (false as boolean) {
        // @ts-expect-error child operations accept one entry, never a list
        children.append([{ id: 'a', name: 'a' }])
        // @ts-expect-error child operations accept one entry, never a list
        children.prepend([{ id: 'a', name: 'a' }])
        // @ts-expect-error child operations accept one entry, never a list
        children.insertBefore('anchor', [{ id: 'a', name: 'a' }])
        // @ts-expect-error child operations accept one entry, never a list
        children.insertAfter('anchor', [{ id: 'a', name: 'a' }])
        // @ts-expect-error replacement accepts one entry, never a list
        children.child('anchor').replaceWith([{ id: 'a', name: 'a' }])
      }
    })
    expect(childIds(definition)).toEqual([])
  })
})

describe('preset selection', () => {
  function planWithSelection(
    build: (layer: LayerBuilder) => void,
  ): ReturnType<typeof planOfDefinition> {
    const built = defineConfig()
      .profile('work', (profile) => {
        profile.generated().layer('registry', build)
      })
      .build(expressiveTable)
    if (Result.isFailure(built)) throw built.failure
    const plan = built.success.profiles.work
    if (plan === undefined || Result.isFailure(plan)) throw plan?.failure
    return plan.success
  }

  it('writes differing selected and deployment-default preset ids', () => {
    const standard = bundle('@fixture/expressive').preset('expressive')
    const adapted = definePreset('ptc-fresh').from(installedPreset())
    const plan = planWithSelection((layer) => layer.selectPreset(adapted, { default: standard }))
    expect(plan.layers[0]?.patches).toEqual([
      {
        id: 'agent-preset-registry',
        config: { default: 'expressive', selectedDefault: 'ptc-fresh' },
      },
    ])
  })

  it('writes the same preset id twice when it is also the deployment default', () => {
    const adapted = definePreset('ptc-fresh')
    const plan = planWithSelection((layer) => layer.selectPreset(adapted, { default: adapted }))
    expect(plan.layers[0]?.patches[0]).toEqual({
      id: 'agent-preset-registry',
      config: { default: 'ptc-fresh', selectedDefault: 'ptc-fresh' },
    })
  })

  it('writes the full registry config without merging or inferring', () => {
    const standard = bundle('@fixture/expressive').preset('expressive')
    const adapted = definePreset('ptc-fresh')
    const plan = planWithSelection((layer) => {
      layer.raw({ id: 'agent-preset-registry', config: { default: 'inferred', extra: true } })
      layer.selectPreset(adapted, { default: standard })
    })
    const patch = plan.layers[0]?.patches[1] as { config: Record<string, unknown> }
    expect(Object.keys(patch.config).sort()).toEqual(['default', 'selectedDefault'])
    expect(patch.config).toEqual({ default: 'expressive', selectedDefault: 'ptc-fresh' })
  })

  it('rejects a non-preset reference with a tagged selection failure', () => {
    const standard = definePreset('standard')
    for (const bad of ['ptc-fresh', {}, null]) {
      expect(() =>
        new LayerBuilder('registry').selectPreset(bad as never, { default: standard }),
      ).toThrowError(PresetDefinitionError)
    }
    try {
      new LayerBuilder('registry').selectPreset({} as never, { default: standard })
    } catch (error) {
      const failure = error as PresetDefinitionError
      expect(failure.code).toBe('preset.invalid_selection')
      expect(failure.message).toContain('preset')
    }
  })
})

describe('child lookup failures', () => {
  function failureOf(run: () => void): PresetDefinitionError {
    try {
      run()
    } catch (error) {
      expect(error).toBeInstanceOf(PresetDefinitionError)
      return error as PresetDefinitionError
    }
    throw new Error('expected a PresetDefinitionError')
  }

  it('reports a missing child with the preset, row, and child ids', () => {
    const definition = definePreset('adapted', { rowId: 'adapted-row' }).from(installedPreset())
    // A copied source is resolved during build, so the lookup replays then.
    definition.children((children) => {
      children.child('missing')
    })
    const replay = failureOf(() => resolvedDefinition(definition))
    expect(replay.code).toBe('preset.child_not_found')
    expect(replay.presetId).toBe('adapted')
    expect(replay.rowId).toBe('adapted-row')
    expect(replay.childId).toBe('missing')
    expect(replay.message).toContain('"adapted"')
    expect(replay.message).toContain('"adapted-row"')
    expect(replay.message).toContain('"missing"')
    expect(childIds(definePreset('adapted').from(installedPreset()))).toEqual([
      'tool-web',
      'tool-todo',
    ])
  })

  it('reports duplicate child ids as ambiguous without mutating', () => {
    const definition = definePreset('adapted')
    definition.children((children) => {
      children.append({ id: 'dup', name: '@fixture/one' })
      children.append({ id: 'dup', name: '@fixture/two' })
    })
    const failure = failureOf(() =>
      definition.children((children) => {
        children.child('dup').disable()
      }),
    )
    expect(failure.code).toBe('preset.child_ambiguous')
    expect(failure.childId).toBe('dup')
    expect(failure.message).toContain('ambiguous')
    expect(childIds(definition)).toEqual(['dup', 'dup'])
    expect(childAt(definition, 0)).not.toHaveProperty('disabled')
    expect(childAt(definition, 1)).not.toHaveProperty('disabled')
  })

  it('reports missing and ambiguous insertion anchors without mutating', () => {
    const definition = definePreset('adapted').from(installedPreset())
    definition.children((children) => {
      children.insertBefore('missing', { id: 'new', name: '@fixture/new' })
    })
    const missingBefore = failureOf(() => resolvedDefinition(definition))
    expect(missingBefore.code).toBe('preset.child_not_found')
    expect(missingBefore.childId).toBe('missing')
    const after = definePreset('adapted').from(installedPreset())
    after.children((children) => {
      children.insertAfter('missing', { id: 'new', name: '@fixture/new' })
    })
    const missingAfter = failureOf(() => resolvedDefinition(after))
    expect(missingAfter.code).toBe('preset.child_not_found')
    expect(childIds(definePreset('adapted').from(installedPreset()))).toEqual([
      'tool-web',
      'tool-todo',
    ])

    const ambiguous = definePreset('adapted').from(installedPreset())
    ambiguous.children((children) => {
      children.append({ id: 'tool-web', name: '@fixture/duplicate' })
      children.insertBefore('tool-web', { id: 'new', name: '@fixture/new' })
    })
    const failure = failureOf(() => resolvedDefinition(ambiguous))
    expect(failure.code).toBe('preset.child_ambiguous')
  })

  it('keeps a failed replacement from mutating the child list', () => {
    const definition = definePreset('adapted').from(installedPreset())
    definition.children((children) => {
      children.child('missing').replaceWith({ id: 'new', name: '@fixture/new' })
    })
    const failure = failureOf(() => resolvedDefinition(definition))
    expect(failure.code).toBe('preset.child_not_found')
    expect(childIds(definePreset('adapted').from(installedPreset()))).toEqual([
      'tool-web',
      'tool-todo',
    ])
  })
})

describe('copying an installed preset', () => {
  it('copies only the child list, not identity or metadata', () => {
    const installed = installedPreset()
    const sourceConfig = installed.resolve(expressiveTable).config as Record<string, unknown>
    const definition = definePreset('adapted').from(installed).name('Adapted')
    const config = definition.toJSON(expressiveTable).config as Record<string, unknown>
    expect(config.plugins).toEqual(sourceConfig.plugins)
    expect(config.id).toBe('adapted')
    expect(config.name).toBe('Adapted')
    expect(config.order).toBeUndefined()
    expect(config).not.toHaveProperty('description')
    expect(definition.id).toBe('adapted')
    expect(definition.rowId).toBe('preset-adapted')
  })

  it('leaves the installed preset unchanged and does not alias its data', () => {
    const installed = installedPreset()
    const before = JSON.stringify(installed.resolve(expressiveTable))
    const definition = definePreset('adapted').from(installed)
    const config = definition.toJSON(expressiveTable).config as Record<string, unknown>
    expect(JSON.stringify(installed.resolve(expressiveTable))).toBe(before)
    const sourceConfig = installed.resolve(expressiveTable).config as Record<string, unknown>
    expect(config.plugins).not.toBe(sourceConfig.plugins)
    expect((config.plugins as unknown[])[0]).not.toBe((sourceConfig.plugins as unknown[])[0])
    ;(config.plugins as Record<string, unknown>[]).push({ id: 'extra', name: '@fixture/extra' })
    expect(sourceConfig.plugins).toHaveLength(2)
  })
})

describe('normalization to an ordinary row', () => {
  it('inserts an ordinary agent-preset row into a generated layer', () => {
    const definition = definePreset('ptc-fresh', { rowId: 'adapted-preset' })
      .name('Adapted PTC')
      .description('PTC for personal use')
      .order(2)
      .from(installedPreset())
    const plan = planOfDefinition(definition)
    expect(plan.layers[0]?.patches[0]).toEqual({
      insert: [
        {
          id: 'adapted-preset',
          name: '@deepseek-ai/dsh-agent-preset',
          config: {
            id: 'ptc-fresh',
            name: 'Adapted PTC',
            description: 'PTC for personal use',
            order: 2,
            plugins: expect.any(Array),
          },
        },
      ],
    })
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan)
  })

  it('keeps the query preset handle distinct from the definition as a patch target', () => {
    const installed = installedPreset()
    const definition = definePreset('ptc-fresh')
    const layer = new LayerBuilder('adapted').disable(installed)
    expect(layer.toJSON(expressiveTable).patches).toEqual([
      { id: 'preset-expressive', disabled: true },
    ])
    expect(() => new LayerBuilder('bad').disable(definition as never)).toThrowError(AuthoringDefect)
  })
})
