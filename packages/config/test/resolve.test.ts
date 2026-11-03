import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  activeDshBridge,
  BundleQuery,
  bundle,
  type DshBridge,
  installDshBridge,
  ResolutionError,
  takeResolutionTrace,
} from '@eedsh/config'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../cli/src/config'
import {
  type AuthoringFixture,
  clearFixtureBridge,
  createAuthoringFixture,
  originalEnv,
  useFixtureBridge,
  useFixtureEnv,
} from './support/fixture'

const root = process.cwd()
const tempRoot = join(root, 'packages/config/.tmp')
let fixture: AuthoringFixture

beforeEach(async () => {
  fixture = await createAuthoringFixture(tempRoot)
  process.env = { ...originalEnv }
  useFixtureEnv(fixture)
  await useFixtureBridge(fixture)
  takeResolutionTrace()
})

afterEach(() => {
  process.env = { ...originalEnv }
  clearFixtureBridge()
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2))
}

describe('active authoring resolution', () => {
  it('requires the bridge and names the remedies', () => {
    clearFixtureBridge()
    expect(() => bundle('@fixture/base').rows()).toThrowError(ResolutionError)
    try {
      bundle('@fixture/base').rows()
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError)
      const resolution = error as ResolutionError
      expect(resolution.code).toBe('resolution.bridge_missing')
      expect(resolution.bundle).toBe('@fixture/base')
      expect(resolution.message).toContain('eedsh sync')
      expect(resolution.message).toContain('--dsh')
    }
  })

  it('fails structurally when the bridge lacks a required capability', () => {
    const bridge = activeDshBridge()
    if (bridge === undefined) throw new Error('expected the fixture bridge')
    installDshBridge({
      ...bridge,
      composeEntries: undefined as unknown as DshBridge['composeEntries'],
    })
    try {
      bundle('@fixture/base').rows()
    } catch (error) {
      expect((error as ResolutionError).code).toBe('resolution.bridge_capability_missing')
      expect((error as ResolutionError).message).toContain('composeEntries')
    }
  })

  it('resolves the active installation and ignores a profile copy of the same bundle', () => {
    const handle = bundle('@fixture/base')
    expect(handle.presets()).toEqual([
      expect.objectContaining({
        rowId: 'preset-standard',
        id: 'standard',
        order: 1,
        name: 'Standard',
      }),
    ])
    expect(handle.row('timer')).toMatchObject({ id: 'timer' })
    expect(handle.rows().map((entry) => entry.id)).toEqual(['preset-standard', 'timer'])
    expect(handle.rows()).not.toContainEqual(expect.objectContaining({ id: 'profile-copy' }))
    expect(handle.packageDir()).toBe(fixture.baseDir)
    expect(takeResolutionTrace()[0]).toMatchObject({
      bundle: '@fixture/base',
      origin: 'active',
      version: '1.0.0',
    })
  })

  it('requires an explicit root for a bundle the active installation does not ship', () => {
    try {
      bundle('@fixture/custom').rows()
    } catch (error) {
      expect((error as ResolutionError).code).toBe('resolution.bundle_not_found')
      expect((error as ResolutionError).message).toContain('@fixture/custom')
      expect((error as ResolutionError).message).toContain('explicit root')
    }
  })

  it('normalizes nested runtime expressions to plan expression nodes', () => {
    const preset = bundle('@fixture/expressive').preset('expressive')
    const config = preset.toJSON().config as Record<string, unknown>
    const children = config.plugins as Record<string, unknown>[]
    expect(children).toEqual([
      expect.objectContaining({
        id: 'tool-web',
        disabled: { $eedsh: { expr: "!ctx.get('profileContext')" } },
      }),
      expect.objectContaining({
        id: 'tool-todo',
        config: { label: { $eedsh: { expr: "ctx.get('profileContext').label" } } },
      }),
    ])
    expect(JSON.stringify(preset.toJSON())).not.toContain('__jsExpr')
    expect(Object.isFrozen(children[0])).toBe(true)
    expect(Object.isFrozen((children[0] as { disabled: unknown }).disabled)).toBe(true)
  })

  it('returns frozen, plain JSON rows', () => {
    const value = bundle('@fixture/base').rows()
    expect(Object.isFrozen(value[0]?.data)).toBe(true)
    expect(JSON.parse(JSON.stringify(value.map((entry) => entry.toJSON())))).toEqual(
      value.map((entry) => entry.toJSON()),
    )
    expect(() => {
      ;(value[0]?.data as Record<string, unknown>).id = 'mutated'
    }).toThrow()
  })
})

