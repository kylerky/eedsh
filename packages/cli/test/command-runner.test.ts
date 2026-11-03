import { describe, expect, it } from 'vitest'
import {
  type CommandRunner,
  commandInvocation,
  DEFAULT_VERSION_PROBE_TIMEOUT_MS,
  defaultCommandRunner,
  parseVersionOutput,
  probeLauncherVersion,
} from '../src/command-runner'

describe('command invocation', () => {
  it('quotes Windows batch launchers and paths with spaces', () => {
    const invocation = commandInvocation('C:\\Program Files\\pnpm\\dsh.CMD', ['--version'], 'win32')
    expect(invocation.command.toLowerCase()).toContain('cmd')
    expect(invocation.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    const line = invocation.args[3] ?? ''
    expect(line).toContain('"C:\\Program Files\\pnpm\\dsh.CMD"')
    expect(line).toContain('--version')
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

describe('launcher version probe', () => {
  it('extracts a version from decorated launcher output', () => {
    expect(parseVersionOutput('0.2.1-rc.2\n')).toBe('0.2.1-rc.2')
    expect(parseVersionOutput('dsh 0.2.1-rc.5')).toBe('0.2.1-rc.5')
    expect(parseVersionOutput('not a version')).toBeUndefined()
  })

  it('passes a bound and accepts only a successful matching probe', () => {
    const calls: { command: string; args: readonly string[]; timeoutMs?: number }[] = []
    const runner: CommandRunner = (command, args, options) => {
      calls.push({
        command,
        args,
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      })
      return { status: 0, stdout: '0.2.1-rc.2\n', stderr: '' }
    }
    expect(probeLauncherVersion(runner, '/bin/dsh', 750)).toBe('0.2.1-rc.2')
    expect(calls).toEqual([{ command: '/bin/dsh', args: ['--version'], timeoutMs: 750 }])

    expect(probeLauncherVersion(runner, '/bin/dsh')).toBe('0.2.1-rc.2')
    expect(calls.at(-1)?.timeoutMs).toBe(DEFAULT_VERSION_PROBE_TIMEOUT_MS)
  })

  it('treats a non-zero exit or a timeout as no version', () => {
    const failed: CommandRunner = () => ({ status: 1, stdout: '0.2.1-rc.2', stderr: 'boom' })
    const timedOut: CommandRunner = () => ({ status: null, stdout: '', stderr: '' })
    expect(probeLauncherVersion(failed, '/bin/dsh')).toBeUndefined()
    expect(probeLauncherVersion(timedOut, '/bin/dsh')).toBeUndefined()
  })

  it('is the default runner for setup probes', () => {
    expect(typeof defaultCommandRunner).toBe('function')
  })
})
