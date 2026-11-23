import {
  AuthoringDefect,
  Bundle,
  BundleQuery,
  bundle,
  defineConfig,
  group,
  js,
  LayerBuilder,
  normalizeAuthoring,
  Preset,
  PresetCollection,
  Row,
  RowCollection,
} from '@eedsh/config'
import { PLAN_FORMAT, PLAN_VERSION, validatePlan } from '@eedsh/plan'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import {
  BASE_ROWS,
  CUSTOM_ROWS,
  EXPRESSIVE_ROWS,
  resolutionTable,
  resolvedBundle,
} from './support/table'

const baseTable = resolutionTable(resolvedBundle('@fixture/base', BASE_ROWS))
const customProfileTable = resolutionTable(
  resolvedBundle('@fixture/custom', CUSTOM_ROWS, {
    root: { profile: 'work' },
    origin: 'profile',
    profile: 'work',
    version: '2.0.0',
  }),
)
const expressiveTable = resolutionTable(resolvedBundle('@fixture/expressive', EXPRESSIVE_ROWS))

function planValue(bundleValue: unknown): unknown {
  return {
    format: PLAN_FORMAT,
    version: PLAN_VERSION,
    profile: { name: 'work' },
    bundles: [bundleValue],
    layers: [],
    packages: {},
  }
}

describe('authoring brand', () => {
  it('exposes a bundle selection as plain plan JSON without a source', () => {
    // @ts-expect-error bundle source options are removed from the authoring API
    const handle = bundle('@fixture/base', { source: 'link:../base' })
    expect(handle).toBeInstanceOf(Bundle)
    expect(handle.toJSON()).toEqual({ kind: 'bundle', name: '@fixture/base' })
    expect(normalizeAuthoring({ bundles: [handle] })).toEqual({
      bundles: [{ kind: 'bundle', name: '@fixture/base' }],
    })
  })

  it('does not brand a rooted query and rejects it as plan data', () => {
    const rooted = bundle('@fixture/base').fromProfile('work')
    expect(rooted).toBeInstanceOf(BundleQuery)
    expect('toJSON' in rooted).toBe(false)
    expect(normalizeAuthoring({ bundles: [rooted] })).toEqual({ bundles: [rooted] })
    const plan = validatePlan(planValue(rooted))
    expect(Result.isFailure(plan)).toBe(true)
    if (Result.isFailure(plan))
      expect(plan.failure.message).toContain('bundle must be a JSON object')
  })
})

describe('query descriptors', () => {
  it('records the bundle, root, and requested row or preset', () => {
    const pinned = bundle('@fixture/base').row('timer')
    const fromProfile = bundle('@fixture/custom').fromProfile('work').preset('standard')
    const rows = bundle('@fixture/base').rows()
    const builder = defineConfig().profile('work', (profile) => {
      profile
        .generated()
        .layer((layer) => layer.insert([pinned]))
        .layer((layer) => layer.disable(fromProfile))
        .layer((layer) => layer.insert(rows))
    })
    expect(builder.queries()).toEqual([
      { bundle: '@fixture/base', root: {}, row: 'timer' },
      {
        bundle: '@fixture/custom',
        root: { profile: 'work' },
        preset: 'standard',
      },
      { bundle: '@fixture/base', root: {}, rows: true },
    ])
  })

  it('resolves every declared row from its table entry', () => {
    const collection = bundle('@fixture/base').rows()
    expect(collection).toBeInstanceOf(RowCollection)
    expect(collection.resolve(baseTable).map((row) => row.id)).toEqual(['preset-standard', 'timer'])
    const presets = bundle('@fixture/base').presets()
    expect(presets).toBeInstanceOf(PresetCollection)
    expect(presets.resolve(baseTable).map((row) => row.id)).toEqual(['preset-standard'])
  })

  it('resolves a row and a preset descriptor from a rooted table entry', () => {
    const row = bundle('@fixture/custom').fromProfile('work').row('custom-row')
    expect(row).toBeInstanceOf(Row)
    expect(row.resolve(customProfileTable)).toMatchObject({ id: 'custom-row' })
    const preset = bundle('@fixture/base').preset('standard')
    expect(preset).toBeInstanceOf(Preset)
    expect(preset.resolve(baseTable)).toMatchObject({
      id: 'preset-standard',
      name: '@deepseek-ai/dsh-agent-preset',
      config: { id: 'standard' },
    })
  })

  it('reports a missing row or preset as an authoring defect at build', () => {
    expect(() => bundle('@fixture/base').row('missing').resolve(baseTable)).toThrowError(
      AuthoringDefect,
    )
    expect(() => bundle('@fixture/base').preset('missing').resolve(baseTable)).toThrowError(
      AuthoringDefect,
    )
  })

  it('reports a missing table entry as an authoring defect naming the descriptor', () => {
    try {
      bundle('@fixture/absent').rows().resolve(baseTable)
    } catch (error) {
      expect(error).toBeInstanceOf(AuthoringDefect)
      const defect = error as AuthoringDefect
      expect(defect.code).toBe('authoring.missing_resolution')
      expect(defect.bundle).toBe('@fixture/absent')
      expect(defect.message).toContain('@fixture/absent')
    }
  })
})

