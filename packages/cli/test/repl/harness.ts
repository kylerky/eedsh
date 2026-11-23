/**
 * Test facades for the Effect-native REPL session. Production code never runs
 * a runtime; tests may, so this module wraps each Effect-returning session
 * method in the promise shape the suites assert on.
 */
import { Effect, Stream } from 'effect'
import type { CompletionResult } from '../../src/repl/completion'
import type { ReplSession, SyncOutcome } from '../../src/repl/session'

/** One async facade over an Effect-native session, for tests. */
export interface TestSession {
  /** The underlying Effect-native session. */
  readonly raw: ReplSession
  readonly authoring: ReplSession['authoring']
  readonly currentPlan: ReplSession['currentPlan']
  readonly profile: ReplSession['profile']
  readonly previewActive: ReplSession['previewActive']
  readonly continuousSync: ReplSession['continuousSync']
  evaluate(code: string): Promise<unknown>
  evaluateOutcome(
    code: string,
  ): Promise<
    { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown }
  >
  reload(): Promise<void>
  command(line: string): Promise<boolean>
  resolve(specs: readonly string[]): Promise<void>
  syncNow(): Promise<SyncOutcome | undefined>
  complete(line: string): Promise<CompletionResult>
  completeGeneric(line: string): Promise<readonly [string[], string]>
  close(): Promise<void>
}

/** Wrap one session in the async facade the test suites assert on. */
export function testSession(session: ReplSession): TestSession {
  return {
    raw: session,
    authoring: session.authoring,
    get currentPlan() {
      return session.currentPlan
    },
    get profile() {
      return session.profile
    },
    get previewActive() {
      return session.previewActive
    },
    get continuousSync() {
      return session.continuousSync
    },
    evaluate: (code) => session.evaluate(code),
    evaluateOutcome: (code) => Effect.runPromise(session.evaluateOutcome(code)),
    reload: () => Effect.runPromise(session.reload()),
    command: (line) => Effect.runPromise(session.command(line)),
    resolve: (specs) => Effect.runPromise(session.resolve(specs)),
    syncNow: () => Effect.runPromise(session.syncNow()),
    complete: (line) => Effect.runPromise(session.complete(line)),
    completeGeneric: (line) => Effect.runPromise(session.completeGeneric(line)),
    close: () => Effect.runPromise(session.close()),
  }
}

/** A watcher seam that never reports a change. */
export function testWatch(): () => Effect.Effect<Stream.Stream<never>> {
  return () => Effect.succeed(Stream.empty)
}
