import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { clearDshBridge, type DshBridge } from '@eedsh/config'
import type { InstallationAnchor } from '@eedsh/runtime/installation-anchor'
import { Cause, Effect, Exit } from 'effect'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import type { InstallationAnchorStore } from '../src/installation-anchor'
import { DshFailure } from '../src/internal/effect/errors'
import type { CommandRunnerShape } from '../src/internal/effect/services'
import { delay, waitFor } from './support/async'
import { devDshInstallation } from './support/bridge'
import {
  type CliOverrides,
  captureOutput,
  fakeBundleResolver,
  fakeDshDiscovery,
  forkCli,
  interruptCli,
  realFileSystem,
  runCli,
} from './support/cli'
import {
  fakeChildProcessSpawner,
  fakePackageManager,
  fakePreflight,
  fakeSyncLock,
  fakeWatcher,
  memoryFileSystem,
} from './support/fakes'
import { fakeSpawner } from './support/process'

const root = process.cwd()
const fixture = (name: string) => join(root, 'packages/cli/test/fixtures', name, 'config.ts')
const generatedManifest = join(
  resolve('/home'),
  'profiles',
  'cli-fixture',
  '.eedsh',
  'generated',
  'package.json',
)
const installation = devDshInstallation()

/** Per-invocation conveniences on top of the service overrides. */
interface RunExtras extends Partial<CliOverrides> {
  /** Replace the invocation environment entirely. */
  env?: Record<string, string | undefined>
  /** Replace the invocation working directory. */
  cwd?: string
}

