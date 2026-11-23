/**
 * `eedsh repl`: evaluate the config interactively, watch it for changes, and
 * publish on request, or evaluate one expression with `--eval`.
 *
 * The interactive loop runs inside this invocation program: input is the
 * `Terminal` service's line stream, and the session's publication trigger posts
 * a request whose materialization this program runs directly.
 * @module @eedsh/cli/command/adapters/repl
 */
import { dirname } from 'node:path'
import type { ConfigProvenance } from '@eedsh/config'
import type { ProfilePlan } from '@eedsh/plan'
import { Cause, Deferred, Effect, Exit, FileSystem, Queue, Ref, Stream } from 'effect'
import * as Option from 'effect/Option'
import { EXIT_FAILURE, EXIT_OK } from '../../exit'
import {
  BundleResolver,
  type CliServices,
  ConfigLoader,
  Environment,
  Output,
  Spawner,
  Watcher,
} from '../../internal/effect/services'
import type { MaterializeResult } from '../../materialize/program'
import { type ReplLoopState, runReplLoop } from '../../repl/prompt'
import {
  composeFor,
  doctorFor,
  installPreviewFor,
  ReplSession,
  type SyncOutcome,
  type SyncPlan,
} from '../../repl/session'
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

/** One publication request from the session to the invocation program. */
interface SyncRequest {
  readonly plan: ProfilePlan
  readonly provenance: ConfigProvenance | undefined
  readonly deferred: Deferred.Deferred<SyncOutcome, unknown>
}

/** The result shape the session consumes, mapped from one materialization. */
function syncOutcome(result: MaterializeResult): SyncOutcome {
  return {
    changed: result.changed,
    generationId: result.generationId,
    restartRequired: result.restartRequired,
    warnings: result.warnings,
    notices: result.notices.map((notice) => `${notice.severity}: ${notice.message}`),
  }
}

/** Open the config REPL, or evaluate one expression with --eval. */
export function runReplCommand(input: ReplInput): Effect.Effect<number, never, CliServices> {
  return Effect.gen(function* () {
    const output = yield* Output
    const { env } = yield* Environment
    const configPath = yield* resolveConfigPath(input.config)
    if (Option.isNone(configPath)) return EXIT_FAILURE
    const installation = yield* requireDsh(input.dsh)
    const loader = yield* ConfigLoader
    const resolver = yield* BundleResolver
    const watcher = yield* Watcher
    const fileSystem = yield* FileSystem.FileSystem
    const spawner = yield* Spawner
    const profile = Option.getOrUndefined(input.profile)
    const configDir = dirname(configPath.value)
    // The session's sync trigger posts a request and awaits its Deferred; the
    // materialization below runs in this program, not a nested runtime.
    const syncRequests = yield* Queue.unbounded<SyncRequest>()
    const syncPlan: SyncPlan = (plan, provenance) =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<SyncOutcome, unknown>()
        yield* Queue.offer(syncRequests, { plan, provenance, deferred })
        return yield* Deferred.await(deferred)
      })
    const serveSync = Stream.fromQueue(syncRequests).pipe(
      Stream.runForEach((request) =>
        Effect.gen(function* () {
          const run = yield* Effect.exit(
            Effect.suspend(() =>
              syncProgram(
                env,
                request.plan,
                false,
                false,
                false,
                request.provenance,
                configDir,
                installation,
                NO_PROVISIONING_MODE,
              ),
            ),
          )
          if (Exit.isFailure(run)) {
            if (Cause.hasInterruptsOnly(run.cause)) {
              yield* Deferred.fail(request.deferred, new Error('interrupted'))
            } else {
              yield* Deferred.fail(request.deferred, Cause.squash(run.cause))
            }
            return
          }
          yield* Deferred.succeed(request.deferred, syncOutcome(run.value))
        }),
      ),
    )
    const evalExpression = Option.getOrUndefined(input.eval)
    const tty = process.stdin.isTTY === true && process.stdout.isTTY === true
    const run = Effect.gen(function* () {
      // Session construction loads the config and the authoring package; a
      // failure there is this command's failure, reported once through Output.
      const session = yield* ReplSession.create({
        configPath: configPath.value,
        ...(profile === undefined ? {} : { profile }),
        sync: input.sync,
        env,
        stdout: output.stdout,
        stderr: output.stderr,
        loadConfig: (path, options) => loader.load(path, options),
        watch: (dir) => watcher.watch(dir),
        compose: composeFor(installation, resolver),
        syncPlan,
        installPreview: installPreviewFor(spawner),
        now: Date.now,
        doctor: doctorFor(env, fileSystem),
        fileSystem,
        spawner,
        installation,
        resolver,
        watchConfig: Option.isNone(input.eval),
        oneShot: Option.isSome(input.eval),
      }).pipe(Effect.mapError((error) => asEedshError(error)))
      yield* Effect.addFinalizer(() => session.close())

      if (evalExpression !== undefined) {
        const evaluated = yield* Effect.exit(
          Effect.tryPromise({
            try: () => session.evaluate(evalExpression),
            catch: (cause) => cause,
          }),
        )
        if (Exit.isFailure(evaluated)) {
          if (Cause.hasInterruptsOnly(evaluated.cause)) return EXIT_FAILURE
          report(output.stderr, asEedshError(Cause.squash(evaluated.cause)))
          return EXIT_FAILURE
        }
        session.printValue(evaluated.value)
        return EXIT_OK
      }

      const prompt = tty ? 'eedsh> ' : ''
      const loopState = yield* Ref.make<ReplLoopState>({ running: true, prompting: false })
      yield* Effect.forkScoped(serveSync)
      yield* runReplLoop(session, { tty, prompt, state: loopState })
      return EXIT_OK
    })
    const loop = yield* Effect.exit(Effect.scoped(run))
    if (Exit.isFailure(loop)) {
      if (Cause.hasInterruptsOnly(loop.cause)) return EXIT_FAILURE
      report(output.stderr, asEedshError(Cause.squash(loop.cause)))
      return EXIT_FAILURE
    }
    return loop.value
  }).pipe(Effect.catch((error) => failWith(asEedshError(error))))
}
