/**
 * The `eedsh` command: evaluate the typed config, publish it into a DSH
 * profile, optionally boot the pinned launcher, or run the config project's
 * TypeScript compiler. The command surface is parsed by `effect/cli`; each
 * invocation is one Effect program observed by one `Effect.runPromiseExit`, and
 * watch mode is one scoped Effect program that builds the materializer's services
 * once for the whole session.
 * @module @eedsh/cli/cli
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { isSafeProfileName, type ProfilePlan } from '@eedsh/config'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Cause, Effect, Exit, Layer, Queue } from 'effect'
import * as Console from 'effect/Console'
import { CliError, Command, Flag } from 'effect/cli'
import type * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { runCheck } from './check'
import {
  CONFIG_FILENAMES,
  ConfigError,
  findConfigPath,
  findUnsupportedConfigPath,
  loadConfig,
  unsupportedConfigExtensionError,
  validateConfigPath,
} from './config'
import { doctor, doctorExitCode, formatDoctorReport } from './doctor'
import { resolveDshInstallation } from './dsh'
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from './exit'
import {
  type CheckFailure,
  type DshResolveFailure,
  type MaterializeError,
  SpawnFailure,
} from './internal/effect/errors'
import { liveServiceLayer } from './internal/effect/layer'
import type {
  DshInstallationShape,
  PackageManagerShape,
  PreflightShape,
  SyncLockShape,
} from './internal/effect/services'
import { messageOf } from './internal/error-message'
import { asRecord } from './internal/record'
import { readVersion } from './internal/schema-readers'
import { describeInvalidRecord } from './materialize/generation-record'
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
  loadConfig?: (configPath: string) => Effect.Effect<ProfilePlan, ConfigError | Schema.SchemaError>
  /** Replace the materializer's service layer. */
  services?: () => CliServiceLayer
  /** Replace the file system `doctor` inspects. */
  fileSystem?: () => Layer.Layer<FileSystem.FileSystem>
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

function runtimeLinkSpec(): Result.Result<string, ConfigError> {
  return Result.try({
    try: () => {
      const require = createRequire(import.meta.url)
      const manifest = require.resolve('@eedsh/runtime/package.json')
      return `link:${dirname(manifest)}`
    },
    catch: (cause) =>
      new ConfigError('runtime.not_found', `cannot resolve @eedsh/runtime: ${messageOf(cause)}`),
  })
}

function cliVersion(): string {
  const parsed = Result.try({
    try: () =>
      JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
        version?: unknown
      },
    catch: () => undefined,
  })
  return Result.isSuccess(parsed)
    ? Option.getOrElse(readVersion(parsed.success.version), () => '0.0.0')
    : '0.0.0'
}

function describeError(error: unknown): string[] {
  if (Schema.isSchemaError(error)) return error.message.split('\n')
  const tagged = asRecord(error)
  if (tagged !== undefined && '_tag' in tagged) {
    switch (tagged._tag) {
      case 'ConfigError':
        return [`${String(tagged.code)}: ${String(tagged.message)}`]
      case 'CheckFailure':
        return [`${String(tagged.code)}: ${String(tagged.message)}`]
      case 'SpawnFailure':
        return [`cannot launch dsh: ${String(tagged.cause)}`]
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
      case 'OwnershipRecordInvalid':
        return [
          describeInvalidRecord({
            path: String(tagged.path),
            detail: String(tagged.detail),
            adoptable: tagged.adoptable === true,
          }),
        ]
      case 'DshResolveFailure':
        return [`cannot resolve DSH package ${String(tagged.packageName)}: ${String(tagged.cause)}`]
      default:
        break
    }
  }
  return [messageOf(error)]
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
  for (const note of result.notices) stderr(`eedsh: ${note.severity}: ${note.message}`)
  if (!explain && result.warnings.length > 0) stderr(EXPLAIN_HINT)
  stdout(
    `eedsh: ${result.changed ? 'published' : 'unchanged'} profile ${plan.profile.name} (generation ${result.generationId.slice(0, 12)})`,
  )
}

/** The reporting context for the one diagnostic the runner emits. */
interface FailureContext {
  sync: boolean
  explain: boolean
}

/** The output sinks, environment, and injected seams a subcommand runs against. */
interface CommandRuntime {
  stdout: (line: string) => void
  stderr: (line: string) => void
  env: Record<string, string | undefined>
  cwd: string
  options: CliRunOptions
  setFailureContext: (context: FailureContext | undefined) => void
}

interface CommandContext extends CommandRuntime {
  configPath: string
  plan: ProfilePlan
}

export function defaultServices(): CliServiceLayer {
  return Layer.mergeAll(
    liveServiceLayer,
    preflightLayer.pipe(Layer.provide(liveServiceLayer)),
  ).pipe(Layer.provideMerge(NodeServices.layer))
}

