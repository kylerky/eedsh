/**
 * Watch mode: turn file changes into repeated sync passes over the selected
 * profiles, with one scoped service layer for the whole session.
 * @module @eedsh/cli/command/watch
 */
import { dirname } from 'node:path'
import { Cause, Effect, Exit, Queue } from 'effect'
import type * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import { ConfigError } from '../config'
import type { DiscoveredDshInstallation } from '../dsh'
import type { DshResolveFailure } from '../internal/effect/errors'
import { messageOf } from '../internal/error-message'
import { selectSyncProfiles } from '../selection'
import { watchConfigDirectory } from '../watch'
import type { CliService, CommandRuntime } from './context'
import { type ProvisioningMode, serviceLayerFor, syncProgram } from './materialize'
import { loadConfigValue, reportProfileFailure, reportProfileSyncFailure } from './prepare'
import { describeError, printResult, report } from './report'

/** A stop signal from an injected `AbortSignal`, SIGINT, or SIGTERM. */
export function stopSignal(signal: AbortSignal | undefined): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    if (signal !== undefined) {
      if (signal.aborted) {
        resume(Effect.void)
        return
      }
      const onAbort = () => resume(Effect.void)
      signal.addEventListener('abort', onAbort, { once: true })
      return Effect.sync(() => signal.removeEventListener('abort', onAbort))
    }
    const onSignal = () => resume(Effect.void)
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    return Effect.sync(() => {
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
    })
  })
}

/** The context one watch session runs against. */
export interface WatchContext extends CommandRuntime {
  configPath: string
  installation: DiscoveredDshInstallation
  /** The `--profile` value, or none to watch every profile. */
  profile: Option.Option<string>
}

/** Run one watch pass over the currently selected profile set. */
export function runWatchSelection(
  context: WatchContext,
  strict: boolean,
  explain: boolean,
  adoptOwnership: boolean,
  provisioning: ProvisioningMode,
): Effect.Effect<void, never, CliService> {
  return Effect.gen(function* () {
    const loaded = yield* Effect.exit(loadConfigValue(context.configPath, context))
    if (Exit.isFailure(loaded)) {
      if (Cause.hasInterruptsOnly(loaded.cause)) return yield* Effect.interrupt
      yield* Effect.sync(() => report(context.stderr, Cause.squash(loaded.cause)))
      return
    }

    const selection = selectSyncProfiles(loaded.value.config, context.profile)
    if (Result.isFailure(selection)) {
      yield* Effect.sync(() => {
        for (const line of describeError(selection.failure)) context.stderr(`eedsh: ${line}`)
      })
      return
    }

    const entries = selection.success
    const multiple = entries.length > 1
    for (const entry of entries) {
      if (Result.isFailure(entry.plan)) {
        const failure = entry.plan.failure
        yield* Effect.sync(() => reportProfileFailure(context.stderr, entry.name, failure))
        continue
      }
      const plan = entry.plan.success
      yield* Effect.sync(() => {
        if (multiple) context.stdout(`eedsh: profile "${entry.name}"`)
      })
      const runExit = yield* Effect.exit(
        syncProgram(
          context.env,
          plan,
          strict,
          explain,
          adoptOwnership,
          loaded.value.provenance,
          loaded.value.configDir,
          provisioning,
        ),
      )
      if (Exit.isFailure(runExit)) {
        if (Cause.hasInterruptsOnly(runExit.cause)) return yield* Effect.interrupt
        yield* Effect.sync(() =>
          reportProfileSyncFailure(
            context.stderr,
            entry.name,
            Cause.squash(runExit.cause),
            explain,
          ),
        )
        continue
      }
      yield* Effect.sync(() =>
        printResult(context.stdout, context.stderr, plan, runExit.value, explain),
      )
    }
  })
}

export function watchFailure(configPath: string, cause: unknown): ConfigError {
  const message = messageOf(cause)
  return new ConfigError('config.watch_failed', `cannot watch ${dirname(configPath)}: ${message}`)
}

/** One scoped watch session; the service layer is built once for the session. */
export function syncWatch(
  context: WatchContext,
  strict: boolean,
  explain: boolean,
  adoptOwnership: boolean,
  provisioning: ProvisioningMode,
): Effect.Effect<void, ConfigError | DshResolveFailure> {
  return Effect.gen(function* () {
    const dir = dirname(context.configPath)
    const program = Effect.gen(function* () {
      const changes = yield* Effect.acquireRelease(Queue.sliding<void>(1), (queue) =>
        Queue.shutdown(queue),
      )
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            context.options.watch === undefined
              ? watchConfigDirectory({
                  dir,
                  onChange: () => {
                    Queue.offerUnsafe(changes, undefined)
                  },
                })
              : context.options.watch(dir, () => {
                  Queue.offerUnsafe(changes, undefined)
                }),
          catch: (cause) => watchFailure(context.configPath, cause),
        }),
        (session) =>
          Effect.tryPromise({
            try: () => session.close(),
            catch: (cause) => cause,
          }).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                for (const line of describeError(error)) {
                  context.stderr(`eedsh: warning: ${line}`)
                }
              }),
            ),
          ),
      )

      const loop = Effect.gen(function* () {
        while (true) {
          yield* Queue.take(changes)
          yield* runWatchSelection(context, strict, explain, adoptOwnership, provisioning)
        }
      })

      yield* Effect.race(
        runWatchSelection(context, strict, explain, adoptOwnership, provisioning).pipe(
          Effect.andThen(loop),
        ),
        stopSignal(context.options.signal),
      )
    })
    yield* Effect.scoped(program).pipe(
      Effect.provide(serviceLayerFor(context.options, context.installation)),
    )
  })
}
