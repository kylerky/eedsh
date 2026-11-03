import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Layer } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import { clearDshBridge, type DshBridge } from '@eedsh/config'
import { runEedsh } from '../src/cli'
import { DshFailure } from '../src/internal/effect/errors'
import {
  DshInstallation,
  PackageManager,
  Preflight,
  SyncLock,
} from '../src/internal/effect/services'
import { delay, waitFor } from './support/async'
import { devDshInstallation } from './support/bridge'
import {
  fakeDsh,
  fakePackageManager,
  fakePreflight,
  fakeSyncLock,
  memoryFileSystem,
} from './support/fakes'
import { fakeSpawner } from './support/process'

const root = process.cwd()
const fixture = (name: string) => join(root, 'packages/cli/test/fixtures', name, 'config.ts')
const generatedManifest = '/home/profiles/cli-fixture/.eedsh/generated/package.json'
const installation = devDshInstallation()

function harness(env: Record<string, string | undefined>, options: Record<string, unknown> = {}) {
  const fs = memoryFileSystem()
  const packages = fakePackageManager()
  const dsh = fakeDsh()
  const preflight = fakePreflight()
  const lock = fakeSyncLock()
  const services = () =>
    Layer.mergeAll(
      Layer.succeed(FileSystem.FileSystem, fs.fs),
      Layer.succeed(PackageManager, packages.shape),
      Layer.succeed(DshInstallation, dsh.shape),
      Layer.succeed(Preflight, preflight.shape),
      Layer.succeed(SyncLock, lock.shape),
    )
  const out: string[] = []
  const err: string[] = []
  return {
    fs,
    out,
    err,
    options: {
      env: { DSH_HOME: '/home', XDG_CONFIG_HOME: '/home/xdg', ...env },
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
      services,
      ...options,
    },
    text: () => ({ out: out.join('\n'), err: err.join('\n') }),
  }
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

async function writeFakeInstallation(version: string): Promise<string> {
  const dir = await tempDir('eedsh-fake-dsh-')
  await mkdir(join(dir, 'lib'), { recursive: true })
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version }, null, 2),
  )
  await writeFile(join(dir, 'lib', 'bin.js'), '#!/usr/bin/env node\n')
  return dir
}

