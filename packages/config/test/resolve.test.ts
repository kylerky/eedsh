import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../cli/src/config'
import { presets, ResolutionError, resolveBundle, row, rows, takeResolutionTrace } from '../src'

const root = process.cwd()
const tempRoot = join(root, 'packages/config/.tmp')
const originalEnv = { ...process.env }

async function dir(): Promise<string> {
  await mkdir(tempRoot, { recursive: true })
  return mkdtemp(join(tempRoot, 'resolution-'))
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2))
}

async function writeBundle(
  baseDir: string,
  name: string,
  version: string,
  patch: string,
): Promise<string> {
  const packageDir = join(baseDir, 'node_modules', ...name.split('/'))
  await writeJson(join(packageDir, 'package.json'), {
    name,
    version,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  await writeFile(join(packageDir, 'cordis.patch.yml'), patch)
  return packageDir
}

async function fixture() {
  const dirRoot = await dir()
  const dshDir = join(dirRoot, 'dsh')
  await writeJson(join(dshDir, 'package.json'), {
    name: '@deepseek-ai/dsh',
    version: '0.2.1-rc.2',
    dependencies: { '@fixture/base': '1.0.0' },
  })
  const baseDir = await writeBundle(
    dshDir,
    '@fixture/base',
    '1.0.0',
    `- insert:
    - id: preset-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard
        order: 1
        name: Standard
    - id: timer
      name: '@deepseek-ai/cordis-plugin-timer'
`,
  )
  const home = join(dirRoot, 'home')
  const workDir = join(home, 'profiles', 'work')
  await writeJson(join(workDir, 'package.json'), {
    name: 'dsh-profile-work',
    private: true,
    dsh: { profile: { bundles: [] } },
  })
  const customDir = await writeBundle(
    workDir,
    '@fixture/custom',
    '2.0.0',
    `- insert:
    - id: custom-row
      name: '@fixture/plugin'
`,
  )
  const profileCopy = await writeBundle(
    workDir,
    '@fixture/base',
    '9.9.9',
    `- insert:
    - id: profile-copy
      name: '@fixture/profile-copy'
`,
  )
  const packageDir = await writeBundle(
    dirRoot,
    '@fixture/vendored',
    '3.0.0',
    `- insert:
    - id: vendored-row
      name: '@fixture/vendored-plugin'
`,
  )
  const configDir = join(dirRoot, 'config')
  await mkdir(configDir, { recursive: true })
  return { dirRoot, dshDir, baseDir, home, workDir, customDir, profileCopy, packageDir, configDir }
}

let f: Awaited<ReturnType<typeof fixture>>

beforeEach(async () => {
  f = await fixture()
  process.env = { ...originalEnv }
  process.env.EEDSH_DSH_ANCHOR = join(f.dshDir, 'package.json')
  process.env.DSH_HOME = f.home
  process.env.EEDSH_CONFIG_DIR = f.configDir
  takeResolutionTrace()
})

afterEach(() => {
  process.env = { ...originalEnv }
})

describe('pinned authoring resolution', () => {
  it('requires the anchor and names it', () => {
    delete process.env.EEDSH_DSH_ANCHOR
    expect(() => rows('@fixture/base')).toThrowError(ResolutionError)
    try {
      rows('@fixture/base')
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError)
      const resolution = error as ResolutionError
      expect(resolution.code).toBe('resolution.anchor_missing')
      expect(resolution.bundle).toBe('@fixture/base')
      expect(resolution.message).toContain('EEDSH_DSH_ANCHOR')
    }
  })

  it('fails structurally for an unreadable anchor and a non-DSH manifest', async () => {
    process.env.EEDSH_DSH_ANCHOR = join(f.dshDir, 'missing.json')
    expect(() => rows('@fixture/base')).toThrowError(/cannot read EEDSH_DSH_ANCHOR/)
    const notDsh = join(f.dirRoot, 'other.json')
    await writeJson(notDsh, { name: 'not-dsh', version: '1.0.0' })
    process.env.EEDSH_DSH_ANCHOR = notDsh
    try {
      rows('@fixture/base')
    } catch (error) {
      expect((error as ResolutionError).code).toBe('resolution.anchor_invalid')
      expect((error as ResolutionError).message).toContain(notDsh)
    }
  })

  it('resolves the pin and ignores a profile copy of the same bundle', () => {
    const summaries = presets('@fixture/base')
    expect(summaries).toEqual([
      {
        rowId: 'preset-standard',
        id: 'standard',
        order: 1,
        name: 'Standard',
      },
    ])
    expect(row('@fixture/base', 'timer')).toMatchObject({ id: 'timer' })
    expect(rows('@fixture/base').map((entry) => entry.id)).toEqual(['preset-standard', 'timer'])
    expect(rows('@fixture/base')).not.toContainEqual(
      expect.objectContaining({ id: 'profile-copy' }),
    )
    expect(resolveBundle('@fixture/base').packageDir).toBe(f.baseDir)
    expect(takeResolutionTrace()[0]).toMatchObject({
      bundle: '@fixture/base',
      origin: 'pinned',
      version: '1.0.0',
    })
  })

  it('requires an explicit root for a bundle the pin does not ship', () => {
    try {
      rows('@fixture/custom')
    } catch (error) {
      expect((error as ResolutionError).code).toBe('resolution.bundle_not_found')
      expect((error as ResolutionError).message).toContain('@fixture/custom')
      expect((error as ResolutionError).message).toContain('explicit root')
    }
  })

  it('returns frozen, plain JSON rows', () => {
    const value = rows('@fixture/base')
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value[0])).toBe(true)
    expect(JSON.parse(JSON.stringify(value))).toEqual(value)
    expect(() => {
      ;(value[0] as Record<string, unknown>).id = 'mutated'
    }).toThrow()
  })
})

