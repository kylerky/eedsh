import { Effect } from 'effect'

export const packageName = '@eedsh/cli'

/**
 * The CLI's application effect. One-shot commands run it through
 * `Effect.runPromise`; the watch loop keeps a `ManagedRuntime` alive.
 */
export const main: Effect.Effect<void> = Effect.void