describe('command DSH requirements', () => {
  it('syncs with EEDSH_DSH_ANCHOR and publishes', async () => {
    const h = harness({ EEDSH_DSH_ANCHOR: installation.installAnchor })
    const code = await runEedsh(['sync', '--config', fixture('basic')], h.options)
    expect(code).toBe(0)
    expect(h.fs.files.has(generatedManifest)).toBe(true)
  })

  it('fails sync before any write when no DSH is discoverable', async () => {
    const h = harness({})
    const code = await runEedsh(['sync', '--config', fixture('basic')], {
      ...h.options,
      cwd: await tempDir('eedsh-no-dsh-'),
    })
    expect(code).toBe(1)
    const errors = h.text().err
    expect(errors).toContain('dsh.not_found')
    expect(errors).toContain('--dsh')
    expect(errors).toContain('EEDSH_DSH_ANCHOR')
    expect(errors).toContain('install')
    expect(h.fs.writeCount()).toBe(0)
  })

  it('rejects an unsupported discovered version before any write', async () => {
    const unsupported = await writeFakeInstallation('0.3.0')
    const h = harness({ EEDSH_DSH_ANCHOR: join(unsupported, 'package.json') })
    const code = await runEedsh(['sync', '--config', fixture('basic')], h.options)
    expect(code).toBe(1)
    const errors = h.text().err
    expect(errors).toContain('dsh.unsupported_version')
    expect(errors).toContain('0.3.0')
    expect(errors).toContain('^0.2.1-rc.2')
    expect(h.fs.writeCount()).toBe(0)
  })

  it('lets --dsh win over the environment and fails an invalid explicit selection', async () => {
    const unsupported = await writeFakeInstallation('0.3.0')
    const h = harness({ EEDSH_DSH_ANCHOR: join(unsupported, 'package.json') })
    const code = await runEedsh(['sync', '--dsh', installation.packageDir, '--config', fixture('basic')], h.options)
    expect(code).toBe(0)

    const invalid = harness({ EEDSH_DSH_ANCHOR: installation.installAnchor })
    const failed = await runEedsh(
      ['sync', '--dsh', join(await tempDir('eedsh-missing-'), 'nope'), '--config', fixture('basic')],
      invalid.options,
    )
    expect(failed).toBe(1)
    expect(invalid.text().err).toContain('dsh.anchor_invalid')
    expect(invalid.fs.writeCount()).toBe(0)
  })

  it('requires DSH for run and boots the discovered launcher', async () => {
    const missing = harness({})
    const spawn = fakeSpawner()
    const code = await runEedsh(
      ['run', '--no-sync', '--config', fixture('basic')],
      { ...missing.options, cwd: await tempDir('eedsh-run-no-dsh-'), spawn: spawn.spawn },
    )
    expect(code).toBe(1)
    expect(spawn.calls).toHaveLength(0)

    const h = harness({ EEDSH_DSH_ANCHOR: installation.installAnchor })
    const launched = fakeSpawner()
    const ok = await runEedsh(['run', '--no-sync', '--config', fixture('basic')], {
      ...h.options,
      spawn: launched.spawn,
    })
    expect(ok).toBe(0)
    expect(launched.calls).toHaveLength(1)
    expect(launched.calls[0]?.command).toBe(process.execPath)
    expect(launched.calls[0]?.args[0]).toBe(installation.binPath)
    expect(h.fs.writeCount()).toBe(0)
  })

  it('requires DSH for repl', async () => {
    const missing = harness({})
    const code = await runEedsh(
      ['repl', '--eval', '1', '--config', fixture('basic')],
      { ...missing.options, cwd: await tempDir('eedsh-repl-no-dsh-') },
    )
    expect(code).toBe(1)
    expect(missing.text().err).toContain('dsh.not_found')

    const h = harness({ EEDSH_DSH_ANCHOR: installation.installAnchor })
    const ok = await runEedsh(
      ['repl', '--eval', 'selectedProfile.name', '--config', fixture('basic')],
      h.options,
    )
    expect(ok).toBe(0)
    expect(h.text().out).toContain("'cli-fixture'")
  })

  it('keeps init usable without DSH and writes no DSH declaration', async () => {
    const home = await tempDir('eedsh-init-no-dsh-')
    const out: string[] = []
    const err: string[] = []
    const code = await runEedsh(['init', '--no-install'], {
      cwd: home,
      env: { XDG_CONFIG_HOME: home, HOME: home },
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
    })
    expect(code).toBe(0)
    expect(err.join('\n')).not.toContain('dsh.not_found')
    const config = await readFile(join(home, 'eedsh', 'config.ts'), 'utf8')
    expect(config).not.toContain('.dsh(')
    expect(config).toContain('defineConfig()')
  })

  it('keeps check independent of DSH discovery', async () => {
    const out: string[] = []
    const err: string[] = []
    const spawn = fakeSpawner({ listing: fixture('basic') })
    const code = await runEedsh(['check', '--config', fixture('basic')], {
      cwd: await tempDir('eedsh-check-no-dsh-'),
      env: {},
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
      spawn: spawn.spawn,
    })
    expect(err.join('\n')).not.toContain('dsh.not_found')
    expect(code === 0 || code === 1).toBe(true)
  })

  it('keeps doctor --profile independent of DSH discovery', async () => {
    const home = await tempDir('eedsh-doctor-no-dsh-')
    await mkdir(join(home, 'profiles', 'work'), { recursive: true })
    await writeFile(
      join(home, 'profiles', 'work', 'package.json'),
      JSON.stringify({ name: 'dsh-profile-work', private: true }),
    )
    const out: string[] = []
    const err: string[] = []
    const code = await runEedsh(['doctor', '--profile', 'work'], {
      cwd: await tempDir('eedsh-doctor-cwd-'),
      env: { DSH_HOME: home },
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
    })
    expect(err.join('\n')).not.toContain('dsh.not_found')
    expect(code === 0 || code === 1).toBe(true)
  })
})