describe('explicit roots', () => {
  it('resolves a profile copy', () => {
    const resolved = resolveBundle('@fixture/custom', { profile: 'work' })
    expect(resolved.origin).toBe('profile')
    expect(resolved.packageDir).toBe(f.customDir)
    expect(resolved.rows.map((entry) => entry.id)).toEqual(['custom-row'])
  })

  it('reports a profile that has not installed the bundle', () => {
    try {
      rows('@fixture/absent', { profile: 'work' })
    } catch (error) {
      const resolution = error as ResolutionError
      expect(resolution.code).toBe('resolution.bundle_not_installed')
      expect(resolution.message).toContain('"work"')
      expect(resolution.message).toContain('@fixture/absent')
    }
  })

  it('reports an unknown profile', () => {
    try {
      rows('@fixture/custom', { profile: 'missing' })
    } catch (error) {
      const resolution = error as ResolutionError
      expect(resolution.code).toBe('resolution.profile_missing')
      expect(resolution.message).toContain('missing')
    }
  })

  it('resolves an absolute package directory', () => {
    expect(rows('@fixture/vendored', { packageDir: f.packageDir })).toHaveLength(1)
  })

  it('resolves a relative package directory against the config file', () => {
    process.env.EEDSH_CONFIG_DIR = f.configDir
    const fromConfig = join('..', 'node_modules', '@fixture', 'vendored')
    expect(rows('@fixture/vendored', { packageDir: fromConfig })).toHaveLength(1)
  })

  it('reports a missing manifest and a directory without dsh.bundle', async () => {
    const empty = join(f.dirRoot, 'empty')
    await mkdir(empty, { recursive: true })
    expect(() => rows('@fixture/vendored', { packageDir: empty })).toThrowError(
      /has no package.json/,
    )
    const plain = join(f.dirRoot, 'plain')
    await writeJson(join(plain, 'package.json'), { name: '@fixture/plain', version: '1.0.0' })
    try {
      rows('@fixture/plain', { packageDir: plain })
    } catch (error) {
      expect((error as ResolutionError).code).toBe('resolution.not_a_bundle')
      expect((error as ResolutionError).message).toContain('dsh.bundle')
    }
  })

  it('rejects both roots at once', () => {
    try {
      rows('@fixture/custom', { profile: 'work', packageDir: f.packageDir })
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
import { defineConfig, defineProfile } from '@eedsh/config'
writeFileSync(${JSON.stringify(marker)}, process.env.EEDSH_DSH_ANCHOR ?? '')
export default defineConfig({
  dsh: '0.2.1-rc.2',
  profiles: { work: defineProfile({ bundles: [] }) },
})
`,
    )
    const { Effect } = await import('effect')
    const loaded = await Effect.runPromise(loadConfig(configPath))
    const { resolveDshInstallation } = await import('../../cli/src/dsh')
    const installation = resolveDshInstallation()
    const { isSuccess } = await import('effect/Result')
    if (!isSuccess(installation)) throw installation.failure
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(marker, 'utf8')).toBe(installation.success.installAnchor)
    expect(loaded.dsh).toBe('0.2.1-rc.2')
    expect(process.env.EEDSH_DSH_ANCHOR).toBeUndefined()
    expect(process.env.EEDSH_CONFIG_DIR).toBeUndefined()
  })
})
