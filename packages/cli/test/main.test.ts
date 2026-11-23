import type { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { main } from '../src/cli'
import type { CliServices } from '../src/internal/effect/services'
import { captureOutput, runCli } from './support/cli'

describe('main is one program over services', () => {
  it('has the single-program signature', () => {
    // The annotation is the assertion: the entry point is an Effect program
    // whose value is the exit code, whose error channel is empty, and whose
    // only requirements are the CLI services a layer provides.
    const program: Effect.Effect<number, never, CliServices> = main([])
    expect(program).toBeDefined()
  })

  it('writes help through the Output service', async () => {
    const out: string[] = []
    const err: string[] = []
    const code = await runCli(['--help'], { output: captureOutput(out, err) })
    expect(code).toBe(0)
    expect(out.join('\n')).toContain('eedsh')
    expect(out.join('\n')).toContain('sync')
    expect(err).toEqual([])
  })

  it('resolves the default config path from the Environment service', async () => {
    const out: string[] = []
    const err: string[] = []
    const code = await runCli(['sync'], {
      output: captureOutput(out, err),
      environment: { env: { XDG_CONFIG_HOME: '/nowhere' }, cwd: '/elsewhere' },
    })
    expect(code).toBe(1)
    expect(err.join('\n')).toContain('/nowhere/eedsh/config.ts')
  })
})
