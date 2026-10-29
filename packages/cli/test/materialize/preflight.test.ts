import { type AuthoringSite, definePreset, LayerBuilder } from '@eedsh/config'
import type { ProfilePlan } from '@eedsh/plan'
import { Effect, Layer } from 'effect'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import { DshResolveFailure } from '../../src/internal/effect/errors'
import {
  DshInstallation,
  type DshInstallationShape,
  Preflight,
  type PreflightInput,
} from '../../src/internal/effect/services'
import { buildGeneratedBundle, type GeneratedBundle } from '../../src/materialize/generated-bundle'
import {
  attributePreflightWarnings,
  composePreflightLayers,
  type PreflightLayer,
  parseGeneratedLayers,
  preflightLayer,
} from '../../src/preflight'
import { planOf } from '../support/plan'
import {
  bundle,
  generated as generatedMarker,
  insert,
  override,
  layer as planLayer,
} from '../support/plan-parts'

const managedBundles = ['@deepseek-ai/dsh-base', '@eedsh/runtime', '@eedsh/generated']

function buildGenerated(plan: ProfilePlan): GeneratedBundle {
  return buildGeneratedBundle({
    plan,
    managedBundles,
    packages: {},
    eedshVersion: '0.0.0',
    dshVersion: '0.2.1-rc.2',
  })
}

function fixturePlan(layers: ProfilePlan['layers']): ProfilePlan {
  return planOf({
    name: 'work',
    dsh: '0.2.1-rc.2',
    bundles: [bundle('@deepseek-ai/dsh-base'), generatedMarker()],
    layers,
  })
}