function harness(env: Record<string, string | undefined>, options: Partial<CliOverrides> = {}) {
  const fs = memoryFileSystem()
  const packages = fakePackageManager()
  const preflight = fakePreflight()
  const lock = fakeSyncLock()
  const out: string[] = []
  const err: string[] = []
  const baseEnv = { DSH_HOME: '/home', XDG_CONFIG_HOME: '/home/xdg', ...env }
  const overrides: CliOverrides = {
    fileSystem: fs.fs,
    packageManager: packages.shape,
    preflight: preflight.shape,
    syncLock: lock.shape,
    childProcessSpawner: fakeChildProcessSpawner().spawner,
    output: captureOutput(out, err),
    environment: { env: baseEnv, cwd: root },
    ...options,
  }
  return {
    fs,
    packages,
    out,
    err,
    run: (argv: readonly string[], extra: RunExtras = {}) => {
      const { env: envOverride, cwd, ...rest } = extra
      return runCli(argv, {
        ...overrides,
        ...rest,
        environment: { env: envOverride ?? baseEnv, cwd: cwd ?? root },
      })
    },
    fork: (argv: readonly string[], extra: RunExtras = {}) => {
      const { env: envOverride, cwd, ...rest } = extra
      return forkCli(argv, {
        ...overrides,
        ...rest,
        environment: { env: envOverride ?? baseEnv, cwd: cwd ?? root },
      })
    },
    text: () => ({ out: out.join('\n'), err: err.join('\n') }),
  }
}

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)))
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
    const code = await h.run(['sync', '--config', fixture('basic')])
    expect(code).toBe(0)
    expect(h.fs.files.has(generatedManifest)).toBe(true)
  })

  it('fails sync before any write when no DSH is discoverable', async () => {
    const h = harness({})
    const code = await h.run(['sync', '--config', fixture('basic')], {
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
    const code = await h.run(['sync', '--config', fixture('basic')])
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
    const code = await h.run([
      'sync',
      '--dsh',
      installation.packageDir,
      '--config',
      fixture('basic'),
    ])
    expect(code).toBe(0)

    const invalid = harness({ EEDSH_DSH_ANCHOR: installation.installAnchor })
    const failed = await invalid.run([
      'sync',
      '--dsh',
      join(await tempDir('eedsh-missing-'), 'nope'),
      '--config',
      fixture('basic'),
    ])
    expect(failed).toBe(1)
    expect(invalid.text().err).toContain('dsh.anchor_invalid')
    expect(invalid.fs.writeCount()).toBe(0)
  })

  it('requires DSH for run and boots the discovered launcher', async () => {
    const missing = harness({})
    const spawn = fakeSpawner()
    const code = await missing.run(['run', '--no-sync', '--config', fixture('basic')], {
      cwd: await tempDir('eedsh-run-no-dsh-'),
      spawner: spawn.spawn,
    })
    expect(code).toBe(1)
    expect(spawn.calls).toHaveLength(0)

    const h = harness({ EEDSH_DSH_ANCHOR: installation.installAnchor })
    const launched = fakeSpawner()
    const ok = await h.run(['run', '--no-sync', '--config', fixture('basic')], {
      spawner: launched.spawn,
    })
    expect(ok).toBe(0)
    expect(launched.calls).toHaveLength(1)
    expect(launched.calls[0]?.command).toBe(process.execPath)
    expect(launched.calls[0]?.args[0]).toBe(installation.binPath)
    expect(h.fs.writeCount()).toBe(0)
  })

  it('requires DSH for repl', async () => {
    const missing = harness({})
    const code = await missing.run(['repl', '--eval', '1', '--config', fixture('basic')], {
      cwd: await tempDir('eedsh-repl-no-dsh-'),
    })
    expect(code).toBe(1)
    expect(missing.text().err).toContain('dsh.not_found')

    // The REPL reads the config project's authoring package through the
    // invocation filesystem, so this run inspects the real project.
    const h = harness({ EEDSH_DSH_ANCHOR: installation.installAnchor })
    const ok = await h.run(
      ['repl', '--eval', 'selectedProfile.name', '--config', fixture('basic')],
      { extra: [realFileSystem] },
    )
    expect(ok).toBe(0)
    expect(h.text().out).toContain("'cli-fixture'")
  })

  it('keeps init usable without DSH and writes no DSH declaration', async () => {
    const home = await tempDir('eedsh-init-no-dsh-')
    const out: string[] = []
    const err: string[] = []
    const code = await runCli(['init', '--no-install'], {
      environment: { env: { XDG_CONFIG_HOME: home, HOME: home }, cwd: home },
      output: captureOutput(out, err),
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
    const code = await runCli(['check', '--config', fixture('basic')], {
      environment: { env: {}, cwd: await tempDir('eedsh-check-no-dsh-') },
      output: captureOutput(out, err),
      spawner: spawn.spawn,
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
    const code = await runCli(['doctor', '--profile', 'work'], {
      environment: { env: { DSH_HOME: home }, cwd: await tempDir('eedsh-doctor-cwd-') },
      output: captureOutput(out, err),
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
    const code = await h.run(['sync', '--config', configPath])
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
        discovery: fakeDshDiscovery(installation, {
          discover: () => {
            discoveries += 1
            return Effect.succeed(Result.succeed(installation))
          },
        }),
      },
    )
    const watcher = fakeWatcher()
    const running = h.fork(['sync', '--config', fixture('basic'), '--watch'], {
      watcher: watcher.shape,
    })
    expect(await waitFor(() => h.fs.files.has(generatedManifest))).toBe(true)
    expect(discoveries).toBe(1)
    watcher.notify()
    await delay(100)
    expect(discoveries).toBe(1)
    const exit = await interruptCli(running)
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  })
})

describe('command DSH failure reporting', () => {
  function countOf(text: string, needle: string): number {
    return text.split('\n').filter((line) => line.includes(needle)).length
  }

  it('prints a discovery failure once and not as a config import failure', async () => {
    const h = harness({})
    const code = await h.run(['sync', '--config', fixture('basic')], {
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
    const code = await h.run(['sync', '--config', fixture('basic')])
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
        bundleResolver: fakeBundleResolver({
          loadBridge: async () =>
            Result.fail(
              new DshFailure({
                code: 'dsh.capability_missing',
                message: 'DSH 0.2.1-rc.2 does not provide the "composeEntries" capability',
                capability: 'composeEntries',
              }),
            ),
        }),
      },
    )
    const code = await h.run(['sync', '--config', fixture('basic')])
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
      {
        bundleResolver: fakeBundleResolver({
          loadBridge: async () => Result.succeed({} as DshBridge),
        }),
      },
    )
    const code = await h.run(['sync', '--config', configPath])
    expect(code).toBe(1)
    const errors = h.text().err
    expect(countOf(errors, 'eedsh: resolution.bridge_missing:')).toBe(1)
    expect(errors).toContain('eedsh sync')
    expect(errors).not.toContain('config.import_failed')
  })
})
interface BootstrapFixture {
  readonly home: string
  readonly bin: string
  readonly launcher: string
  readonly installation: string
  readonly calls: { command: string; args: readonly string[]; timeoutMs?: number }[]
  readonly runner: CommandRunnerShape
  readonly h: ReturnType<typeof harness>
}

interface FakeBootstrapOptions {
  readonly manifestVersion?: string
  readonly probeVersion?: string
  readonly pnpm?: boolean
}

async function fakeBootstrap(options: FakeBootstrapOptions = {}): Promise<BootstrapFixture> {
  const home = await tempDir('eedsh-bootstrap-home-')
  const installation = await writeFakeInstallation(options.manifestVersion ?? '0.2.1-rc.2')
  const bin = join(home, 'bin')
  await mkdir(bin, { recursive: true })
  const launcher = join(bin, 'dsh')
  await writeFile(launcher, '#!/bin/sh\nexec dsh "$@"\n')
  const calls: { command: string; args: readonly string[]; timeoutMs?: number }[] = []
  const version = options.probeVersion ?? '0.2.1-rc.2'
  const runner: CommandRunnerShape = (command, args, runOptions) =>
    Effect.sync(() => {
      calls.push({
        command,
        args,
        ...(runOptions?.timeoutMs === undefined ? {} : { timeoutMs: runOptions.timeoutMs }),
      })
      if (args[0] === '--version') return { status: 0, stdout: `${version}\n`, stderr: '' }
      if (command === 'pnpm') {
        if (options.pnpm === false) return { status: 1, stdout: '', stderr: 'no pnpm' }
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              path: '/pnpm/global',
              dependencies: {
                '@deepseek-ai/dsh': { version, path: installation },
              },
            },
          ]),
          stderr: '',
        }
      }
      return { status: 1, stdout: '', stderr: '' }
    })
  const h = harness(
    { DSH_HOME: home, PATH: bin, XDG_CONFIG_HOME: join(home, 'xdg') },
    {
      commandRunner: runner,
      bundleResolver: fakeBundleResolver({
        loadBridge: async () => Result.succeed({} as DshBridge),
      }),
    },
  )
  return { home, bin, launcher, installation, calls, runner, h }
}

