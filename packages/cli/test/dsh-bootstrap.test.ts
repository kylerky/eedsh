import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import type { CommandRunner } from '../src/command-runner'
import { bootstrapDshInstallation } from '../src/dsh-bootstrap'
import type { DshFailure } from '../src/internal/effect/errors'

const root = process.cwd()
const tempRoot = join(root, 'packages/cli/.tmp')

interface Fixture {
  readonly dir: string
  readonly anchor: string
}

async function tempDir(prefix: string): Promise<string> {
  await mkdir(tempRoot, { recursive: true })
  return mkdtemp(join(tempRoot, prefix))
}

async function writeInstallation(
  parent: string,
  directory: string,
  version: string,
): Promise<Fixture> {
  const dir = join(parent, directory)
  await mkdir(join(dir, 'lib'), { recursive: true })
  const anchor = join(dir, 'package.json')
  await writeFile(
    anchor,
    JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: './lib/bin.js' } }, null, 2),
  )
  await writeFile(join(dir, 'lib', 'bin.js'), '#!/usr/bin/env node\n')
  return { dir, anchor }
}

function failureOf(result: Result.Result<unknown, DshFailure>): DshFailure {
  if (Result.isSuccess(result)) throw new Error('expected the bootstrap to fail')
  return result.failure
}

interface Call {
  readonly command: string
  readonly args: readonly string[]
  readonly timeoutMs: number | undefined
}

interface RunnerOptions {
  readonly pnpm?: () => { status: number | null; stdout: string; stderr?: string }
  readonly npmRoot?: () => { status: number | null; stdout: string; stderr?: string }
  readonly version?: () => { status: number | null; stdout: string; stderr?: string }
}

function fakeRunner(options: RunnerOptions): { runner: CommandRunner; calls: Call[] } {
  const calls: Call[] = []
  const runner: CommandRunner = (command, args, runOptions) => {
    calls.push({ command, args, timeoutMs: runOptions?.timeoutMs })
    const empty = { status: 1, stdout: '', stderr: '' }
    if (command === 'pnpm') return { stderr: '', ...(options.pnpm?.() ?? empty) }
    if (command === 'npm') return { stderr: '', ...(options.npmRoot?.() ?? empty) }
    if (args[0] === '--version') return { stderr: '', ...(options.version?.() ?? empty) }
    return empty
  }
  return { runner, calls }
}

function pnpmJson(anchor: string, version: string): string {
  return JSON.stringify([
    {
      path: '/pnpm/global/5',
      dependencies: { '@deepseek-ai/dsh': { version, path: anchor } },
    },
  ])
}

function bootstrap(launcher: string, runner: CommandRunner) {
  return bootstrapDshInstallation({
    env: { PATH: join(launcher, '..') },
    cwd: root,
    launcher,
    runner,
  })
}