const basePatches = [{ insert: [{ id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' }] }]

function groupLayer(
  position: number,
  patches: Record<string, unknown>[],
  options: {
    readonly label?: string
    readonly sites?: readonly (AuthoringSite | undefined)[]
  } = {},
): PreflightLayer {
  return {
    label: `generated #${position}`,
    patches,
    generated: { position, label: options.label, sites: options.sites ?? [] },
  }
}

function fakeDsh(resolve: DshInstallationShape['resolveBundlePatches']): DshInstallationShape {
  return {
    version: '0.2.1-rc.2',
    installAnchor: '/dsh/package.json',
    binPath: '/dsh/bin.js',
    resolveBundlePatches: resolve,
  }
}

async function runCheck(input: PreflightInput, dsh: DshInstallationShape) {
  const layer = preflightLayer.pipe(Layer.provide(Layer.succeed(DshInstallation, dsh)))
  const effect = Effect.gen(function* () {
    const service = yield* Preflight
    return yield* service.check(input)
  }).pipe(Effect.provide(layer))
  return Effect.runPromise(Effect.result(effect))
}

describe('preflight composition', () => {
  it('composes once and reports raw unmatched targets', () => {
    const layers: PreflightLayer[] = [
      { label: 'bundle:@deepseek-ai/dsh-base', patches: basePatches },
      groupLayer(1, [{ id: 'missing-row', config: { interval: 1 } }], { label: 'overrides' }),
    ]
    const result = composePreflightLayers(layers)
    expect(result.entries).toEqual(basePatches[0]!.insert)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('"missing-row"')
    expect(result.warnings[0]).not.toContain('generated:overrides:')
  })

  it('attributes warnings from the first, middle, and last layers in raw order', () => {
    const layers: PreflightLayer[] = [
      {
        label: 'bundle:first',
        patches: [{ id: 'missing-first', config: {} }],
      },
      groupLayer(1, [{ id: 'missing-middle', config: {} }], {
        label: 'middle',
        sites: [{ file: '/work/config.ts', line: 4, column: 7 }],
      }),
      {
        label: 'bundle:last',
        patches: [{ id: 'missing-last', config: {} }],
      },
    ]
    const result = composePreflightLayers(layers)
    expect(result.warnings).toHaveLength(3)
    expect(result.warnings.join('\n')).toMatch(
      /missing-first[\s\S]*missing-middle[\s\S]*missing-last/,
    )

    const attributed = attributePreflightWarnings(layers, result.warnings, {
      configDir: '/work',
    })
    expect(attributed.map((warning) => warning.layer)).toEqual([
      'bundle:first',
      'generated #1 "middle" (config.ts:4:7) [missing-middle]',
      'bundle:last',
    ])
    expect(attributed.map((warning) => warning.message)).toEqual(result.warnings)
    expect(attributed.map((warning) => `${warning.layer}: ${warning.message}`)).toEqual([
      `bundle:first: ${result.warnings[0]}`,
      `generated #1 "middle" (config.ts:4:7) [missing-middle]: ${result.warnings[1]}`,
      `bundle:last: ${result.warnings[2]}`,
    ])
  })

  it('attributes the offending patch by position, site, and touched row ids', () => {
    const layers: PreflightLayer[] = [
      { label: 'bundle:base', patches: basePatches },
      groupLayer(
        2,
        [
          { insert: [{ id: 'ok-row', name: '@scope/ok' }] },
          { insert: [{ id: 'nested-group', group: true, config: [] }] },
          { id: 'missing-row', config: {} },
        ],
        {
          label: 'lsp',
          sites: [undefined, undefined, { file: '/work/config.ts', line: 9, column: 5 }],
        },
      ),
    ]
    const result = composePreflightLayers(layers)
    expect(result.warnings).toHaveLength(1)
    const attributed = attributePreflightWarnings(layers, result.warnings, {
      configDir: '/work',
    })
    expect(attributed).toEqual([
      {
        layer: 'generated #2 "lsp" (config.ts:9:5) [missing-row]',
        message: result.warnings[0],
      },
    ])
  })

  it('keeps a bundle label for a warning a bundle produced', () => {
    const layers: PreflightLayer[] = [
      { label: 'bundle:@fixture/base', patches: [{ id: 'missing-from-bundle', config: {} }] },
      groupLayer(1, basePatches),
    ]
    const result = composePreflightLayers(layers)
    const attributed = attributePreflightWarnings(layers, result.warnings)
    expect(attributed.map((warning) => warning.layer)).toEqual(['bundle:@fixture/base'])
  })

  it('attributes an empty generated group with the same prefix', () => {
    const layers: PreflightLayer[] = [
      groupLayer(1, []),
      groupLayer(2, [{ id: 'missing-row', config: {} }]),
    ]
    const result = composePreflightLayers(layers)
    const attributed = attributePreflightWarnings(layers, result.warnings)
    expect(attributed.map((warning) => warning.layer)).toEqual([
      'generated #2 [missing-row]',
      'generated #1',
    ])
    expect(attributed.map((warning) => `${warning.layer}: ${warning.message}`)).toEqual([
      `generated #2 [missing-row]: ${result.warnings[0]}`,
      'generated #1: contains no patches',
    ])
  })

  it('returns no attributed warnings when there are no raw warnings', () => {
    expect(attributePreflightWarnings([], [])).toEqual([])
    expect(
      attributePreflightWarnings([{ label: 'bundle:only', patches: basePatches }], []),
    ).toEqual([])
  })

  it('composes the generated layer at the marker position', () => {
    const layers: PreflightLayer[] = [
      {
        label: 'bundle:first',
        patches: [
          {
            insert: [
              {
                id: 'timer',
                name: '@deepseek-ai/cordis-plugin-timer',
                config: { ms: 1 },
              },
            ],
          },
        ],
      },
      groupLayer(1, [{ id: 'timer', config: { ms: 2 } }]),
      { label: 'bundle:second', patches: [{ id: 'timer', config: { ms: 3 } }] },
    ]
    const result = composePreflightLayers(layers)
    expect(result.entries).toEqual([
      { id: 'timer', name: '@deepseek-ai/cordis-plugin-timer', config: { ms: 3 } },
    ])
    expect(result.warnings).toEqual([])
  })

  it('parses generated layers as a Result', () => {
    const plan = fixturePlan([planLayer('base', [override('timer', { interval: 1 })])])
    const generated = buildGenerated(plan)
    const result = parseGeneratedLayers(generated)
    expect(Result.isSuccess(result)).toBe(true)

    const tampered: GeneratedBundle = {
      ...generated,
      files: generated.files.map((file) =>
        file.path.endsWith('.yml') ? { ...file, content: 'not: an array\n' } : file,
      ),
    }
    const failed = parseGeneratedLayers(tampered)
    expect(Result.isFailure(failed)).toBe(true)
    if (Result.isFailure(failed)) {
      expect(failed.failure._tag).toBe('PreflightFailure')
      expect(failed.failure.message).toContain('must be a top-level YAML array')
    }
  })

  it('rejects a non-object generated patch entry', () => {
    const plan = fixturePlan([planLayer('base', [override('timer', { interval: 1 })])])
    const generated = buildGenerated(plan)
    const tampered: GeneratedBundle = {
      ...generated,
      files: generated.files.map((file) =>
        file.path.endsWith('.yml') ? { ...file, content: '- 42\n' } : file,
      ),
    }
    const failed = parseGeneratedLayers(tampered)
    expect(Result.isFailure(failed)).toBe(true)
    if (Result.isFailure(failed)) {
      expect(failed.failure._tag).toBe('PreflightFailure')
      expect(failed.failure.message).toContain('contains a non-object patch entry')
    }
  })

  it('rejects duplicate ids inserted by generated layers', () => {
    const layers: PreflightLayer[] = [
      groupLayer(1, [{ insert: [{ id: 'dup', name: 'a' }] }]),
      groupLayer(2, [{ insert: [{ id: 'dup', name: 'b' }] }]),
    ]
    const result = composePreflightLayers(layers)
    expect(result.duplicateInsertIds).toEqual(['dup'])
  })
})

describe('preset selection composition', () => {
  const registryRow = {
    id: 'agent-preset-registry',
    name: '@deepseek-ai/dsh-agent-preset-registry',
    config: { default: 'standard' },
  }

  function selectionLayer(): PreflightLayer {
    const layer = new LayerBuilder('registry').selectPreset(definePreset('ptc-fresh'), {
      default: definePreset('standard'),
    })
    return groupLayer(1, layer.patches as Record<string, unknown>[], { label: 'registry' })
  }

  it('composes the selected registry config over a bundle registry row', () => {
    const layers: PreflightLayer[] = [
      { label: 'bundle:@fixture/base', patches: [{ insert: [registryRow] }] },
      selectionLayer(),
    ]
    const result = composePreflightLayers(layers)
    expect(result.warnings).toEqual([])
    expect(result.entries).toEqual([
      {
        id: 'agent-preset-registry',
        name: '@deepseek-ai/dsh-agent-preset-registry',
        config: { default: 'standard', selectedDefault: 'ptc-fresh' },
      },
    ])
  })

  it('leaves a missing registry row as an attributed preflight warning', () => {
    const layers: PreflightLayer[] = [
      { label: 'bundle:@fixture/base', patches: basePatches },
      selectionLayer(),
    ]
    const result = composePreflightLayers(layers)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('agent-preset-registry')
    const attributed = attributePreflightWarnings(layers, result.warnings)
    expect(attributed).toEqual([
      {
        layer: 'generated #1 "registry" [agent-preset-registry]',
        message: result.warnings[0],
      },
    ])
    expect(result.entries.map((entry) => entry.id)).toEqual(['timer'])
  })
})

describe('empty generated layers', () => {
  it('warns once in raw mode and names the empty layer', async () => {
    const plan = fixturePlan([
      planLayer('empty', []),
      planLayer('base', [override('timer', { interval: 1 })]),
    ])
    const generated = buildGenerated(plan)
    const result = await runCheck(
      {
        plan,
        profileDir: '/profiles/work',
        generated,
        strict: false,
        explain: false,
      },
      fakeDsh(() => Effect.succeed(basePatches)),
    )
    expect(result._tag).toBe('Success')
    if (result._tag !== 'Success') return
    expect(result.success.warnings).toHaveLength(1)
    expect(result.success.warnings[0]).toBe('generated #1: contains no patches')
    expect(buildGenerated(plan)).toEqual(generated)
  })

  it('attributes the empty-layer warning when explain is enabled', async () => {
    const plan = fixturePlan([planLayer('empty', [])])
    const result = await runCheck(
      {
        plan,
        profileDir: '/profiles/work',
        generated: buildGenerated(plan),
        strict: false,
        explain: true,
      },
      fakeDsh(() => Effect.succeed(basePatches)),
    )
    expect(result._tag).toBe('Success')
    if (result._tag !== 'Success') return
    expect(result.success.warnings).toHaveLength(1)
    expect(result.success.warnings[0]).toMatch(/^generated #1: contains no patches$/)
  })

  it('fails strict without changing the plan or generated output', async () => {
    const plan = fixturePlan([planLayer('empty', [])])
    const generated = buildGenerated(plan)
    const result = await runCheck(
      {
        plan,
        profileDir: '/profiles/work',
        generated,
        strict: true,
        explain: false,
      },
      fakeDsh(() => Effect.succeed(basePatches)),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    expect(result.failure._tag).toBe('PreflightFailure')
    expect(result.failure.warnings).toHaveLength(1)
    expect(result.failure.warnings[0]).toBe('generated #1: contains no patches')
    const emptyFile = generated.files.find((file) => file.path.endsWith('0001.yml'))
    expect(emptyFile?.content).toBe('[]\n')
    expect(buildGenerated(plan)).toEqual(generated)
  })

  it('does not warn for an empty bundle layer or a filled generated layer', () => {
    const layers: PreflightLayer[] = [
      { label: 'bundle:empty-bundle', patches: [] },
      groupLayer(1, [{ insert: [{ id: 'filled-row', name: '@scope/filled' }] }]),
    ]
    const result = composePreflightLayers(layers)
    expect(result.warnings).toEqual([])
    expect(result.emptyLayerLabels).toEqual([])
    expect(result.entries.map((entry) => entry.id)).toEqual(['filled-row'])
  })

  it('attributes an empty-layer warning alongside composition warnings', () => {
    const layers: PreflightLayer[] = [
      { label: 'bundle:@deepseek-ai/dsh-base', patches: basePatches },
      groupLayer(1, [{ id: 'missing-row', config: { interval: 1 } }], { label: 'target' }),
      groupLayer(2, [], { label: 'empty' }),
    ]
    const result = composePreflightLayers(layers)
    expect(result.warnings).toHaveLength(2)
    expect(result.emptyLayerLabels).toEqual(['generated #2 "empty"'])
    const attributed = attributePreflightWarnings(layers, result.warnings)
    expect(attributed.map((warning) => warning.layer)).toEqual([
      'generated #1 "target" [missing-row]',
      'generated #2 "empty"',
    ])
    expect(attributed.map((warning) => warning.message)).toEqual([
      result.warnings[0],
      'contains no patches',
    ])
  })
})

describe('preflight checks', () => {
  it('returns raw warnings by default', async () => {
    const plan = fixturePlan([planLayer('overrides', [override('missing-row', { interval: 1 })])])
    const result = await runCheck(
      {
        plan,
        profileDir: '/profiles/work',
        generated: buildGenerated(plan),
        strict: false,
        explain: false,
      },
      fakeDsh(() => Effect.succeed(basePatches)),
    )
    expect(result._tag).toBe('Success')
    if (result._tag !== 'Success') return
    expect(result.success.warnings).toHaveLength(1)
    expect(result.success.warnings[0]).toContain('missing-row')
    expect(result.success.warnings[0]).not.toContain('generated:overrides:')
  })

  it('attributes warnings when explain is enabled', async () => {
    const plan = fixturePlan([planLayer('overrides', [override('missing-row', { interval: 1 })])])
    const result = await runCheck(
      {
        plan,
        profileDir: '/profiles/work',
        generated: buildGenerated(plan),
        strict: false,
        explain: true,
      },
      fakeDsh(() => Effect.succeed(basePatches)),
    )
    expect(result._tag).toBe('Success')
    if (result._tag !== 'Success') return
    expect(result.success.warnings).toHaveLength(1)
    expect(result.success.warnings[0]).toMatch(/^generated #1 \[missing-row\]: /)
    expect(result.success.warnings[0]).toContain('missing-row')
  })

  it('fails with raw warnings in strict mode by default', async () => {
    const plan = fixturePlan([planLayer('overrides', [override('missing-row', { interval: 1 })])])
    const result = await runCheck(
      {
        plan,
        profileDir: '/profiles/work',
        generated: buildGenerated(plan),
        strict: true,
        explain: false,
      },
      fakeDsh(() => Effect.succeed(basePatches)),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    expect(result.failure._tag).toBe('PreflightFailure')
    expect(result.failure.warnings).toHaveLength(1)
    expect(result.failure.warnings[0]).toContain('missing-row')
    expect(result.failure.warnings[0]).not.toContain('generated:overrides:')
  })

  it('fails with attributed warnings in strict mode when explain is enabled', async () => {
    const plan = fixturePlan([planLayer('overrides', [override('missing-row', { interval: 1 })])])
    const result = await runCheck(
      {
        plan,
        profileDir: '/profiles/work',
        generated: buildGenerated(plan),
        strict: true,
        explain: true,
      },
      fakeDsh(() => Effect.succeed(basePatches)),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    expect(result.failure._tag).toBe('PreflightFailure')
    expect(result.failure.warnings).toHaveLength(1)
    expect(result.failure.warnings[0]).toMatch(/^generated #1 \[missing-row\]: /)
    expect(result.failure.warnings[0]).toContain('missing-row')
  })

  it('rejects duplicate inserted ids before publication', async () => {
    const plan = fixturePlan([
      planLayer('one', [insert({ id: 'dup', name: 'a' })]),
      planLayer('two', [insert({ id: 'dup', name: 'b' })]),
    ])
    const result = await runCheck(
      {
        plan,
        profileDir: '/profiles/work',
        generated: buildGenerated(plan),
        strict: false,
        explain: false,
      },
      fakeDsh(() => Effect.succeed(basePatches)),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    expect(result.failure._tag).toBe('PreflightFailure')
    expect(result.failure.message).toContain('dup')
  })

  it('rejects a malformed generated patch file', async () => {
    const plan = fixturePlan([planLayer('bad', [override('timer', { interval: 1 })])])
    const generated = buildGenerated(plan)
    const tampered: GeneratedBundle = {
      ...generated,
      files: generated.files.map((file) =>
        file.path.endsWith('.yml') ? { ...file, content: 'not: an array\n' } : file,
      ),
    }
    const result = await runCheck(
      {
        plan,
        profileDir: '/profiles/work',
        generated: tampered,
        strict: false,
        explain: false,
      },
      fakeDsh(() => Effect.succeed(basePatches)),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    expect(result.failure._tag).toBe('PreflightFailure')
  })

  it('rejects a plan expression leaking into emitted data', async () => {
    const plan = fixturePlan([planLayer('bad', [override('timer', { interval: 1 })])])
    const generated = buildGenerated(plan)
    const leaked: GeneratedBundle = {
      ...generated,
      files: generated.files.map((file) =>
        file.path.endsWith('.yml')
          ? { ...file, content: '- id: timer\n  config:\n    $eedsh:\n      expr: x\n' }
          : file,
      ),
    }
    const result = await runCheck(
      {
        plan,
        profileDir: '/profiles/work',
        generated: leaked,
        strict: false,
        explain: false,
      },
      fakeDsh(() => Effect.succeed(basePatches)),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    expect(result.failure._tag).toBe('PreflightFailure')
  })

  it('fails with a tagged preflight failure when a target bundle cannot be resolved', async () => {
    const plan = fixturePlan([planLayer('base', [override('timer', { interval: 1 })])])
    const result = await runCheck(
      {
        plan,
        profileDir: '/profiles/work',
        generated: buildGenerated(plan),
        strict: false,
        explain: false,
      },
      fakeDsh(() =>
        Effect.fail(new DshResolveFailure({ packageName: '@deepseek-ai/dsh-base', cause: 'gone' })),
      ),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    expect(result.failure._tag).toBe('PreflightFailure')
    expect(result.failure.message).toContain('@deepseek-ai/dsh-base')
  })
})
