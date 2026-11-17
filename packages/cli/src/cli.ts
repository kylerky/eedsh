/**
 * The `eedsh` command's composition root: split passthrough arguments, build the
 * runtime every subcommand runs against, assemble the `effect/cli` surface from
 * the command adapters, and observe one invocation through a single
 * `Effect.runPromiseExit` boundary. Command behavior lives in
 * `./command/adapters`; the wiring they share lives in `./command`.
 * @module @eedsh/cli/cli
 */
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Cause, Effect, Exit } from 'effect'
import * as Console from 'effect/Console'
import { CliError, Command, Flag } from 'effect/cli'
import { runCheckCommand } from './command/adapters/check'
import { runDoctorCommand } from './command/adapters/doctor'
import { runInitCommand } from './command/adapters/init'
import { runReplCommand } from './command/adapters/repl'
import { runRunCommand } from './command/adapters/run'
import { runSyncCommand } from './command/adapters/sync'
import type { CliRunOptions, CommandRuntime, FailureContext } from './command/context'
import { cliConsole, report, reportSyncError } from './command/report'
import { cliVersion } from './command/version'
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from './exit'

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
