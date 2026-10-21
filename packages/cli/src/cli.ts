/**
 * The `eedsh` command: evaluate the typed config, publish it into a DSH
 * profile, optionally boot the pinned launcher, or run the config project's
 * TypeScript compiler. The command surface is parsed by `@effect/cli`; one-shot
 * syncs use `Effect.runPromise`, while watch mode keeps one `ManagedRuntime`
 * alive so the materializer's services are reused across runs.
 * @module @eedsh/cli/cli
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { PlanValidationError, type ProfilePlan } from '@eedsh/config'
import { CliApp, Command, Options } from '@effect/cli'
import * as ValidationError from '@effect/cli/ValidationError'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import * as NodeTerminal from '@effect/platform-node/NodeTerminal'
import { Effect, Layer, ManagedRuntime } from 'effect'
import * as Console from 'effect/Console'
import * as Option from 'effect/Option'
import { isRecord } from 'effect/Predicate'
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
  FileSystemShape,
  PackageManagerShape,
  PreflightShape,
  SyncLockShape,
} from './internal/effect/services'
import { type MaterializeResult, materialize } from './materialize/program'
import { preflightLayer } from './preflight'
import { defaultSpawn, type SpawnLike } from './spawn'
import { type WatchSession, watchConfigDirectory } from './watch'

/** The services the materializer needs, built once per CLI run. */
export type CliServiceLayer = Layer.Layer<
  FileSystemShape | PackageManagerShape | DshInstallationShape | PreflightShape | SyncLockShape,
  DshResolveFailure,
  never
>

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