function managerQueries(calls: readonly { command: string }[]): number {
  return calls.filter((call) => call.command === 'pnpm' || call.command === 'npm').length
}

/** One bootstrap asks pnpm once, so pnpm calls count bootstrap rounds. */
function bootstrapRounds(calls: readonly { command: string }[]): number {
  return calls.filter((call) => call.command === 'pnpm').length
}

function anchorPathOf(home: string): string {
  return join(home, '.local', 'state', 'installation.json')
}

function profileManifest(home: string): string {
  return join(home, 'profiles', 'cli-fixture', '.eedsh', 'generated', 'package.json')
}

describe('sync installation bootstrap', () => {
  it('bootstraps the first sync through pnpm and records the anchor', async () => {
    const f = await fakeBootstrap()
    const code = await f.h.run(['sync', '--config', fixture('basic')])
    expect(code).toBe(0)
    expect(f.h.fs.files.has(profileManifest(f.home))).toBe(true)
    expect(f.h.text().err).not.toContain('dsh.launcher_unresolved')

    const anchor = JSON.parse(await readFile(anchorPathOf(f.home), 'utf8')) as InstallationAnchor
    expect(anchor.format).toBe(1)
    expect(anchor.installAnchor).toBe(join(f.installation, 'package.json'))
    expect(anchor.version).toBe('0.2.1-rc.2')
    expect(anchor.launcher).toBe(f.launcher)
    expect(anchor.manager).toBe('pnpm')
    expect(anchor.recordedBy).toBe('sync')
    expect(bootstrapRounds(f.calls)).toBe(1)
  })

  it('does not query package managers again when the anchor is valid', async () => {
    const f = await fakeBootstrap()
    expect(await f.h.run(['sync', '--config', fixture('basic')])).toBe(0)
    const queries = managerQueries(f.calls)
    expect(await f.h.run(['sync', '--config', fixture('basic')])).toBe(0)
    expect(managerQueries(f.calls)).toBe(queries)
    expect(f.calls.filter((call) => call.command === f.launcher)).toHaveLength(2)
  })

  it('re-bootstraps when the recorded package disappears', async () => {
    const f = await fakeBootstrap()
    expect(await f.h.run(['sync', '--config', fixture('basic')])).toBe(0)
    await rm(anchorPathOf(f.home), { force: true })
    expect(await f.h.run(['sync', '--config', fixture('basic')])).toBe(0)
    expect(bootstrapRounds(f.calls)).toBe(2)
    expect(existsSync(anchorPathOf(f.home))).toBe(true)
  })

  it('re-bootstraps when the recorded version no longer matches', async () => {
    const f = await fakeBootstrap()
    expect(await f.h.run(['sync', '--config', fixture('basic')])).toBe(0)
    const record = JSON.parse(await readFile(anchorPathOf(f.home), 'utf8')) as InstallationAnchor
    await writeFile(
      anchorPathOf(f.home),
      JSON.stringify({ ...record, version: '0.2.1-rc.5' }, null, 2),
      'utf8',
    )
    expect(await f.h.run(['sync', '--config', fixture('basic')])).toBe(0)
    expect(bootstrapRounds(f.calls)).toBe(2)
    const refreshed = JSON.parse(await readFile(anchorPathOf(f.home), 'utf8')) as InstallationAnchor
    expect(refreshed.version).toBe('0.2.1-rc.2')
  })

  it("bootstraps during run's sync step", async () => {
    const f = await fakeBootstrap()
    const spawn = fakeSpawner()
    const code = await f.h.run(['run', '--config', fixture('basic')], { spawner: spawn.spawn })
    expect(code).toBe(0)
    expect(f.h.fs.files.has(profileManifest(f.home))).toBe(true)
    expect(existsSync(anchorPathOf(f.home))).toBe(true)
    expect(spawn.calls).toHaveLength(1)
  })

  it('fails with launcher_unresolved before import, publication, or boot', async () => {
    const f = await fakeBootstrap({ pnpm: false })
    const spawn = fakeSpawner()
    const code = await f.h.run(['run', '--config', fixture('basic')], { spawner: spawn.spawn })
    expect(code).toBe(1)
    const errors = f.h.text().err
    expect(errors).toContain('dsh.launcher_unresolved')
    expect(errors).toContain('pnpm and npm only')
    expect(errors).toContain('--dsh')
    expect(errors).toContain('EEDSH_DSH_ANCHOR')
    expect(errors).toContain(f.launcher)
    expect(errors).not.toContain('config.import_failed')
    expect(spawn.calls).toHaveLength(0)
    expect(f.h.fs.writeCount()).toBe(0)
    expect(f.h.fs.files.has(profileManifest(f.home))).toBe(false)
    expect(existsSync(anchorPathOf(f.home))).toBe(false)
  })
})

