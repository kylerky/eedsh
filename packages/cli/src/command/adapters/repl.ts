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
import {
  type CliServices,
  ConfigLoader,
  Environment,
  Output,
  Watcher,
} from '../../internal/effect/services'
import { runReplLoop } from '../../repl/prompt'
import { ReplSession } from '../../repl/session'
import { configFlag, dshFlag, evalFlag, profileFlag, replSyncFlag } from '../../surface'
import { asEedshError } from '../errors'
import { NO_PROVISIONING_MODE, syncProgram } from '../materialize'
import type { Parsed } from '../options'
import { requireDsh, resolveConfigPath } from '../prepare'
import { failWith, report } from '../report'

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
export function runReplCommand(input: ReplInput): Effect.Effect<number, never, CliServices> {
  return Effect.gen(function* () {
    const output = yield* Output
    const { env } = yield* Environment
    const configPath = yield* resolveConfigPath(input.config)
    if (Option.isNone(configPath)) return EXIT_FAILURE
    const installation = yield* requireDsh(input.dsh)
    const loader = yield* ConfigLoader
    const watcher = yield* Watcher
    const services = yield* Effect.context<CliServices>()
    const profile = Option.getOrUndefined(input.profile)
    const configDir = dirname(configPath.value)
    const syncPlan = async (plan: ProfilePlan, provenance: ConfigProvenance | undefined) => {
      const exit = await Effect.runPromiseExit(
        Effect.suspend(() =>
          syncProgram(
            env,
            plan,
            false,
            false,
            false,
            provenance,
            configDir,
            installation,
            NO_PROVISIONING_MODE,
          ).pipe(Effect.provide(services)),
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
    // Session construction loads the config and the authoring package; a
    // rejection there is this command's failure, reported once through Output.
    const session = yield* Effect.tryPromise({
      try: () =>
        ReplSession.create({
          configPath: configPath.value,
          ...(profile === undefined ? {} : { profile }),
          sync: input.sync,
          env,
          stdout: output.stdout,
          stderr: output.stderr,
          loadConfig: (path, evaluationNonce) => loader.load(path, evaluationNonce),
          watch: (dir, onChange) => watcher.watch(dir, onChange),
          syncPlan,
          watchConfig: Option.isNone(input.eval),
          oneShot: Option.isSome(input.eval),
        }),
      catch: (cause) => asEedshError(cause),
    })

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
        report(output.stderr, asEedshError(Cause.squash(evaluated.cause)))
        return EXIT_FAILURE
      }
      session.printValue(evaluated.value)
      return EXIT_OK
    }

    const loop = yield* Effect.exit(
      Effect.tryPromise({
        try: () => runReplLoop(session, { input: process.stdin, output: process.stdout }),
        catch: (cause) => cause,
      }),
    )
    yield* Effect.promise(() => session.close())
    if (Exit.isFailure(loop)) {
      if (Cause.hasInterruptsOnly(loop.cause)) return EXIT_FAILURE
      report(output.stderr, asEedshError(Cause.squash(loop.cause)))
      return EXIT_FAILURE
    }
    return EXIT_OK
  }).pipe(Effect.catch((error) => failWith(asEedshError(error))))
}
