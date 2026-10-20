/**
 * The profile-local sync lock: one materialization at a time per profile, with
 * stale-lock recovery limited to a PID liveness check. The lock is acquired
 * with an exclusive create and released by the surrounding scope, so a failed
 * run never leaves the profile locked.
 * @module @eedsh/cli/internal/lock
 */
import { dirname } from 'node:path'
import { Effect } from 'effect'
import { type FileSystemFailure, SyncLocked } from './effect/errors.js'
import { FileSystem, type FileSystemShape } from './effect/services.js'

const LOCK_POLL_ATTEMPTS = 1

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function parsePid(content: string): number | undefined {
  try {
    const value = JSON.parse(content) as { pid?: unknown }
    return typeof value.pid === 'number' && Number.isInteger(value.pid) ? value.pid : undefined
  } catch {
    return undefined
  }
}

function lockContent(): string {
  return `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`
}

/** Options for {@link withSyncLock}. */
export interface SyncLockOptions {
  lockPath: string
  isPidAlive?: (pid: number) => boolean
}

function acquire(
  options: SyncLockOptions,
): Effect.Effect<void, SyncLocked | FileSystemFailure, FileSystemShape> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem
    const alive = options.isPidAlive ?? defaultIsPidAlive
    yield* fs.ensureDir(dirname(options.lockPath))
    if (yield* fs.writeFileExclusive(options.lockPath, lockContent())) return
    const existing = yield* fs
      .readFile(options.lockPath)
      .pipe(Effect.catchAll(() => Effect.succeed('')))
    const pid = parsePid(existing)
    if (pid !== undefined && alive(pid)) {
      return yield* Effect.fail(new SyncLocked({ lockPath: options.lockPath, pid }))
    }
    for (let attempt = 0; attempt < LOCK_POLL_ATTEMPTS; attempt += 1) {
      yield* fs.remove(options.lockPath)
      if (yield* fs.writeFileExclusive(options.lockPath, lockContent())) return
    }
    return yield* Effect.fail(new SyncLocked({ lockPath: options.lockPath, pid }))
  })
}

function release(lockPath: string): Effect.Effect<void, never, FileSystemShape> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem
    yield* fs.remove(lockPath).pipe(Effect.catchAll(() => Effect.void))
  })
}

/**
 * Run an effect while holding the profile sync lock.
 * @param options - lock path and PID liveness probe.
 * @param effect - the work to run under the lock.
 * @returns the effect's result; the lock is released on success or failure.
 */
export function withSyncLock<A, E, R>(
  options: SyncLockOptions,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SyncLocked | FileSystemFailure, R | FileSystemShape> {
  return Effect.scoped(
    Effect.acquireRelease(acquire(options), () => release(options.lockPath)).pipe(
      Effect.flatMap(() => effect),
    ),
  )
}
