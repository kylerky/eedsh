import {
  bundle,
  defineProfile,
  generated as generatedMarker,
  insert,
  override,
  type ProfilePlan,
  layer as planLayer,
} from '@eedsh/config'
import { Effect, Layer } from 'effect'
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
  preflightLayer,
} from '../../src/preflight'

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
  return defineProfile({
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
  return Effect.runPromise(Effect.either(effect))
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
    expect(result.warnings.join('\n')).toMatch(/missing-first[\s\S]*missing-middle[\s\S]*missing-last/)

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
      attributePreflightWarnings(
        [{ label: 'bundle:only', patches: basePatches }],
        [],
      ),
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
    expect(result._tag).toBe('Right')
    if (result._tag !== 'Right') return
    expect(result.right.warnings).toHaveLength(1)
    expect(result.right.warnings[0]).toContain('missing-row')
    expect(result.right.warnings[0]).not.toContain('generated:overrides:')
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
    expect(result._tag).toBe('Right')
    if (result._tag !== 'Right') return
    expect(result.right.warnings).toHaveLength(1)
    expect(result.right.warnings[0]).toMatch(/^generated:overrides: /)
    expect(result.right.warnings[0]).toContain('missing-row')
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
    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    expect(result.left._tag).toBe('PreflightFailure')
    expect(result.left.warnings).toHaveLength(1)
    expect(result.left.warnings[0]).toContain('missing-row')
    expect(result.left.warnings[0]).not.toContain('generated:overrides:')
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
    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    expect(result.left._tag).toBe('PreflightFailure')
    expect(result.left.warnings).toHaveLength(1)
    expect(result.left.warnings[0]).toMatch(/^generated:overrides: /)
    expect(result.left.warnings[0]).toContain('missing-row')
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
    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    expect(result.left._tag).toBe('PreflightFailure')
    expect(result.left.message).toContain('dup')
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
    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    expect(result.left._tag).toBe('PreflightFailure')
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
    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    expect(result.left._tag).toBe('PreflightFailure')
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
    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    expect(result.left._tag).toBe('PreflightFailure')
    expect(result.left.message).toContain('@deepseek-ai/dsh-base')
  })
})
