/**
 * The `eedsh` command: evaluate the typed config, publish it into a DSH
 * profile, optionally boot the discovered launcher, or run the config project's
 * TypeScript compiler. The command surface is parsed by `effect/cli`; each
 * invocation is one Effect program observed by one `Effect.runPromiseExit`, and
 * watch mode is one scoped Effect program that builds the materializer's services
 * once for the whole session.
 * @module @eedsh/cli/cli
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import type { ConfigProvenance, DshBridge } from '@eedsh/config'
import { isSafeProfileName, type ProfilePlan } from '@eedsh/plan'
import type { InstallationAnchor } from '@eedsh/runtime/installation-anchor'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Cause, Effect, Exit, Layer, Queue } from 'effect'
import * as Console from 'effect/Console'
import { CliError, Command, Flag } from 'effect/cli'
import type * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import type * as PlatformError from 'effect/PlatformError'
import type { ChildProcessSpawner } from 'effect/process'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { runCheck } from './check'
import { type CommandRunner, defaultCommandRunner, versionProbe } from './command-runner'
import {
  ConfigError,
  type ConfigLoadFailure,
  type LoadedConfig,
  loadConfig,
  validateConfigPath,
} from './config'
import { configDirectory, defaultConfigPath } from './config-path'
import { doctor, doctorExitCode, formatDoctorReport } from './doctor'
import { type DiscoveredDshInstallation, discoverDshInstallation, validateDshVersion } from './dsh'
import {
  type BootstrapInput,
  type BootstrappedDsh,
  bootstrapDshInstallation,
} from './dsh-bootstrap'
import { loadDshBridge } from './dsh-bridge'
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from './exit'
import {
  defaultInitServices,
  INIT_PROFILE_NAME,
  type InitError,
  type InitService,
  resolveInitDependencySpecs,
  runInit,
} from './init'
import {
  anchorForInstallation,
  defaultInstallationAnchorStore,
  type InstallationAnchorStore,
  installationAnchorPathForEnv,
  installationFromSelection,
} from './installation-anchor'
import { presetDefinitionErrorLines } from './internal/authoring-error'
import { resolveDshHome, resolveProfileDir } from './internal/dsh-home'
import {
  type CheckFailure,
  type DshFailure,
  type DshResolveFailure,
  type MaterializeError,
  type PackageInstallFailure,
  SpawnFailure,
} from './internal/effect/errors'
import { liveServiceLayerFor } from './internal/effect/layer'
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
import { provisionPlanSources } from './provision/plan'
import { runReplLoop } from './repl/prompt'
import { ReplSession } from './repl/session'
import {
  AmbiguousProfile,
  describeProfileSelection,
  type ProfileSelectionError,
  selectProfile,
  selectSyncProfiles,
  UnknownProfile,
} from './selection'
import { defaultSpawn, type SpawnLike } from './spawn'
import { type WatchSession, watchConfigDirectory } from './watch'

/** The services the materializer needs, built once per CLI run. */
type CliService =
  | FileSystem.FileSystem
  | PackageManagerShape
  | DshInstallationShape
  | PreflightShape
  | SyncLockShape
  | ChildProcessSpawner.ChildProcessSpawner

/** A layer providing every CLI service. */
export type CliServiceLayer = Layer.Layer<CliService, DshResolveFailure, never>

/** Watch seam for `eedsh sync --watch`. */
export type WatchFactory = (dir: string, onChange: () => void) => Promise<WatchSession>

/** The discovery input a command passes to an injected seam. */
export interface DshDiscoveryInput {
  readonly explicit?: string | undefined
  readonly env: Record<string, string | undefined>
  readonly cwd: string
}

