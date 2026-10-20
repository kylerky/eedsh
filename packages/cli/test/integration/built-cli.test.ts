import { execFile } from 'node:child_process'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { resolveDshInstallation } from '../../src/dsh.js'

const execFileAsync = promisify(execFile)
const root = process.cwd()

describe('built CLI integration', () => {
  beforeAll(async () => {
    await execFileAsync('pnpm', ['-r', 'build'], { cwd: root })
  }, 180_000)

  it('syncs a TypeScript config and produces a dumpable profile', async () => {
    await mkdir(join(root, '.tmp'), { recursive: true })
    const home = await mkdtemp(join(root, '.tmp', 'built-home-'))
    const cli = join(root, 'packages/cli/lib/bin.js')
    const fixture = join(root, 'packages/cli/test/fixtures/built/eedsh.config.ts')

    const sync = await execFileAsync(process.execPath, [cli, 'sync', '--config', fixture], {
      cwd: root,
      env: { ...process.env, DSH_HOME: home },
    })
    expect(sync.stdout).toContain('published profile built-cli')

    const { binPath } = resolveDshInstallation()
    const dump = await execFileAsync(
      process.execPath,
      [binPath, '--profile', 'built-cli', '--dump-config'],
      { cwd: home, env: { ...process.env, DSH_HOME: home } },
    )
    expect(dump.stdout).toContain('id: built-row')
    expect(dump.stdout).toContain('marker: built')
  }, 180_000)
})