describe('installation bootstrap boundaries', () => {
  it('keeps doctor query-free and usable without a valid anchor', async () => {
    const f = await fakeBootstrap()
    const home = await tempDir('eedsh-doctor-bootstrap-')
    await mkdir(join(home, 'profiles', 'work'), { recursive: true })
    await writeFile(
      join(home, 'profiles', 'work', 'package.json'),
      JSON.stringify({ name: 'dsh-profile-work', private: true }),
    )
    const out: string[] = []
    const err: string[] = []
    const code = await runCli(['doctor', '--profile', 'work'], {
      environment: {
        env: { DSH_HOME: home, PATH: f.bin },
        cwd: await tempDir('eedsh-doctor-bootstrap-cwd-'),
      },
      output: captureOutput(out, err),
      commandRunner: f.runner,
    })
    expect(code === 0 || code === 1).toBe(true)
    expect(err.join('\n')).not.toContain('dsh.not_found')
    expect(managerQueries(f.calls)).toBe(0)
    expect(f.calls).toHaveLength(0)
  })

  it('names the sync-once remedy when repl has no launcher and no anchor', async () => {
    const home = await tempDir('eedsh-repl-nolauncher-home-')
    const h = harness({ DSH_HOME: home, PATH: '' })
    const code = await h.run(['repl', '--eval', '1', '--config', fixture('basic')], {
      cwd: await tempDir('eedsh-repl-nolauncher-'),
    })
    expect(code).toBe(1)
    const errors = h.text().err
    expect(errors).toContain('dsh.not_found')
    expect(errors).toContain('eedsh sync')
    expect(errors).toContain('--dsh')
    expect(errors).toContain('EEDSH_DSH_ANCHOR')
  })

  it('rejects repl and run --no-sync without querying a package manager', async () => {
    const f = await fakeBootstrap()
    const repl = await f.h.run(['repl', '--eval', '1', '--config', fixture('basic')])
    expect(repl).toBe(1)
    expect(f.h.text().err).toContain('dsh.launcher_unresolved')
    expect(f.h.text().err).toContain('eedsh sync')
    expect(f.calls).toHaveLength(0)

    const spawn = fakeSpawner()
    const runNoSync = await f.h.run(['run', '--no-sync', '--config', fixture('basic')], {
      spawner: spawn.spawn,
    })
    expect(runNoSync).toBe(1)
    expect(spawn.calls).toHaveLength(0)
    expect(f.calls).toHaveLength(0)
  })

  it('continues with the validated installation when the anchor write fails', async () => {
    const f = await fakeBootstrap()
    const store: InstallationAnchorStore = {
      read: () => Effect.succeed(undefined),
      write: () => Effect.succeed({ ok: false, error: 'read-only home' } as const),
    }
    const options: CliOverrides = { anchor: store }
    expect(await f.h.run(['sync', '--config', fixture('basic')], options)).toBe(0)
    expect(f.h.fs.files.has(profileManifest(f.home))).toBe(true)
    expect(f.h.text().err).toContain('warning')
    expect(f.h.text().err).toContain('read-only home')
    expect(existsSync(anchorPathOf(f.home))).toBe(false)

    expect(await f.h.run(['sync', '--config', fixture('basic')], options)).toBe(0)
    expect(bootstrapRounds(f.calls)).toBe(2)
  })
})
