/**
 * Characterization of the command surface through the `runCli` seam. The
 * assertions pin the invocation contract — subcommands, flags, passthrough,
 * exit codes, and help output — that the `effect/cli` surface must preserve.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { waitFor } from './support/async'
import { devDshInstallation, installTestBridge } from './support/bridge'
import {
  type CliOverrides,
  captureOutput,
  fakeBundleResolver,
  fakeDshDiscovery,
  fakeWatcher,
  liveTestDshDiscovery,
  runCli,
} from './support/cli'
import {
  fakeChildProcessSpawner,
  fakePackageManager,
  fakePreflight,
  fakeSyncLock,
  memoryFileSystem,
} from './support/fakes'
import { fakeSpawner } from './support/process'

const execFileAsync = promisify(execFile)
const root = process.cwd()
const fixture = (name: string) => join(root, 'packages/cli/test/fixtures', name, 'config.ts')
// The CLI resolves DSH_HOME, so expectations must use the same platform path.
const homeRoot = resolve('/home')
const generatedPath = (profile: string) =>
  join(homeRoot, 'profiles', profile, '.eedsh', 'generated', 'package.json')
const generatedManifest = generatedPath('cli-fixture')
const unmatchedManifest = generatedPath('cli-unmatched')

/** A base layer row the unmatched fixture patches across. */
const basePatches = [{ insert: [{ id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' }] }]

interface HarnessOptions {
  basePatches?: Record<string, unknown>[]
  realPreflight?: boolean
}

function harness(options: HarnessOptions = {}) {
  const fs = memoryFileSystem()
  const packages = fakePackageManager()
  const preflight = fakePreflight()
  const lock = fakeSyncLock()
  const out: string[] = []
  const err: string[] = []
  const overrides: CliOverrides = {
    fileSystem: fs.fs,
    packageManager: packages.shape,
    syncLock: lock.shape,
    childProcessSpawner: fakeChildProcessSpawner().spawner,
    bundleResolver: fakeBundleResolver({ patches: options.basePatches ?? [] }),
    discovery: fakeDshDiscovery(devDshInstallation()),
    output: captureOutput(out, err),
    environment: {
      env: { DSH_HOME: '/home', XDG_CONFIG_HOME: '/home/xdg' },
      cwd: root,
    },
    // Omitted overrides are the live services; omit preflight for the real one
    // so it composes the fake bundle resolver's patches.
    ...(options.realPreflight ? {} : { preflight: preflight.shape }),
  }
  return {
    fs,
    packages,
    out,
    err,
    run: (argv: readonly string[], extra: CliOverrides = {}) =>
      runCli(argv, { ...overrides, ...extra }),
  }
}

beforeAll(async () => {
  if (!existsSync(join(root, 'packages/config/lib/index.js'))) {
    await execFileAsync('pnpm', ['--filter', '@eedsh/config', 'build'], {
      cwd: root,
      shell: process.platform === 'win32',
    })
  }
  await installTestBridge()
}, 120_000)

describe('command surface characterization', () => {
  it('runs sync and publishes the profile', async () => {
    const h = harness()
    expect(await h.run(['sync', '--config', fixture('basic')])).toBe(0)
    expect(h.fs.files.has(generatedManifest)).toBe(true)
    expect(h.out.join('\n')).toContain('profile cli-fixture')
  })

  it('runs sync --strict and fails on preflight warnings', async () => {
    const h = harness({ basePatches, realPreflight: true })
    expect(await h.run(['sync', '--strict', '--config', fixture('unmatched')])).toBe(1)
    expect(h.err.join('\n')).toContain('missing-row')
    expect(h.fs.files.has(unmatchedManifest)).toBe(false)
  })

  it('runs sync --watch until it is stopped', async () => {
    const h = harness()
    let onChange: (() => void) | undefined
    const watch = async (_dir: string, callback: () => void) => {
      onChange = callback
      return { close: async () => {} }
    }
    const controller = new AbortController()
    const running = h.run(['sync', '--config', fixture('basic'), '--watch'], {
      watcher: fakeWatcher({ watch, signal: controller.signal }),
    })
    expect(await waitFor(() => h.fs.files.has(generatedManifest))).toBe(true)
    expect(typeof onChange).toBe('function')
    controller.abort()
    expect(await running).toBe(0)
  })

  it('runs check through the compiler seam without materializing', async () => {
    const h = harness()
    const { calls, spawn } = fakeSpawner({ listing: `${fixture('basic')}\n` })
    expect(await h.run(['check', '--config', fixture('basic')], { spawner: spawn })).toBe(0)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.args).toContain('--listFilesOnly')
    expect(calls[1]?.options.stdio).toBe('inherit')
    expect(h.fs.files.size).toBe(0)
  })

  it('forwards run -- passthrough arguments to the launcher', async () => {
    const h = harness()
    const { calls, spawn } = fakeSpawner({ exitCode: 7 })
    const code = await h.run(
      ['run', '--config', fixture('basic'), '--no-sync', '--', '--port', '7777'],
      { spawner: spawn },
    )
    expect(code).toBe(7)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args.slice(1)).toEqual(['--profile', 'cli-fixture', '--port', '7777'])
  })

  it('returns the usage exit code for an unknown flag', async () => {
    const h = harness()
    expect(await h.run(['sync', '--bogus'])).toBe(2)
    expect(h.fs.files.size).toBe(0)
  })

  it('prints help naming every subcommand', async () => {
    const noArgs = harness()
    expect(await noArgs.run([])).toBe(0)
    const noArgsText = noArgs.out.join('\n')
    for (const command of ['init', 'sync', 'run', 'check']) expect(noArgsText).toContain(command)

    const help = harness()
    expect(await help.run(['--help'])).toBe(0)
    const helpText = help.out.join('\n')
    for (const command of ['init', 'sync', 'run', 'check']) expect(helpText).toContain(command)

    const syncHelp = harness()
    expect(await syncHelp.run(['sync', '--help'])).toBe(0)
    const syncText = syncHelp.out.join('\n')
    for (const flag of ['--config', '--profile', '--strict', '--watch', '--explain']) {
      expect(syncText).toContain(flag)
    }
    expect(syncText).toContain('treat preflight warnings as failures')

    const runHelp = harness()
    expect(await runHelp.run(['run', '--help'])).toBe(0)
    const runText = runHelp.out.join('\n')
    expect(runText).toContain('--profile')
    expect(runText).toContain('--no-sync')

    const initHelp = harness()
    expect(await initHelp.run(['init', '--help'])).toBe(0)
    expect(initHelp.out.join('\n')).toContain('--dsh')
  })

  it('prints the launcher_unresolved remedies once', async () => {
    await mkdir(join(root, '.tmp'), { recursive: true })
    const home = await mkdtemp(join(root, '.tmp', 'launcher-remedy-'))
    const bin = join(home, 'bin')
    await mkdir(bin, { recursive: true })
    const launcher = join(bin, 'dsh')
    await writeFile(launcher, '#!/bin/sh\nexec dsh "$@"\n')

    const h = harness()
    const code = await h.run(['sync', '--config', fixture('basic')], {
      environment: {
        env: { DSH_HOME: home, PATH: bin, XDG_CONFIG_HOME: join(home, 'xdg') },
        cwd: root,
      },
      commandRunner: () => ({ status: 1, stdout: '', stderr: '' }),
      discovery: liveTestDshDiscovery(),
    })
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain('dsh.launcher_unresolved')
    expect(errors).toContain(launcher)
    expect(errors).toContain('pnpm and npm only')
    expect(errors).toContain('--dsh')
    expect(errors).toContain('EEDSH_DSH_ANCHOR')
    expect(errors).toContain('eedsh run')
    expect(errors).toContain('eedsh sync')
    expect(
      errors.split('\n').filter((line) => line.includes('dsh.launcher_unresolved')),
    ).toHaveLength(1)
    expect(h.fs.writeCount()).toBe(0)
  })
})
