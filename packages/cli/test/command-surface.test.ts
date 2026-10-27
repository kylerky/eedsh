/**
 * Characterization of the command surface through the `runEedsh` seam. The
 * assertions pin the invocation contract — subcommands, flags, passthrough,
 * exit codes, and help output — that the `effect/cli` port must preserve.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Layer } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { beforeAll, describe, expect, it } from 'vitest'
import { runEedsh } from '../src/cli'
import {
  DshInstallation,
  PackageManager,
  Preflight,
  SyncLock,
} from '../src/internal/effect/services'
import { preflightLayer } from '../src/preflight'
import { waitFor } from './support/async'
import {
  fakeDsh,
  fakePackageManager,
  fakePreflight,
  fakeSyncLock,
  memoryFileSystem,
} from './support/fakes'
import { fakeSpawner } from './support/process'

const execFileAsync = promisify(execFile)
const root = process.cwd()
const fixture = (name: string) => join(root, 'packages/cli/test/fixtures', name, 'eedsh.config.ts')
const generatedManifest = '/home/profiles/cli-fixture/.eedsh/generated/package.json'
const unmatchedManifest = '/home/profiles/cli-unmatched/.eedsh/generated/package.json'

/** A base layer row the unmatched fixture patches across. */
const basePatches = [{ insert: [{ id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' }] }]

interface HarnessOptions {
  basePatches?: Record<string, unknown>[]
  realPreflight?: boolean
}

function harness(options: HarnessOptions = {}) {
  const fs = memoryFileSystem()
  const packages = fakePackageManager()
  const dsh = fakeDsh({ patches: options.basePatches ?? [] })
  const preflight = fakePreflight()
  const lock = fakeSyncLock()
  const dshLayer = Layer.succeed(DshInstallation, dsh.shape)
  const services = () =>
    Layer.mergeAll(
      Layer.succeed(FileSystem.FileSystem, fs.fs),
      Layer.succeed(PackageManager, packages.shape),
      dshLayer,
      options.realPreflight
        ? preflightLayer.pipe(Layer.provide(dshLayer))
        : Layer.succeed(Preflight, preflight.shape),
      Layer.succeed(SyncLock, lock.shape),
    )
  const out: string[] = []
  const err: string[] = []
  return {
    fs,
    packages,
    out,
    err,
    options: {
      env: { DSH_HOME: '/home', XDG_CONFIG_HOME: '/home/xdg' },
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
      services,
    },
  }
}

beforeAll(async () => {
  if (!existsSync(join(root, 'packages/config/lib/index.js'))) {
    await execFileAsync('pnpm', ['--filter', '@eedsh/config', 'build'], { cwd: root })
  }
}, 120_000)

describe('command surface characterization', () => {
  it('runs sync and publishes the profile', async () => {
    const h = harness()
    expect(await runEedsh(['sync', '--config', fixture('basic')], h.options)).toBe(0)
    expect(h.fs.files.has(generatedManifest)).toBe(true)
    expect(h.out.join('\n')).toContain('profile cli-fixture')
  })

  it('runs sync --strict and fails on unmatched patch targets', async () => {
    const h = harness({ basePatches, realPreflight: true })
    expect(await runEedsh(['sync', '--strict', '--config', fixture('unmatched')], h.options)).toBe(
      1,
    )
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
    const running = runEedsh(['sync', '--config', fixture('basic'), '--watch'], {
      ...h.options,
      watch,
      signal: controller.signal,
    })
    expect(await waitFor(() => h.fs.files.has(generatedManifest))).toBe(true)
    expect(typeof onChange).toBe('function')
    controller.abort()
    expect(await running).toBe(0)
  })

  it('runs check through the compiler seam without materializing', async () => {
    const h = harness()
    const { calls, spawn } = fakeSpawner({ listing: `${fixture('basic')}\n` })
    expect(await runEedsh(['check', '--config', fixture('basic')], { ...h.options, spawn })).toBe(0)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.args).toContain('--listFilesOnly')
    expect(calls[1]?.options.stdio).toBe('inherit')
    expect(h.fs.files.size).toBe(0)
  })

  it('forwards run -- passthrough arguments to the launcher', async () => {
    const h = harness()
    const { calls, spawn } = fakeSpawner({ exitCode: 7 })
    const code = await runEedsh(
      ['run', '--config', fixture('basic'), '--no-sync', '--', '--port', '7777'],
      { ...h.options, spawn },
    )
    expect(code).toBe(7)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args.slice(1)).toEqual(['--profile', 'cli-fixture', '--port', '7777'])
  })

  it('returns the usage exit code for an unknown flag', async () => {
    const h = harness()
    expect(await runEedsh(['sync', '--bogus'], h.options)).toBe(2)
    expect(h.fs.files.size).toBe(0)
  })

  it('prints help naming every subcommand', async () => {
    const noArgs = harness()
    expect(await runEedsh([], noArgs.options)).toBe(0)
    const noArgsText = noArgs.out.join('\n')
    for (const command of ['sync', 'run', 'check']) expect(noArgsText).toContain(command)

    const help = harness()
    expect(await runEedsh(['--help'], help.options)).toBe(0)
    const helpText = help.out.join('\n')
    for (const command of ['sync', 'run', 'check']) expect(helpText).toContain(command)

    const syncHelp = harness()
    expect(await runEedsh(['sync', '--help'], syncHelp.options)).toBe(0)
    const syncText = syncHelp.out.join('\n')
    for (const flag of ['--config', '--profile', '--strict', '--watch', '--explain']) {
      expect(syncText).toContain(flag)
    }

    const runHelp = harness()
    expect(await runEedsh(['run', '--help'], runHelp.options)).toBe(0)
    const runText = runHelp.out.join('\n')
    expect(runText).toContain('--profile')
    expect(runText).toContain('--no-sync')
  })
})