/** Overridable dependencies, for tests and embedders. */
export interface CliRunOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  stdout?: (line: string) => void
  stderr?: (line: string) => void
  /** Replace config evaluation. */
  loadConfig?: (
    configPath: string,
    evaluationNonce?: string,
  ) => Effect.Effect<LoadedConfig, ConfigLoadFailure>
  /** Replace the materializer's service layer. */
  services?: () => CliServiceLayer
  /** Replace DSH discovery. */
  discoverDsh?: (input: DshDiscoveryInput) => Result.Result<DiscoveredDshInstallation, DshFailure>
  /** Replace bridge loading; the default imports app-boot from the installation. */
  loadDshBridge?: (
    installation: DiscoveredDshInstallation,
  ) => Promise<Result.Result<DshBridge, DshFailure>>
  /** Replace the file system `doctor` inspects. */
  fileSystem?: () => Layer.Layer<FileSystem.FileSystem>
  /** Replace the launcher spawn. */
  spawn?: SpawnLike
  /** Replace the config-directory watcher. */
  watch?: WatchFactory
  /** Input stream for the interactive REPL (default: process.stdin). */
  replInput?: NodeJS.ReadableStream
  /** Output stream for REPL prompts and values (default: process.stdout). */
  replOutput?: NodeJS.WritableStream
  /** Stop watch mode when aborted. */
  signal?: AbortSignal
  /** Replace the narrow services `init` needs. */
  initServices?: () => Layer.Layer<InitService>
  /** Replace the machine-local installation anchor store. */
  installationAnchor?: InstallationAnchorStore
  /** Replace the bounded command runner used by setup paths. */
  commandRunner?: CommandRunner
  /** Replace the pnpm/npm installation bootstrap. */
  bootstrapDsh?: (input: BootstrapInput) => Result.Result<BootstrappedDsh, DshFailure>
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
  if (error instanceof UnknownProfile || error instanceof AmbiguousProfile) {
    return [describeProfileSelection(error)]
  }
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
      case 'DshFailure':
        return [`${String(tagged.code)}: ${String(tagged.message)}`]
      case 'InitError':
        return [`${String(tagged.code)}: ${String(tagged.message)}`]
      case 'ReplSessionError':
        return Array.isArray(tagged.lines) ? tagged.lines.map(String) : [String(tagged.message)]
      case 'ResolutionError':
        return [`${String(tagged.code)}: ${String(tagged.message)}`]
      case 'PresetDefinitionError':
        return presetDefinitionErrorLines(tagged)
      case 'SourceDeclarationError':
        return [`${String(tagged.code)}: ${String(tagged.message)}`]
      case 'ProvisionFailure':
        return [`${String(tagged.code)}: ${String(tagged.message)}`]
      case 'PreviewError':
        return [`${String(tagged.code)}: ${String(tagged.message)}`]
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
  /** The installation selected for this invocation, once discovery ran. */
  installation?: DiscoveredDshInstallation
  setFailureContext: (context: FailureContext | undefined) => void
}

interface CommandContext extends CommandRuntime {
  configPath: string
  installation: DiscoveredDshInstallation
  plan: ProfilePlan
  /** The evaluated config's recorded provenance, when it has any. */
  provenance: ConfigProvenance | undefined
  /** Absolute directory of the evaluated config file. */
  configDir: string
  /** The `--profile` value the run was started with, for watch reruns. */
  profile: Option.Option<string>
}

export function defaultServices(installation: DiscoveredDshInstallation): CliServiceLayer {
  const live = liveServiceLayerFor(installation)
  return Layer.mergeAll(live, preflightLayer.pipe(Layer.provide(live))).pipe(
    Layer.provideMerge(NodeServices.layer),
  )
}

