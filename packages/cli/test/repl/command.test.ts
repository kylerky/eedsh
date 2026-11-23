import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { devDshInstallation } from '../support/bridge'
import { captureOutput, fakeDshDiscovery, runCli } from '../support/cli'

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

function harness(env: Record<string, string> = {}) {
  const out: string[] = []
  const err: string[] = []
  const overrides = {
    output: captureOutput(out, err),
    environment: {
      env: { DSH_HOME: home, XDG_CONFIG_HOME: join(home, 'xdg'), ...env },
      cwd: root,
    },
    discovery: fakeDshDiscovery(devDshInstallation()),
  }
  return {
    out,
    err,
    run: (argv: readonly string[]) => runCli(argv, overrides),
  }
}

describe('eedsh repl command surface', () => {
  it('evaluates one expression without starting a prompt', async () => {
    const h = harness()
    const code = await h.run(['repl', '--config', fixture, '--eval', 'selectedProfile.name'])
    expect(code).toBe(0)
    expect(h.out.join('\n')).toContain("'cli-fixture'")
  })

  it('returns a non-zero status when evaluation or the config fails', async () => {
    const badExpression = harness()
    expect(await badExpression.run(['repl', '--config', fixture, '--eval', 'missingName'])).toBe(1)
    expect(badExpression.err.join('\n')).toContain('missingName')

    const dir = await mkdtemp(join(home, 'invalid-'))
    const configPath = join(dir, 'config.ts')
    await writeFile(configPath, 'export default { dsh: "latest", profiles: {} }\n')
    const badConfig = harness()
    expect(await badConfig.run(['repl', '--config', configPath, '--eval', '1 + 1'])).toBe(1)
    expect(badConfig.err.length).toBeGreaterThan(0)
    expect(badConfig.err.join('\n')).toContain('dsh')
  })

  it('lists repl and its flags in help', async () => {
    const h = harness()
    expect(await h.run(['--help'])).toBe(0)
    expect(h.out.join('\n')).toContain('repl')
    const replHelp = harness()
    expect(await replHelp.run(['repl', '--help'])).toBe(0)
    for (const flag of ['--config', '--profile', '--sync', '--eval']) {
      expect(replHelp.out.join('\n')).toContain(flag)
    }
  })
})
