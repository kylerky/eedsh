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
import { CliError, Command } from 'effect/cli'
import { checkOptions, runCheckCommand } from './command/adapters/check'
import { doctorOptions, runDoctorCommand } from './command/adapters/doctor'
import { initOptions, runInitCommand } from './command/adapters/init'
import { replOptions, runReplCommand } from './command/adapters/repl'
import { runOptions, runRunCommand } from './command/adapters/run'
import { runSyncCommand, syncOptions } from './command/adapters/sync'
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

  const initCommandLine = Command.make('init', initOptions, (parsed) =>
    Effect.gen(function* () {
      exitCode = yield* runInitCommand(parsed, runtime)
    }),
  ).pipe(
    Command.withDescription(
      'create the XDG config project and install its dependencies (needs no DSH installation)',
    ),
  )

  const syncCommand = Command.make('sync', syncOptions, (parsed) =>
    Effect.gen(function* () {
      exitCode = yield* runSyncCommand(parsed, runtime)
    }),
  ).pipe(
    Command.withDescription(
      'evaluate the config, preflight the layers, and publish (requires a discovered dsh)',
    ),
  )

  const runCommandLine = Command.make('run', runOptions, (parsed) =>
    Effect.gen(function* () {
      exitCode = yield* runRunCommand({ ...parsed, dshArgs: split.passthrough }, runtime)
    }),
  ).pipe(Command.withDescription('sync (unless --no-sync) and boot the discovered dsh'))

  const checkCommandLine = Command.make('check', checkOptions, (parsed) =>
    Effect.gen(function* () {
      exitCode = yield* runCheckCommand({ ...parsed, tscArgs: split.passthrough }, runtime)
    }),
  ).pipe(Command.withDescription("typecheck the config's project with its own tsc"))

  const doctorCommandLine = Command.make('doctor', doctorOptions, (parsed) =>
    Effect.gen(function* () {
      const program = runDoctorCommand(parsed, runtime)
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

  const replCommandLine = Command.make('repl', replOptions, (parsed) =>
    Effect.gen(function* () {
      exitCode = yield* runReplCommand(parsed, runtime)
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
