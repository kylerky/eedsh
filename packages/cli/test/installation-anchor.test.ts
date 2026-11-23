import { existsSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import {
  anchorForInstallation,
  decodeInstallationAnchor,
  type InstallationAnchorStore,
  installationAnchorPathForEnv,
  installationFromManifestAnchor,
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

describe('CLI installation anchor decoder', () => {
  const required = { format: 1, installAnchor: '/opt/dsh/package.json' }

  it('decodes every recorded field', () => {
    const record = {
      format: 1 as const,
      installAnchor: '/opt/dsh/package.json',
      version: '0.2.1-rc.2',
      launcher: '/opt/dsh/bin/dsh',
      manager: 'pnpm' as const,
      recordedBy: 'sync',
      recordedAt: '2026-11-03T08:00:00.000Z',
    }
    expect(decodeInstallationAnchor(JSON.stringify(record))).toEqual({ ok: true, anchor: record })
  })

  it('accepts the required fields only', () => {
    expect(decodeInstallationAnchor(JSON.stringify(required))).toEqual({
      ok: true,
      anchor: required,
    })
  })

  it('reports malformed JSON', () => {
    const decoded = decodeInstallationAnchor('{ not json')
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.reason).toMatch(/^the installation anchor is not valid JSON: /)
  })

  it('rejects a non-object root', () => {
    for (const text of ['[]', 'null', '"anchor"', '1', 'true']) {
      expect(decodeInstallationAnchor(text), text).toEqual({
        ok: false,
        reason: 'the installation anchor must be a JSON object',
      })
    }
  })

  it('rejects an unsupported format', () => {
    expect(decodeInstallationAnchor(JSON.stringify({ ...required, format: 2 }))).toEqual({
      ok: false,
      reason: 'unsupported installation anchor format 2; expected 1',
    })
  })

  it('rejects a missing installAnchor', () => {
    expect(decodeInstallationAnchor(JSON.stringify({ format: 1 }))).toEqual({
      ok: false,
      reason: 'the installation anchor has no installAnchor path',
    })
  })

  it('rejects a relative installAnchor', () => {
    expect(
      decodeInstallationAnchor(JSON.stringify({ ...required, installAnchor: 'dsh/package.json' })),
    ).toEqual({
      ok: false,
      reason: 'installAnchor must be an absolute package.json path: "dsh/package.json"',
    })
  })

  it('rejects an installAnchor that is not a package.json', () => {
    expect(
      decodeInstallationAnchor(JSON.stringify({ ...required, installAnchor: '/opt/dsh/index' })),
    ).toEqual({
      ok: false,
      reason: 'installAnchor must name a package.json: "/opt/dsh/index"',
    })
  })

  const invalidFields: readonly [string, Record<string, unknown>, string][] = [
    ['a non-string version', { version: 3 }, 'version must be a non-empty string when present'],
    ['an empty version', { version: '' }, 'version must be a non-empty string when present'],
    ['a non-string launcher', { launcher: 3 }, 'launcher must be a non-empty string when present'],
    [
      'a relative launcher',
      { launcher: 'bin/dsh' },
      'launcher must be absolute when present: "bin/dsh"',
    ],
    [
      'an unknown manager',
      { manager: 'yarn' },
      'manager must be "pnpm" or "npm" when present: "yarn"',
    ],
    [
      'an empty recordedBy',
      { recordedBy: '' },
      'recordedBy must be a non-empty string when present',
    ],
    [
      'a non-string recordedAt',
      { recordedAt: 7 },
      'recordedAt must be a non-empty string when present',
    ],
  ]

  it.each(invalidFields)('rejects %s', (_label, extra, reason) => {
    expect(decodeInstallationAnchor(JSON.stringify({ ...required, ...extra }))).toEqual({
      ok: false,
      reason,
    })
  })

  it('drops extra fields', () => {
    expect(
      decodeInstallationAnchor(JSON.stringify({ ...required, extra: 'ignored', layers: [] })),
    ).toEqual({ ok: true, anchor: required })
  })

  it('reports the first defect in the recorded validation order', () => {
    const decoded = decodeInstallationAnchor(
      JSON.stringify({
        format: 1,
        installAnchor: 'dsh/package.json',
        version: 3,
        launcher: 'bin/dsh',
        manager: 'yarn',
        recordedBy: '',
      }),
    )
    expect(decoded).toEqual({
      ok: false,
      reason: 'installAnchor must be an absolute package.json path: "dsh/package.json"',
    })
  })

  it('reports a bad version before a bad launcher', () => {
    const decoded = decodeInstallationAnchor(
      JSON.stringify({ ...required, version: 3, launcher: 'bin/dsh' }),
    )
    expect(decoded).toEqual({
      ok: false,
      reason: 'version must be a non-empty string when present',
    })
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

describe('CLI package manifest launcher resolution', () => {
  const identity = { name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' }

  async function writeManifest(
    prefix: string,
    manifest: Record<string, unknown>,
    files: readonly string[] = [],
  ): Promise<Fixture> {
    const home = await tempDir(prefix)
    const dir = join(home, 'dsh')
    const anchor = join(dir, 'package.json')
    await mkdir(dir, { recursive: true })
    writeFileSync(anchor, JSON.stringify({ ...identity, ...manifest }, null, 2))
    for (const file of files) {
      const path = join(dir, file)
      await mkdir(dirname(path), { recursive: true })
      writeFileSync(path, '#!/usr/bin/env node\n')
    }
    return { dir, anchor }
  }

  function launcherOf(anchor: string): string {
    const validated = installationFromManifestAnchor(anchor, anchor)
    if (Result.isFailure(validated)) throw validated.failure
    return validated.success.binPath
  }

  it('uses a string bin entry', async () => {
    const fixture = await writeManifest('manifest-string-bin-', { bin: './custom/bin.js' }, [
      join('custom', 'bin.js'),
    ])
    expect(launcherOf(fixture.anchor)).toBe(join(fixture.dir, 'custom', 'bin.js'))
  })

  it('uses the dsh entry of an object bin', async () => {
    const fixture = await writeManifest(
      'manifest-object-bin-',
      { bin: { dsh: './custom/bin.js' } },
      [join('custom', 'bin.js')],
    )
    expect(launcherOf(fixture.anchor)).toBe(join(fixture.dir, 'custom', 'bin.js'))
  })

  it('falls back to main for a malformed bin', async () => {
    const fixture = await writeManifest('manifest-main-', { bin: { dsh: 5 }, main: './main.js' }, [
      'main.js',
    ])
    expect(launcherOf(fixture.anchor)).toBe(join(fixture.dir, 'main.js'))
  })

  it('falls back to lib/bin.js for a malformed main', async () => {
    const fixture = await writeManifest('manifest-lib-bin-', { main: 7 }, [join('lib', 'bin.js')])
    expect(launcherOf(fixture.anchor)).toBe(join(fixture.dir, 'lib', 'bin.js'))
  })

  it('reports invalid JSON and a non-object document as an unreadable manifest', async () => {
    for (const content of ['{ nope', '[]', '"text"', 'null']) {
      const home = await tempDir('manifest-raw-')
      const dir = join(home, 'dsh')
      await mkdir(dir, { recursive: true })
      const anchor = join(dir, 'package.json')
      writeFileSync(anchor, content)
      const failure = failureOf(installationFromManifestAnchor(anchor, anchor))
      expect(failure.code, content).toBe('dsh.anchor_invalid')
      expect(failure.message, content).toContain('cannot read a DSH manifest')
    }
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