describe('resolved expressions', () => {
  it('makes nested runtime expressions plan-shaped and validates the row', () => {
    const preset = bundle('@fixture/expressive').preset('expressive')
    const built = defineConfig()
      .profile('work', (profile) => {
        profile
          .bundle(bundle('@fixture/expressive'))
          .generated()
          .layer('preset', (layer) => layer.insert(preset))
      })
      .build(expressiveTable)
    expect(Result.isSuccess(built)).toBe(true)
    if (Result.isFailure(built)) throw built.failure
    const plan = built.success.profiles.work
    expect(plan !== undefined && Result.isSuccess(plan)).toBe(true)
    if (plan === undefined || Result.isFailure(plan)) throw plan?.failure
    const patch = plan.success.layers[0]?.patches[0] as
      | { insert?: readonly Record<string, unknown>[] }
      | undefined
    const inserted = patch?.insert?.[0] as Record<string, unknown>
    expect(inserted.config).toMatchObject({
      plugins: [
        { id: 'tool-web', disabled: { $eedsh: { expr: "!ctx.get('profileContext')" } } },
        {
          id: 'tool-todo',
          config: { label: { $eedsh: { expr: "ctx.get('profileContext').label" } } },
        },
      ],
    })
    expect(JSON.stringify(inserted)).not.toContain('__jsExpr')
  })
})

describe('rows and presets', () => {
  it('exposes ids and plain patch data for an explicit row', () => {
    const row = bundle('@fixture/base').row('timer')
    expect(row.id).toBe('timer')
    expect(row.disable()).toEqual({ id: 'timer', disabled: true })
    expect(row.enable()).toEqual({ id: 'timer', disabled: false })
    expect(row.override({ interval: 2 })).toEqual({ id: 'timer', config: { interval: 2 } })
  })

  it('targets a preset row through the resolved table', () => {
    const preset = bundle('@fixture/base').preset('standard')
    const built = defineConfig()
      .profile('work', (profile) => {
        profile.generated().layer((layer) => layer.disable(preset))
      })
      .build(baseTable)
    if (Result.isFailure(built)) throw built.failure
    const plan = built.success.profiles.work
    if (plan === undefined || Result.isFailure(plan)) throw plan?.failure
    expect(plan.success.layers[0]?.patches).toEqual([{ id: 'preset-standard', disabled: true }])
    expect(preset.override({ enabled: false })).toMatchObject({ target: preset })
  })

  it('inserts a row collection and a preset collection as ordinary rows', () => {
    const built = defineConfig()
      .profile('work', (profile) => {
        profile
          .generated()
          .layer((layer) =>
            layer.insert([bundle('@fixture/base').rows(), bundle('@fixture/base').presets()]),
          )
      })
      .build(baseTable)
    if (Result.isFailure(built)) throw built.failure
    const plan = built.success.profiles.work
    if (plan === undefined || Result.isFailure(plan)) throw plan?.failure
    const inserted = plan.success.layers[0]?.patches[0]?.insert as
      | readonly Record<string, unknown>[]
      | undefined
    expect(inserted?.map((row) => row.id)).toEqual(['preset-standard', 'timer', 'preset-standard'])
  })
})

