/**
 * The spawn seam shared by `eedsh run` and `eedsh check`: the narrow child
 * process shape the CLI observes and the default `node:child_process` adapter.
 * @module @eedsh/cli/spawn
 */
import { spawn } from 'node:child_process'

/** A readable child stream, as the CLI observes it. */
export interface ReadableLike {
  on(event: 'data', listener: (chunk: unknown) => void): unknown
}

/** One spawned child process, as the CLI observes it. */
export interface SpawnedProcessLike {
  on(event: 'exit', callback: (code: number | null, signal: string | null) => void): unknown
  on(event: 'close', callback: (code: number | null, signal: string | null) => void): unknown
  on(event: 'error', callback: (error: Error) => void): unknown
  stdout?: ReadableLike | null
  stderr?: ReadableLike | null
  kill(signal?: NodeJS.Signals): boolean
}

/** Spawn options the CLI uses. */
export interface SpawnOptionsLike {
  cwd?: string | undefined
  env?: Record<string, string | undefined>
  stdio: 'inherit' | 'pipe'
}

/** Spawn seam for `eedsh run` and `eedsh check`. */
export type SpawnLike = (
  command: string,
  args: string[],
  options: SpawnOptionsLike,
) => SpawnedProcessLike

/** Spawn a child process with `node:child_process`. */
export const defaultSpawn: SpawnLike = (command, args, options) =>
  spawn(command, args, options as Parameters<typeof spawn>[2])
