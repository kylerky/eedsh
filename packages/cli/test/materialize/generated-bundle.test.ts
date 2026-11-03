import { createHash } from 'node:crypto'
import { canonicalJson, type ProfilePlan } from '@eedsh/plan'
import { describe, expect, it } from 'vitest'
import { buildGeneratedBundle, generationIdFor } from '../../src/materialize/generated-bundle'
import { classifyGenerationRecord } from '../../src/materialize/generation-record'
import { emitPatchesYaml } from '../../src/materialize/yaml'
import { planOf } from '../support/plan'
import { bundle, generated, insert, js, layer, override } from '../support/plan-parts'

function fixturePlan(): ProfilePlan {
  return planOf({
    name: 'work',
    bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
    layers: [
      layer('base', [
        insert({
          id: 'timer',
          name: '@deepseek-ai/cordis-plugin-timer',
          config: { interval: 1000 },
        }),
      ]),
      layer('overrides', [override('timer', { interval: 2000 })]),
      layer('expressions', [
        insert({
          id: 'plugin-manager',
          name: '@deepseek-ai/dsh-plugin-manager',
          disabled: js("!ctx.get('profileContext')"),
        }),
      ]),
    ],
  })
}

const managedBundles = ['@deepseek-ai/dsh-base', '@eedsh/runtime', '@eedsh/generated']
const packages = {
  '@eedsh/runtime': 'link:/repo/packages/runtime',
  '@eedsh/generated': 'link:./.eedsh/generated',
}

function build(plan: ProfilePlan = fixturePlan()) {
  return buildGeneratedBundle({
    plan,
    managedBundles,
    packages,
    eedshVersion: '0.0.0',
    dshVersion: '0.2.1-rc.2',
  })
}