function profileDirForName(name: string, env: Record<string, string | undefined>): string {
  const home = env.DSH_HOME
  return home === undefined || home === '' ? resolveProfileDir(name) : resolveProfileDir(name, home)
}

function profileDirFor(plan: ProfilePlan, env: Record<string, string | undefined>): string {
  return profileDirForName(plan.profile.name, env)
}

function programFor(
  env: Record<string, string | undefined>,
  plan: ProfilePlan,
  strict: boolean,
  explain: boolean,
  adoptOwnership: boolean,
): Effect.Effect<MaterializeResult, MaterializeError | ConfigError, CliService> {
  return Effect.gen(function* () {
    const runtimeSpec = yield* Effect.fromResult(runtimeLinkSpec())
    return yield* materialize({
      plan,
      profileDir: profileDirFor(plan, env),
      eedshVersion: cliVersion(),
      runtimeSpec,
      generatedSpec: 'link:./.eedsh/generated',
      strict,
      explain,
      adoptOwnership,
    })
  })
}

/** Build the materializer's service layer for one command invocation. */
function serviceLayerFor(options: CliRunOptions): CliServiceLayer {
  return (options.services ?? defaultServices)()
}

/** The materialization program before its service layer is provided. */
function syncProgram(
  context: CommandContext,
  plan: ProfilePlan,
  strict: boolean,
  explain: boolean,
  adoptOwnership: boolean,
): Effect.Effect<MaterializeResult, MaterializeError | ConfigError, CliService> {
  return programFor(context.env, plan, strict, explain, adoptOwnership)
}

/** Run one one-shot materialization with its own service layer. */
function syncOnce(
  context: CommandContext,
  strict: boolean,
  explain: boolean,
  adoptOwnership: boolean,
): Effect.Effect<MaterializeResult, MaterializeError | ConfigError | DshResolveFailure> {
  return Effect.suspend(() =>
    syncProgram(context, context.plan, strict, explain, adoptOwnership).pipe(
      Effect.provide(serviceLayerFor(context.options)),
    ),
  )
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
  plan: ProfilePlan,
  strict: boolean,
  explain: boolean,
  adoptOwnership: boolean,
): Effect.Effect<void, never, CliService> {
  return Effect.gen(function* () {
    const runExit = yield* Effect.exit(syncProgram(context, plan, strict, explain, adoptOwnership))
    if (Exit.isFailure(runExit)) {
      if (Cause.hasInterruptsOnly(runExit.cause)) return yield* Effect.interrupt
      yield* Effect.sync(() =>
        reportSyncError(context.stderr, Cause.squash(runExit.cause), explain),
      )
      return
    }
    yield* Effect.sync(() =>
      printResult(context.stdout, context.stderr, plan, runExit.value, explain),
    )
  })
}

function watchFailure(context: CommandContext, cause: unknown): ConfigError {
  const message = messageOf(cause)
  return new ConfigError(
    'config.watch_failed',
    `cannot watch ${dirname(context.configPath)}: ${message}`,
  )
}

/** One scoped watch session; the service layer is built once for the session. */
function syncWatch(
  context: CommandContext,
  strict: boolean,
  explain: boolean,
  adoptOwnership: boolean,
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
          catch: (cause) => watchFailure(context, cause),
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
          const planExit = yield* Effect.exit(loadPlan(context.configPath, context))
          if (Exit.isFailure(planExit)) {
            if (Cause.hasInterruptsOnly(planExit.cause)) return yield* Effect.interrupt
            yield* Effect.sync(() => report(context.stderr, Cause.squash(planExit.cause)))
            continue
          }
          yield* runWatch(context, planExit.value, strict, explain, adoptOwnership)
        }
      })

      yield* Effect.race(
        runWatch(context, context.plan, strict, explain, adoptOwnership).pipe(Effect.andThen(loop)),
        stopSignal(context.options.signal),
      )
    })
    yield* Effect.scoped(program).pipe(Effect.provide(serviceLayerFor(context.options)))
  })
}

function spawnDsh(
  context: CommandContext,
  binPath: string,
  dshArgs: readonly string[],
): Effect.Effect<number, SpawnFailure> {
  const spawnFn: SpawnLike = context.options.spawn ?? defaultSpawn
  return Effect.tryPromise({
    try: () =>
      new Promise<number>((resolveExit, rejectExit) => {
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
        child.on('error', rejectExit)
      }),
    catch: (cause) => new SpawnFailure({ cause }),
  })
}

function runBoot(
  context: CommandContext,
  dshArgs: readonly string[],
): Effect.Effect<number, DshResolveFailure | SpawnFailure> {
  return Effect.gen(function* () {
    const installation = yield* Effect.fromResult(resolveDshInstallation())
    return yield* spawnDsh(context, installation.binPath, dshArgs)
  })
}