describe('explicit roots', () => {
  it('resolves a profile copy', () => {
    const query = bundle('@fixture/custom').fromProfile('work')
    expect(query.origin()).toBe('profile')
    expect(query.packageDir()).toBe(fixture.customDir)
    expect(query.rows().map((entry) => entry.id)).toEqual(['custom-row'])
  })

  it('reports a profile that has not installed the bundle', () => {
    try {
      bundle('@fixture/absent').fromProfile('work').rows()
    } catch (error) {
      const resolution = error as ResolutionError
      expect(resolution.code).toBe('resolution.bundle_not_installed')
      expect(resolution.message).toContain('"work"')
      expect(resolution.message).toContain('@fixture/absent')
    }
  })

  it('reports an unknown profile', () => {
    try {
      bundle('@fixture/custom').fromProfile('missing').rows()
    } catch (error) {
      const resolution = error as ResolutionError
      expect(resolution.code).toBe('resolution.profile_missing')
      expect(resolution.message).toContain('missing')
    }
  })

  it('resolves an absolute package directory', () => {
    expect(bundle('@fixture/vendored').fromPackageDir(fixture.packageDir).rows()).toHaveLength(1)
  })

  it('resolves a relative package directory against the config file', () => {
    process.env.EEDSH_CONFIG_DIR = fixture.configDir
    const fromConfig = join('..', 'node_modules', '@fixture', 'vendored')
    expect(bundle('@fixture/vendored').fromPackageDir(fromConfig).rows()).toHaveLength(1)
  })

  it('reports a missing manifest and a directory without dsh.bundle', async () => {
    const empty = join(fixture.root, 'empty')
    await mkdir(empty, { recursive: true })
    expect(() => bundle('@fixture/vendored').fromPackageDir(empty).rows()).toThrowError(
      /has no package.json/,
    )
    const plain = join(fixture.root, 'plain')
    await writeJson(join(plain, 'package.json'), { name: '@fixture/plain', version: '1.0.0' })
    try {
      bundle('@fixture/plain').fromPackageDir(plain).rows()
    } catch (error) {
      expect((error as ResolutionError).code).toBe('resolution.not_a_bundle')
      expect((error as ResolutionError).message).toContain('dsh.bundle')
    }
  })

  it('rejects both roots at once', () => {
    try {
      new BundleQuery('@fixture/custom', {
        profile: 'work',
        packageDir: fixture.packageDir,
      }).rows()
    } catch (error) {
      expect((error as ResolutionError).code).toBe('resolution.root_conflict')
      expect((error as ResolutionError).message).toContain('exactly one root')
    }
  })
})

describe('config import anchor', () => {
  it('sets and restores the anchor around loadConfig', async () => {
    delete process.env.EEDSH_DSH_ANCHOR
    delete process.env.EEDSH_CONFIG_DIR
    const configDir = await mkdtemp(join(root, 'packages/cli/.tmp', 'resolution-config-'))
    const configPath = join(configDir, 'config.ts')
    const marker = join(configDir, 'anchor.txt')
    await writeFile(
      configPath,
      `import { writeFileSync } from 'node:fs'
import { defineConfig } from '@eedsh/config'
writeFileSync(${JSON.stringify(marker)}, process.env.EEDSH_DSH_ANCHOR ?? '')
export default defineConfig()
  .profile('work', (profile) => profile.bundle('@deepseek-ai/dsh-base'))
  .build()
`,
    )
    const { Effect } = await import('effect')
    await Effect.runPromise(loadConfig(configPath))
    expect(await readFile(marker, 'utf8')).toBe(fixture.anchor)
    expect(process.env.EEDSH_DSH_ANCHOR).toBeUndefined()
    expect(process.env.EEDSH_CONFIG_DIR).toBeUndefined()
  })
})
