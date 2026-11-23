import { Effect, Layer } from 'effect'
import * as PlatformError from 'effect/PlatformError'
import { ChildProcessSpawner } from 'effect/process'
import { describe, expect, it } from 'vitest'
import {
  boundedCommandRunner,
  commandInvocation,
  DEFAULT_VERSION_PROBE_TIMEOUT_MS,
  parseVersionOutput,
  pnpmInvocation,
  probeLauncherVersion,
  versionProbe,
} from '../src/command-runner'
import { commandRunnerLayer } from '../src/internal/effect/layer'
import { CommandRunner, type CommandRunnerShape } from '../src/internal/effect/services'
import { fakeChildProcessSpawner } from './support/fakes'

describe('command invocation', () => {
  it('quotes Windows batch launchers and paths with spaces', () => {
    const invocation = commandInvocation('C:\\Program Files\\pnpm\\dsh.CMD', ['--version'], 'win32')
    expect(invocation.command.toLowerCase()).toContain('cmd')
    expect(invocation.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    const line = invocation.args[3] ?? ''
    expect(line).toContain('"C:\\Program Files\\pnpm\\dsh.CMD"')
    expect(line).toContain('--version')
  })

  it('runs pnpm through cmd.exe on Windows and directly elsewhere', () => {
    const windows = pnpmInvocation(['install'], 'win32')
    expect(windows.command.toLowerCase()).toContain('cmd')
    expect(windows.args).toEqual(['/d', '/s', '/c', 'pnpm', 'install'])
    expect(pnpmInvocation(['install'], 'linux')).toEqual({ command: 'pnpm', args: ['install'] })
  })

  it('runs non-batch commands directly', () => {
    expect(commandInvocation('/usr/local/bin/dsh', ['--version'], 'linux')).toEqual({
      command: '/usr/local/bin/dsh',
      args: ['--version'],
    })
    expect(commandInvocation('C:\\tools\\dsh.exe', ['--version'], 'win32')).toEqual({
      command: 'C:\\tools\\dsh.exe',
      args: ['--version'],
    })
  })
})

describe('bounded command runner', () => {
  it('runs the invocation through the spawner and captures output', async () => {
    const fake = fakeChildProcessSpawner({ stdout: '0.2.1-rc.2\n', stderr: 'warn\n', exitCode: 3 })
    const result = await Effect.runPromise(
      Effect.provideService(
        boundedCommandRunner('/usr/local/bin/dsh', ['--version'], {
          timeoutMs: 750,
          env: { PATH: '/usr/local/bin' },
        }),
        ChildProcessSpawner.ChildProcessSpawner,
        fake.spawner,
      ),
    )
    expect(result).toEqual({ status: 3, stdout: '0.2.1-rc.2\n', stderr: 'warn\n' })
    expect(fake.calls).toEqual([
      {
        command: '/usr/local/bin/dsh',
        args: ['--version'],
        cwd: undefined,
        env: { PATH: '/usr/local/bin' },
      },
    ])
  })

  it('returns a null status when the command cannot start', async () => {
    const fake = fakeChildProcessSpawner({
      spawnError: PlatformError.systemError({
        _tag: 'NotFound',
        module: 'ChildProcess',
        method: 'spawn',
        pathOrDescriptor: '/missing/dsh',
      }),
    })
    const result = await Effect.runPromise(
      Effect.provideService(
        boundedCommandRunner('/missing/dsh', ['--version']),
        ChildProcessSpawner.ChildProcessSpawner,
        fake.spawner,
      ),
    )
    expect(result.status).toBeNull()
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('NotFound')
    expect(result.stderr).toContain('/missing/dsh')
  })

  it('binds the live runner layer to the child-process spawner', async () => {
    const fake = fakeChildProcessSpawner({
      resultFor: (command) =>
        command === '/usr/local/bin/dsh' ? { stdout: '0.2.1-rc.2\n' } : undefined,
    })
    const runnerLayer = commandRunnerLayer.pipe(
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, fake.spawner)),
    )
    const program = Effect.gen(function* () {
      const runner = yield* CommandRunner
      return yield* probeLauncherVersion(runner, '/usr/local/bin/dsh')
    })
    expect(await Effect.runPromise(program.pipe(Effect.provide(runnerLayer)))).toBe('0.2.1-rc.2')
  })

  it('returns a null status when the command exceeds its bound', async () => {
    const spawner = ChildProcessSpawner.make(() => Effect.never)
    const result = await Effect.runPromise(
      Effect.provideService(
        boundedCommandRunner('/hanging/dsh', ['--version'], { timeoutMs: 10 }),
        ChildProcessSpawner.ChildProcessSpawner,
        spawner,
      ),
    )
    expect(result.status).toBeNull()
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('timed out')
  })
})

describe('launcher version probe', () => {
  it('extracts a version from decorated launcher output', () => {
    expect(parseVersionOutput('0.2.1-rc.2\n')).toBe('0.2.1-rc.2')
    expect(parseVersionOutput('dsh 0.2.1-rc.5')).toBe('0.2.1-rc.5')
    expect(parseVersionOutput('not a version')).toBeUndefined()
  })

  it('passes a bound and accepts only a successful matching probe', async () => {
    const calls: {
      command: string
      args: readonly string[]
      timeoutMs?: number
      env?: Record<string, string | undefined>
    }[] = []
    const runner: CommandRunnerShape = (command, args, options) => {
      calls.push({
        command,
        args,
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options?.env === undefined ? {} : { env: options.env }),
      })
      return Effect.succeed({ status: 0, stdout: '0.2.1-rc.2\n', stderr: '' })
    }
    expect(await Effect.runPromise(probeLauncherVersion(runner, '/bin/dsh', 750))).toBe(
      '0.2.1-rc.2',
    )
    expect(calls).toEqual([{ command: '/bin/dsh', args: ['--version'], timeoutMs: 750 }])

    expect(await Effect.runPromise(probeLauncherVersion(runner, '/bin/dsh'))).toBe('0.2.1-rc.2')
    expect(calls.at(-1)?.timeoutMs).toBe(DEFAULT_VERSION_PROBE_TIMEOUT_MS)
  })

  it('treats a non-zero exit or a timeout as no version', async () => {
    const failed: CommandRunnerShape = () =>
      Effect.succeed({ status: 1, stdout: '0.2.1-rc.2', stderr: 'boom' })
    const timedOut: CommandRunnerShape = () =>
      Effect.succeed({ status: null, stdout: '', stderr: '' })
    expect(await Effect.runPromise(probeLauncherVersion(failed, '/bin/dsh'))).toBeUndefined()
    expect(await Effect.runPromise(probeLauncherVersion(timedOut, '/bin/dsh'))).toBeUndefined()
  })

  it('binds the probe environment through versionProbe', async () => {
    const env = { DSH_HOME: '/home' }
    const runner: CommandRunnerShape = (_command, _args, options) =>
      Effect.succeed({
        status: 0,
        stdout: options?.env === env ? '0.2.1-rc.2\n' : '',
        stderr: '',
      })
    expect(await Effect.runPromise(versionProbe(runner, env)('/bin/dsh'))).toBe('0.2.1-rc.2')
  })
})
