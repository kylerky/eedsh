/**
 * The interactive prompt around a ReplSession. Lines come from the `Terminal`
 * service: its line stream for piped input, or the key-driven line editor for a
 * TTY. Commands and values use the session's sinks; completion output uses the
 * terminal display so ambiguous candidates can be listed above a redrawn
 * prompt. The loop's running/prompting state lives in a `Ref`, never in a
 * mutable local or session field.
 * @module @eedsh/cli/repl/prompt
 */
import { Effect, Exit, Ref, Stream } from 'effect'
import * as Terminal from 'effect/Terminal'
import type { CompletionResult } from './completion'
import { readLines, readLinesInteractive } from './input'
import { formatSessionError, isDotCommand, type ReplSession } from './session'

/** The completion surface the pure adapter needs. */
export interface CompletingSession {
  complete(line: string): Effect.Effect<CompletionResult, unknown>
  completeGeneric(line: string): Effect.Effect<readonly [readonly string[], string], unknown>
}

/**
 * Adapt one completion request: use the domain engine first, then the
 * evaluator's JavaScript completion, and contain every failure.
 * @param session - the session whose catalogs and evaluator supply hits.
 * @param line - the text before the cursor.
 * @returns the hits and the token to replace.
 */
export function completeShellLine(
  session: CompletingSession,
  line: string,
): Effect.Effect<readonly [readonly string[], string]> {
  return Effect.gen(function* () {
    const result = yield* Effect.exit(session.complete(line))
    if (Exit.isFailure(result)) return [[], line]
    if (result.value.hits.length > 0) {
      return [[...result.value.hits], line.slice(result.value.start)]
    }
    const generic = yield* Effect.exit(session.completeGeneric(line))
    if (Exit.isFailure(generic)) return [[], line]
    return [[...generic.value[0]], generic.value[1]]
  })
}

/** The interactive state one loop owns. */
export interface ReplLoopState {
  /** Whether the loop should keep reading lines. */
  readonly running: boolean
  /** Whether the loop is waiting for input rather than handling a line. */
  readonly prompting: boolean
}

/** Inputs for {@link runReplLoop}. */
export interface ReplLoopOptions {
  /**
   * Read key events with the TTY line editor instead of whole lines. Completion
   * is only meaningful for an interactive terminal, so a piped input stream
   * leaves this false.
   */
  readonly tty?: boolean
  /** The prompt written before each read; empty suppresses prompting. */
  readonly prompt?: string
  /** The invocation program's loop state; a fresh Ref is created when omitted. */
  readonly state?: Ref.Ref<ReplLoopState>
}

/**
 * Run the interactive loop until .exit, end of input, or a quit key. Either
 * input path ends with `Terminal.QuitError`; this loop treats that as a normal
 * exit, while an evaluation or command failure stays in the error channel for
 * the command edge to report.
 * @param session - an initialized session.
 * @param options - TTY mode, prompt text, and the loop state Ref.
 * @returns an effect that completes when the session exits.
 */
export function runReplLoop(
  session: ReplSession,
  options: ReplLoopOptions = {},
): Effect.Effect<void, unknown, Terminal.Terminal> {
  return Effect.gen(function* () {
    const terminal = yield* Terminal.Terminal
    const state =
      options.state ?? (yield* Ref.make<ReplLoopState>({ running: true, prompting: false }))
    const prompt = options.prompt ?? ''
    const lines =
      options.tty === true
        ? readLinesInteractive(terminal, prompt, (line) => completeShellLine(session, line))
        : readLines(terminal, prompt)
    const writeError = (error: unknown): void => {
      for (const line of formatSessionError(error)) session.stdout(`error: ${line}`)
    }
    const stop = Ref.update(state, (current) => ({
      ...current,
      running: false,
      prompting: false,
    }))
    yield* Ref.update(state, (current) => ({ ...current, running: true, prompting: true }))
    yield* lines.pipe(
      Stream.runForEachWhile((line) =>
        Effect.gen(function* () {
          const trimmed = line.trim()
          if (trimmed === '') return true
          yield* Ref.update(state, (current) => ({ ...current, prompting: false }))
          if (isDotCommand(trimmed)) {
            const exit = yield* session.command(trimmed)
            if (exit) {
              yield* stop
              return false
            }
          } else {
            const outcome = yield* session.evaluateOutcome(trimmed)
            yield* Effect.sync(() => {
              if (outcome.ok) session.printValue(outcome.value)
              else writeError(outcome.error)
            })
          }
          yield* Ref.update(state, (current) => ({ ...current, prompting: true }))
          return true
        }),
      ),
      Effect.catchIf(
        (error) => Terminal.isQuitError(error),
        () => stop,
      ),
    )
  })
}
