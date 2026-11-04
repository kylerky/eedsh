import { existsSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import {
  anchorForInstallation,
  type InstallationAnchorStore,
  installationAnchorPathForEnv,
  installationFromSelection,
  readInstallationAnchorSnapshot,
  validateRecordedInstallation,
  writeInstallationAnchorSync,
} from '../src/installation-anchor'
import type { DshFailure } from '../src/internal/effect/errors'

const root = process.cwd()
const tempRoot = join(root, 'packages/cli/.tmp')

async function tempDir(prefix: string): Promise<string> {
  await mkdir(tempRoot, { recursive: true })
  return mkdtemp(join(tempRoot, prefix))
}

interface Fixture {
  readonly dir: string
  readonly anchor: string
}

async function writePackage(
  parent: string,
  directory: string,
  name: string,
  version: string,
  manifest: Record<string, unknown> = {},
): Promise<Fixture> {
  const dir = join(parent, directory)
  await mkdir(join(dir, 'lib'), { recursive: true })
  const anchor = join(dir, 'package.json')
  writeFileSync(
    anchor,
    JSON.stringify({ name, version, bin: { dsh: './lib/bin.js' }, ...manifest }, null, 2),
  )
  writeFileSync(join(dir, 'lib', 'bin.js'), '#!/usr/bin/env node\n')
  return { dir, anchor }
}

function failureOf(result: Result.Result<unknown, DshFailure>): DshFailure {
  if (Result.isSuccess(result)) throw new Error('expected a failure')
  return result.failure
}

describe('CLI installation anchor location', () => {
  it('resolves the cache below resolveDshHome', () => {
    expect(installationAnchorPathForEnv({ DSH_HOME: '/custom/home' })).toBe(
      resolve('/custom/home', '.local', 'state', 'installation.json'),
    )
    expect(installationAnchorPathForEnv({ HOME: '/users/me' })).toBe(
      resolve('/users/me', '.dsh', '.local', 'state', 'installation.json'),
    )
    expect(installationAnchorPathForEnv({ HOME: '/users/me', DSH_HOME: '/explicit' })).toBe(
      resolve('/explicit', '.local', 'state', 'installation.json'),
    )
  })

  it('never places the cache in the config project', () => {
    const env = { DSH_HOME: '/dsh-home', XDG_CONFIG_HOME: '/xdg' }
    const path = installationAnchorPathForEnv(env)
    expect(path.startsWith(resolve('/dsh-home'))).toBe(true)
    expect(path.startsWith(resolve('/xdg'))).toBe(false)
  })
})

describe('CLI installation anchor validation', () => {
  it('accepts a supported @deepseek-ai/dsh record', async () => {
    const home = await tempDir('anchor-valid-')
    const installation = await writePackage(home, 'dsh', '@deepseek-ai/dsh', '0.2.1-rc.2')
    const record = {
      format: 1 as const,
      installAnchor: installation.anchor,
      version: '0.2.1-rc.2',
    }
    const validated = validateRecordedInstallation(record)
    expect(Result.isSuccess(validated)).toBe(true)
    if (Result.isSuccess(validated)) {
      expect(validated.success.version).toBe('0.2.1-rc.2')
      expect(validated.success.installAnchor).toBe(installation.anchor)
      expect(validated.success.packageDir).toBe(installation.dir)
      expect(validated.success.binPath).toBe(join(installation.dir, 'lib', 'bin.js'))
    }
  })

  it('rejects a record whose anchor does not exist', async () => {
    const home = await tempDir('anchor-missing-')
    const failure = failureOf(
      validateRecordedInstallation({
        format: 1,
        installAnchor: join(home, 'missing', 'package.json'),
        version: '0.2.1-rc.2',
      }),
    )
    expect(failure.code).toBe('dsh.anchor_invalid')
    expect(failure.message).toContain(join(home, 'missing', 'package.json'))
  })

  it('rejects a record whose anchor is another package', async () => {
    const home = await tempDir('anchor-other-')
    const other = await writePackage(home, 'other', 'other', '1.0.0')
    const failure = failureOf(
      validateRecordedInstallation({ format: 1, installAnchor: other.anchor, version: '1.0.0' }),
    )
    expect(failure.code).toBe('dsh.anchor_invalid')
    expect(failure.message).toContain('@deepseek-ai/dsh')
  })

  it('rejects an unsupported package version with the range', async () => {
    const home = await tempDir('anchor-unsupported-')
    const installation = await writePackage(home, 'dsh', '@deepseek-ai/dsh', '0.3.0')
    const failure = failureOf(
      validateRecordedInstallation({
        format: 1,
        installAnchor: installation.anchor,
        version: '0.3.0',
      }),
    )
    expect(failure.code).toBe('dsh.unsupported_version')
    expect(failure.version).toBe('0.3.0')
    expect(failure.range).toBe('^0.2.1-rc.2')
  })

  it('rejects a record version that disagrees with the manifest', async () => {
    const home = await tempDir('anchor-version-')
    const installation = await writePackage(home, 'dsh', '@deepseek-ai/dsh', '0.2.1-rc.2')
    const failure = failureOf(
      validateRecordedInstallation({
        format: 1,
        installAnchor: installation.anchor,
        version: '0.2.1-rc.5',
      }),
    )
    expect(failure.code).toBe('dsh.anchor_invalid')
    expect(failure.message).toContain('0.2.1-rc.5')
    expect(failure.message).toContain('0.2.1-rc.2')
  })
})

describe('CLI installation anchor snapshots', () => {
  it('reads a written record and reports an absent one', async () => {
    const home = await tempDir('anchor-snapshot-')
    const installation = await writePackage(home, 'dsh', '@deepseek-ai/dsh', '0.2.1-rc.2')
    const env = { DSH_HOME: home }
    expect(readInstallationAnchorSnapshot(env).record).toBeUndefined()

    const record = anchorForInstallation(
      {
        installAnchor: installation.anchor,
        version: '0.2.1-rc.2',
      },
      { recordedBy: 'sync', manager: 'pnpm', launcher: join(home, 'bin', 'dsh') },
    )
    expect(writeInstallationAnchorSync(env, record)).toEqual({ ok: true })
    const snapshot = readInstallationAnchorSnapshot(env)
    expect(snapshot.record).toEqual(record)
    expect(snapshot.problem).toBeUndefined()
  })

  it('removes the retired anchor and its empty directory on write', async () => {
    const home = await tempDir('anchor-retired-')
    const installation = await writePackage(home, 'dsh', '@deepseek-ai/dsh', '0.2.1-rc.2')
    const env = { DSH_HOME: home }
    await mkdir(join(home, '.eedsh'), { recursive: true })
    writeFileSync(join(home, '.eedsh', 'installation.json'), '{}')

    const record = anchorForInstallation(
      { installAnchor: installation.anchor, version: '0.2.1-rc.2' },
      { recordedBy: 'sync' },
    )
    expect(writeInstallationAnchorSync(env, record)).toEqual({ ok: true })
    expect(existsSync(join(home, '.eedsh'))).toBe(false)
    expect(existsSync(join(home, '.local', 'state', 'installation.json'))).toBe(true)
  })

  it('leaves a retired directory that holds other content', async () => {
    const home = await tempDir('anchor-retired-other-')
    const installation = await writePackage(home, 'dsh', '@deepseek-ai/dsh', '0.2.1-rc.2')
    const env = { DSH_HOME: home }
    await mkdir(join(home, '.eedsh'), { recursive: true })
    writeFileSync(join(home, '.eedsh', 'installation.json'), '{}')
    writeFileSync(join(home, '.eedsh', 'keep.txt'), 'keep')

    const record = anchorForInstallation(
      { installAnchor: installation.anchor, version: '0.2.1-rc.2' },
      { recordedBy: 'sync' },
    )
    expect(writeInstallationAnchorSync(env, record)).toEqual({ ok: true })
    expect(existsSync(join(home, '.eedsh', 'installation.json'))).toBe(false)
    expect(existsSync(join(home, '.eedsh', 'keep.txt'))).toBe(true)
  })

  it('reports a malformed record as a problem without a record', async () => {
    const home = await tempDir('anchor-malformed-')
    const env = { DSH_HOME: home }
    await mkdir(join(home, '.local', 'state'), { recursive: true })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(home, '.local', 'state', 'installation.json'), '{ nope', 'utf8')
    const snapshot = readInstallationAnchorSnapshot(env)
    expect(snapshot.record).toBeUndefined()
    expect(snapshot.problem).toBeDefined()
    expect(snapshot.problem).not.toContain('ENOENT')
  })
})

describe('CLI explicit installation selection', () => {
  it('accepts a package directory and rejects a non-DSH path', async () => {
    const home = await tempDir('anchor-selection-')
    const installation = await writePackage(home, 'dsh', '@deepseek-ai/dsh', '0.2.1-rc.2')
    const selected = installationFromSelection(installation.dir, home)
    expect(Result.isSuccess(selected)).toBe(true)

    const other = await writePackage(home, 'other', 'other', '1.0.0')
    const failure = failureOf(installationFromSelection(other.dir, home))
    expect(failure.code).toBe('dsh.anchor_invalid')
  })

  it('rejects an unsupported explicit installation when support is required', async () => {
    const home = await tempDir('anchor-selection-range-')
    const installation = await writePackage(home, 'dsh', '@deepseek-ai/dsh', '0.3.0')
    const failure = failureOf(
      installationFromSelection(installation.dir, home, { requireSupported: true }),
    )
    expect(failure.code).toBe('dsh.unsupported_version')
  })
})

describe('CLI installation anchor store seam', () => {
  it('is the documented default shape', () => {
    const store = {
      read: () => undefined,
      write: () => ({ ok: true }),
    } satisfies InstallationAnchorStore
    expect(store.read()).toBeUndefined()
  })
})
