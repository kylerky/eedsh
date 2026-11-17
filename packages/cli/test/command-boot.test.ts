import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveLaunch } from '../src/command/boot'
import { defaultSpawn } from '../src/spawn'

const binPath = '/opt/dsh/lib/bin.js'

describe('launch resolution', () => {
  it('runs a wrapper launcher distinct from the bin entry on POSIX', () => {
    const launch = resolveLaunch(
      { launcher: '/usr/local/bin/dsh', binPath, launcherExists: true },
      ['--profile', 'work', '--port', '7777'],
      { platform: 'linux' },
    )
    expect(launch).toEqual({
      command: '/usr/local/bin/dsh',
      args: ['--profile', 'work', '--port', '7777'],
    })
  })

  it('runs the bin entry with the Node.js executable when the launcher is the bin entry', () => {
    const launch = resolveLaunch(
      { launcher: binPath, binPath, launcherExists: true },
      ['--profile', 'work'],
      { platform: 'linux' },
    )
    expect(launch).toEqual({ command: process.execPath, args: [binPath, '--profile', 'work'] })
  })

  it('falls back to the bin entry when the recorded wrapper is missing', () => {
    const launch = resolveLaunch(
      { launcher: '/usr/local/bin/dsh', binPath, launcherExists: false },
      ['--profile', 'work'],
      { platform: 'linux' },
    )
    expect(launch).toEqual({ command: process.execPath, args: [binPath, '--profile', 'work'] })
  })

  it('quotes a Windows command-shell wrapper and every argument', () => {
    const wrapper = 'C:\\Program Files\\pnpm\\dsh.CMD'
    const launch = resolveLaunch(
      { launcher: wrapper, binPath: 'C:\\dsh\\lib\\bin.js', launcherExists: true },
      ['--profile', 'super agent', '--port', '7777'],
      { platform: 'win32', comSpec: 'C:\\Windows\\System32\\cmd.exe' },
    )
    expect(launch).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '"C:\\Program Files\\pnpm\\dsh.CMD" "--profile" "super agent" "--port" "7777"',
      ],
    })
  })
})

describe.skipIf(process.platform === 'win32')('launcher child environment', () => {
  it('runs the wrapper with its environment and forwards the exit status', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eedsh-launch-wrapper-'))
    try {
      const child = join(dir, 'child.mjs')
      await writeFile(
        child,
        "process.stdout.write(process.env.EEDSH_LAUNCH_MARKER ?? 'missing')\nprocess.exitCode = 23\n",
      )
      const wrapper = join(dir, 'dsh')
      await writeFile(
        wrapper,
        `#!/bin/sh\nexport EEDSH_LAUNCH_MARKER=from-wrapper\nexec "${process.execPath}" "${child}" "$@"\n`,
      )
      await chmod(wrapper, 0o755)
      const launch = resolveLaunch(
        { launcher: wrapper, binPath: join(dir, 'bin.js'), launcherExists: true },
        ['--profile', 'fixture'],
        { platform: 'linux' },
      )
      const result = await new Promise<{ code: number | null; output: string }>(
        (resolve, reject) => {
          const spawned = defaultSpawn(launch.command, [...launch.args], { stdio: 'pipe' })
          let output = ''
          spawned.stdout?.on('data', (chunk) => {
            output += String(chunk)
          })
          spawned.on('error', reject)
          spawned.on('close', (code) => resolve({ code, output }))
        },
      )
      expect(result.output).toBe('from-wrapper')
      expect(result.code).toBe(23)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