interface Invocation {
  command: 'sync' | 'run' | 'check'
  configPath: string | undefined
  strict: boolean
  watch: boolean
  explain: boolean
  noSync: boolean
  dshArgs: string[]
  tscArgs: string[]
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
  const write = (sink: (line: string) => void, args: ReadonlyArray<unknown>) =>
    Effect.sync(() => sink(render(args)))
  const unsafe = {
    assert: () => {},
    clear: () => {},
    count: () => {},
    countReset: () => {},
    debug: () => {},
    dir: () => {},
    dirxml: () => {},
    error: () => {},
    group: () => {},
    groupCollapsed: () => {},
    groupEnd: () => {},
    info: () => {},
    log: () => {},
    table: () => {},
    time: () => {},
    timeEnd: () => {},
    timeLog: () => {},
    trace: () => {},
    warn: () => {},
  }
  return {
    [Console.TypeId]: Console.TypeId,
    assert: (condition, ...args) =>
      condition ? Effect.void : write(stderr, ['Assertion failed:', ...args]),
    clear: Effect.void,
    count: () => Effect.void,
    countReset: () => Effect.void,
    debug: (...args) => write(stderr, args),
    dir: (item) => write(stderr, [item]),
    dirxml: (...args) => write(stderr, args),
    error: (...args) => write(stderr, args),
    group: () => Effect.void,
    groupEnd: Effect.void,
    info: (...args) => write(stderr, args),
    log: (...args) => write(stdout, args),
    table: (tabularData) => write(stdout, [tabularData]),
    time: () => Effect.void,
    timeEnd: () => Effect.void,
    timeLog: () => Effect.void,
    trace: (...args) => write(stderr, args),
    warn: (...args) => write(stderr, args),
    unsafe,
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

function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
  let text = ''
  for (const segment of path) {
    if (typeof segment === 'number') text += `[${segment}]`
    else text += text === '' ? String(segment) : `.${String(segment)}`
  }
  return text === '' ? 'plan' : text
}

function describeError(error: unknown): string[] {
  if (error instanceof PlanValidationError) {
    return error.issues.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`)
  }
  if (error instanceof ConfigError) return [`${error.code}: ${error.message}`]
  if (isRecord(error) && '_tag' in error) {
    const tagged = error
    switch (tagged._tag) {
      case 'FileSystemFailure':
        return [
          `cannot ${String(tagged.operation)} ${String(tagged.path)}: ${String(tagged.cause)}`,
        ]
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
  if (!isRecord(error) || error._tag !== 'PreflightFailure') return []
  return Array.isArray(error.warnings) ? error.warnings.map(String) : []
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

interface CommandContext {
  configPath: string
  invocation: Invocation
  plan: ProfilePlan
  stdout: (line: string) => void
  stderr: (line: string) => void
  env: Record<string, string | undefined>
  cwd: string
  options: CliRunOptions
}

function defaultServices(): CliServiceLayer {
  return Layer.mergeAll(liveServiceLayer, preflightLayer.pipe(Layer.provide(liveServiceLayer)))
}

function profileDirFor(plan: ProfilePlan, env: Record<string, string | undefined>): string {
  const home = env.DSH_HOME
  return home === undefined || home === ''
    ? resolveProfileDir(plan.profile.name)
    : resolveProfileDir(plan.profile.name, home)
}

function programFor(context: CommandContext, plan: ProfilePlan) {
  return materialize({
    plan,
    profileDir: profileDirFor(plan, context.env),
    eedshVersion: cliVersion(),
    runtimeSpec: runtimeLinkSpec(),
    generatedSpec: 'link:./.eedsh/generated',
    strict: context.invocation.strict,
    explain: context.invocation.explain,
  })
}

interface SyncOutcome {
  ok: boolean
  result?: MaterializeResult
}

async function syncOnce(context: CommandContext): Promise<SyncOutcome> {
  const layer = (context.options.services ?? defaultServices)()
  let outcome:
    | { _tag: 'Left'; left: MaterializeError }
    | { _tag: 'Right'; right: MaterializeResult }
  try {
    outcome = await Effect.runPromise(
      Effect.either(programFor(context, context.plan).pipe(Effect.provide(layer))),
    )
  } catch (error) {
    reportSyncError(context.stderr, error, context.invocation.explain)
    return { ok: false }
  }
  if (outcome._tag === 'Left') {
    reportSyncError(context.stderr, outcome.left, context.invocation.explain)
    return { ok: false }
  }
  printResult(
    context.stdout,
    context.stderr,
    context.plan,
    outcome.right,
    context.invocation.explain,
  )
  return { ok: true, result: outcome.right }
}

function waitForStop(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolveStop) => {
    if (signal !== undefined) {
      if (signal.aborted) return resolveStop()
      signal.addEventListener('abort', () => resolveStop(), { once: true })
      return
    }
    process.once('SIGINT', () => resolveStop())
    process.once('SIGTERM', () => resolveStop())
  })
}

async function syncWatch(context: CommandContext): Promise<number> {
  const layer = (context.options.services ?? defaultServices)()
  const runtime = ManagedRuntime.make(layer)
  let running = false
  let queued = false

  const runWith = async (plan: ProfilePlan): Promise<void> => {
    try {
      const outcome = await runtime.runPromise(Effect.either(programFor(context, plan)))
      if (outcome._tag === 'Left') {
        reportSyncError(context.stderr, outcome.left, context.invocation.explain)
        return
      }
      printResult(context.stdout, context.stderr, plan, outcome.right, context.invocation.explain)
    } catch (error) {
      reportSyncError(context.stderr, error, context.invocation.explain)
    }
  }

  const runOnce = async (): Promise<void> => {
    if (running) {
      queued = true
      return
    }
    running = true
    try {
      let plan: ProfilePlan
      try {
        plan = await (context.options.loadConfig ?? loadConfig)(context.configPath)
      } catch (error) {
        report(context.stderr, error)
        return
      }
      await runWith(plan)
    } finally {
      running = false
      if (queued) {
        queued = false
        void runOnce()
      }
    }
  }

  await runWith(context.plan)
  const dir = dirname(context.configPath)
  const onChange = () => {
    void runOnce()
  }
  const session =
    context.options.watch === undefined
      ? await watchConfigDirectory({ dir, onChange })
      : await context.options.watch(dir, onChange)
  await waitForStop(context.options.signal)
  await session.close()
  await runtime.dispose()
  return EXIT_OK
}

async function runBoot(context: CommandContext): Promise<number> {
  if (!context.invocation.noSync) {
    const outcome = await syncOnce(context)
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
      [binPath, '--profile', context.plan.profile.name, ...context.invocation.dshArgs],
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

async function dispatch(
  invocation: Invocation,
  options: CliRunOptions,
  stdout: (line: string) => void,
  stderr: (line: string) => void,
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<number> {
  let configPath: string
  if (invocation.configPath === undefined) {
    const discovered = findConfigPath(cwd)
    if (discovered === undefined) {
      const rejected = findUnsupportedConfigPath(cwd)
      if (rejected !== undefined) {
        report(stderr, unsupportedConfigExtensionError(rejected))
        return EXIT_FAILURE
      }
      stderr(`eedsh: cannot find a config (${CONFIG_FILENAMES.join(', ')}) in ${cwd}`)
      return EXIT_FAILURE
    }
    configPath = discovered
  } else {
    configPath = resolve(cwd, invocation.configPath)
    try {
      assertSupportedConfigPath(configPath)
    } catch (error) {
      report(stderr, error)
      return EXIT_FAILURE
    }
  }

  if (invocation.command === 'check') {
    return runCheck({
      configPath,
      tscArgs: invocation.tscArgs,
      stdout,
      stderr,
      env,
      cwd,
      spawn: options.spawn ?? defaultSpawn,
    })
  }

  let plan: ProfilePlan
  try {
    plan = await (options.loadConfig ?? loadConfig)(configPath)
  } catch (error) {
    report(stderr, error)
    return EXIT_FAILURE
  }

  const context: CommandContext = {
    configPath,
    invocation,
    plan,
    stdout,
    stderr,
    env,
    cwd,
    options,
  }
  if (invocation.command === 'sync' && invocation.watch) return syncWatch(context)
  if (invocation.command === 'sync') {
    const outcome = await syncOnce(context)
    return outcome.ok ? EXIT_OK : EXIT_FAILURE
  }
  return runBoot(context)
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

  let exitCode: number = EXIT_OK

  const dispatchEffect = (invocation: Invocation) =>
    Effect.tryPromise({
      try: async () => {
        exitCode = await dispatch(invocation, options, stdout, stderr, env, cwd)
      },
      catch: (error) => error,
    }).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          report(stderr, error)
          exitCode = EXIT_FAILURE
        }),
      ),
    )

  const configOption = Options.text('config').pipe(
    Options.withDescription('config file to load (default: eedsh.config.ts in the cwd)'),
    Options.optional,
  )
  const strictOption = Options.boolean('strict').pipe(
    Options.withDescription('treat unmatched patch targets as failures'),
  )
  const watchOption = Options.boolean('watch').pipe(
    Options.withDescription('re-run sync when files in the config directory change'),
  )
  const explainOption = Options.boolean('explain').pipe(
    Options.withDescription('attribute preflight warnings to their source layer'),
  )
  const noSyncOption = Options.boolean('no-sync').pipe(
    Options.withDescription('skip publication and boot the last published generation'),
  )

  const syncCommand = Command.make(
    'sync',
    {
      config: configOption,
      strict: strictOption,
      watch: watchOption,
      explain: explainOption,
    },
    (parsed) =>
      dispatchEffect({
        command: 'sync',
        configPath: Option.getOrUndefined(parsed.config),
        strict: parsed.strict,
        watch: parsed.watch,
        explain: parsed.explain,
        noSync: false,
        dshArgs: [],
        tscArgs: [],
      }),
  ).pipe(Command.withDescription('evaluate the config, preflight the layers, and publish'))

  const runCommandLine = Command.make(
    'run',
    { config: configOption, noSync: noSyncOption },
    (parsed) =>
      dispatchEffect({
        command: 'run',
        configPath: Option.getOrUndefined(parsed.config),
        strict: false,
        watch: false,
        explain: false,
        noSync: parsed.noSync,
        dshArgs: [...split.passthrough],
        tscArgs: [],
      }),
  ).pipe(Command.withDescription('sync (unless --no-sync) and boot the pinned dsh'))

  const checkCommandLine = Command.make('check', { config: configOption }, (parsed) =>
    dispatchEffect({
      command: 'check',
      configPath: Option.getOrUndefined(parsed.config),
      strict: false,
      watch: false,
      explain: false,
      noSync: false,
      dshArgs: [],
      tscArgs: [...split.passthrough],
    }),
  ).pipe(Command.withDescription("typecheck the config's project with its own tsc"))

  const rootCommand = Command.make('eedsh').pipe(
    Command.withDescription('typed configuration for DeepSeek Harness profiles'),
    Command.withSubcommands([syncCommand, runCommandLine, checkCommandLine]),
  )

  const app = CliApp.make({
    name: 'eedsh',
    version: cliVersion(),
    command: rootCommand.descriptor,
  })

  const parsedArgs = split.args.length === 0 ? ['--help'] : split.args
  const program = CliApp.run(app, ['node', 'eedsh', ...parsedArgs], (parsed) =>
    rootCommand.handler(parsed),
  ).pipe(
    Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeTerminal.layer)),
    Console.withConsole(cliConsole(stdout, stderr)),
    // The published CliApp.run signature swaps the handler's error and
    // environment slots; the runtime result is a ValidationError failure.
  ) as unknown as Effect.Effect<void, ValidationError.ValidationError, never>

  try {
    const result = await Effect.runPromise(Effect.either(program))
    if (result._tag === 'Left') {
      if (ValidationError.isValidationError(result.left)) return EXIT_USAGE
      report(stderr, result.left)
      return EXIT_FAILURE
    }
    return exitCode
  } catch (error) {
    report(stderr, error)
    return EXIT_FAILURE
  }
}