describe('generated bundle', () => {
  it('emits one versioned patch file per layer, in plan order', () => {
    const result = build()
    expect(result.generationId).toMatch(/^[0-9a-f]{64}$/)
    const patchFiles = result.files.filter((file) => file.path.endsWith('.yml'))
    expect(patchFiles.map((file) => file.path)).toEqual([
      `patches/${result.generationId}/0001.yml`,
      `patches/${result.generationId}/0002.yml`,
      `patches/${result.generationId}/0003.yml`,
    ])
  })

  it('describes the bundle through dsh.bundle.patch in application order', () => {
    const result = build()
    expect(result.manifest.dsh.bundle.patch).toEqual(
      result.generation.layers.map((entry) => `./${entry.file}`),
    )
    expect(result.manifest.name).toBe('@eedsh/generated')
    expect(result.manifest.private).toBe(true)
    expect('engines' in result.manifest).toBe(false)
    const manifest = JSON.parse(result.files.at(-1)?.content ?? '{}') as Record<string, unknown>
    expect(manifest.engines).toBeUndefined()
    expect(manifest.dsh).toEqual({
      bundle: { patch: result.generation.layers.map((entry) => `./${entry.file}`) },
    })
  })

  it('records provenance in the eedsh metadata block', () => {
    const result = build()
    const metadata = result.manifest.eedsh
    expect(metadata.format).toBe('eedsh/generation')
    expect(metadata.version).toBe(1)
    expect(metadata.generationId).toBe(result.generationId)
    expect(metadata.planHash).toBe(result.planHash)
    expect(metadata.eedshVersion).toBe('0.0.0')
    expect(metadata.dshVersion).toBe('0.2.1-rc.2')
    expect(typeof metadata.dshVersion).toBe('string')
    expect(metadata.bundles).toEqual(managedBundles)
    expect(metadata.packages).toEqual(packages)
    expect(metadata.layers.map((entry) => entry.file)).toEqual([
      `patches/${result.generationId}/0001.yml`,
      `patches/${result.generationId}/0002.yml`,
      `patches/${result.generationId}/0003.yml`,
    ])
    for (const entry of metadata.layers) {
      expect(entry.file).toMatch(/^patches\/[0-9a-f]{64}\/\d{4,}\.yml$/)
      expect(entry.hash).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('records layer files without an identifier', () => {
    const result = build()
    for (const entry of result.generation.layers) {
      expect('id' in entry).toBe(false)
    }
  })

  it('still classifies a legacy record whose layers carry an id', () => {
    const result = build()
    const legacy = {
      ...result.manifest,
      eedsh: {
        ...result.manifest.eedsh,
        layers: result.manifest.eedsh.layers.map((entry, index) => ({
          id: ['base', 'overrides', 'expressions'][index],
          file: entry.file,
          hash: entry.hash,
        })),
      },
    }
    const classified = classifyGenerationRecord(legacy, '/profile/.eedsh/generated/package.json')
    expect(classified._tag).toBe('valid')
    if (classified._tag !== 'valid') return
    expect(classified.record.layers.map((entry) => entry.file)).toEqual(
      result.generation.layers.map((entry) => entry.file),
    )
  })

  it('rejects a record whose layer has no file', () => {
    const result = build()
    const malformed = {
      ...result.manifest,
      eedsh: {
        ...result.manifest.eedsh,
        layers: result.manifest.eedsh.layers.map(({ file: _file, ...rest }) => rest),
      },
    }
    const classified = classifyGenerationRecord(malformed, '/profile/.eedsh/generated/package.json')
    expect(classified._tag).toBe('invalid')
    if (classified._tag !== 'invalid') return
    expect(classified.reason).toBe('layers')
  })

  it('writes the generated package manifest last', () => {
    const result = build()
    expect(result.files.at(-1)?.path).toBe('package.json')
    expect(JSON.parse(result.files.at(-1)?.content ?? '{}')).toEqual(result.manifest)
  })

  it('writes the authoritative plan immediately before the package manifest', () => {
    const result = build()
    const planPath = `plans/${result.generationId}.json`
    expect(result.files.at(-2)?.path).toBe(planPath)
    expect(result.files.at(-1)?.path).toBe('package.json')
    const content = result.files.at(-2)?.content ?? ''
    expect(content).toBe(canonicalJson(fixturePlan()))
    expect(createHash('sha256').update(content).digest('hex')).toBe(result.planHash)
    expect(result.authoritativePlanPath).toBe(planPath)
    expect(result.authoritativePlanContent).toBe(content)
  })

  it('keeps the stable plan mirror distinct from the authoritative plan', () => {
    const result = build()
    expect(result.planPath).toBe('.eedsh/plan.json')
    expect(result.planContent).toBe(`${result.authoritativePlanContent}\n`)
  })

  it('emits the validated plan as canonical JSON', () => {
    const result = build()
    expect(result.planPath).toBe('.eedsh/plan.json')
    expect(result.planContent.endsWith('\n')).toBe(true)
    expect(JSON.parse(result.planContent)).toEqual(fixturePlan())
  })

  it('keeps the generation id and file content stable for an unchanged plan', () => {
    const first = build()
    const second = build()
    expect(second.generationId).toBe(first.generationId)
    expect(second.files).toEqual(first.files)
  })

  it('changes the generation id and the affected layer hash when a layer changes', () => {
    const original = fixturePlan()
    const changed: ProfilePlan = {
      ...original,
      layers: [
        original.layers[0]!,
        { id: 'overrides', patches: [{ id: 'timer', config: { interval: 3000 } }] },
        original.layers[2]!,
      ],
    }
    const before = build(original)
    const after = build(changed)
    expect(after.generationId).not.toBe(before.generationId)
    const beforeHashes = before.generation.layers.map((entry) => entry.hash)
    const afterHashes = after.generation.layers.map((entry) => entry.hash)
    expect(afterHashes[1]).not.toBe(beforeHashes[1])
    expect(afterHashes[0]).toBe(beforeHashes[0])
    expect(afterHashes[2]).toBe(beforeHashes[2])
  })

  it('computes the generation id from the plan hash and layer hashes', () => {
    const result = build()
    expect(
      generationIdFor({
        planHash: result.planHash,
        layers: result.generation.layers,
      }),
    ).toBe(result.generationId)
  })
})

describe('yaml emission', () => {
  it('emits expressions as !!js scalars that survive a DSH patch parse', async () => {
    const yaml = await import('js-yaml')
    const { entryListSchema } = await import('../../src/materialize/yaml-schema')
    const text = emitPatchesYaml([
      {
        insert: [
          {
            id: 'plugin-manager',
            name: '@deepseek-ai/dsh-plugin-manager',
            disabled: js("!ctx.get('profileContext')"),
          },
        ],
      },
    ])
    expect(text).toContain('!!js')
    const parsed = yaml.load(text, { schema: entryListSchema }) as unknown
    expect(parsed).toEqual([
      {
        insert: [
          {
            id: 'plugin-manager',
            name: '@deepseek-ai/dsh-plugin-manager',
            disabled: { __jsExpr: "!ctx.get('profileContext')" },
          },
        ],
      },
    ])
  })
})
describe('preset expression emission', () => {
  it('emits nested preset child expressions that survive the DSH patch parse', async () => {
    const yaml = await import('js-yaml')
    const { entryListSchema } = await import('../../src/materialize/yaml-schema')
    const plan = planOf({
      name: 'work',
      bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
      layers: [
        layer('preset', [
          insert({
            id: 'preset-expressive',
            name: '@deepseek-ai/dsh-agent-preset',
            config: {
              id: 'expressive',
              plugins: [
                {
                  id: 'tool-web',
                  name: '@deepseek-ai/dsh-tool-web',
                  disabled: js("!ctx.get('profileContext')"),
                },
                {
                  id: 'tool-todo',
                  name: '@deepseek-ai/dsh-tool-todo',
                  config: { label: js("ctx.get('profileContext').label") },
                },
              ],
            },
          }),
        ]),
      ],
    })
    const result = build(plan)
    const layerFile = result.files.find((file) => file.path.endsWith('.yml'))
    expect(layerFile?.content).toContain('!!js')
    expect(layerFile?.content).not.toContain('$eedsh')
    const parsed = yaml.load(layerFile?.content ?? '', { schema: entryListSchema }) as unknown
    expect(parsed).toMatchObject([
      {
        insert: [
          {
            config: {
              plugins: [
                { id: 'tool-web', disabled: { __jsExpr: "!ctx.get('profileContext')" } },
                {
                  id: 'tool-todo',
                  config: { label: { __jsExpr: "ctx.get('profileContext').label" } },
                },
              ],
            },
          },
        ],
      },
    ])
  })
})

describe('DSH round-trip', () => {
  it('composes emitted layers through the DSH patch loader', async () => {
    const { mkdir, mkdtemp, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { composeEntries, loadOverlayPatches } = await import('@deepseek-ai/dsh-app-boot')

    const source = "ctx.get('profileContext') ? \"x: y\" : (1 + 2) * ctx.get('nested')(3)"
    const plan = planOf({
      name: 'work',
      bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
      layers: [
        layer('expressive', [
          insert({
            id: 'plugin-manager',
            name: '@deepseek-ai/dsh-plugin-manager',
            disabled: js("!ctx.get('profileContext')"),
          }),
          override('timer', { interval: 250, adaptive: js(source) }),
        ]),
      ],
    })
    const result = buildGeneratedBundle({
      plan,
      managedBundles,
      packages,
      eedshVersion: '0.0.0',
      dshVersion: '0.2.1-rc.2',
    })
    const layerFile = result.files.find((file) => file.path.endsWith('.yml'))
    expect(layerFile).toBeDefined()

    await mkdir(join(process.cwd(), '.tmp'), { recursive: true })
    const dir = await mkdtemp(join(process.cwd(), '.tmp', 'round-trip-'))
    const patchFile = join(dir, 'expressive.yml')
    await writeFile(patchFile, layerFile?.content ?? '', 'utf8')

    const patches = loadOverlayPatches('eedsh', patchFile)
    const warnings: string[] = []
    const entries = composeEntries(
      [[{ insert: [{ id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' }] }], patches],
      (warning) => warnings.push(warning),
    )

    expect(warnings).toEqual([])
    expect(entries).toEqual([
      {
        id: 'timer',
        name: '@deepseek-ai/cordis-plugin-timer',
        config: { interval: 250, adaptive: { __jsExpr: source } },
      },
      {
        id: 'plugin-manager',
        name: '@deepseek-ai/dsh-plugin-manager',
        disabled: { __jsExpr: "!ctx.get('profileContext')" },
      },
    ])
  })
})