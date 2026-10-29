import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'
import * as Result from 'effect/Result'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config'
import { buildGeneratedBundle } from '../../src/materialize/generated-bundle'
import { composePreflightLayers, parseGeneratedLayers } from '../../src/preflight'

const root = process.cwd()
const tempRoot = join(root, 'packages/cli/.tmp')
const originalEnv = { ...process.env }

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2))
}

async function writeBundle(base: string, name: string, patch: string): Promise<string> {
  const dir = join(base, 'node_modules', ...name.split('/'))
  await writeJson(join(dir, 'package.json'), {
    name,
    version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  await writeFile(join(dir, 'cordis.patch.yml'), patch)
  return dir
}

let workdir = ''

beforeEach(async () => {
  process.env = { ...originalEnv }
  await mkdir(tempRoot, { recursive: true })
  workdir = await mkdtemp(join(tempRoot, 'authoring-resolution-'))
})

afterEach(() => {
  process.env = { ...originalEnv }
})

describe('authoring resolution integration', () => {
  it('loads config queries through both roots and composes in preflight', async () => {
    const home = join(workdir, 'home')
    const profileDir = join(home, 'profiles', 'work')
    await writeJson(join(profileDir, 'package.json'), {
      name: 'dsh-profile-work',
      private: true,
      dsh: { profile: { bundles: [] } },
    })
    await writeBundle(
      profileDir,
      '@fixture/custom',
      `- insert:
    - id: profile-row
      name: '@fixture/profile-plugin'
`,
    )
    await writeBundle(
      workdir,
      '@fixture/vendored',
      `- insert:
    - id: vendored-row
      name: '@fixture/vendored-plugin'
`,
    )
    process.env.DSH_HOME = home
    const configDir = join(workdir, 'config')
    await mkdir(configDir, { recursive: true })
    const configPath = join(configDir, 'config.ts')
    await writeFile(
      configPath,
      `import { bundle, defineConfig } from '@eedsh/config'

const pinned = bundle('@deepseek-ai/dsh-base').row('timer')
const fromProfile = bundle('@fixture/custom').fromProfile('work').row('profile-row')
const fromDirectory = bundle('@fixture/vendored')
  .fromPackageDir('../node_modules/@fixture/vendored')
  .row('vendored-row')

export default defineConfig()
  .dsh('0.2.1-rc.2')
  .profile('work', (profile) => {
    profile
      .generated()
      .layer('queried', (layer) => {
        layer.insert([pinned, fromProfile, fromDirectory])
      })
  })
  .build()
`,
    )

    const config = await Effect.runPromise(loadConfig(configPath))
    const plan = config.profiles.work
    expect(plan !== undefined && Result.isSuccess(plan)).toBe(true)
    if (plan === undefined || Result.isFailure(plan)) return
    const insert = plan.success.layers[0]?.patches[0]?.insert
    expect(Array.isArray(insert) ? insert.length : 0).toBe(3)
    const layers = plan.success.layers.map((item) => ({
      label: `generated:${item.id}`,
      patches: item.patches as Record<string, unknown>[],
    }))
    const composition = composePreflightLayers(layers, {
      generatedLayerLabels: layers.map((item) => item.label),
    })
    expect(composition.entries.map((entry) => entry.id)).toEqual([
      'timer',
      'profile-row',
      'vendored-row',
    ])
    expect(composition.warnings).toEqual([])
  })

  it('preserves resolved preset expressions through the emitted generated bundle', async () => {
    await writeBundle(
      workdir,
      '@fixture/expressive',
      `- insert:
    - id: preset-expressive
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: expressive
        name: Expressive
        plugins:
          - id: tool-web
            name: '@deepseek-ai/dsh-tool-web'
            disabled: !!js "!ctx.get('profileContext')"
          - id: tool-todo
            name: '@deepseek-ai/dsh-tool-todo'
            config:
              label: !!js "ctx.get('profileContext').label"
`,
    )
    const configDir = join(workdir, 'config')
    await mkdir(configDir, { recursive: true })
    const configPath = join(configDir, 'config.ts')
    await writeFile(
      configPath,
      `import { bundle, defineConfig } from '@eedsh/config'

const expressive = bundle('@fixture/expressive')
  .fromPackageDir('../node_modules/@fixture/expressive')
  .preset('expressive')

export default defineConfig()
  .dsh('0.2.1-rc.2')
  .profile('work', (profile) => {
    profile.generated().layer('preset', (layer) => layer.insert(expressive))
  })
  .build()
`,
    )

    const config = await Effect.runPromise(loadConfig(configPath))
    const plan = config.profiles.work
    expect(plan !== undefined && Result.isSuccess(plan)).toBe(true)
    if (plan === undefined || Result.isFailure(plan)) return
    expect(JSON.stringify(plan.success)).not.toContain('__jsExpr')

    const generated = buildGeneratedBundle({
      plan: plan.success,
      managedBundles: ['@deepseek-ai/dsh-base', '@eedsh/runtime', '@eedsh/generated'],
      packages: {
        '@eedsh/runtime': 'link:/repo/packages/runtime',
        '@eedsh/generated': 'link:./.eedsh/generated',
      },
      eedshVersion: '0.0.0',
      dshVersion: '0.2.1-rc.2',
    })
    const layerFile = generated.files.find((file) => file.path.endsWith('.yml'))
    expect(layerFile?.content).toContain('!!js')
    expect(layerFile?.content).not.toContain('$eedsh')

    const parsed = parseGeneratedLayers(generated)
    expect(Result.isSuccess(parsed)).toBe(true)
    if (Result.isFailure(parsed)) return
    const composition = composePreflightLayers(
      parsed.success.map((layer) => ({ label: layer.label, patches: [...layer.patches] })),
      { generatedLayerLabels: parsed.success.map((layer) => layer.label) },
    )
    expect(composition.warnings).toEqual([])
    const inserted = composition.entries.find((entry) => entry.id === 'preset-expressive')
    expect(inserted).toMatchObject({
      config: {
        plugins: [
          { id: 'tool-web', disabled: { __jsExpr: "!ctx.get('profileContext')" } },
          {
            id: 'tool-todo',
            config: { label: { __jsExpr: "ctx.get('profileContext').label" } },
          },
        ],
      },
    })
  })
})
