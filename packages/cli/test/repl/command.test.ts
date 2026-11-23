import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect, Layer, Stream } from 'effect'
import * as Terminal from 'effect/Terminal'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CliServices } from '../../src/internal/effect/services'
import { devDshInstallation } from '../support/bridge'
import { type CliOverrides, captureOutput, fakeDshDiscovery, runCli } from '../support/cli'

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

function harness(env: Record<string, string> = {}, extra: CliOverrides = {}) {
  const out: string[] = []
  const err: string[] = []
  const overrides = {
    output: captureOutput(out, err),
    environment: {
      env: { DSH_HOME: home, XDG_CONFIG_HOME: join(home, 'xdg'), ...env },
      cwd: root,
    },
    discovery: fakeDshDiscovery(devDshInstallation()),
    ...extra,
  }
  return {
    out,
    err,
    run: (argv: readonly string[]) => runCli(argv, overrides),
  }
}

/** A Terminal whose readLine drains a fixed list and then quits. */
function fakeTerminal(lines: readonly string[]): Terminal.Terminal {
  const remaining = [...lines]
  return Terminal.make({
    columns: Effect.succeed(80),
    rows: Effect.succeed(24),
    readInput: Effect.die(new Error('readInput is not part of the line loop')),
    readLine: Effect.suspend(() => {
      const line = remaining.shift()
      return line === undefined ? Effect.fail(new Terminal.QuitError({})) : Effect.succeed(line)
    }),
    display: () => Effect.void,
  })
}

/** The Terminal layer for one scripted line list, as the test layer expects. */
function terminalLayer(lines: readonly string[]): Layer.Layer<CliServices> {
  return Layer.succeed(Terminal.Terminal, fakeTerminal(lines)) as Layer.Layer<CliServices>
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

  it('runs the interactive loop inside the invocation program', async () => {
    const h = harness(
      {},
      {
        watcher: { watch: () => Effect.succeed(Stream.empty) },
        extra: [terminalLayer(['.help', '.exit'])],
      },
    )
    expect(await h.run(['repl', '--config', fixture])).toBe(0)
    const printed = h.out.join('\n')
    expect(printed).toContain('eedsh repl (profile selection:')
    expect(printed).toContain('.resolve')
  })

  it('publishes through the invocation program handshake', async () => {
    const h = harness(
      {},
      {
        watcher: { watch: () => Effect.succeed(Stream.empty) },
        extra: [terminalLayer(['.sync', '.exit'])],
      },
    )
    expect(await h.run(['repl', '--config', fixture])).toBe(0)
    expect(h.out.join('\n')).toContain('published profile "cli-fixture"')
    expect(h.err.join('\n')).not.toContain('sync failed')
  }, 60_000)

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
