/**
 * The `eedsh` command's composition root: split passthrough arguments, assemble
 * the `effect/cli` surface from the command adapters, and run one invocation as
 * one Effect program whose value is the process exit code. Command behavior
 * lives in `./command/adapters`; the capabilities they use arrive as services.
 * @module @eedsh/cli/cli
 */
import { Effect, Ref } from 'effect'
import * as Console from 'effect/Console'
import { CliError, Command } from 'effect/cli'
import { checkOptions, runCheckCommand } from './command/adapters/check'
import { doctorOptions, runDoctorCommand } from './command/adapters/doctor'
import { initOptions, runInitCommand } from './command/adapters/init'
import { replOptions, runReplCommand } from './command/adapters/repl'
import { runOptions, runRunCommand } from './command/adapters/run'
import { runSyncCommand, syncOptions } from './command/adapters/sync'
import { cliConsole, report } from './command/report'
import { cliVersion } from './command/version'
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from './exit'
import { type CliServices, Output } from './internal/effect/services'

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
 * Run the CLI with an explicit argument vector as one program. Every command
 * reports its own typed failure and returns its exit code; the program's value
 * is that exit code. The caller provides the service layer and observes the one
 * `Exit`.
 * @param argv - arguments after the executable and script.
 * @returns the process exit code.
 */
export function main(argv: readonly string[]): Effect.Effect<number, never, CliServices> {
  return Effect.gen(function* () {
    const output = yield* Output
    const split = splitPassthrough(argv)
    if ('error' in split) {
      output.stderr(`eedsh: ${split.error}`)
      return EXIT_USAGE
    }

    const exitCode = yield* Ref.make<number>(EXIT_OK)
    const record = <E, R>(program: Effect.Effect<number, E, R>) =>
      program.pipe(Effect.flatMap((code) => Ref.set(exitCode, code)))

    const initCommandLine = Command.make('init', initOptions, (parsed) =>
      record(runInitCommand(parsed)),
    ).pipe(
      Command.withDescription(
        'create the XDG config project and install its dependencies (needs no DSH installation)',
      ),
    )

    const syncCommand = Command.make('sync', syncOptions, (parsed) =>
      record(runSyncCommand(parsed)),
    ).pipe(
      Command.withDescription(
        'evaluate the config, preflight the layers, and publish (requires a discovered dsh)',
      ),
    )

    const runCommandLine = Command.make('run', runOptions, (parsed) =>
      record(runRunCommand({ ...parsed, dshArgs: split.passthrough })),
    ).pipe(Command.withDescription('sync (unless --no-sync) and boot the discovered dsh'))

    const checkCommandLine = Command.make('check', checkOptions, (parsed) =>
      record(runCheckCommand({ ...parsed, tscArgs: split.passthrough })),
    ).pipe(Command.withDescription("typecheck the config's project with its own tsc"))

    const doctorCommandLine = Command.make('doctor', doctorOptions, (parsed) =>
      record(runDoctorCommand(parsed)),
    ).pipe(
      Command.withDescription(
        'inspect a published profile without changing it; reports discovered DSH version and drift',
      ),
    )

    const replCommandLine = Command.make('repl', replOptions, (parsed) =>
      record(runReplCommand(parsed)),
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
    const program = Command.runWith(rootCommand, { version: cliVersion() })(parsedArgs).pipe(
      Effect.provideService(Console.Console, cliConsole(output.stdout, output.stderr)),
    )
    yield* program.pipe(
      Effect.catch((error) => {
        if (CliError.isCliError(error)) return Ref.set(exitCode, EXIT_USAGE)
        report(output.stderr, error)
        return Ref.set(exitCode, EXIT_FAILURE)
      }),
    )
    return yield* Ref.get(exitCode)
  })
}