function resolveConfigPath(
  requested: Option.Option<string>,
  runtime: CommandRuntime,
): Option.Option<string> {
  if (Option.isSome(requested)) {
    const configPath = resolve(runtime.cwd, requested.value)
    const valid = validateConfigPath(configPath)
    if (Result.isFailure(valid)) {
      report(runtime.stderr, valid.failure)
      return Option.none()
    }
    return Option.some(configPath)
  }

  const discovered = findConfigPath(runtime.cwd)
  if (Option.isSome(discovered)) return discovered

  const rejected = findUnsupportedConfigPath(runtime.cwd)
  if (Option.isSome(rejected)) {
    report(runtime.stderr, unsupportedConfigExtensionError(rejected.value))
    return Option.none()
  }

  runtime.stderr(`eedsh: cannot find a config (${CONFIG_FILENAMES.join(', ')}) in ${runtime.cwd}`)
  return Option.none()
}

function loadPlan(
  configPath: string,
  runtime: CommandRuntime,
): Effect.Effect<ProfilePlan, ConfigError | Schema.SchemaError> {
  return (runtime.options.loadConfig ?? loadConfig)(configPath)
}

interface SyncCommandInput {
  configPath: Option.Option<string>
  strict: boolean
  watch: boolean
  explain: boolean
  adoptOwnership: boolean
}

function runSyncCommand(
  input: SyncCommandInput,
  runtime: CommandRuntime,
): Effect.Effect<number, ConfigError | Schema.SchemaError | MaterializeError | DshResolveFailure> {
  return Effect.gen(function* () {
    runtime.setFailureContext({ sync: true, explain: input.explain })
    const configPath = resolveConfigPath(input.configPath, runtime)
    if (Option.isNone(configPath)) return EXIT_FAILURE
    const plan = yield* loadPlan(configPath.value, runtime)
    const context: CommandContext = { ...runtime, configPath: configPath.value, plan }
    if (input.watch) {
      yield* syncWatch(context, input.strict, input.explain, input.adoptOwnership)
      return EXIT_OK
    }
    const result = yield* syncOnce(context, input.strict, input.explain, input.adoptOwnership)
    yield* Effect.sync(() =>
      printResult(runtime.stdout, runtime.stderr, plan, result, input.explain),
    )
    return EXIT_OK
  })
}

interface RunCommandInput {
  configPath: Option.Option<string>
  noSync: boolean
  dshArgs: readonly string[]
}

function runRunCommand(
  input: RunCommandInput,
  runtime: CommandRuntime,
): Effect.Effect<
  number,
  ConfigError | Schema.SchemaError | MaterializeError | DshResolveFailure | SpawnFailure
> {
  return Effect.gen(function* () {
    runtime.setFailureContext(input.noSync ? undefined : { sync: true, explain: false })
    const configPath = resolveConfigPath(input.configPath, runtime)
    if (Option.isNone(configPath)) return EXIT_FAILURE
    const plan = yield* loadPlan(configPath.value, runtime)
    const context: CommandContext = { ...runtime, configPath: configPath.value, plan }
    if (!input.noSync) {
      const result = yield* syncOnce(context, false, false, false)
      yield* Effect.sync(() => printResult(runtime.stdout, runtime.stderr, plan, result, false))
    }
    return yield* runBoot(context, input.dshArgs)
  })
}

interface CheckCommandInput {
  configPath: Option.Option<string>
  tscArgs: readonly string[]
}

function runCheckCommand(
  input: CheckCommandInput,
  runtime: CommandRuntime,
): Effect.Effect<number, ConfigError | Schema.SchemaError | CheckFailure> {
  return Effect.gen(function* () {
    runtime.setFailureContext(undefined)
    const configPath = resolveConfigPath(input.configPath, runtime)
    if (Option.isNone(configPath)) return EXIT_FAILURE
    return yield* runCheck({
      configPath: configPath.value,
      tscArgs: input.tscArgs,
      stdout: runtime.stdout,
      stderr: runtime.stderr,
      env: runtime.env,
      cwd: runtime.cwd,
      spawn: runtime.options.spawn ?? defaultSpawn,
    })
  })
}

interface DoctorCommandInput {
  configPath: Option.Option<string>
  profile: Option.Option<string>
  strict: boolean
}

