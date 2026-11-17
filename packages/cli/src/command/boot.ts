/**
 * Boot the discovered DSH launcher as a child of the CLI process.
 * @module @eedsh/cli/command/boot
 */
import { Effect } from 'effect'
import type { DiscoveredDshInstallation } from '../dsh'
import { EXIT_FAILURE } from '../exit'
import { SpawnFailure } from '../internal/effect/errors'
import { defaultSpawn, type SpawnLike } from '../spawn'
import type { CommandContext } from './context'

export function spawnDsh(
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

export function runBoot(
  context: CommandContext,
  installation: DiscoveredDshInstallation,
  dshArgs: readonly string[],
): Effect.Effect<number, SpawnFailure> {
  return spawnDsh(context, installation.binPath, dshArgs)
}