function profileDirForName(name: string, env: Record<string, string | undefined>): string {
  return resolveProfileDir(name, resolveDshHome(undefined, env))
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
  provenance: ConfigProvenance | undefined,
  configDir: string,
): Effect.Effect<MaterializeResult, MaterializeError | ConfigError, CliService> {
  return Effect.gen(function* () {
    const runtimeSpec = yield* Effect.fromResult(runtimeLinkSpec())
    // Provision declared sources before reconciliation so the derived link
    // specifications take part in the same managed dependency decision.
    const provisioned = yield* provisionPlanSources({
      home: resolveDshHome(undefined, env),
      configDir,
      plan,
    })
    const result = yield* materialize({
      plan,
      profileDir: profileDirFor(plan, env),
      eedshVersion: cliVersion(),
      runtimeSpec,
      generatedSpec: 'link:./.eedsh/generated',
      strict,
      explain,
      adoptOwnership,
      ...(provenance === undefined ? {} : { provenance }),
      configDir,
      sourceSpecs: provisioned.specs,
    })
    return { ...result, warnings: [...provisioned.warnings, ...result.warnings] }
  })
}

/** Build the materializer's service layer for one command invocation. */
function serviceLayerFor(
  options: CliRunOptions,
  installation: DiscoveredDshInstallation,
): CliServiceLayer {
  if (options.services !== undefined) return options.services()
  return defaultServices(installation)
}

/**
 * Discover and validate one installation, then install its bridge. Runs before
 * any config import so a top-level query or dshVersion() resolves. Setup
 * commands may bootstrap an unresolved PATH launcher through pnpm/npm and
 * record the anchor; doctor, repl, and run --no-sync never do.
 */
function requireDsh(
  runtime: CommandRuntime,
  explicit: Option.Option<string>,
  options: { readonly bootstrap?: boolean } = {},
): Effect.Effect<DiscoveredDshInstallation, DshFailure> {
  return Effect.gen(function* () {
    const store = runtime.options.installationAnchor ?? defaultInstallationAnchorStore
    const runner = runtime.options.commandRunner ?? defaultCommandRunner
    const discovery = runtime.options.discoverDsh ?? discoverDshInstallation
    const discovered = yield* Effect.sync(() =>
      discovery({
        ...(Option.isSome(explicit) ? { explicit: explicit.value } : {}),
        env: runtime.env,
        cwd: runtime.cwd,
        readAnchor: () => store.read(runtime.env),
        probeVersion: versionProbe(runner, runtime.env),
      }),
    )

    let selected: DiscoveredDshInstallation
    if (Result.isSuccess(discovered)) {
      selected = discovered.success
    } else {
      const envAnchor = runtime.env.EEDSH_DSH_ANCHOR
      const explicitAnchor = envAnchor !== undefined && envAnchor.trim() !== ''
      const launcher = discovered.failure.path
      const canBootstrap =
        options.bootstrap === true &&
        !Option.isSome(explicit) &&
        !explicitAnchor &&
        discovered.failure.code === 'dsh.launcher_unresolved' &&
        launcher !== undefined
      if (!canBootstrap) return yield* Effect.fail(discovered.failure)
      const bootstrap = runtime.options.bootstrapDsh ?? bootstrapDshInstallation
      const bootstrapped = yield* Effect.sync(() =>
        bootstrap({ env: runtime.env, cwd: runtime.cwd, launcher: launcher as string, runner }),
      )
      if (Result.isFailure(bootstrapped)) return yield* Effect.fail(bootstrapped.failure)
      selected = {
        ...bootstrapped.success.installation,
        source: 'bootstrapped',
        launcher: bootstrapped.success.launcher,
      }
      const written = yield* Effect.sync(() =>
        store.write(
          runtime.env,
          anchorForInstallation(selected, {
            recordedBy: 'sync',
            launcher: bootstrapped.success.launcher,
            manager: bootstrapped.success.manager,
          }),
        ),
      )
      if (!written.ok) {
        runtime.stderr(
          `eedsh: warning: cannot record the DSH installation anchor: ${written.error}; ` +
            `continuing with ${selected.installAnchor}`,
        )
      }
    }

    const validated = validateDshVersion(selected)
    if (Result.isFailure(validated)) return yield* Effect.fail(validated.failure)
    const load = runtime.options.loadDshBridge ?? loadDshBridge
    const loaded = yield* Effect.promise(() => load(validated.success))
    if (Result.isFailure(loaded)) return yield* Effect.fail(loaded.failure)
    runtime.installation = validated.success
    return validated.success
  })
}