/** Inspect one published profile and print its findings. */
function runDoctorCommand(
  input: DoctorCommandInput,
  runtime: CommandRuntime,
): Effect.Effect<number, ConfigError | Schema.SchemaError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    runtime.setFailureContext(undefined)
    if (Option.isSome(input.profile) && Option.isSome(input.configPath)) {
      runtime.stderr('eedsh: doctor accepts either --profile or --config, not both')
      return EXIT_USAGE
    }
    let profileName: string
    if (Option.isSome(input.profile)) {
      if (!isSafeProfileName(input.profile.value)) {
        runtime.stderr(
          `eedsh: profile name "${input.profile.value}" is not usable as a profile directory`,
        )
        return EXIT_USAGE
      }
      profileName = input.profile.value
    } else {
      const configPath = resolveConfigPath(input.configPath, runtime)
      if (Option.isNone(configPath)) return EXIT_FAILURE
      const plan = yield* loadPlan(configPath.value, runtime)
      profileName = plan.profile.name
    }
    const result = yield* doctor({ profileDir: profileDirForName(profileName, runtime.env) })
    yield* Effect.sync(() => {
      for (const line of formatDoctorReport(result)) runtime.stdout(line)
    })
    return doctorExitCode(result, input.strict)
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

  let failureContext: FailureContext | undefined
  const runtime: CommandRuntime = {
    stdout,
    stderr,
    env,
    cwd,
    options,
    setFailureContext: (context) => {
      failureContext = context
    },
  }

  // effect/cli handlers return Effect<void>, so each handler records its command's exit code
  // here; failures flow through the single Exit boundary below.
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
  const adoptOwnershipFlag = Flag.Boolean('adopt-ownership').pipe(
    Flag.withDescription(
      're-baseline ownership from the current manifest when the generation record is unreadable',
    ),
    Flag.withDefault(false),
  )
  const profileFlag = Flag.String('profile').pipe(
    Flag.withDescription(
      'profile name to inspect under DSH_HOME (default: the configured profile)',
    ),
    Flag.optional,
  )
  const doctorStrictFlag = Flag.Boolean('strict').pipe(
    Flag.withDescription('exit 1 when there is at least one warning'),
    Flag.withDefault(false),
  )

  const syncCommand = Command.make(
    'sync',
    {
      config: configFlag,
      strict: strictFlag,
      watch: watchFlag,
      explain: explainFlag,
      adoptOwnership: adoptOwnershipFlag,
    },
    (parsed) =>
      Effect.gen(function* () {
        exitCode = yield* runSyncCommand(
          {
            configPath: parsed.config,
            strict: parsed.strict,
            watch: parsed.watch,
            explain: parsed.explain,
            adoptOwnership: parsed.adoptOwnership,
          },
          runtime,
        )
      }),
  ).pipe(Command.withDescription('evaluate the config, preflight the layers, and publish'))

  const runCommandLine = Command.make('run', { config: configFlag, noSync: noSyncFlag }, (parsed) =>
    Effect.gen(function* () {
      exitCode = yield* runRunCommand(
        {
          configPath: parsed.config,
          noSync: parsed.noSync,
          dshArgs: split.passthrough,
        },
        runtime,
      )
    }),
  ).pipe(Command.withDescription('sync (unless --no-sync) and boot the pinned dsh'))

  const checkCommandLine = Command.make('check', { config: configFlag }, (parsed) =>
    Effect.gen(function* () {
      exitCode = yield* runCheckCommand(
        {
          configPath: parsed.config,
          tscArgs: split.passthrough,
        },
        runtime,
      )
    }),
  ).pipe(Command.withDescription("typecheck the config's project with its own tsc"))

  const doctorCommandLine = Command.make(
    'doctor',
    { config: configFlag, profile: profileFlag, strict: doctorStrictFlag },
    (parsed) =>
      Effect.gen(function* () {
        const program = runDoctorCommand(
          {
            configPath: parsed.config,
            profile: parsed.profile,
            strict: parsed.strict,
          },
          runtime,
        )
        const fileSystem = runtime.options.fileSystem
        exitCode = yield* fileSystem === undefined
          ? program
          : program.pipe(Effect.provide(fileSystem()))
      }),
  ).pipe(Command.withDescription('inspect a published profile without changing it'))

  const rootCommand = Command.make('eedsh').pipe(
    Command.withDescription('typed configuration for DeepSeek Harness profiles'),
    Command.withSubcommands([syncCommand, runCommandLine, checkCommandLine, doctorCommandLine]),
  )

  const parsedArgs = split.args.length === 0 ? ['--help'] : split.args
  const buildProgram = () =>
    Command.runWith(rootCommand, { version: cliVersion() })(parsedArgs).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(Console.Console, cliConsole(stdout, stderr)),
    )

  const exit = await Effect.runPromiseExit(Effect.suspend(buildProgram))
  if (Exit.isSuccess(exit)) return exitCode
  if (Cause.hasInterruptsOnly(exit.cause)) return EXIT_FAILURE
  const error = Cause.squash(exit.cause)
  if (CliError.isCliError(error)) return EXIT_USAGE
  if (failureContext?.sync === true) reportSyncError(stderr, error, failureContext.explain)
  else report(stderr, error)
  return EXIT_FAILURE
}
