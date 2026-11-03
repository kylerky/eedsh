import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as Result from 'effect/Result'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runEedsh } from '../../src/cli'
import { devDshInstallation } from '../support/bridge'

const root = process.cwd()
const tempRoot = join(root, 'packages/cli/.tmp')
const fixture = join(root, 'packages/cli/test/fixtures/basic/config.ts')
let home = ''

beforeEach(async () => {
  await mkdir(tempRoot, { recursive: true })
  home = await mkdtemp(join(tempRoot, 'repl-command-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function options(env: Record<string, string> = {}) {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    options: {
      env: { DSH_HOME: home, XDG_CONFIG_HOME: join(home, 'xdg'), ...env },
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
      discoverDsh: () => Result.succeed(devDshInstallation()),
    },
  }
}

describe('eedsh repl command surface', () => {
  it('evaluates one expression without starting a prompt', async () => {
    const h = options()
    const code = await runEedsh(
      ['repl', '--config', fixture, '--eval', 'selectedProfile.name'],
      h.options,
    )
    expect(code).toBe(0)
    expect(h.out.join('\n')).toContain("'cli-fixture'")
  })

  it('returns a non-zero status when evaluation or the config fails', async () => {
    const badExpression = options()
    expect(
      await runEedsh(['repl', '--config', fixture, '--eval', 'missingName'], badExpression.options),
    ).toBe(1)
    expect(badExpression.err.join('\n')).toContain('missingName')

    const dir = await mkdtemp(join(home, 'invalid-'))
    const configPath = join(dir, 'config.ts')
    await writeFile(configPath, 'export default { dsh: "latest", profiles: {} }\n')
    const badConfig = options()
    expect(
      await runEedsh(['repl', '--config', configPath, '--eval', '1 + 1'], badConfig.options),
    ).toBe(1)
    expect(badConfig.err.length).toBeGreaterThan(0)
  })

  it('lists repl and its flags in help', async () => {
    const h = options()
    expect(await runEedsh(['--help'], h.options)).toBe(0)
    expect(h.out.join('\n')).toContain('repl')
    const replHelp = options()
    expect(await runEedsh(['repl', '--help'], replHelp.options)).toBe(0)
    for (const flag of ['--config', '--profile', '--sync', '--eval']) {
      expect(replHelp.out.join('\n')).toContain(flag)
    }
  })
})
