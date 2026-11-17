/**
 * The `eedsh` command: evaluate the typed config, publish it into a DSH
 * profile, optionally boot the discovered launcher, or run the config project's
 * TypeScript compiler. The command surface is parsed by `effect/cli`; each
 * invocation is one Effect program observed by one `Effect.runPromiseExit`, and
 * watch mode is one scoped Effect program that builds the materializer's services
 * once for the whole session.
 * @module @eedsh/cli/cli
 */
import { dirname } from 'node:path'
import type { ConfigProvenance } from '@eedsh/config'
import { isSafeProfileName, type ProfilePlan } from '@eedsh/plan'
import type { InstallationAnchor } from '@eedsh/runtime/installation-anchor'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Cause, Effect, Exit } from 'effect'
import * as Console from 'effect/Console'
import { CliError, Command, Flag } from 'effect/cli'
import type * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import type * as PlatformError from 'effect/PlatformError'
import * as Result from 'effect/Result'
import type * as Schema from 'effect/Schema'
import { runCheck } from './check'
import { runBoot } from './command/boot'
import type {
  CliRunOptions,
  CommandContext,
  CommandRuntime,
  FailureContext,
} from './command/context'
import {
  NO_PROVISIONING_MODE,
  type ProvisioningMode,
  serviceLayerFor,
  syncOnce,
  syncProgram,
} from './command/materialize'
import {
  loadConfigValue,
  profileDirForName,
  reportProfileFailure,
  reportProfileSyncFailure,
  requireDsh,
  resolveConfigPath,
  selectionFailure,
} from './command/prepare'
import { cliConsole, printResult, report, reportSyncError } from './command/report'
import { cliVersion } from './command/version'
import { syncWatch, type WatchContext } from './command/watch'
import { defaultCommandRunner, versionProbe } from './command-runner'
import type { ConfigError, ConfigLoadFailure } from './config'
import { configDirectory } from './config-path'
import { doctor, doctorExitCode, formatDoctorReport } from './doctor'
import { type DiscoveredDshInstallation, discoverDshInstallation } from './dsh'
import { loadDshBridge } from './dsh-bridge'
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from './exit'
import {
  defaultInitServices,
  INIT_PROFILE_NAME,
  type InitError,
  resolveInitDependencySpecs,
  runInit,
} from './init'
import {
  anchorForInstallation,
  defaultInstallationAnchorStore,
  installationAnchorPathForEnv,
  installationFromSelection,
} from './installation-anchor'
import { resolveDshHome } from './internal/dsh-home'
import type {
  CheckFailure,
  DshFailure,
  MaterializeError,
  PackageInstallFailure,
  SpawnFailure,
} from './internal/effect/errors'
import { runReplLoop } from './repl/prompt'
import { ReplSession } from './repl/session'
import { selectProfile, selectSyncProfiles } from './selection'
import { defaultSpawn } from './spawn'

interface ParsedArgv {
  args: string[]
  passthrough: string[]
}
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
interface SyncCommandInput {
  configPath: Option.Option<string>
  profile: Option.Option<string>
  dsh: Option.Option<string>
  strict: boolean
  watch: boolean
  explain: boolean
  adoptOwnership: boolean
  rebuild: boolean
  noBuild: boolean
}

function runSyncCommand(
  input: SyncCommandInput,
  runtime: CommandRuntime,
): Effect.Effect<number, ConfigLoadFailure | MaterializeError | DshFailure> {
  return Effect.gen(function* () {
    runtime.setFailureContext({ sync: true, explain: input.explain })
    if (input.rebuild && input.noBuild) {
      runtime.stderr('eedsh: --rebuild and --no-build are mutually exclusive')
      return EXIT_USAGE
    }
    const provisioning: ProvisioningMode = {
      rebuild: input.rebuild,
      noBuild: input.noBuild,
    }
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
      yield* syncWatch(context, input.strict, input.explain, input.adoptOwnership, provisioning)
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
        syncOnce(context, input.strict, input.explain, input.adoptOwnership, provisioning),
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
      const result = yield* syncOnce(context, false, false, false, NO_PROVISIONING_MODE)
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
      dshHome: resolveDshHome(undefined, runtime.env),
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
  const rebuildFlag = Flag.Boolean('rebuild').pipe(
    Flag.withDescription('run every source preparation step even when the source is unchanged'),
    Flag.withDefault(false),
  )
  const noBuildFlag = Flag.Boolean('no-build').pipe(
    Flag.withDescription('fail instead of preparing when a declared source needs preparation'),
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
      rebuild: rebuildFlag,
      noBuild: noBuildFlag,
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
            rebuild: parsed.rebuild,
            noBuild: parsed.noBuild,
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
