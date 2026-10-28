import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'
import * as Result from 'effect/Result'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config'
import { composePreflightLayers } from '../../src/preflight'

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
})
