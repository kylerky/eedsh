/**
 * The profile-local sync lock: one materialization at a time per profile. The
 * lock itself is kernel-owned and provided by the {@link SyncLock} service;
 * this module only scopes it around the materialization effect, so a failed run
 * never leaves the profile locked.
 * @module @eedsh/cli/internal/lock
 */
import { Effect } from 'effect'
import type { FileSystemFailure, SyncLocked } from './effect/errors'
import { SyncLock, type SyncLockShape } from './effect/services'

/**
 * Run an effect while holding the profile sync lock.
 * @param lockPath - the canonical lock path for the profile.
 * @param effect - the work to run under the lock.
 * @returns the effect's result; the lock is released on success or failure.
 */
export function withSyncLock<A, E, R>(
  lockPath: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SyncLocked | FileSystemFailure, R | SyncLockShape> {
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const lock = yield* SyncLock
      return yield* lock.acquire(lockPath)
    }),
    () => effect,
    (handle) => handle.release,
  )
}
