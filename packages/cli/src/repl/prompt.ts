/**
 * The interactive prompt around a ReplSession. Commands and values use the
 * session's line sinks; the prompt is written only for a terminal, so a piped
 * or test session stays free of control characters.
 * @module @eedsh/cli/repl/prompt
 */
import { createInterface } from 'node:readline'
import { formatSessionError, isDotCommand, type ReplSession } from './session'

/** Streams an interactive session reads from and writes to. */
export interface ReplStreams {
  readonly input: NodeJS.ReadableStream
  readonly output: NodeJS.WritableStream
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
