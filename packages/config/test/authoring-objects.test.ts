import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  Bundle,
  BundleQuery,
  bundle,
  defineConfig,
  group,
  js,
  LayerBuilder,
  normalizeAuthoring,
  Preset,
  ResolutionError,
  Row,
} from '@eedsh/config'
import { PLAN_FORMAT, PLAN_VERSION, validatePlan } from '@eedsh/plan'
import * as Result from 'effect/Result'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AuthoringFixture,
  createAuthoringFixture,
  originalEnv,
  useFixtureEnv,
} from './support/fixture'

const tempRoot = join(process.cwd(), 'packages/config/.tmp')
let fixture: AuthoringFixture

beforeEach(async () => {
  fixture = await createAuthoringFixture(tempRoot)
  process.env = { ...originalEnv }
  useFixtureEnv(fixture)
})

afterEach(() => {
  process.env = { ...originalEnv }
})

function planValue(bundleValue: unknown): unknown {
  return {
    format: PLAN_FORMAT,
    version: PLAN_VERSION,
    profile: { name: 'work' },
    dsh: '0.2.1-rc.2',
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

  it('normalizes typed rows and presets inside patch data', () => {
    const rows = bundle('@fixture/base').rows()
    const preset = bundle('@fixture/base').presets()[0]
    expect(preset).toBeDefined()
    const normalized = normalizeAuthoring({
      insert: rows,
      target: preset,
    }) as { insert: { id?: string }[]; target: { rowId: string; id: string } }
    expect(normalized.insert.map((entry) => entry.id)).toEqual(['preset-standard', 'timer'])
    expect(normalized.target).toMatchObject({
      id: 'preset-standard',
      name: '@deepseek-ai/dsh-agent-preset',
      config: { id: 'standard' },
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

describe('typed resolution data', () => {
  it('resolves rows from the pinned installation by default', () => {
    const handle = bundle('@fixture/base')
    expect(handle.origin()).toBe('pinned')
    expect(handle.version()).toBe('1.0.0')
    expect(handle.packageDir()).toBe(fixture.baseDir)
    expect(handle.rows().map((row) => row.id)).toEqual(['preset-standard', 'timer'])
    expect(handle.presets().map((preset) => preset.id)).toEqual(['standard'])
    expect(handle.row('timer')).toBeInstanceOf(Row)
  })

  it('resolves a profile root from a name or a handle carrying a name', () => {
    const fromName = bundle('@fixture/custom').fromProfile('work')
    const fromHandle = bundle('@fixture/custom').fromProfile({ name: 'work' })
    expect(fromName.origin()).toBe('profile')
    expect(fromName.version()).toBe('2.0.0')
    expect(fromName.rows().map((row) => row.id)).toEqual(['custom-row'])
    expect(fromHandle.rows().map((row) => row.id)).toEqual(['custom-row'])
    expect(
      bundle('@fixture/base')
        .fromProfile('work')
        .rows()
        .map((row) => row.id),
    ).toEqual(['profile-copy'])
  })

  it('resolves an absolute and relative package directory', () => {
    expect(
      bundle('@fixture/vendored')
        .fromPackageDir(fixture.packageDir)
        .rows()
        .map((row) => row.id),
    ).toEqual(['vendored-row'])
    expect(
      bundle('@fixture/vendored')
        .fromPackageDir('../node_modules/@fixture/vendored')
        .rows()
        .map((row) => row.id),
    ).toEqual(['vendored-row'])
    expect(bundle('@fixture/vendored').fromPackageDir(fixture.packageDir).origin()).toBe(
      'packageDir',
    )
  })

  it('rejects a second root on a rooted query', () => {
    const rooted = bundle('@fixture/base').fromProfile('work')
    expect('fromProfile' in rooted).toBe(false)
    expect('fromPackageDir' in rooted).toBe(false)
  })
})

describe('resolved expressions', () => {
  it('makes nested runtime expressions plan-shaped and validates the row', () => {
    const preset = bundle('@fixture/expressive').preset('expressive')
    const built = defineConfig()
      .dsh('0.2.1-rc.2')
      .profile('work', (profile) => {
        profile
          .bundle(bundle('@fixture/expressive'))
          .generated()
          .layer('preset', (layer) => layer.insert(preset))
      })
      .build()
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
  it('exposes ids, data, and plain patch data', () => {
    const row = bundle('@fixture/base').row('timer')
    expect(row.id).toBe('timer')
    expect(row.data).toMatchObject({ id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' })
    expect(row.toJSON()).toEqual(row.data)
    expect(row.disable()).toEqual({ id: 'timer', disabled: true })
    expect(row.enable()).toEqual({ id: 'timer', disabled: false })
    expect(row.override({ interval: 2 })).toEqual({ id: 'timer', config: { interval: 2 } })
  })

  it('targets a preset row when a preset handle builds a patch', () => {
    const preset = bundle('@fixture/base').preset('standard')
    expect(preset).toBeInstanceOf(Preset)
    expect(preset).toMatchObject({
      rowId: 'preset-standard',
      id: 'standard',
      order: 1,
      name: 'Standard',
    })
    expect(preset.disable()).toEqual({ id: 'preset-standard', disabled: true })
    expect(preset.override({ enabled: false })).toEqual({
      id: 'preset-standard',
      config: { enabled: false },
    })
    expect(preset.toJSON()).toMatchObject({ id: 'preset-standard' })
  })
})

describe('structured failures', () => {
  it('reports a missing row naming the bundle and the id', () => {
    try {
      bundle('@fixture/base').row('missing')
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError)
      const failure = error as ResolutionError
      expect(failure.code).toBe('resolution.row_not_found')
      expect(failure.bundle).toBe('@fixture/base')
      expect(failure.message).toContain('"missing"')
    }
  })

  it('reports a missing preset naming the bundle and the id', () => {
    try {
      bundle('@fixture/base').preset('missing')
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError)
      expect((error as ResolutionError).code).toBe('resolution.preset_not_found')
      expect((error as ResolutionError).message).toContain('"missing"')
    }
  })

  it('reports a missing anchor instead of falling back', () => {
    delete process.env.EEDSH_DSH_ANCHOR
    try {
      bundle('@fixture/base').rows()
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError)
      expect((error as ResolutionError).code).toBe('resolution.anchor_missing')
      expect((error as ResolutionError).message).toContain('EEDSH_DSH_ANCHOR')
    }
  })

  it('reports malformed patch files instead of partial rows', async () => {
    await writeFile(join(fixture.baseDir, 'cordis.patch.yml'), '- insert: not-a-list\n')
    try {
      bundle('@fixture/base').rows()
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError)
      expect((error as ResolutionError).code).toBe('resolution.patch_invalid')
      expect((error as ResolutionError).message).toContain('@fixture/base')
    }
  })

  it('reports both roots as a conflict', () => {
    const rooted = new BundleQuery('@fixture/custom', {
      profile: 'work',
      packageDir: fixture.packageDir,
    })
    try {
      rooted.rows()
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError)
      expect((error as ResolutionError).code).toBe('resolution.root_conflict')
    }
  })
})
describe('layer patches', () => {
  it('appends patches in call order and returns the layer', () => {
    const row = bundle('@fixture/base').row('timer')
    const preset = bundle('@fixture/base').preset('standard')
    const layer = new LayerBuilder('order')
    const chained = layer
      .insert([{ id: 'inserted', name: '@scope/inserted' }])
      .disable(row)
      .enable(preset)
      .override(row, { interval: 5 })
      .raw({ id: 'raw-row', extra: { a: 1 } })
    expect(chained).toBe(layer)
    expect(layer.id).toBe('order')
    expect(layer.patches).toEqual([
      { insert: [{ id: 'inserted', name: '@scope/inserted' }] },
      { id: 'timer', disabled: true },
      { id: 'preset-standard', disabled: false },
      { id: 'timer', config: { interval: 5 } },
      { id: 'raw-row', extra: { a: 1 } },
    ])
    expect(layer.toJSON()).toEqual({ id: 'order', patches: layer.patches })
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

  it('rejects an invalid patch target', () => {
    expect(() => new LayerBuilder('bad').disable({} as never)).toThrowError(ResolutionError)
  })
})