describe('layer patches', () => {
  it('appends patches in call order and returns the layer', () => {
    const row = bundle('@fixture/base').row('timer')
    const layer = new LayerBuilder('order')
    const chained = layer
      .insert([{ id: 'inserted', name: '@scope/inserted' }])
      .disable(row)
      .override(row, { interval: 5 })
      .raw({ id: 'raw-row', extra: { a: 1 } })
    expect(chained).toBe(layer)
    expect(layer.label).toBe('order')
    expect(layer.toJSON()).toEqual({
      patches: [
        { insert: [{ id: 'inserted', name: '@scope/inserted' }] },
        { id: 'timer', disabled: true },
        { id: 'timer', config: { interval: 5 } },
        { id: 'raw-row', extra: { a: 1 } },
      ],
    })
  })

  it('keeps js and group as plain value constructors', () => {
    expect(js("ctx.get('profileContext')")).toEqual({
      $eedsh: { expr: "ctx.get('profileContext')" },
    })
    expect(
      group('group-row', { isolate: { label: { color: 'red' } } }, [{ id: 'child-a', name: 'a' }]),
    ).toEqual({
      id: 'group-row',
      isolate: { label: { color: 'red' } },
      group: true,
      config: [{ id: 'child-a', name: 'a' }],
    })
  })

  it('expands a row collection as a patch target', () => {
    const built = defineConfig()
      .profile('work', (profile) => {
        profile.generated().layer((layer) => layer.disable(bundle('@fixture/base').rows()))
      })
      .build(baseTable)
    if (Result.isFailure(built)) throw built.failure
    const plan = built.success.profiles.work
    if (plan === undefined || Result.isFailure(plan)) throw plan?.failure
    expect(plan.success.layers[0]?.patches).toEqual([
      { id: 'preset-standard', disabled: true },
      { id: 'timer', disabled: true },
    ])
  })

  it('expands a preset collection as a patch target', () => {
    const built = defineConfig()
      .profile('work', (profile) => {
        profile
          .generated()
          .layer((layer) => layer.override(bundle('@fixture/base').presets(), { enabled: false }))
      })
      .build(baseTable)
    if (Result.isFailure(built)) throw built.failure
    const plan = built.success.profiles.work
    if (plan === undefined || Result.isFailure(plan)) throw plan?.failure
    expect(plan.success.layers[0]?.patches).toEqual([
      { id: 'preset-standard', config: { enabled: false } },
    ])
  })

  it('rejects an invalid patch target as an authoring defect', () => {
    expect(() => new LayerBuilder('bad').disable({} as never)).toThrowError(AuthoringDefect)
  })

  it('rejects a rooted query as a bundle selection', () => {
    const rooted = bundle('@deepseek-ai/dsh-base').fromProfile('work')
    const builder = defineConfig()
    expect(() =>
      builder.profile('work', (profile) => {
        // @ts-expect-error a rooted query is query-only and not a plan selection
        profile.bundle(rooted)
      }),
    ).toThrowError(AuthoringDefect)
  })

  it('rejects a preset definition as a patch target', () => {
    expect(() => new LayerBuilder('bad').disable({ id: 'x' } as never)).toThrowError(
      AuthoringDefect,
    )
  })
})
