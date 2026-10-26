import { Effect } from 'effect'
import type { SyncLockHandle, SyncLockShape } from '../../src/internal/effect/services'

/**
 * Acquire a sync lock through its Effect interface.
 * @param lock - the lock service shape.
 * @param path - absolute lock path.
 * @returns the acquired lock handle.
 */
export function acquire(lock: SyncLockShape, path: string): Promise<SyncLockHandle> {
  return Effect.runPromise(lock.acquire(path))
}

/**
 * Release a sync lock handle.
 * @param handle - the acquired lock handle.
 */
export function release(handle: SyncLockHandle): Promise<void> {
  return Effect.runPromise(handle.release)
}
