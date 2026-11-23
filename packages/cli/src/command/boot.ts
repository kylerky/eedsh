/**
 * Boot the discovered DSH launcher as a child of the CLI process.
 * @module @eedsh/cli/command/boot
 */
import { existsSync } from 'node:fs'
import { Effect } from 'effect'
import type { DiscoveredDshInstallation } from '../dsh'
import { EXIT_FAILURE } from '../exit'
import { SpawnFailure } from '../internal/effect/errors'
import { Environment, type EnvironmentShape, Spawner } from '../internal/effect/services'
import type { SpawnLike } from '../spawn'
import type { CommandContext } from './context'

/** The executable and arguments that start DSH. */
export interface LaunchCommand {
  readonly command: string
  readonly args: readonly string[]
}

/** The selected installation paths a launch decision needs. */
export interface LaunchTarget {
  /** The launcher discovery selected. */
  readonly launcher: string
  /** The installation's package bin entry. */
  readonly binPath: string
  /** Whether {@link launcher} exists. */
  readonly launcherExists: boolean
}

/** Platform facts for {@link resolveLaunch}; defaults come from the process. */
export interface LaunchOptions {
  /** Platform to build the command line for; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform
  /** Windows command interpreter; defaults to `ComSpec`, then `cmd.exe`. */
  readonly comSpec?: string | undefined
  /** Node.js executable for a bin-entry launch; defaults to `process.execPath`. */
  readonly execPath?: string
}

function quoteCommandShellArgument(argument: string): string {
  return `"${argument.replaceAll('"', '\\"')}"`
}

/**
 * Build the platform-specific invocation. A Windows batch wrapper runs through
 * the command interpreter with every argument quoted so paths with spaces
 * survive; every other command runs directly.
 */
function platformInvocation(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform,
  comSpec: string | undefined,
): LaunchCommand {
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
    const line = [command, ...args].map(quoteCommandShellArgument).join(' ')
    return { command: comSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', line] }
  }
  return { command, args: [...args] }
}

/**
 * Resolve how `run` starts DSH. A launcher distinct from the package bin entry
 * runs directly on POSIX and through the command interpreter on Windows; a
 * missing launcher or one that matches the bin entry starts the bin entry with
 * the Node.js executable running eedsh.
 * @param target - selected installation paths and wrapper availability.
 * @param args - DSH arguments, `--profile` first.
 * @param options - platform, command interpreter, and executable overrides.
 * @returns the executable and arguments to spawn.
 */
export function resolveLaunch(
  target: LaunchTarget,
  args: readonly string[],
  options: LaunchOptions = {},
): LaunchCommand {
  const platform = options.platform ?? process.platform
  const comSpec = options.comSpec ?? process.env.ComSpec
  const useWrapper =
    target.launcherExists &&
    target.launcher !== target.binPath &&
    (platform !== 'win32' || /\.(?:cmd|bat)$/i.test(target.launcher))
  const command = useWrapper ? target.launcher : (options.execPath ?? process.execPath)
  const launchArgs = useWrapper ? [...args] : [target.binPath, ...args]
  return platformInvocation(command, launchArgs, platform, comSpec)
}

export function spawnDsh(
  context: CommandContext,
  installation: DiscoveredDshInstallation,
  dshArgs: readonly string[],
): Effect.Effect<number, SpawnFailure, SpawnLike | EnvironmentShape> {
  return Effect.gen(function* () {
    const spawnFn = yield* Spawner
    const { env, cwd } = yield* Environment
    const launch = resolveLaunch(
      {
        launcher: installation.launcher,
        binPath: installation.binPath,
        launcherExists: existsSync(installation.launcher),
      },
      ['--profile', context.plan.profile.name, ...dshArgs],
    )
    return yield* Effect.tryPromise({
      try: () =>
        new Promise<number>((resolveExit, rejectExit) => {
          const child = spawnFn(launch.command, [...launch.args], {
            cwd,
            env,
            stdio: 'inherit',
          })
          child.on('exit', (code) => resolveExit(code ?? EXIT_FAILURE))
          child.on('error', rejectExit)
        }),
      catch: (cause) => new SpawnFailure({ cause }),
    })
  })
}

export function runBoot(
  context: CommandContext,
  installation: DiscoveredDshInstallation,
  dshArgs: readonly string[],
): Effect.Effect<number, SpawnFailure, SpawnLike | EnvironmentShape> {
  return spawnDsh(context, installation, dshArgs)
}
