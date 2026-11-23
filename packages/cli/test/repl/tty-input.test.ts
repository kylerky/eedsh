/**
 * The TTY line editor over `Terminal.readInput`: echo, editing, Tab
 * completion, quit keys, and the scope-owned line stream.
 */
import { type Cause, Effect, Option, Queue, Stream } from 'effect'
import * as Terminal from 'effect/Terminal'
import { describe, expect, it } from 'vitest'
import { readEditedLine, readLinesInteractive } from '../../src/repl/input'

/** One scripted key event. */
function key(
  name: string,
  options: { readonly ctrl?: boolean; readonly input?: string } = {},
): Terminal.UserInput {
  return {
    input: options.input === undefined ? Option.none() : Option.some(options.input),
    key: { name, ctrl: options.ctrl ?? false, meta: false, shift: false },
  }
}

/** The key events that type a string, one printable character at a time. */
function typeText(text: string): Terminal.UserInput[] {
  return [...text].map((character) => key(character, { input: character }))
}

/** A Terminal whose readInput drains the scripted events and then ends. */
function interactiveTerminal(
  events: readonly Terminal.UserInput[],
  displayed: string[],
): {
  readonly terminal: Terminal.Terminal
  readonly input: Queue.Queue<Terminal.UserInput, Cause.Done>
} {
  const input = Effect.runSync(Queue.unbounded<Terminal.UserInput, Cause.Done>())
  for (const event of events) Queue.offerUnsafe(input, event)
  Queue.endUnsafe(input)
  const terminal = Terminal.make({
    columns: Effect.succeed(80),
    rows: Effect.succeed(24),
    readInput: Effect.succeed(input),
    readLine: Effect.die(new Error('readLine is not part of the interactive editor')),
    display: (text) =>
      Effect.sync(() => {
        displayed.push(text)
      }),
  })
  return { terminal, input }
}

/** Run the editor for one scripted line and capture its display. */
async function runEditor(
  events: readonly Terminal.UserInput[],
  complete: (line: string) => Effect.Effect<readonly [readonly string[], string], unknown>,
  prompt = 'eedsh> ',
): Promise<{ readonly line: string; readonly displayed: string }> {
  const displayed: string[] = []
  const fake = interactiveTerminal(events, displayed)
  const line = await Effect.runPromise(readEditedLine(fake.terminal, fake.input, prompt, complete))
  return { line, displayed: displayed.join('') }
}

/** No completion hits. */
const noHits = () => Effect.succeed([[], ''] as const)

describe('Terminal interactive line editor', () => {
  it('echoes printable input, backspaces, and submits on Enter', async () => {
    const result = await runEditor(
      [...typeText('abc'), key('backspace'), ...typeText('d'), key('return', { input: '\r' })],
      noHits,
    )
    expect(result.line).toBe('abd')
    expect(result.displayed).toBe('eedsh> abc\b \bd\n')
  })

  it('inserts a unique completion and lets the user submit it', async () => {
    const result = await runEditor(
      [...typeText('selectedPro'), key('tab'), key('return', { input: '\r' })],
      () => Effect.succeed([['selectedProfile'], 'selectedPro'] as const),
    )
    expect(result.line).toBe('selectedProfile')
    expect(result.displayed).toBe('eedsh> selectedProfile\n')
  })

  it('inserts the common extension of several hits', async () => {
    const result = await runEditor(
      [...typeText('selectedPro'), key('tab'), key('return', { input: '\r' })],
      () => Effect.succeed([['selectedProfile', 'selectedProfiles'], 'selectedPro'] as const),
    )
    expect(result.line).toBe('selectedProfile')
    expect(result.displayed).not.toContain('selectedProfiles')
  })

  it('lists ambiguous hits and redraws the prompt with the buffer', async () => {
    const result = await runEditor(
      [...typeText('s'), key('tab'), key('return', { input: '\r' })],
      () => Effect.succeed([['selectedProfile', 'sync'], 's'] as const),
    )
    expect(result.line).toBe('s')
    expect(result.displayed).toBe('eedsh> s\nselectedProfile\nsync\needsh> s\n')
  })

  it('contains a completion failure and keeps the prompt usable', async () => {
    const result = await runEditor(
      [...typeText('s'), key('tab'), ...typeText('x'), key('return', { input: '\r' })],
      () => Effect.fail(new Error('completion broke')),
    )
    expect(result.line).toBe('sx')
    expect(result.displayed).toBe('eedsh> sx\n')
  })

  it('quits on Ctrl-C, Ctrl-D, and Escape with QuitError', async () => {
    for (const event of [key('c', { ctrl: true }), key('d', { ctrl: true }), key('escape')]) {
      const displayed: string[] = []
      const fake = interactiveTerminal([event], displayed)
      const error = await Effect.runPromise(
        Effect.flip(readEditedLine(fake.terminal, fake.input, 'eedsh> ', noHits)),
      )
      expect(Terminal.isQuitError(error)).toBe(true)
    }
  })

  it('ends the line stream at input end with QuitError', async () => {
    const displayed: string[] = []
    const fake = interactiveTerminal(
      [
        ...typeText('ab'),
        key('return', { input: '\r' }),
        ...typeText('cd'),
        key('return', { input: '\r' }),
      ],
      displayed,
    )
    const lines: string[] = []
    const outcome = await Effect.runPromise(
      Stream.runForEach(readLinesInteractive(fake.terminal, 'eedsh> ', noHits), (line) =>
        Effect.sync(() => {
          lines.push(line)
        }),
      ).pipe(
        Effect.as('completed' as const),
        Effect.catchIf(Terminal.isQuitError, () => Effect.succeed('quit' as const)),
      ),
    )
    expect(outcome).toBe('quit')
    expect(lines).toEqual(['ab', 'cd'])
    expect(displayed.join('')).toBe('eedsh> ab\needsh> cd\needsh> ')
  })
})
