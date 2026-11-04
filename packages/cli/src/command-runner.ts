/**
 * The narrow, injectable command runner used only by setup paths: optional
 * anchor validation and the pnpm/npm bootstrap. Discovery itself never calls
 * it for package metadata. Commands are fixed-argument, read-only, bounded, and
 * captured; Windows `.cmd`/`.bat` launchers go through `cmd.exe` so paths with
 * spaces still resolve.
 * @module @eedsh/cli/command-runner
 */
import { spawnSync } from 'node:child_process'

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

/** Runs one command with fixed arguments and no interactive input. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: CommandOptions,
) => CommandResult

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

/**
 * Run one command synchronously with a bound. The default runner is the only
 * production code that spawns for an anchor setup step.
 * @param command - the executable or launcher path.
 * @param args - fixed arguments.
 * @param options - timeout override.
 * @returns the captured result.
 */
export const defaultCommandRunner: CommandRunner = (command, args, options) => {
  const invocation = commandInvocation(command, args)
  const result = spawnSync(invocation.command, [...invocation.args], {
    encoding: 'utf8',
    timeout: options?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    windowsHide: true,
    shell: false,
    ...(options?.env === undefined ? {} : { env: options.env }),
  })
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  }
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
 * @returns the exact version, or undefined.
 */
export function probeLauncherVersion(
  runner: CommandRunner,
  launcher: string,
  timeoutMs: number = DEFAULT_VERSION_PROBE_TIMEOUT_MS,
  env?: Record<string, string | undefined>,
): string | undefined {
  const result = runner(launcher, ['--version'], {
    timeoutMs,
    ...(env === undefined ? {} : { env }),
  })
  if (result.status !== 0) return undefined
  return parseVersionOutput(result.stdout)
}

/**
 * Bind a launcher version probe to one runner.
 * @param runner - the command runner seam.
 * @returns a probe suitable for discovery.
 */
export function versionProbe(
  runner: CommandRunner,
  env?: Record<string, string | undefined>,
): (launcher: string) => string | undefined {
  return (launcher) => probeLauncherVersion(runner, launcher, undefined, env)
}
