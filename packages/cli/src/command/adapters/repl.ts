/**
 * `eedsh repl`: evaluate the config interactively, watch it for changes, and
 * publish on request, or evaluate one expression with `--eval`.
 * @module @eedsh/cli/command/adapters/repl
 */
import { dirname } from 'node:path'
import type { ConfigProvenance } from '@eedsh/config'
import type { ProfilePlan } from '@eedsh/plan'
import { Cause, Effect, Exit } from 'effect'
import * as Option from 'effect/Option'
import { EXIT_FAILURE, EXIT_OK } from '../../exit'
import { runReplLoop } from '../../repl/prompt'
import { ReplSession } from '../../repl/session'
import { configFlag, dshFlag, evalFlag, profileFlag, replSyncFlag } from '../../surface'
import type { CommandRuntime } from '../context'
import { NO_PROVISIONING_MODE, serviceLayerFor, syncProgram } from '../materialize'
import type { Parsed } from '../options'
import { requireDsh, resolveConfigPath } from '../prepare'
import { report } from '../report'

/** The `eedsh repl` flag record. */
export const replOptions = {
  config: configFlag,
  profile: profileFlag,
  dsh: dshFlag,
  sync: replSyncFlag,
  eval: evalFlag,
}

/** The parsed input for {@link runReplCommand}. */
export type ReplInput = Parsed<typeof replOptions>

/** Open the config REPL, or evaluate one expression with --eval. */
export function runReplCommand(
  input: ReplInput,
  runtime: CommandRuntime,
): Effect.Effect<number, unknown> {
  return Effect.gen(function* () {
    runtime.setFailureContext(undefined)
    const configPath = resolveConfigPath(input.config, runtime)
    if (Option.isNone(configPath)) return EXIT_FAILURE
    const installation = yield* requireDsh(runtime, input.dsh)
    const profile = Option.getOrUndefined(input.profile)
    const configDir = dirname(configPath.value)
    const syncPlan = async (plan: ProfilePlan, provenance: ConfigProvenance | undefined) => {
      const exit = await Effect.runPromiseExit(
        Effect.suspend(() =>
          syncProgram(
            runtime.env,
            plan,
            false,
            false,
            false,
            provenance,
            configDir,
            NO_PROVISIONING_MODE,
          ).pipe(Effect.provide(serviceLayerFor(runtime.options, installation))),
        ),
      )
      if (Exit.isFailure(exit)) {
        return Promise.reject(
          Cause.hasInterruptsOnly(exit.cause) ? new Error('interrupted') : Cause.squash(exit.cause),
        )
      }
      return {
        changed: exit.value.changed,
        generationId: exit.value.generationId,
        restartRequired: exit.value.restartRequired,
        warnings: exit.value.warnings,
        notices: exit.value.notices.map((notice) => `${notice.severity}: ${notice.message}`),
      }
    }
    const session = yield* Effect.promise(() =>
      ReplSession.create({
        configPath: configPath.value,
        ...(profile === undefined ? {} : { profile }),
        sync: input.sync,
        env: runtime.env,
        stdout: runtime.stdout,
        stderr: runtime.stderr,
        ...(runtime.options.loadConfig === undefined
          ? {}
          : { loadConfig: runtime.options.loadConfig }),
        ...(runtime.options.watch === undefined ? {} : { watch: runtime.options.watch }),
        syncPlan,
        watchConfig: Option.isNone(input.eval),
        oneShot: Option.isSome(input.eval),
      }),
    )

    const evalExpression = Option.getOrUndefined(input.eval)
    if (evalExpression !== undefined) {
      const evaluated = yield* Effect.exit(
        Effect.tryPromise({
          try: () => session.evaluate(evalExpression),
          catch: (cause) => cause,
        }),
      )
      yield* Effect.promise(() => session.close())
      if (Exit.isFailure(evaluated)) {
        if (Cause.hasInterruptsOnly(evaluated.cause)) return EXIT_FAILURE
        report(runtime.stderr, Cause.squash(evaluated.cause))
        return EXIT_FAILURE
      }
      session.printValue(evaluated.value)
      return EXIT_OK
    }

    const inputStream = runtime.options.replInput ?? process.stdin
    const outputStream = runtime.options.replOutput ?? process.stdout
    const loop = yield* Effect.exit(
      Effect.tryPromise({
        try: () => runReplLoop(session, { input: inputStream, output: outputStream }),
        catch: (cause) => cause,
      }),
    )
    yield* Effect.promise(() => session.close())
    if (Exit.isFailure(loop)) {
      if (Cause.hasInterruptsOnly(loop.cause)) return EXIT_FAILURE
      report(runtime.stderr, Cause.squash(loop.cause))
      return EXIT_FAILURE
    }
    return EXIT_OK
  })
}