/** The materialization program before its service layer is provided. */
function syncProgram(
  env: Record<string, string | undefined>,
  plan: ProfilePlan,
  strict: boolean,
  explain: boolean,
  adoptOwnership: boolean,
  provenance: ConfigProvenance | undefined,
  configDir: string,
): Effect.Effect<MaterializeResult, MaterializeError | ConfigError, CliService> {
  return programFor(env, plan, strict, explain, adoptOwnership, provenance, configDir)
}

/** Run one one-shot materialization with its own service layer. */
function syncOnce(
  context: CommandContext,
  strict: boolean,
  explain: boolean,
  adoptOwnership: boolean,
): Effect.Effect<MaterializeResult, MaterializeError | ConfigError | DshFailure> {
  return Effect.suspend(() =>
    syncProgram(
      context.env,
      context.plan,
      strict,
      explain,
      adoptOwnership,
      context.provenance,
      context.configDir,
    ).pipe(Effect.provide(serviceLayerFor(context.options, context.installation))),
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

/** The context one watch session runs against. */
interface WatchContext extends CommandRuntime {
  configPath: string
  installation: DiscoveredDshInstallation
  /** The `--profile` value, or none to watch every profile. */
  profile: Option.Option<string>
}

/** Run one watch pass over the currently selected profile set. */
function runWatchSelection(
  context: WatchContext,
  strict: boolean,
  explain: boolean,
  adoptOwnership: boolean,
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

function watchFailure(configPath: string, cause: unknown): ConfigError {
  const message = messageOf(cause)
  return new ConfigError('config.watch_failed', `cannot watch ${dirname(configPath)}: ${message}`)
}

/** One scoped watch session; the service layer is built once for the session. */
function syncWatch(
  context: WatchContext,
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
          yield* runWatchSelection(context, strict, explain, adoptOwnership)
        }
      })

      yield* Effect.race(
        runWatchSelection(context, strict, explain, adoptOwnership).pipe(Effect.andThen(loop)),
        stopSignal(context.options.signal),
      )
    })
    yield* Effect.scoped(program).pipe(
      Effect.provide(serviceLayerFor(context.options, context.installation)),
    )
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
  installation: DiscoveredDshInstallation,
  dshArgs: readonly string[],
): Effect.Effect<number, SpawnFailure> {
  return spawnDsh(context, installation.binPath, dshArgs)
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

  const configPath = defaultConfigPath(runtime.env)
  if (existsSync(configPath)) return Option.some(configPath)

  runtime.stderr(
    `eedsh: cannot find a config at ${configPath}; run "eedsh init" to create one, or pass --config <path>`,
  )
  return Option.none()
}

function loadConfigValue(
  configPath: string,
  runtime: CommandRuntime,
): Effect.Effect<LoadedConfig, ConfigLoadFailure> {
  return (runtime.options.loadConfig ?? loadConfig)(configPath)
}

function selectionFailure(runtime: CommandRuntime, error: ProfileSelectionError): number {
  for (const line of describeError(error)) runtime.stderr(`eedsh: ${line}`)
  return EXIT_USAGE
}

/** Report one profile-labelled failure without stopping the run. */
function reportProfileFailure(stderr: (line: string) => void, name: string, error: unknown): void {
  stderr(`eedsh: profile "${name}":`)
  for (const line of describeError(error)) stderr(`eedsh: ${line}`)
}

/** Report a profile-labelled sync failure, keeping the explain hint. */
function reportProfileSyncFailure(
  stderr: (line: string) => void,
  name: string,
  error: unknown,
  explain: boolean,
): void {
  reportProfileFailure(stderr, name, error)
  if (!explain && rawPreflightWarnings(error).length > 0) stderr(EXPLAIN_HINT)
}

