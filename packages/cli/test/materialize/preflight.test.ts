import { definePreset, LayerBuilder } from '@eedsh/config'
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
      {
        label: 'generated:overrides',
        patches: [{ id: 'missing-row', config: { interval: 1 } }],
      },
    ]
    const result = composePreflightLayers(layers, {
      generatedLayerLabels: ['generated:overrides'],
    })
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
      {
        label: 'generated:middle',
        patches: [{ id: 'missing-middle', config: {} }],
      },
      {
        label: 'bundle:last',
        patches: [{ id: 'missing-last', config: {} }],
      },
    ]
    const result = composePreflightLayers(layers, {
      generatedLayerLabels: ['generated:middle'],
    })
    expect(result.warnings).toHaveLength(3)
    expect(result.warnings.join('\n')).toMatch(
      /missing-first[\s\S]*missing-middle[\s\S]*missing-last/,
    )

    const attributed = attributePreflightWarnings(layers, result.warnings)
    expect(attributed.map((warning) => warning.layer)).toEqual([
      'bundle:first',
      'generated:middle',
      'bundle:last',
    ])
    expect(attributed.map((warning) => warning.message)).toEqual(result.warnings)
    expect(attributed.map((warning) => `${warning.layer}: ${warning.message}`)).toEqual([
      `bundle:first: ${result.warnings[0]}`,
      `generated:middle: ${result.warnings[1]}`,
      `bundle:last: ${result.warnings[2]}`,
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
      { label: 'generated:middle', patches: [{ id: 'timer', config: { ms: 2 } }] },
      { label: 'bundle:second', patches: [{ id: 'timer', config: { ms: 3 } }] },
    ]
    const result = composePreflightLayers(layers, {
      generatedLayerLabels: ['generated:middle'],
    })
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
      { label: 'generated:one', patches: [{ insert: [{ id: 'dup', name: 'a' }] }] },
      { label: 'generated:two', patches: [{ insert: [{ id: 'dup', name: 'b' }] }] },
    ]
    const result = composePreflightLayers(layers, {
      generatedLayerLabels: ['generated:one', 'generated:two'],
    })
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
    return {
      label: 'generated:registry',
      patches: layer.patches as Record<string, unknown>[],
    }
  }

  it('composes the selected registry config over a bundle registry row', () => {
    const layers: PreflightLayer[] = [
      { label: 'bundle:@fixture/base', patches: [{ insert: [registryRow] }] },
      selectionLayer(),
    ]
    const result = composePreflightLayers(layers, {
      generatedLayerLabels: ['generated:registry'],
    })
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
    const result = composePreflightLayers(layers, {
      generatedLayerLabels: ['generated:registry'],
    })
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('agent-preset-registry')
    const attributed = attributePreflightWarnings(layers, result.warnings)
    expect(attributed).toEqual([
      { layer: 'generated:registry', message: result.warnings[0] },
    ])
    expect(result.entries.map((entry) => entry.id)).toEqual(['timer'])
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
    expect(result.success.warnings[0]).toMatch(/^generated:overrides: /)
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
    expect(result.failure.warnings[0]).toMatch(/^generated:overrides: /)
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
