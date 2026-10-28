/**
 * The interactive prompt around a ReplSession. Commands and values use the
 * session's line sinks; the prompt is written only for a terminal, so a piped
 * or test session stays free of control characters.
 * @module @eedsh/cli/repl/prompt
 */
import { createInterface } from 'node:readline'
import type { CompletionResult } from './completion'
import { formatSessionError, isDotCommand, type ReplSession } from './session'

/** Streams an interactive session reads from and writes to. */
export interface ReplStreams {
  readonly input: NodeJS.ReadableStream
  readonly output: NodeJS.WritableStream
}

/** The completion surface the readline adapter needs. */
export interface CompletingSession {
  complete(line: string): Promise<CompletionResult>
  completeGeneric(line: string): Promise<readonly [string[], string]>
}

/**
 * Adapt one readline completion request: use the domain engine first, then the
 * hidden evaluator's JavaScript completion, and contain every failure.
 * @param session - the session whose catalogs and evaluator supply hits.
 * @param line - the text before the cursor.
 * @returns the hits and the token to replace.
 */
export async function completeShellLine(
  session: CompletingSession,
  line: string,
): Promise<[string[], string]> {
  try {
    const result = await session.complete(line)
    if (result.hits.length > 0) return [[...result.hits], line.slice(result.start)]
    const [hits, completedOn] = await session.completeGeneric(line)
    return [[...hits], completedOn]
  } catch {
    return [[], line]
  }
}

/** The callback-shaped completer `node:readline` expects. */
export type ReplCompleter = (
  line: string,
  callback: (error: Error | null, result: [string[], string]) => void,
) => void

/**
 * Adapt the async completion surface to readline's callback completer. The
 * public readline wrapper only preserves a completer whose function length is
 * two; a one-argument async completer is wrapped and its Promise reaches the
 * callback instead of the hits.
 * @param session - the session whose catalogs and evaluator supply hits.
 * @returns a callback completer for `createInterface`.
 */
export function createCompletionCompleter(session: CompletingSession): ReplCompleter {
  return (line, callback) => {
    completeShellLine(session, line).then(
      (result) => callback(null, result),
      () => callback(null, [[], line]),
    )
  }
}

/**
 * Run the interactive loop until .exit, EOF, or an interrupt.
 * @param session - an initialized session.
 * @param streams - input and output streams.
 */
export async function runReplLoop(session: ReplSession, streams: ReplStreams): Promise<void> {
  const terminal =
    (streams.input as NodeJS.ReadStream).isTTY === true &&
    (streams.output as NodeJS.WriteStream).isTTY === true
  const rl = createInterface({
    input: streams.input,
    output: streams.output,
    terminal,
    prompt: 'eedsh> ',
    completer: createCompletionCompleter(session),
  })
  const prompt = (): void => {
    if (terminal) rl.prompt()
  }
  const writeError = (error: unknown): void => {
    for (const line of formatSessionError(error)) streams.output.write(`error: ${line}\n`)
  }

  let closed = false
  rl.on('close', () => {
    closed = true
  })
  rl.on('SIGINT', () => {
    streams.output.write('\n')
    rl.close()
  })
  prompt()
  for await (const line of rl) {
    const trimmed = line.trim()
    if (trimmed === '') {
      prompt()
      continue
    }
    if (terminal) rl.pause()
    if (isDotCommand(trimmed)) {
      const exit = await session.command(trimmed)
      if (exit) {
        rl.close()
        break
      }
    } else {
      const outcome = await session.evaluateOutcome(trimmed)
      if (outcome.ok) session.printValue(outcome.value)
      else writeError(outcome.error)
    }
    if (terminal && !closed) {
      rl.resume()
      prompt()
    }
  }
  rl.close()
}