interface SyncCommandInput {
  configPath: Option.Option<string>
  profile: Option.Option<string>
  dsh: Option.Option<string>
  strict: boolean
  watch: boolean
  explain: boolean
  adoptOwnership: boolean
}

function runSyncCommand(
  input: SyncCommandInput,
  runtime: CommandRuntime,
): Effect.Effect<number, ConfigLoadFailure | MaterializeError | DshFailure> {
  return Effect.gen(function* () {
    runtime.setFailureContext({ sync: true, explain: input.explain })
    const configPath = resolveConfigPath(input.configPath, runtime)
    if (Option.isNone(configPath)) return EXIT_FAILURE
    const path = configPath.value
    const installation = yield* requireDsh(runtime, input.dsh, { bootstrap: true })

    if (input.watch) {
      const context: WatchContext = {
        ...runtime,
        configPath: path,
        profile: input.profile,
        installation,
      }
      yield* syncWatch(context, input.strict, input.explain, input.adoptOwnership)
      return EXIT_OK
    }

    const loaded = yield* loadConfigValue(path, runtime)
    const selection = selectSyncProfiles(loaded.config, input.profile)
    if (Result.isFailure(selection)) return selectionFailure(runtime, selection.failure)
    const entries = selection.success

    const multiple = entries.length > 1
    let failed = false
    for (const entry of entries) {
      if (Result.isFailure(entry.plan)) {
        failed = true
        reportProfileFailure(runtime.stderr, entry.name, entry.plan.failure)
        continue
      }
      const plan = entry.plan.success
      if (multiple) runtime.stdout(`eedsh: profile "${entry.name}"`)
      const context: CommandContext = {
        ...runtime,
        configPath: path,
        installation,
        plan,
        provenance: loaded.provenance,
        configDir: loaded.configDir,
        profile: input.profile,
      }
      const runExit = yield* Effect.exit(
        syncOnce(context, input.strict, input.explain, input.adoptOwnership),
      )
      if (Exit.isFailure(runExit)) {
        if (Cause.hasInterruptsOnly(runExit.cause)) return yield* Effect.interrupt
        failed = true
        reportProfileSyncFailure(
          runtime.stderr,
          entry.name,
          Cause.squash(runExit.cause),
          input.explain,
        )
        continue
      }
      printResult(runtime.stdout, runtime.stderr, plan, runExit.value, input.explain)
    }
    return failed ? EXIT_FAILURE : EXIT_OK
  })
}

interface RunCommandInput {
  configPath: Option.Option<string>
  profile: Option.Option<string>
  dsh: Option.Option<string>
  noSync: boolean
  dshArgs: readonly string[]
}

