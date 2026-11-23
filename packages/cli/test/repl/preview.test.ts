import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type * as FileSystem from 'effect/FileSystem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cleanupPreviews,
  installPreviewWithPnpm,
  type PreparePreviewInput,
  PreviewError,
  type PreviewServices,
  preparePreview,
  previewCacheRoot,
} from '../../src/repl/preview'
import { defaultSpawn } from '../../src/spawn'
import { realFileSystemValue } from '../support/cli'
import { fakeSpawner } from '../support/process'

const root = process.cwd()
const tempRoot = join(root, 'packages/cli/.tmp')
let work = ''
let fileSystem: FileSystem.FileSystem

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2))
}

async function profile(): Promise<string> {
  const dir = join(work, 'home', 'profiles', 'work')
  await writeJson(join(dir, 'package.json'), {
    name: 'dsh-profile-work',
    private: true,
    dsh: { profile: { bundles: [] } },
  })
  await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  await writeFile(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  return dir
}

function installer(calls: string[]): (dir: string) => Promise<void> {
  return async (dir) => {
    calls.push(dir)
    for (const name of ['@acme/x']) {
      await writeJson(join(dir, 'node_modules', ...name.split('/'), 'package.json'), {
        name,
        version: '1.2.3',
      })
    }
  }
}

/** The process service values every preview call runs through. */
function services(): PreviewServices {
  return { fileSystem, spawner: defaultSpawn }
}

/** Prepare a preview against the process service values. */
async function prepare(input: PreparePreviewInput) {
  return await preparePreview(input, services())
}

beforeEach(async () => {
  await mkdir(tempRoot, { recursive: true })
  work = await mkdtemp(join(tempRoot, 'preview-'))
  fileSystem = await realFileSystemValue()
})

afterEach(async () => {
  await rm(work, { recursive: true, force: true })
})

describe('preview cache', () => {
  it('copies profile metadata, installs the exact spec, and reuses the key', async () => {
    const profileDir = await profile()
    const calls: string[] = []
    const cacheRoot = join(work, 'cache')
    const first = await prepare({
      profileName: 'work',
      profileDir,
      dshVersion: '0.2.1-rc.2',
      specs: [{ name: '@acme/x', version: '1.2.3' }],
      env: {},
      cacheRoot,
      install: installer(calls),
    })
    expect(first.reused).toBe(false)
    expect(calls).toEqual([first.dir])
    const manifest = JSON.parse(await readFile(join(first.dir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(manifest.dependencies['@acme/x']).toBe('1.2.3')
    expect(await readFile(join(first.dir, 'pnpm-lock.yaml'), 'utf8')).toContain('lockfileVersion')
    expect(first.override).toEqual({ work: first.dir })

    const second = await prepare({
      profileName: 'work',
      profileDir,
      dshVersion: '0.2.1-rc.2',
      specs: [{ name: '@acme/x', version: '1.2.3' }],
      env: {},
      cacheRoot,
      install: installer(calls),
    })
    expect(second.reused).toBe(true)
    expect(calls).toHaveLength(1)
    expect(second.dir).toBe(first.dir)
  })

  it('keys a preview by the selected installation version', async () => {
    const profileDir = await profile()
    const cacheRoot = join(work, 'cache')
    const first = await prepare({
      profileName: 'work',
      profileDir,
      dshVersion: '0.2.1-rc.2',
      specs: [{ name: '@acme/x', version: '1.2.3' }],
      env: {},
      cacheRoot,
      install: installer([]),
    })
    const second = await prepare({
      profileName: 'work',
      profileDir,
      dshVersion: '0.2.1-rc.5',
      specs: [{ name: '@acme/x', version: '1.2.3' }],
      env: {},
      cacheRoot,
      install: installer([]),
    })
    expect(second.dir).not.toBe(first.dir)
    expect(second.reused).toBe(false)
  })

  it('serializes concurrent installs for one key', async () => {
    const profileDir = await profile()
    const cacheRoot = join(work, 'cache')
    let active = 0
    let maximum = 0
    let calls = 0
    const install = async (dir: string): Promise<void> => {
      calls += 1
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
      await writeJson(join(dir, 'node_modules', '@acme', 'x', 'package.json'), {
        name: '@acme/x',
        version: '1.2.3',
      })
      active -= 1
    }
    const input = {
      profileName: 'work',
      profileDir,
      dshVersion: '0.2.1-rc.2',
      specs: [{ name: '@acme/x', version: '1.2.3' }],
      env: {},
      cacheRoot,
      install,
    }
    const [left, right] = await Promise.all([prepare(input), prepare(input)])
    expect(calls).toBe(1)
    expect(maximum).toBe(1)
    expect(left.dir).toBe(right.dir)
  })

  it('does not reuse a stale marker or a missing package directory', async () => {
    const profileDir = await profile()
    const calls: string[] = []
    const cacheRoot = join(work, 'cache')
    const first = await prepare({
      profileName: 'work',
      profileDir,
      dshVersion: '0.2.1-rc.2',
      specs: [{ name: '@acme/x', version: '1.2.3' }],
      env: {},
      cacheRoot,
      install: installer(calls),
    })
    const markerPath = join(first.dir, '.eedsh-preview.json')
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>
    await writeJson(markerPath, { ...marker, key: 'stale' })
    const second = await prepare({
      profileName: 'work',
      profileDir,
      dshVersion: '0.2.1-rc.2',
      specs: [{ name: '@acme/x', version: '1.2.3' }],
      env: {},
      cacheRoot,
      install: installer(calls),
    })
    expect(second.reused).toBe(false)
    expect(calls).toHaveLength(2)
    await rm(join(second.dir, 'node_modules', '@acme', 'x'), { recursive: true, force: true })
    const third = await prepare({
      profileName: 'work',
      profileDir,
      dshVersion: '0.2.1-rc.2',
      specs: [{ name: '@acme/x', version: '1.2.3' }],
      env: {},
      cacheRoot,
      install: installer(calls),
    })
    expect(third.reused).toBe(false)
    expect(calls).toHaveLength(3)
  })

  it('fails structurally when the profile has no manifest', async () => {
    const dir = join(work, 'missing')
    await expect(
      prepare({
        profileName: 'work',
        profileDir: dir,
        dshVersion: '0.2.1-rc.2',
        specs: [{ name: '@acme/x', version: '1.2.3' }],
        env: {},
        cacheRoot: join(work, 'cache'),
        install: installer([]),
      }),
    ).rejects.toBeInstanceOf(PreviewError)
  })

  it('removes previews older than the maximum age', async () => {
    const cacheRoot = join(work, 'cache')
    const oldDir = join(cacheRoot, 'old')
    const newDir = join(cacheRoot, 'new')
    await writeJson(join(oldDir, '.eedsh-preview.json'), {
      key: 'old',
      profile: 'work',
      specs: [],
      createdAt: 1,
    })
    await writeJson(join(newDir, '.eedsh-preview.json'), {
      key: 'new',
      profile: 'work',
      specs: [],
      createdAt: 900,
    })
    const removed = await cleanupPreviews(cacheRoot, fileSystem, { now: () => 1000, maxAgeMs: 100 })
    expect(removed).toEqual([oldDir])
    expect(await readFile(join(newDir, '.eedsh-preview.json'), 'utf8')).toContain('new')
  })

  it('derives the cache root from XDG or home', () => {
    expect(previewCacheRoot({ XDG_CACHE_HOME: join(work, 'xdg') })).toBe(
      join(work, 'xdg', 'eedsh', 'repl'),
    )
    expect(previewCacheRoot({ HOME: work })).toBe(join(work, '.cache', 'eedsh', 'repl'))
  })
})

describe('pnpm installer', () => {
  it('spawns pnpm install in the preview directory', async () => {
    const { calls, spawn } = fakeSpawner()
    const dir = join(work, 'preview')
    await installPreviewWithPnpm(dir, spawn)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toContain('install')
    expect(calls[0]?.options.cwd).toBe(dir)
    expect(calls[0]?.options.stdio).toBe('pipe')
  })

  it('reports a failed install with its captured stderr', async () => {
    const { spawn } = fakeSpawner({ exitCode: 1, stderr: 'registry unavailable' })
    await expect(installPreviewWithPnpm(join(work, 'preview'), spawn)).rejects.toMatchObject({
      code: 'preview.install_failed',
      message: expect.stringContaining('registry unavailable'),
    })
  })
})
