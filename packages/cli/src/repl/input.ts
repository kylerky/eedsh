/**
 * Line input for the interactive REPL, built on the core `Terminal` service.
 * Non-TTY sessions keep the line-oriented `Terminal.readLine` stream. TTY
 * sessions read key events from `Terminal.readInput` through a small line
 * editor: printable input is echoed, Backspace removes, Enter submits, Tab
 * completes, and Ctrl-C / Ctrl-D / Esc fail with `Terminal.QuitError` so the
 * loop exits exactly as it does on end of input.
 * @module @eedsh/cli/repl/input
 */
import { type Cause, Effect, Option, Queue, Stream } from 'effect'
import * as Terminal from 'effect/Terminal'

/**
 * Complete the text before the cursor, returning the candidate hits and the
 * token they replace. The hook runs for every Tab press; its failures are
 * contained by the editor.
 */
export type CompletionHook = (line: string) => Promise<readonly [readonly string[], string]>

/**
 * A stream of lines read from the terminal, one prompt before each read.
 * The stream ends by failing with `Terminal.QuitError` when the user quits or
 * the input reaches end of file, so callers recover it as a normal exit.
 * @param terminal - the terminal service to read from and prompt on.
 * @param prompt - the prompt written before every read; empty writes nothing.
 * @returns a stream of input lines; failure means end of session.
 */
export function readLines(
  terminal: Terminal.Terminal,
  prompt: string,
): Stream.Stream<string, Terminal.QuitError> {
  const read =
    prompt === ''
      ? terminal.readLine
      : Effect.gen(function* () {
          yield* terminal.display(prompt).pipe(Effect.ignore)
          return yield* terminal.readLine
        })
  return Stream.fromEffectRepeat(read)
}

/**
 * A stream of edited lines for a TTY session. `Terminal.readInput` is scoped:
 * the stream acquires it once and keeps it for every line it reads.
 * @param terminal - the terminal service to read from, prompt on, and echo to.
 * @param prompt - the prompt written and rewritten before every read.
 * @param complete - the Tab-completion hook for the text before the cursor.
 * @returns a stream of submitted lines; failure means end of session.
 */
export function readLinesInteractive(
  terminal: Terminal.Terminal,
  prompt: string,
  complete: CompletionHook,
): Stream.Stream<string, Terminal.QuitError> {
  return Stream.scoped(
    Stream.flatMap(Stream.fromEffect(terminal.readInput), (input) =>
      Stream.fromEffectRepeat(readEditedLine(terminal, input, prompt, complete)),
    ),
  )
}

/**
 * Read one line with the minimal TTY editor. Printable input appends to the
 * buffer and is echoed; Backspace removes the last code point; Enter echoes a
 * newline and submits; Tab runs completion; Ctrl-C, Ctrl-D, and Esc quit.
 * @param terminal - the terminal service to echo on.
 * @param input - the low-level key-event queue from `Terminal.readInput`.
 * @param prompt - the prompt written when the read starts; empty writes nothing.
 * @param complete - the Tab-completion hook for the text before the cursor.
 * @returns the submitted line, or `Terminal.QuitError` on quit or end of input.
 */
export function readEditedLine(
  terminal: Terminal.Terminal,
  input: Queue.Dequeue<Terminal.UserInput, Cause.Done>,
  prompt: string,
  complete: CompletionHook,
): Effect.Effect<string, Terminal.QuitError> {
  return Effect.gen(function* () {
    if (prompt !== '') yield* terminal.display(prompt).pipe(Effect.ignore)
    let buffer = ''
    while (true) {
      const event = yield* Queue.take(input).pipe(Effect.mapError(() => new Terminal.QuitError({})))
      const key = event.key
      if (isQuitKey(key)) return yield* new Terminal.QuitError({})
      if (key.name === 'tab') {
        const [hits, token] = yield* completeLine(complete, buffer)
        const edit = applyCompletion(buffer, hits, token)
        buffer = edit.buffer
        if (edit.listing !== undefined) {
          const listing = `\n${edit.listing.join('\n')}\n${prompt}${buffer}`
          yield* terminal.display(listing).pipe(Effect.ignore)
        } else if (edit.echo !== '') {
          yield* terminal.display(edit.echo).pipe(Effect.ignore)
        }
        continue
      }
      if (key.name === 'enter' || key.name === 'return' || key.name === 'linefeed') {
        yield* terminal.display('\n').pipe(Effect.ignore)
        return buffer
      }
      if (key.name === 'backspace') {
        const characters = Array.from(buffer)
        if (characters.length > 0) {
          characters.pop()
          buffer = characters.join('')
          yield* terminal.display('\b \b').pipe(Effect.ignore)
        }
        continue
      }
      const text = printableText(event)
      if (text !== undefined) {
        buffer += text
        yield* terminal.display(text).pipe(Effect.ignore)
      }
    }
  })
}

/** One completion result, applied to the editor buffer. */
interface CompletionEdit {
  /** The buffer after the completion. */
  readonly buffer: string
  /** The text to echo after the already-echoed token. */
  readonly echo: string
  /** Candidates to list when the hit set has no common extension. */
  readonly listing: readonly string[] | undefined
}

/** The longest prefix every hit shares. */
function commonPrefix(hits: readonly string[]): string {
  const first = hits[0]
  if (first === undefined) return ''
  let prefix = first
  for (const hit of hits.slice(1)) {
    let index = 0
    while (index < prefix.length && index < hit.length && prefix[index] === hit[index]) {
      index += 1
    }
    prefix = prefix.slice(0, index)
  }
  return prefix
}

/**
 * Apply one completion to the buffer. A single hit, or a common extension of
 * several hits, is inserted; several hits with no extension are listed instead.
 */
function applyCompletion(buffer: string, hits: readonly string[], token: string): CompletionEdit {
  if (hits.length === 0) return { buffer, echo: '', listing: undefined }
  const insert = hits.length === 1 ? (hits[0] as string) : commonPrefix(hits)
  if (insert.length <= token.length) {
    return {
      buffer,
      echo: '',
      listing: hits.length > 1 ? [...hits] : undefined,
    }
  }
  const replaceStart = buffer.endsWith(token) ? buffer.length - token.length : buffer.length
  const echo = insert.startsWith(token) ? insert.slice(token.length) : insert
  return { buffer: buffer.slice(0, replaceStart) + insert, echo, listing: undefined }
}

/** Run the completion hook, containing any failure as no hits. */
function completeLine(
  complete: CompletionHook,
  buffer: string,
): Effect.Effect<readonly [readonly string[], string]> {
  // `tryPromise` maps a thrown hook or rejected promise into the error channel;
  // `catch` recovers only that failure, never an interrupt of the editor.
  return Effect.tryPromise({
    try: () => complete(buffer),
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.succeed([[], buffer] as const)))
}

/** Whether a key event ends the session. */
function isQuitKey(key: Terminal.Key): boolean {
  if (key.name === 'escape') return true
  return key.ctrl && (key.name === 'c' || key.name === 'd')
}

/** Whether every character is printable text rather than a control code. */
function isPrintable(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return false
  }
  return text !== ''
}

/** The printable text an event carries, if any. */
function printableText(event: Terminal.UserInput): string | undefined {
  const key = event.key
  if (key.ctrl || key.meta) return undefined
  const text = Option.getOrUndefined(event.input)
  if (text === undefined || !isPrintable(text)) return undefined
  return text
}