function runRunCommand(
  input: RunCommandInput,
  runtime: CommandRuntime,
): Effect.Effect<number, ConfigLoadFailure | MaterializeError | DshFailure | SpawnFailure> {
  return Effect.gen(function* () {
    runtime.setFailureContext(input.noSync ? undefined : { sync: true, explain: false })
    const configPath = resolveConfigPath(input.configPath, runtime)
    if (Option.isNone(configPath)) return EXIT_FAILURE
    const installation = yield* requireDsh(runtime, input.dsh, { bootstrap: !input.noSync })
    const loaded = yield* loadConfigValue(configPath.value, runtime)
    const selection = selectProfile(loaded.config, input.profile)
    if (Result.isFailure(selection)) return selectionFailure(runtime, selection.failure)
    const entry = selection.success
    if (Result.isFailure(entry.plan)) {
      reportProfileFailure(runtime.stderr, entry.name, entry.plan.failure)
      return EXIT_FAILURE
    }
    const plan = entry.plan.success
    const context: CommandContext = {
      ...runtime,
      configPath: configPath.value,
      installation,
      plan,
      provenance: loaded.provenance,
      configDir: loaded.configDir,
      profile: input.profile,
    }
    if (!input.noSync) {
      const result = yield* syncOnce(context, false, false, false)
      yield* Effect.sync(() => printResult(runtime.stdout, runtime.stderr, plan, result, false))
    }
    return yield* runBoot(context, installation, input.dshArgs)
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
  dsh: Option.Option<string>
  strict: boolean
}

/** Inspect one published profile and print its findings. */
function runDoctorCommand(
  input: DoctorCommandInput,
  runtime: CommandRuntime,
): Effect.Effect<number, ConfigLoadFailure, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    runtime.setFailureContext(undefined)
    if (Option.isSome(input.profile) && Option.isSome(input.configPath)) {
      runtime.stderr('eedsh: doctor accepts either --profile or --config, not both')
      return EXIT_USAGE
    }
    const store = runtime.options.installationAnchor ?? defaultInstallationAnchorStore
    const runner = runtime.options.commandRunner ?? defaultCommandRunner
    const discovery = runtime.options.discoverDsh ?? discoverDshInstallation
    const discovered = discovery({
      ...(Option.isSome(input.dsh) ? { explicit: input.dsh.value } : {}),
      env: runtime.env,
      cwd: runtime.cwd,
      readAnchor: () => store.read(runtime.env),
      probeVersion: versionProbe(runner, runtime.env),
    })
    let doctorDsh: DiscoveredDshInstallation | undefined
    if (Result.isSuccess(discovered)) {
      doctorDsh = discovered.success
      const load = runtime.options.loadDshBridge ?? loadDshBridge
      const loaded = yield* Effect.promise(() => load(discovered.success))
      if (Result.isSuccess(loaded)) runtime.installation = discovered.success
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
      const loaded = yield* loadConfigValue(configPath.value, runtime)
      const selection = selectProfile(loaded.config, Option.none())
      if (Result.isFailure(selection)) return selectionFailure(runtime, selection.failure)
      profileName = selection.success.name
    }
    const result = yield* doctor({
      profileDir: profileDirForName(profileName, runtime.env),
      ...(doctorDsh === undefined ? {} : { dsh: doctorDsh }),
    })
    yield* Effect.sync(() => {
      for (const line of formatDoctorReport(result)) runtime.stdout(line)
    })
    return doctorExitCode(result, input.strict)
  })
}

interface ReplCommandInput {
  configPath: Option.Option<string>
  profile: Option.Option<string>
  dsh: Option.Option<string>
  sync: boolean
  eval: Option.Option<string>
}

