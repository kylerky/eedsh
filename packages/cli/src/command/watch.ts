/**
 * Watch mode: turn file changes into repeated sync passes over the selected
 * profiles. The watcher is a scoped stream, and interrupting the invocation is
 * the stop request.
 * @module @eedsh/cli/command/watch
 */
import { dirname } from 'node:path'
import { Cause, Duration, Effect, Exit, Stream } from 'effect'
import type * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import { ConfigError } from '../config'
import type { DiscoveredDshInstallation } from '../dsh'
import {
  type CliServices,
  type ConfigLoaderShape,
  Environment,
  type EnvironmentShape,
  Output,
  type OutputShape,
  Watcher,
} from '../internal/effect/services'
import { messageOf } from '../internal/error-message'
import { selectSyncProfiles } from '../selection'
import { asEedshError } from './errors'
import { type MaterializeServices, type ProvisioningMode, syncProgram } from './materialize'
import { loadConfigValue, reportProfileFailure, reportProfileSyncFailure } from './prepare'
import { describeError, printResult } from './report'

/** The context one watch session runs against. */
export interface WatchContext {
  configPath: string
  installation: DiscoveredDshInstallation
  /** The `--profile` value, or none to watch every profile. */
  profile: Option.Option<string>
}

/** The services one watch pass needs. */
type WatchServices = ConfigLoaderShape | OutputShape | EnvironmentShape | MaterializeServices

/** Run one watch pass over the currently selected profile set. */
export function runWatchSelection(
  context: WatchContext,
  strict: boolean,
  explain: boolean,
  adoptOwnership: boolean,
  provisioning: ProvisioningMode,
): Effect.Effect<void, never, WatchServices> {
  return Effect.gen(function* () {
    const output = yield* Output
    const { env } = yield* Environment
    const loaded = yield* Effect.exit(loadConfigValue(context.configPath))
    if (Exit.isFailure(loaded)) {
      if (Cause.hasInterruptsOnly(loaded.cause)) return yield* Effect.interrupt
      const failure = asEedshError(Cause.squash(loaded.cause))
      for (const line of describeError(failure)) output.stderr(`eedsh: ${line}`)
      return
    }

    const selection = selectSyncProfiles(loaded.value.config, context.profile)
    if (Result.isFailure(selection)) {
      for (const line of describeError(selection.failure)) output.stderr(`eedsh: ${line}`)
      return
    }

    const entries = selection.success
    const multiple = entries.length > 1
    for (const entry of entries) {
      if (Result.isFailure(entry.plan)) {
        reportProfileFailure(output.stderr, entry.name, entry.plan.failure)
        continue
      }
      const plan = entry.plan.success
      if (multiple) output.stdout(`eedsh: profile "${entry.name}"`)
      const runExit = yield* Effect.exit(
        syncProgram(
          env,
          plan,
          strict,
          explain,
          adoptOwnership,
          loaded.value.provenance,
          loaded.value.configDir,
          context.installation,
          provisioning,
        ),
      )
      if (Exit.isFailure(runExit)) {
        if (Cause.hasInterruptsOnly(runExit.cause)) return yield* Effect.interrupt
        reportProfileSyncFailure(
          output.stderr,
          entry.name,
          asEedshError(Cause.squash(runExit.cause)),
          explain,
        )
        continue
      }
      printResult(output.stdout, output.stderr, plan, runExit.value, explain)
    }
  })
}

export function watchFailure(configPath: string, cause: unknown): ConfigError {
  const message = messageOf(cause)
  return new ConfigError('config.watch_failed', `cannot watch ${dirname(configPath)}: ${message}`)
}

/** One scoped watch session; the watcher is released when the session ends. */
export function syncWatch(
  context: WatchContext,
  strict: boolean,
  explain: boolean,
  adoptOwnership: boolean,
  provisioning: ProvisioningMode,
): Effect.Effect<void, ConfigError, CliServices> {
  const dir = dirname(context.configPath)
  const run = () => runWatchSelection(context, strict, explain, adoptOwnership, provisioning)
  const program = Effect.gen(function* () {
    const watcher = yield* Watcher
    const events = yield* watcher
      .watch(dir)
      .pipe(Effect.mapError((cause) => watchFailure(context.configPath, cause)))
    // The watcher is ready; run the initial sync before draining changes. The
    // subscription queues anything observed meanwhile, so a change during this
    // pass produces exactly one debounced follow-up.
    yield* run()
    yield* events.pipe(
      Stream.debounce(Duration.millis(150)),
      Stream.runForEach(() => run()),
    )
  })
  return Effect.scoped(program)
}
