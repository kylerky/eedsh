/**
 * The `eedsh` command: evaluate the typed config, publish it into a DSH
 * profile, optionally boot the pinned launcher, or run the config project's
 * TypeScript compiler. The command surface is parsed by `effect/cli`; one-shot
 * syncs use `Effect.runPromise`, while watch mode is one scoped Effect program
 * that builds the materializer's services once for the whole session.
 * @module @eedsh/cli/cli
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import type { ProfilePlan } from '@eedsh/config'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Cause, Effect, Exit, Layer, Queue } from 'effect'
import * as Console from 'effect/Console'
import { CliError, Command, Flag } from 'effect/cli'
import type * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'
import * as Schema from 'effect/Schema'
import { runCheck } from './check'
import {
  assertSupportedConfigPath,
  CONFIG_FILENAMES,
  ConfigError,
  findConfigPath,
  findUnsupportedConfigPath,
  loadConfig,
  unsupportedConfigExtensionError,
} from './config'
import { resolveDshInstallation } from './dsh'
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from './exit'
import type { DshResolveFailure, MaterializeError } from './internal/effect/errors'
import { liveServiceLayer } from './internal/effect/layer'
import type {
  DshInstallationShape,
  PackageManagerShape,
  PreflightShape,
  SyncLockShape,
} from './internal/effect/services'
import { type MaterializeResult, materialize } from './materialize/program'
import { preflightLayer } from './preflight'
import { defaultSpawn, type SpawnLike } from './spawn'
import { type WatchSession, watchConfigDirectory } from './watch'

/** The services the materializer needs, built once per CLI run. */
type CliService =
  | FileSystem.FileSystem
  | PackageManagerShape
  | DshInstallationShape
  | PreflightShape
  | SyncLockShape

/** A layer providing every CLI service. */
export type CliServiceLayer = Layer.Layer<CliService, DshResolveFailure, never>

/** Watch seam for `eedsh sync --watch`. */
export type WatchFactory = (dir: string, onChange: () => void) => Promise<WatchSession>

/** Overridable dependencies, for tests and embedders. */
export interface CliRunOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  stdout?: (line: string) => void
  stderr?: (line: string) => void
  /** Replace config evaluation. */
  loadConfig?: (configPath: string) => Promise<ProfilePlan>
  /** Replace the materializer's service layer. */
  services?: () => CliServiceLayer
  /** Replace the launcher spawn. */
  spawn?: SpawnLike
  /** Replace the config-directory watcher. */
  watch?: WatchFactory
  /** Stop watch mode when aborted. */
  signal?: AbortSignal
}

interface ParsedArgv {
  args: string[]
  passthrough: string[]
}

const EXPLAIN_HINT = 'eedsh: add --explain to attribute each warning to its source layer'

function splitPassthrough(argv: readonly string[]): ParsedArgv | { error: string } {
  const separator = argv.indexOf('--')
  if (separator === -1) return { args: [...argv], passthrough: [] }
  const command = argv[0]
  if (command !== 'run' && command !== 'check') {
    return { error: '"--" is only accepted by eedsh run and eedsh check' }
  }
  return {
    args: argv.slice(0, separator),
    passthrough: argv.slice(separator + 1),
  }
}