/** Open the config REPL, or evaluate one expression with --eval. */
function runReplCommand(
  input: ReplCommandInput,
  runtime: CommandRuntime,
): Effect.Effect<number, unknown> {
  return Effect.gen(function* () {
    runtime.setFailureContext(undefined)
    const configPath = resolveConfigPath(input.configPath, runtime)
    if (Option.isNone(configPath)) return EXIT_FAILURE
    const installation = yield* requireDsh(runtime, input.dsh)
    const profile = Option.getOrUndefined(input.profile)
    const configDir = dirname(configPath.value)
    const syncPlan = async (plan: ProfilePlan, provenance: ConfigProvenance | undefined) => {
      const exit = await Effect.runPromiseExit(
        Effect.suspend(() =>
          syncProgram(runtime.env, plan, false, false, false, provenance, configDir).pipe(
            Effect.provide(serviceLayerFor(runtime.options, installation)),
          ),
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

interface InitCommandInput {
  noInstall: boolean
  dsh: Option.Option<string>
}

/** Create the XDG config project and print what to do next. */
function runInitCommand(
  input: InitCommandInput,
  runtime: CommandRuntime,
): Effect.Effect<
  number,
  InitError | PackageInstallFailure | PlatformError.PlatformError | DshFailure
> {
  return Effect.gen(function* () {
    runtime.setFailureContext(undefined)
    let anchorRecord: InstallationAnchor | undefined
    if (Option.isSome(input.dsh)) {
      const selected = installationFromSelection(input.dsh.value, runtime.cwd, {
        requireSupported: true,
      })
      if (Result.isFailure(selected)) return yield* Effect.fail(selected.failure)
      anchorRecord = anchorForInstallation(selected.success, { recordedBy: 'init' })
    }
    const specs = resolveInitDependencySpecs()
    if (Result.isFailure(specs)) return yield* Effect.fail(specs.failure)
    const configDir = configDirectory(runtime.env)
    const anchorPath = installationAnchorPathForEnv(runtime.env)
    const result = yield* runInit({
      configDir,
      specs: specs.success,
      install: !input.noInstall,
      stdout: runtime.stdout,
      anchorPath,
      ...(anchorRecord === undefined ? {} : { anchorRecord }),
      warn: (line: string) => runtime.stderr(line),
    }).pipe(Effect.provide((runtime.options.initServices ?? defaultInitServices)()))

    runtime.stdout(`eedsh: initialized ${configDir}`)
    runtime.stdout(`eedsh: profiles: ${INIT_PROFILE_NAME}`)
    if (result.kept.length > 0) {
      runtime.stdout(`eedsh: kept existing files: ${result.kept.join(', ')}`)
    }
    if (input.noInstall) runtime.stdout(`eedsh: ${result.installCommand}`)
    else runtime.stdout('eedsh: installed dependencies with pnpm')
    if (result.recordedAnchor !== undefined) {
      const version =
        result.recordedAnchor.version === undefined ? '' : ` (DSH ${result.recordedAnchor.version})`
      runtime.stdout(
        `eedsh: recorded installation anchor${version} at ${result.recordedAnchor.installAnchor}`,
      )
    } else if (result.existingAnchor !== undefined) {
      const version =
        result.existingAnchor.version === undefined ? '' : ` (DSH ${result.existingAnchor.version})`
      runtime.stdout(`eedsh: installation: ${result.existingAnchor.installAnchor}${version}`)
    } else {
      runtime.stdout(
        'eedsh: no installation anchor; the first "eedsh sync" bootstraps one through pnpm or npm, or pass --dsh <package dir|package.json>',
      )
    }
    runtime.stdout('eedsh: next: eedsh check')
    runtime.stdout('eedsh: next: eedsh sync')
    runtime.stdout('eedsh: next: eedsh run')
    return EXIT_OK
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
    Flag.withDescription('config file to load (default: $XDG_CONFIG_HOME/eedsh/config.ts)'),
    Flag.optional,
  )
  const dshFlag = Flag.String('dsh').pipe(
    Flag.withDescription(
      'DSH installation package directory or package.json (default: EEDSH_DSH_ANCHOR, PATH, then a project-local package)',
    ),
    Flag.optional,
  )
  const strictFlag = Flag.Boolean('strict').pipe(
    Flag.withDescription('treat preflight warnings as failures'),
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
  const noInstallFlag = Flag.Boolean('no-install').pipe(
    Flag.withDescription('write the config project without running pnpm install'),
    Flag.withDefault(false),
  )
  const adoptOwnershipFlag = Flag.Boolean('adopt-ownership').pipe(
    Flag.withDescription(
      're-baseline ownership from the current manifest when the generation record is unreadable',
    ),
    Flag.withDefault(false),
  )
  const syncProfileFlag = Flag.String('profile').pipe(
    Flag.withDescription('profile to sync (default: every profile in the config)'),
    Flag.optional,
  )
  const runProfileFlag = Flag.String('profile').pipe(
    Flag.withDescription('profile to boot (default: the declared default, then the sole profile)'),
    Flag.optional,
  )
  const profileFlag = Flag.String('profile').pipe(
    Flag.withDescription(
      'profile name to inspect under DSH_HOME (default: the config default or sole profile)',
    ),
    Flag.optional,
  )
  const doctorStrictFlag = Flag.Boolean('strict').pipe(
    Flag.withDescription('exit 1 when there is at least one warning'),
    Flag.withDefault(false),
  )
  const replSyncFlag = Flag.Boolean('sync').pipe(
    Flag.withDescription('sync the selected profile after each successful save'),
    Flag.withDefault(false),
  )
  const evalFlag = Flag.String('eval').pipe(
    Flag.withDescription('evaluate one expression, print its value, and exit'),
    Flag.optional,
  )

  const initCommandLine = Command.make(
    'init',
    { noInstall: noInstallFlag, dsh: dshFlag },
    (parsed) =>
      Effect.gen(function* () {
        exitCode = yield* runInitCommand({ noInstall: parsed.noInstall, dsh: parsed.dsh }, runtime)
      }),
  ).pipe(
    Command.withDescription(
      'create the XDG config project and install its dependencies (needs no DSH installation)',
    ),
  )

  const syncCommand = Command.make(
    'sync',
    {
      config: configFlag,
      profile: syncProfileFlag,
      dsh: dshFlag,
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
            profile: parsed.profile,
            dsh: parsed.dsh,
            strict: parsed.strict,
            watch: parsed.watch,
            explain: parsed.explain,
            adoptOwnership: parsed.adoptOwnership,
          },
          runtime,
        )
      }),
  ).pipe(
    Command.withDescription(
      'evaluate the config, preflight the layers, and publish (requires a discovered dsh)',
    ),
  )

  const runCommandLine = Command.make(
    'run',
    { config: configFlag, profile: runProfileFlag, dsh: dshFlag, noSync: noSyncFlag },
    (parsed) =>
      Effect.gen(function* () {
        exitCode = yield* runRunCommand(
          {
            configPath: parsed.config,
            profile: parsed.profile,
            dsh: parsed.dsh,
            noSync: parsed.noSync,
            dshArgs: split.passthrough,
          },
          runtime,
        )
      }),
  ).pipe(Command.withDescription('sync (unless --no-sync) and boot the discovered dsh'))

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
    { config: configFlag, profile: profileFlag, dsh: dshFlag, strict: doctorStrictFlag },
    (parsed) =>
      Effect.gen(function* () {
        const program = runDoctorCommand(
          {
            configPath: parsed.config,
            profile: parsed.profile,
            dsh: parsed.dsh,
            strict: parsed.strict,
          },
          runtime,
        )
        const fileSystem = runtime.options.fileSystem
        exitCode = yield* fileSystem === undefined
          ? program
          : program.pipe(Effect.provide(fileSystem()))
      }),
  ).pipe(
    Command.withDescription(
      'inspect a published profile without changing it; reports discovered DSH version and drift',
    ),
  )

  const replCommandLine = Command.make(
    'repl',
    {
      config: configFlag,
      profile: profileFlag,
      dsh: dshFlag,
      sync: replSyncFlag,
      eval: evalFlag,
    },
    (parsed) =>
      Effect.gen(function* () {
        exitCode = yield* runReplCommand(
          {
            configPath: parsed.config,
            profile: parsed.profile,
            dsh: parsed.dsh,
            sync: parsed.sync,
            eval: parsed.eval,
          },
          runtime,
        )
      }),
  ).pipe(
    Command.withDescription(
      'evaluate the config interactively, watch it for changes, and publish on request',
    ),
  )

  const rootCommand = Command.make('eedsh').pipe(
    Command.withDescription(
      'typed configuration for DeepSeek Harness profiles; sync, run, and repl use a discovered dsh installation',
    ),
    Command.withSubcommands([
      initCommandLine,
      syncCommand,
      runCommandLine,
      checkCommandLine,
      doctorCommandLine,
      replCommandLine,
    ]),
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
