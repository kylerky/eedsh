import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Cause, Effect, Exit, Layer } from 'effect'
import * as Result from 'effect/Result'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig as loadConfigUnprovided } from '../../src/config'
import { bundleResolverLayer } from '../../src/internal/effect/layer'
import { buildGeneratedBundle } from '../../src/materialize/generated-bundle'
import { composePreflightLayers, parseGeneratedLayers } from '../../src/preflight'
import { devDshInstallation, loadTestBridge } from '../support/bridge'

const testResolver = bundleResolverLayer.pipe(Layer.provide(NodeServices.layer))
const loadConfig = (configPath: string) =>
  loadConfigUnprovided(configPath, {
    installation: devDshInstallation(),
    env: process.env,
  }).pipe(Effect.provide(Layer.merge(NodeServices.layer, testResolver)))

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

export default () => defineConfig()
  .profile('work', (profile) => {
    profile
      .generated()
      .layer('queried', (layer) => {
        layer.insert([pinned, fromProfile, fromDirectory])
      })
  })
`,
    )

    const { config } = await Effect.runPromise(loadConfig(configPath))
    const plan = config.profiles.work
    expect(plan !== undefined && Result.isSuccess(plan)).toBe(true)
    if (plan === undefined || Result.isFailure(plan)) return
    const insert = plan.success.layers[0]?.patches[0]?.insert
    expect(Array.isArray(insert) ? insert.length : 0).toBe(3)
    const layers = plan.success.layers.map((item, index) => ({
      label: `generated #${index + 1}`,
      patches: item.patches as Record<string, unknown>[],
      generated: {
        position: index + 1,
        label: item.id,
        sites: [] as [],
      },
    }))
    const composition = composePreflightLayers(layers, (await loadTestBridge()).composeEntries)
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

export default () => defineConfig()
  .profile('work', (profile) => {
    profile.generated().layer('preset', (layer) => layer.insert(expressive))
  })
`,
    )

    const { config } = await Effect.runPromise(loadConfig(configPath))
    const plan = config.profiles.work
    expect(plan !== undefined && Result.isSuccess(plan)).toBe(true)
    if (plan === undefined || Result.isFailure(plan)) return
    expect(JSON.stringify(plan.success)).not.toContain('__jsExpr')

    const built = buildGeneratedBundle({
      plan: plan.success,
      managedBundles: ['@deepseek-ai/dsh-base', '@eedsh/runtime', '@eedsh/generated'],
      packages: {
        '@eedsh/runtime': 'link:/repo/packages/runtime',
        '@eedsh/generated': 'link:./.eedsh/generated',
      },
      eedshVersion: '0.0.0',
      dshVersion: '0.2.1-rc.2',
    })
    if (Result.isFailure(built)) throw new Error(built.failure.message)
    const generated = built.success
    const layerFile = generated.files.find((file) => file.path.endsWith('.yml'))
    expect(layerFile?.content).toContain('!!js')
    expect(layerFile?.content).not.toContain('$eedsh')

    const parsed = parseGeneratedLayers(generated)
    expect(Result.isSuccess(parsed)).toBe(true)
    if (Result.isFailure(parsed)) return
    const composition = composePreflightLayers(
      parsed.success,
      (await loadTestBridge()).composeEntries,
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

  it('resolves one query pair once for two layers and reports one trace', async () => {
    const configDir = join(workdir, 'config')
    await mkdir(configDir, { recursive: true })
    const configPath = join(configDir, 'config.ts')
    await writeFile(
      configPath,
      `import { bundle, defineConfig } from '@eedsh/config'

export default () => defineConfig()
  .profile('work', (profile) => {
    profile
      .generated()
      .layer('first', (layer) => layer.insert(bundle('@deepseek-ai/dsh-base').row('timer')))
      .layer('second', (layer) => layer.insert(bundle('@deepseek-ai/dsh-base').rows()))
  })
`,
    )
    const loaded = await Effect.runPromise(loadConfig(configPath))
    expect(loaded.queries).toHaveLength(2)
    expect(loaded.traces).toHaveLength(1)
    expect(loaded.resolution.bundles).toHaveLength(1)
    const plan = loaded.config.profiles.work
    expect(plan !== undefined && Result.isSuccess(plan)).toBe(true)
  })

  it('stops before the terminal build when a requested row is missing', async () => {
    const configDir = join(workdir, 'config')
    await mkdir(configDir, { recursive: true })
    const configPath = join(configDir, 'config.ts')
    await writeFile(
      configPath,
      `import { bundle, defineConfig } from '@eedsh/config'

export default () => {
  const builder = defineConfig().profile('work', (profile) => {
    profile
      .generated()
      .layer('missing', (layer) => layer.insert(bundle('@deepseek-ai/dsh-base').row('no-such-row')))
  })
  builder.build = () => {
    throw new Error('the terminal build must not run')
  }
  return builder
}
`,
    )
    const exit = await Effect.runPromiseExit(loadConfig(configPath))
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return
    const failure = Cause.squash(exit.cause) as { _tag?: string; code?: string; message?: string }
    expect(failure._tag).toBe('ResolutionError')
    expect(failure.code).toBe('resolution.row_not_found')
    expect(String(failure.message)).not.toContain('terminal build')
  })
})
