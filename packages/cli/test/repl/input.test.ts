/**
 * The Terminal-backed line input: prompts are displayed before each read and
 * end of input reaches the caller as `Terminal.QuitError`.
 */
import { Effect, Stream } from 'effect'
import * as Terminal from 'effect/Terminal'
import { describe, expect, it } from 'vitest'
import { readLines } from '../../src/repl/input'

/** A Terminal whose readLine drains a fixed list and then quits. */
function fakeTerminal(lines: readonly string[], prompts: string[]): Terminal.Terminal {
  const remaining = [...lines]
  return Terminal.make({
    columns: Effect.succeed(80),
    rows: Effect.succeed(24),
    readInput: Effect.die(new Error('readInput is not part of the line input')),
    readLine: Effect.suspend(() => {
      const line = remaining.shift()
      return line === undefined ? Effect.fail(new Terminal.QuitError({})) : Effect.succeed(line)
    }),
    display: (text) =>
      Effect.sync(() => {
        prompts.push(text)
      }),
  })
}

describe('Terminal line input', () => {
  it('reads lines, prompts before each read, and ends with QuitError', async () => {
    const prompts: string[] = []
    const collected: string[] = []
    const outcome = await Effect.runPromise(
      Stream.runForEach(
        readLines(fakeTerminal(['.help', '.sync on'], prompts), 'eedsh> '),
        (line) =>
          Effect.sync(() => {
            collected.push(line)
          }),
      ).pipe(
        Effect.as('completed' as const),
        Effect.catchIf(Terminal.isQuitError, () => Effect.succeed('quit' as const)),
      ),
    )
    expect(outcome).toBe('quit')
    expect(collected).toEqual(['.help', '.sync on'])
    expect(prompts).toEqual(['eedsh> ', 'eedsh> ', 'eedsh> '])
  })

  it('writes nothing for an empty prompt', async () => {
    const prompts: string[] = []
    const collected: string[] = []
    await Effect.runPromise(
      Stream.runForEach(readLines(fakeTerminal(['one'], prompts), ''), (line) =>
        Effect.sync(() => {
          collected.push(line)
        }),
      ).pipe(Effect.catchIf(Terminal.isQuitError, () => Effect.void)),
    )
    expect(collected).toEqual(['one'])
    expect(prompts).toEqual([])
  })
})