describe('pnpm and npm bootstrap', () => {
  it('selects a pnpm global package that matches the launcher version', async () => {
    const home = await tempDir('bootstrap-pnpm-')
    const installation = await writeInstallation(home, 'dsh', '0.2.1-rc.2')
    const launcher = join(home, 'pnpm', 'bin', 'dsh')
    const { runner, calls } = fakeRunner({
      pnpm: () => ({ status: 0, stdout: pnpmJson(installation.dir, '0.2.1-rc.2') }),
      version: () => ({ status: 0, stdout: '0.2.1-rc.2\n' }),
    })
    const result = bootstrapDshInstallation({ env: {}, cwd: root, launcher, runner })
    if (Result.isFailure(result)) throw result.failure
    expect(result.success.manager).toBe('pnpm')
    expect(result.success.launcher).toBe(launcher)
    expect(result.success.installation.installAnchor).toBe(installation.anchor)
    expect(result.success.installation.version).toBe('0.2.1-rc.2')
    expect(calls).toContainEqual({
      command: 'pnpm',
      args: ['list', '-g', '--depth=0', '--json'],
      timeoutMs: expect.any(Number),
    })
    expect(calls).toContainEqual({
      command: 'npm',
      args: ['root', '-g'],
      timeoutMs: expect.any(Number),
    })
    expect(calls).toContainEqual({
      command: launcher,
      args: ['--version'],
      timeoutMs: expect.any(Number),
    })
  })

  it('selects an npm global package that matches the launcher version', async () => {
    const home = await tempDir('bootstrap-npm-')
    const globalRoot = join(home, 'npm-global')
    const installation = await writeInstallation(
      join(globalRoot, '@deepseek-ai'),
      'dsh',
      '0.2.1-rc.5',
    )
    const launcher = join(home, 'npm', 'bin', 'dsh')
    const { runner } = fakeRunner({
      npmRoot: () => ({ status: 0, stdout: `${globalRoot}\n` }),
      version: () => ({ status: 0, stdout: '0.2.1-rc.5\n' }),
    })
    const result = bootstrapDshInstallation({ env: {}, cwd: root, launcher, runner })
    if (Result.isFailure(result)) throw result.failure
    expect(result.success.manager).toBe('npm')
    expect(result.success.installation.installAnchor).toBe(installation.anchor)
  })

  it('rejects a candidate whose version differs from dsh --version', async () => {
    const home = await tempDir('bootstrap-mismatch-')
    const installation = await writeInstallation(home, 'dsh', '0.2.1-rc.2')
    const { runner } = fakeRunner({
      pnpm: () => ({ status: 0, stdout: pnpmJson(installation.dir, '0.2.1-rc.2') }),
      version: () => ({ status: 0, stdout: '0.2.1-rc.5\n' }),
    })
    const failure = failureOf(
      bootstrapDshInstallation({
        env: {},
        cwd: root,
        launcher: join(home, 'pnpm', 'bin', 'dsh'),
        runner,
      }),
    )
    expect(failure.code).toBe('dsh.launcher_unresolved')
    expect(failure.message).toContain('0.2.1-rc.5')
  })

  it('prefers the manager indicated by the launcher path for matching candidates', async () => {
    const home = await tempDir('bootstrap-multiple-')
    const pnpmInstall = await writeInstallation(home, 'pnpm-install', '0.2.1-rc.2')
    const npmRoot = join(home, 'npm-global')
    const npmInstall = await writeInstallation(join(npmRoot, '@deepseek-ai'), 'dsh', '0.2.1-rc.2')
    const launcher = join(home, 'pnpm', 'bin', 'dsh')
    const { runner } = fakeRunner({
      pnpm: () => ({ status: 0, stdout: pnpmJson(pnpmInstall.dir, '0.2.1-rc.2') }),
      npmRoot: () => ({ status: 0, stdout: npmRoot }),
      version: () => ({ status: 0, stdout: '0.2.1-rc.2\n' }),
    })
    const result = bootstrapDshInstallation({ env: {}, cwd: root, launcher, runner })
    if (Result.isFailure(result)) throw result.failure
    expect(result.success.manager).toBe('pnpm')
    expect(result.success.installation.installAnchor).toBe(pnpmInstall.anchor)
    expect(npmInstall.anchor).not.toBe(pnpmInstall.anchor)
  })

  it('fails with the candidates when the launcher cannot choose one', async () => {
    const home = await tempDir('bootstrap-ambiguous-')
    const pnpmInstall = await writeInstallation(home, 'pnpm-install', '0.2.1-rc.2')
    const npmRoot = join(home, 'npm-global')
    const npmInstall = await writeInstallation(join(npmRoot, '@deepseek-ai'), 'dsh', '0.2.1-rc.2')
    const launcher = join(home, 'neutral', 'bin', 'dsh')
    const { runner } = fakeRunner({
      pnpm: () => ({ status: 0, stdout: pnpmJson(pnpmInstall.dir, '0.2.1-rc.2') }),
      npmRoot: () => ({ status: 0, stdout: npmRoot }),
      version: () => ({ status: 0, stdout: '0.2.1-rc.2\n' }),
    })
    const failure = failureOf(bootstrapDshInstallation({ env: {}, cwd: root, launcher, runner }))
    expect(failure.code).toBe('dsh.launcher_unresolved')
    expect(failure.message).toContain(pnpmInstall.anchor)
    expect(failure.message).toContain(npmInstall.anchor)
    expect(failure.message).toContain('--dsh')
  })

  it('fails when no pnpm or npm candidate matches', async () => {
    const home = await tempDir('bootstrap-none-')
    const launcher = join(home, 'bin', 'dsh')
    const { runner } = fakeRunner({ version: () => ({ status: 0, stdout: '0.2.1-rc.2' }) })
    const failure = failureOf(bootstrapDshInstallation({ env: {}, cwd: root, launcher, runner }))
    expect(failure.code).toBe('dsh.launcher_unresolved')
    expect(failure.message).toContain('pnpm and npm only')
    expect(failure.message).toContain('EEDSH_DSH_ANCHOR')
  })

  it('contains malformed pnpm metadata instead of throwing', async () => {
    const home = await tempDir('bootstrap-json-')
    const { runner } = fakeRunner({
      pnpm: () => ({ status: 0, stdout: '{ not json' }),
      version: () => ({ status: 0, stdout: '0.2.1-rc.2' }),
    })
    const failure = failureOf(
      bootstrapDshInstallation({
        env: {},
        cwd: root,
        launcher: join(home, 'bin', 'dsh'),
        runner,
      }),
    )
    expect(failure.code).toBe('dsh.launcher_unresolved')
  })

  it('treats a timed-out metadata command as no candidate', async () => {
    const home = await tempDir('bootstrap-timeout-')
    const { runner, calls } = fakeRunner({
      pnpm: () => ({ status: null, stdout: '' }),
      npmRoot: () => ({ status: null, stdout: '' }),
      version: () => ({ status: 0, stdout: '0.2.1-rc.2' }),
    })
    const failure = failureOf(
      bootstrapDshInstallation({
        env: {},
        cwd: root,
        launcher: join(home, 'bin', 'dsh'),
        runner,
      }),
    )
    expect(failure.code).toBe('dsh.launcher_unresolved')
    for (const call of calls) expect(call.timeoutMs).toBeGreaterThan(0)
  })

  it('does not guess an unsupported launcher manager', async () => {
    const home = await tempDir('bootstrap-unsupported-')
    const { runner, calls } = fakeRunner({
      version: () => ({ status: 0, stdout: '0.2.1-rc.2' }),
    })
    const failure = failureOf(
      bootstrapDshInstallation({
        env: {},
        cwd: root,
        launcher: join(home, '.volta', 'bin', 'dsh'),
        runner,
      }),
    )
    expect(failure.code).toBe('dsh.launcher_unresolved')
    expect(failure.message).toContain('pnpm and npm only')
    const commands = calls.map((call) => `${call.command} ${call.args.join(' ')}`)
    expect(commands).not.toContain(expect.stringContaining('cmd-shim-target'))
    expect(commands).not.toContain(expect.stringContaining('yarn'))
    expect(commands).not.toContain(expect.stringContaining('bun'))
  })
})