describe('command DSH reuse', () => {
  it('evaluates a config that calls dshVersion()', async () => {
    await mkdir(join(root, 'packages/cli/.tmp'), { recursive: true })
    const dir = await mkdtemp(join(root, 'packages/cli/.tmp', 'dshversion-config-'))
    const configPath = join(dir, 'config.ts')
    await writeFile(
      configPath,
      `import { defineConfig, dshVersion } from '@eedsh/config'
const version = dshVersion()
if (typeof version !== 'string' || version.length === 0) throw new Error('no version')
export default defineConfig()
  .profile('cli-fixture', (profile) => {
    profile.bundle('@deepseek-ai/dsh-base').generated().layer('cli', (layer) => {
      layer.insert({ id: 'version-' + version, name: '@scope/version-row' })
    })
  })
  .build()
`,
    )
    const h = harness({ EEDSH_DSH_ANCHOR: installation.installAnchor })
    const code = await runEedsh(['sync', '--config', configPath], h.options)
    expect(code).toBe(0)
    const manifest = JSON.parse(h.fs.files.get(generatedManifest) ?? '{}') as {
      eedsh?: { dshVersion?: string }
    }
    expect(manifest.eedsh?.dshVersion).toBe(installation.version)
  })

  it('selects one installation for every watch pass', async () => {
    let discoveries = 0
    const h = harness(
      {},
      {
        discoverDsh: () => {
          discoveries += 1
          return Result.succeed(installation)
        },
      },
    )
    let onChange: (() => void) | undefined
    const watch = async (_dir: string, callback: () => void) => {
      onChange = callback
      return { close: async () => {} }
    }
    const controller = new AbortController()
    const running = runEedsh(['sync', '--config', fixture('basic'), '--watch'], {
      ...h.options,
      watch,
      signal: controller.signal,
    })
    expect(await waitFor(() => h.fs.files.has(generatedManifest))).toBe(true)
    expect(discoveries).toBe(1)
    onChange?.()
    await delay(100)
    expect(discoveries).toBe(1)
    controller.abort()
    expect(await running).toBe(0)
  })
})
describe('command DSH failure reporting', () => {
  function countOf(text: string, needle: string): number {
    return text.split('\n').filter((line) => line.includes(needle)).length
  }

  it('prints a discovery failure once and not as a config import failure', async () => {
    const h = harness({})
    const code = await runEedsh(['sync', '--config', fixture('basic')], {
      ...h.options,
      cwd: await tempDir('eedsh-report-not-found-'),
    })
    expect(code).toBe(1)
    const errors = h.text().err
    expect(countOf(errors, 'eedsh: dsh.not_found:')).toBe(1)
    expect(errors).not.toContain('config.import_failed')
    expect(errors).not.toContain('cannot import')
  })

  it('prints an unsupported-version failure once with its facts', async () => {
    const unsupported = await writeFakeInstallation('0.3.0')
    const h = harness({ EEDSH_DSH_ANCHOR: join(unsupported, 'package.json') })
    const code = await runEedsh(['sync', '--config', fixture('basic')], h.options)
    expect(code).toBe(1)
    const errors = h.text().err
    expect(countOf(errors, 'eedsh: dsh.unsupported_version:')).toBe(1)
    expect(errors).toContain('0.3.0')
    expect(errors).toContain('^0.2.1-rc.2')
    expect(errors).not.toContain('config.import_failed')
  })

  it('prints a capability failure once instead of a generic defect', async () => {
    const h = harness(
      { EEDSH_DSH_ANCHOR: installation.installAnchor },
      {
        loadDshBridge: async () =>
          Result.fail(
            new DshFailure({
              code: 'dsh.capability_missing',
              message: 'DSH 0.2.1-rc.2 does not provide the "composeEntries" capability',
              capability: 'composeEntries',
            }),
          ),
      },
    )
    const code = await runEedsh(['sync', '--config', fixture('basic')], h.options)
    expect(code).toBe(1)
    const errors = h.text().err
    expect(countOf(errors, 'eedsh: dsh.capability_missing:')).toBe(1)
    expect(errors).toContain('composeEntries')
    expect(errors).not.toContain('config.import_failed')
  })

  it('preserves a resolution.bridge_missing failure through config import', async () => {
    clearDshBridge()
    await mkdir(join(root, 'packages/cli/.tmp'), { recursive: true })
    const dir = await mkdtemp(join(root, 'packages/cli/.tmp', 'bridge-missing-config-'))
    const configPath = join(dir, 'config.ts')
    await writeFile(
      configPath,
      `import { defineConfig, dshVersion } from '@eedsh/config'
const version = dshVersion()
export default defineConfig()
  .profile('cli-fixture', (profile) => profile.bundle('@deepseek-ai/dsh-base').generated())
  .build()
`,
    )
    const h = harness(
      { EEDSH_DSH_ANCHOR: installation.installAnchor },
      { loadDshBridge: async () => Result.succeed({} as DshBridge) },
    )
    const code = await runEedsh(['sync', '--config', configPath], h.options)
    expect(code).toBe(1)
    const errors = h.text().err
    expect(countOf(errors, 'eedsh: resolution.bridge_missing:')).toBe(1)
    expect(errors).toContain('eedsh sync')
    expect(errors).not.toContain('config.import_failed')
  })
})