const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}[[][0-9;]*m`, 'g')

function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR, '')
}

function cliConsole(
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): Console.Console {
  const render = (args: ReadonlyArray<unknown>): string =>
    stripAnsi(args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' '))
  const write =
    (sink: (line: string) => void) =>
    (...args: ReadonlyArray<unknown>): void => {
      sink(render(args))
    }
  return {
    assert: (condition, ...args) => {
      if (!condition) stderr(`Assertion failed: ${render(args)}`)
    },
    clear: () => {},
    count: () => {},
    countReset: () => {},
    debug: write(stderr),
    dir: (item) => {
      stderr(render([item]))
    },
    dirxml: write(stderr),
    error: write(stderr),
    group: () => {},
    groupCollapsed: () => {},
    groupEnd: () => {},
    info: write(stderr),
    log: write(stdout),
    table: (tabularData) => {
      stdout(render([tabularData]))
    },
    time: () => {},
    timeEnd: () => {},
    timeLog: write(stderr),
    trace: write(stderr),
    warn: write(stderr),
  }
}

function runtimeLinkSpec(): string {
  const require = createRequire(import.meta.url)
  const manifest = require.resolve('@eedsh/runtime/package.json')
  return `link:${dirname(manifest)}`
}

function cliVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** Read a value as a plain record, when it is one. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return Predicate.isObject(value) ? (value as Record<string, unknown>) : undefined
}

function describeError(error: unknown): string[] {
  if (Schema.isSchemaError(error)) return error.message.split('\n')
  if (error instanceof ConfigError) return [`${error.code}: ${error.message}`]
  const tagged = asRecord(error)
  if (tagged !== undefined && '_tag' in tagged) {
    switch (tagged._tag) {
      case 'PackageInstallFailure':
        return [
          `package installation failed in ${String(tagged.profileDir)}: ${String(tagged.cause)}`,
        ]
      case 'PreflightFailure': {
        const warnings = Array.isArray(tagged.warnings) ? tagged.warnings.map(String) : []
        return [String(tagged.message), ...warnings]
      }
      case 'SyncLocked':
        return [`another sync is running for this profile; lock: ${String(tagged.lockPath)}`]
      case 'DshResolveFailure':
        return [`cannot resolve DSH package ${String(tagged.packageName)}: ${String(tagged.cause)}`]
      default:
        break
    }
  }
  return [error instanceof Error ? error.message : String(error)]
}

function report(stderr: (line: string) => void, error: unknown): void {
  for (const line of describeError(error)) stderr(`eedsh: ${line}`)
}

function rawPreflightWarnings(error: unknown): string[] {
  const tagged = asRecord(error)
  if (tagged === undefined || tagged._tag !== 'PreflightFailure') return []
  return Array.isArray(tagged.warnings) ? tagged.warnings.map(String) : []
}

function reportSyncError(stderr: (line: string) => void, error: unknown, explain: boolean): void {
  report(stderr, error)
  if (!explain && rawPreflightWarnings(error).length > 0) stderr(EXPLAIN_HINT)
}

function printResult(
  stdout: (line: string) => void,
  stderr: (line: string) => void,
  plan: ProfilePlan,
  result: MaterializeResult,
  explain: boolean,
): void {
  for (const warning of result.warnings) stderr(`eedsh: warning: ${warning}`)
  if (!explain && result.warnings.length > 0) stderr(EXPLAIN_HINT)
  stdout(
    `eedsh: ${result.changed ? 'published' : 'unchanged'} profile ${plan.profile.name} (generation ${result.generationId.slice(0, 12)})`,
  )
}

/** The output sinks, environment, and injected seams a subcommand runs against. */
interface CommandRuntime {
  stdout: (line: string) => void
  stderr: (line: string) => void
  env: Record<string, string | undefined>
  cwd: string
  options: CliRunOptions
}

interface CommandContext extends CommandRuntime {
  configPath: string
  plan: ProfilePlan
}

function defaultServices(): CliServiceLayer {
  return Layer.mergeAll(
    liveServiceLayer,
    preflightLayer.pipe(Layer.provide(liveServiceLayer)),
  ).pipe(Layer.provideMerge(NodeServices.layer))
}

function profileDirFor(plan: ProfilePlan, env: Record<string, string | undefined>): string {
  const home = env.DSH_HOME
  return home === undefined || home === ''
    ? resolveProfileDir(plan.profile.name)
    : resolveProfileDir(plan.profile.name, home)
}

function programFor(
  env: Record<string, string | undefined>,
  plan: ProfilePlan,
  strict: boolean,
  explain: boolean,
) {
  return materialize({
    plan,
    profileDir: profileDirFor(plan, env),
    eedshVersion: cliVersion(),
    runtimeSpec: runtimeLinkSpec(),
    generatedSpec: 'link:./.eedsh/generated',
    strict,
    explain,
  })
}

interface SyncOutcome {
  ok: boolean
  result?: MaterializeResult
}

async function syncOnce(
  context: CommandContext,
  strict: boolean,
  explain: boolean,
): Promise<SyncOutcome> {
  const layer = (context.options.services ?? defaultServices)()
  let outcome:
    | { _tag: 'Failure'; failure: MaterializeError }
    | { _tag: 'Success'; success: MaterializeResult }
  try {
    outcome = await Effect.runPromise(
      Effect.result(
        programFor(context.env, context.plan, strict, explain).pipe(Effect.provide(layer)),
      ),
    )
  } catch (error) {
    reportSyncError(context.stderr, error, explain)
    return { ok: false }
  }
  if (outcome._tag === 'Failure') {
    reportSyncError(context.stderr, outcome.failure, explain)
    return { ok: false }
  }
  printResult(context.stdout, context.stderr, context.plan, outcome.success, explain)
  return { ok: true, result: outcome.success }
}

/** A stop signal from an injected `AbortSignal`, SIGINT, or SIGTERM. */
function stopSignal(signal: AbortSignal | undefined): Effect.Effect<void> {
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

/** Run one watch-mode sync, reporting failures and stopping on interruption. */
function runWatch(
  context: CommandContext,
  planEffect: Effect.Effect<ProfilePlan, unknown>,
  strict: boolean,
  explain: boolean,
): Effect.Effect<void, never, CliService> {
  return Effect.gen(function* () {
    const planExit = yield* Effect.exit(planEffect)
    if (Exit.isFailure(planExit)) {
      if (Cause.hasInterruptsOnly(planExit.cause)) return yield* Effect.interrupt
      yield* Effect.sync(() => report(context.stderr, Cause.squash(planExit.cause)))
      return
    }
    const runExit = yield* Effect.exit(programFor(context.env, planExit.value, strict, explain))
    if (Exit.isFailure(runExit)) {
      if (Cause.hasInterruptsOnly(runExit.cause)) return yield* Effect.interrupt
      yield* Effect.sync(() =>
        reportSyncError(context.stderr, Cause.squash(runExit.cause), explain),
      )
      return
    }
    yield* Effect.sync(() =>
      printResult(context.stdout, context.stderr, planExit.value, runExit.value, explain),
    )
  })
}

async function syncWatch(
  context: CommandContext,
  strict: boolean,
  explain: boolean,
): Promise<number> {
  const layer = (context.options.services ?? defaultServices)()
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
        catch: (cause) => cause,
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
        yield* runWatch(
          context,
          Effect.tryPromise({
            try: () => (context.options.loadConfig ?? loadConfig)(context.configPath),
            catch: (cause) => cause,
          }),
          strict,
          explain,
        )
      }
    })

    yield* Effect.race(
      runWatch(context, Effect.succeed(context.plan), strict, explain).pipe(Effect.andThen(loop)),
      stopSignal(context.options.signal),
    )
  })

  const exit = await Effect.runPromiseExit(Effect.scoped(program).pipe(Effect.provide(layer)))
  if (Exit.isSuccess(exit)) return EXIT_OK
  report(context.stderr, Cause.squash(exit.cause))
  return EXIT_FAILURE
}

async function runBoot(
  context: CommandContext,
  noSync: boolean,
  dshArgs: readonly string[],
): Promise<number> {
  if (!noSync) {
    const outcome = await syncOnce(context, false, false)
    if (!outcome.ok) return EXIT_FAILURE
  }
  let binPath: string
  try {
    binPath = resolveDshInstallation().binPath
  } catch (error) {
    report(context.stderr, error)
    return EXIT_FAILURE
  }
  const spawnFn: SpawnLike = context.options.spawn ?? defaultSpawn
  return await new Promise<number>((resolveExit) => {
    const child = spawnFn(
      process.execPath,
      [binPath, '--profile', context.plan.profile.name, ...dshArgs],
      {
        cwd: context.cwd,
        env: context.env,
        stdio: 'inherit',
      },
    )
    child.on('exit', (code) => resolveExit(code ?? EXIT_FAILURE))
    child.on('error', (error) => {
      report(context.stderr, error)
      resolveExit(EXIT_FAILURE)
    })
  })
}

function resolveConfigPath(
  requested: string | undefined,
  runtime: CommandRuntime,
): string | undefined {
  if (requested !== undefined) {
    const configPath = resolve(runtime.cwd, requested)
    try {
      assertSupportedConfigPath(configPath)
      return configPath
    } catch (error) {
      report(runtime.stderr, error)
      return undefined
    }
  }

  const discovered = findConfigPath(runtime.cwd)
  if (discovered !== undefined) return discovered

  const rejected = findUnsupportedConfigPath(runtime.cwd)
  if (rejected !== undefined) {
    report(runtime.stderr, unsupportedConfigExtensionError(rejected))
    return undefined
  }

  runtime.stderr(`eedsh: cannot find a config (${CONFIG_FILENAMES.join(', ')}) in ${runtime.cwd}`)
  return undefined
}

async function loadPlan(
  configPath: string,
  runtime: CommandRuntime,
): Promise<ProfilePlan | undefined> {
  try {
    return await (runtime.options.loadConfig ?? loadConfig)(configPath)
  } catch (error) {
    report(runtime.stderr, error)
    return undefined
  }
}

interface SyncCommandInput {
  configPath: string | undefined
  strict: boolean
  watch: boolean
  explain: boolean
}

async function runSyncCommand(input: SyncCommandInput, runtime: CommandRuntime): Promise<number> {
  const configPath = resolveConfigPath(input.configPath, runtime)
  if (configPath === undefined) return EXIT_FAILURE
  const plan = await loadPlan(configPath, runtime)
  if (plan === undefined) return EXIT_FAILURE
  const context: CommandContext = { ...runtime, configPath, plan }
  if (input.watch) return syncWatch(context, input.strict, input.explain)
  const outcome = await syncOnce(context, input.strict, input.explain)
  return outcome.ok ? EXIT_OK : EXIT_FAILURE
}

interface RunCommandInput {
  configPath: string | undefined
  noSync: boolean
  dshArgs: readonly string[]
}

async function runRunCommand(input: RunCommandInput, runtime: CommandRuntime): Promise<number> {
  const configPath = resolveConfigPath(input.configPath, runtime)
  if (configPath === undefined) return EXIT_FAILURE
  const plan = await loadPlan(configPath, runtime)
  if (plan === undefined) return EXIT_FAILURE
  const context: CommandContext = { ...runtime, configPath, plan }
  return runBoot(context, input.noSync, input.dshArgs)
}

interface CheckCommandInput {
  configPath: string | undefined
  tscArgs: readonly string[]
}

async function runCheckCommand(input: CheckCommandInput, runtime: CommandRuntime): Promise<number> {
  const configPath = resolveConfigPath(input.configPath, runtime)
  if (configPath === undefined) return EXIT_FAILURE
  return runCheck({
    configPath,
    tscArgs: input.tscArgs,
    stdout: runtime.stdout,
    stderr: runtime.stderr,
    env: runtime.env,
    cwd: runtime.cwd,
    spawn: runtime.options.spawn ?? defaultSpawn,
  })
}

/**
 * Run the CLI with an explicit argument vector.
 * @param argv - arguments after the executable and script.
 * @param options - overridable dependencies.
 * @returns the process exit code.
 */
export async function runEedsh(
  argv: readonly string[],
  options: CliRunOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((line: string) => console.log(line))
  const stderr = options.stderr ?? ((line: string) => console.error(line))
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()

  const split = splitPassthrough(argv)
  if ('error' in split) {
    stderr(`eedsh: ${split.error}`)
    return EXIT_USAGE
  }

  const runtime: CommandRuntime = { stdout, stderr, env, cwd, options }

  // effect/cli handlers return Effect<void>, so each handler records its command's exit code
  // here; unexpected failures surface through the outer catch below.
  let exitCode: number = EXIT_OK

  const configFlag = Flag.String('config').pipe(
    Flag.withDescription('config file to load (default: eedsh.config.ts in the cwd)'),
    Flag.optional,
  )
  const strictFlag = Flag.Boolean('strict').pipe(
    Flag.withDescription('treat unmatched patch targets as failures'),
    Flag.withDefault(false),
  )
  const watchFlag = Flag.Boolean('watch').pipe(
    Flag.withDescription('re-run sync when files in the config directory change'),
    Flag.withDefault(false),
  )
  const explainFlag = Flag.Boolean('explain').pipe(
    Flag.withDescription('attribute preflight warnings to their source layer'),
    Flag.withDefault(false),
  )
  const noSyncFlag = Flag.Boolean('no-sync').pipe(
    Flag.withDescription('skip publication and boot the last published generation'),
    Flag.withDefault(false),
  )

  const syncCommand = Command.make(
    'sync',
    {
      config: configFlag,
      strict: strictFlag,
      watch: watchFlag,
      explain: explainFlag,
    },
    (parsed) =>
      Effect.promise(async () => {
        exitCode = await runSyncCommand(
          {
            configPath: Option.getOrUndefined(parsed.config),
            strict: parsed.strict,
            watch: parsed.watch,
            explain: parsed.explain,
          },
          runtime,
        )
      }),
  ).pipe(Command.withDescription('evaluate the config, preflight the layers, and publish'))

  const runCommandLine = Command.make('run', { config: configFlag, noSync: noSyncFlag }, (parsed) =>
    Effect.promise(async () => {
      exitCode = await runRunCommand(
        {
          configPath: Option.getOrUndefined(parsed.config),
          noSync: parsed.noSync,
          dshArgs: split.passthrough,
        },
        runtime,
      )
    }),
  ).pipe(Command.withDescription('sync (unless --no-sync) and boot the pinned dsh'))

  const checkCommandLine = Command.make('check', { config: configFlag }, (parsed) =>
    Effect.promise(async () => {
      exitCode = await runCheckCommand(
        {
          configPath: Option.getOrUndefined(parsed.config),
          tscArgs: split.passthrough,
        },
        runtime,
      )
    }),
  ).pipe(Command.withDescription("typecheck the config's project with its own tsc"))

  const rootCommand = Command.make('eedsh').pipe(
    Command.withDescription('typed configuration for DeepSeek Harness profiles'),
    Command.withSubcommands([syncCommand, runCommandLine, checkCommandLine]),
  )

  const parsedArgs = split.args.length === 0 ? ['--help'] : split.args
  const program = Command.runWith(rootCommand, { version: cliVersion() })(parsedArgs).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provideService(Console.Console, cliConsole(stdout, stderr)),
  )

  try {
    const result = await Effect.runPromise(Effect.result(program))
    if (result._tag === 'Failure') {
      if (CliError.isCliError(result.failure)) return EXIT_USAGE
      report(stderr, result.failure)
      return EXIT_FAILURE
    }
    return exitCode
  } catch (error) {
    report(stderr, error)
    return EXIT_FAILURE
  }
}