describe('bootstrap boundaries', () => {
  it('never writes the anchor cache', async () => {
    const home = await tempDir('bootstrap-nowrite-')
    const installation = await writeInstallation(home, 'dsh', '0.2.1-rc.2')
    const launcher = join(home, 'pnpm', 'bin', 'dsh')
    const { runner } = fakeRunner({
      pnpm: () => ({ status: 0, stdout: pnpmJson(installation.dir, '0.2.1-rc.2') }),
      version: () => ({ status: 0, stdout: '0.2.1-rc.2' }),
    })
    const result = bootstrapDshInstallation({
      env: { DSH_HOME: home },
      cwd: root,
      launcher,
      runner,
    })
    expect(Result.isSuccess(result)).toBe(true)
    expect(existsSync(join(home, '.eedsh', 'installation.json'))).toBe(false)
  })

  it('uses fixed-argument commands and reads no shim metadata', async () => {
    const home = await tempDir('bootstrap-args-')
    const installation = await writeInstallation(home, 'dsh', '0.2.1-rc.2')
    const { runner, calls } = fakeRunner({
      pnpm: () => ({ status: 0, stdout: pnpmJson(installation.dir, '0.2.1-rc.2') }),
      version: () => ({ status: 0, stdout: '0.2.1-rc.2' }),
    })
    const result = bootstrap(join(home, 'bin', 'dsh'), runner)
    expect(Result.isSuccess(result)).toBe(true)
    for (const call of calls) {
      expect(call.args).not.toContain('cmd-shim-target')
      expect(call.args.join(' ')).not.toContain('cmd-shim-target')
    }
  })
})
describe('windows launchers', () => {
  it('bootstraps a .cmd launcher below a path with spaces', async () => {
    const home = await tempDir('bootstrap-win-')
    const installation = await writeInstallation(home, 'dsh with space', '0.2.1-rc.2')
    const launcherDir = join(home, 'Program Files', 'pnpm')
    await mkdir(launcherDir, { recursive: true })
    const launcher = join(launcherDir, 'dsh.CMD')
    await writeFile(launcher, '@echo off\r\n')
    const { runner, calls } = fakeRunner({
      pnpm: () => ({ status: 0, stdout: pnpmJson(installation.dir, '0.2.1-rc.2') }),
      version: () => ({ status: 0, stdout: '0.2.1-rc.2\r\n' }),
    })
    const result = bootstrapDshInstallation({ env: {}, cwd: root, launcher, runner })
    if (Result.isFailure(result)) throw result.failure
    expect(result.success.installation.installAnchor).toBe(installation.anchor)
    expect(result.success.launcher).toBe(launcher)
    expect(calls.find((call) => call.args[0] === '--version')?.command).toBe(launcher)
  })

  it('reads an npm global root with spaces and selects its package', async () => {
    const home = await tempDir('bootstrap-win-npm-')
    const globalRoot = join(home, 'npm global')
    const installation = await writeInstallation(
      join(globalRoot, '@deepseek-ai'),
      'dsh',
      '0.2.1-rc.5',
    )
    const launcherDir = join(home, 'Program Files', 'npm')
    await mkdir(launcherDir, { recursive: true })
    const launcher = join(launcherDir, 'dsh.CMD')
    await writeFile(launcher, '@echo off\r\n')
    const { runner } = fakeRunner({
      npmRoot: () => ({ status: 0, stdout: `${globalRoot}\r\n` }),
      version: () => ({ status: 0, stdout: '0.2.1-rc.5\r\n' }),
    })
    const result = bootstrapDshInstallation({ env: {}, cwd: root, launcher, runner })
    if (Result.isFailure(result)) throw result.failure
    expect(result.success.manager).toBe('npm')
    expect(result.success.installation.installAnchor).toBe(installation.anchor)
  })
})
