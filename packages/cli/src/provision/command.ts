/**
 * The child-process seam for provisioning. Git and preparation commands run as
 * fixed argv with no shell and are captured; the default implementation uses
 * the core child-process service, and tests inject a recording fake.
 * @module @eedsh/cli/provision/command
 */
import { Effect, Stream } from 'effect'
import { ChildProcess, type ChildProcessSpawner } from 'effect/process'
import { ProvisionFailure } from '../internal/effect/errors'
import { messageOf } from '../internal/error-message'

/** One captured command result. */
export interface CommandResult {
  /** The exit status. */
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

/** Options for one provisioning command. */
export interface CommandOptions {
  /** The directory the command runs in. */
  readonly cwd: string
}

/** Run one fixed-argument command for provisioning. */
export type ProvisionCommand = (
  command: string,
  args: readonly string[],
  options: CommandOptions,
) => Effect.Effect<CommandResult, ProvisionFailure, ChildProcessSpawner.ChildProcessSpawner>

/** The default runner: the core child-process service with no shell. */
export const childProcessCommand: ProvisionCommand = (command, args, options) => {
  const argv = [command, ...args]
  const run = Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make(command, [...args], { cwd: options.cwd })
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
          handle.exitCode,
        ],
        { concurrency: 'unbounded' },
      )
      return { status: Number(exitCode), stdout, stderr }
    }),
  )
  return run.pipe(
    Effect.mapError((cause) =>
      cause instanceof ProvisionFailure
        ? cause
        : new ProvisionFailure({
            code: 'provision.command_failed',
            packageName: '',
            message: `cannot run ${argv.join(' ')} in ${options.cwd}: ${messageOf(cause)}`,
            command: argv,
            path: options.cwd,
            cause,
          }),
    ),
  )
}
