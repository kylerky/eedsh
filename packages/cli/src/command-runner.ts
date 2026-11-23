/**
 * The narrow, injectable command runner used only by setup paths: optional
 * anchor validation and the pnpm/npm bootstrap. Discovery itself never calls
 * it for package metadata. Commands are fixed-argument, read-only, bounded, and
 * captured; Windows `.cmd`/`.bat` launchers go through `cmd.exe` so paths with
 * spaces still resolve. Every run goes through the child-process spawner, so
 * the runner is one Effect service and a test replaces the spawner instead of
 * the runner.
 * @module @eedsh/cli/command-runner
 */
import { Effect, Stream } from 'effect'
import * as Duration from 'effect/Duration'
import { ChildProcess, type ChildProcessSpawner } from 'effect/process'
import type { CommandRunnerShape } from './internal/effect/services'
import { messageOf } from './internal/error-message'

/** Captured result of one fixed-argument command. */
export interface CommandResult {
  /** Exit status, or null when the command could not start or timed out. */
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Options for one fixed-argument command. */
export interface CommandOptions {
  /** Bound in milliseconds. */
  readonly timeoutMs?: number | undefined
  /** Environment to run under; defaults to the process environment. */
  readonly env?: Record<string, string | undefined> | undefined
}

/** The default bound for setup commands. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 5000

/** The bound for the lightweight `dsh --version` cache guard. */
export const DEFAULT_VERSION_PROBE_TIMEOUT_MS = 2000

/** The executable and arguments a platform needs to run one command. */
export interface CommandInvocation {
  readonly command: string
  readonly args: readonly string[]
}

function quoteWindowsArgument(argument: string): string {
  return `"${argument.replaceAll('"', '\\"')}"`
}

/**
 * Build the platform-specific invocation for a command. On Windows a batch
 * launcher runs through `cmd.exe /d /s /c`; every argument is quoted so paths
 * with spaces survive. Other commands run directly with no shell.
 * @param command - the executable or launcher path.
 * @param args - fixed arguments.
 * @param platform - platform override for tests.
 * @returns the invocation.
 */
export function commandInvocation(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): CommandInvocation {
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
    const line = [command, ...args].map(quoteWindowsArgument).join(' ')
    return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', line] }
  }
  return { command, args: [...args] }
}

/**
 * Build the invocation that runs the `pnpm` package manager. Node cannot spawn
 * the Windows `pnpm.cmd` shim directly, so Windows runs it through `cmd.exe`;
 * other platforms execute the binary on `PATH`.
 * @param args - the pnpm arguments.
 * @param platform - platform override for tests.
 * @returns the platform-specific invocation.
 */
export function pnpmInvocation(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): CommandInvocation {
  if (platform === 'win32') {
    // cmd.exe matches an unquoted command through PATHEXT and joins these
    // words into the `/c` command line, quoting any argument that needs it.
    return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', 'pnpm', ...args] }
  }
  return { command: 'pnpm', args: [...args] }
}

/** The message a timed-out command reports in place of its empty output. */
function timeoutMessage(timeoutMs: number): string {
  return `command timed out after ${timeoutMs}ms`
}

/**
 * Run one command through the child-process spawner with a bound. The child is
 * scoped, so interruption and timeout close the scope and kill it. A failed
 * spawn, non-start, or timeout yields a null status with the failure message in
 * stderr, matching the captured shape the synchronous runner produced.
 * @param command - the executable or launcher path.
 * @param args - fixed arguments.
 * @param options - bound and environment override.
 * @returns the captured result.
 */
export function boundedCommandRunner(
  command: string,
  args: readonly string[],
  options?: CommandOptions,
): Effect.Effect<CommandResult, never, ChildProcessSpawner.ChildProcessSpawner> {
  const invocation = commandInvocation(command, args)
  const timeoutMs = options?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  return Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make(invocation.command, [...invocation.args], {
        ...(options?.env === undefined ? {} : { env: options.env }),
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
        shell: false,
      })
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
  ).pipe(
    Effect.timeout(Duration.millis(timeoutMs)),
    Effect.catch((cause) =>
      Effect.succeed({
        status: null,
        stdout: '',
        stderr: cause._tag === 'TimeoutError' ? timeoutMessage(timeoutMs) : messageOf(cause),
      }),
    ),
  )
}

/**
 * Extract one version token from launcher or metadata output.
 * @param output - command stdout.
 * @returns the first semver-shaped token, or undefined.
 */
export function parseVersionOutput(output: string): string | undefined {
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(output)
  return match?.[1]
}

/**
 * Probe a launcher's version once, with a bound. A failed start, timeout,
 * non-zero exit, or missing version token yields undefined.
 * @param runner - the command runner seam.
 * @param launcher - absolute launcher path.
 * @param timeoutMs - probe bound.
 * @param env - environment override for the probe.
 * @returns the exact version, or undefined.
 */
export function probeLauncherVersion(
  runner: CommandRunnerShape,
  launcher: string,
  timeoutMs: number = DEFAULT_VERSION_PROBE_TIMEOUT_MS,
  env?: Record<string, string | undefined>,
): Effect.Effect<string | undefined> {
  return runner(launcher, ['--version'], {
    timeoutMs,
    ...(env === undefined ? {} : { env }),
  }).pipe(
    Effect.map((result) => (result.status === 0 ? parseVersionOutput(result.stdout) : undefined)),
  )
}

/**
 * Bind a launcher version probe to one runner.
 * @param runner - the command runner seam.
 * @param env - environment override for the probe.
 * @returns a probe suitable for discovery.
 */
export function versionProbe(
  runner: CommandRunnerShape,
  env?: Record<string, string | undefined>,
): (launcher: string) => Effect.Effect<string | undefined> {
  return (launcher) => probeLauncherVersion(runner, launcher, undefined, env)
}
