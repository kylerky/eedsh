/**
 * POSIX (Linux/macOS) kernel sync lock: a persistent advisory flock on the
 * profile's `.eedsh/sync.lock` file. The locked descriptor, not the path,
 * carries the lock; release closes it and never unlinks the file. Acquisition
 * verifies the descriptor still names the file at the lock path, because a lock
 * on a replaced (orphaned) file proves nothing.
 * @module @eedsh/cli/internal/lock-posix
 */
import { mkdir, open, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import { Effect } from 'effect'
import * as Either from 'effect/Either'
import { FileSystemFailure, SyncLocked } from './effect/errors'
import type { SyncLockHandle, SyncLockShape } from './effect/services'

/** How many times acquisition re-opens a lock file that was replaced. */
export const POSIX_LOCK_ATTEMPTS = 3

/** The descriptor operations POSIX acquisition needs. */
export interface PosixLockHandle {
  readonly fd: number
  stat(options: { bigint: true }): Promise<{ dev: bigint; ino: bigint }>
  close(): Promise<void>
}

/** The file operations POSIX acquisition needs; injectable for tests. */
export interface PosixLockIo {
  ensureDir(path: string): Promise<void>
  open(path: string): Promise<PosixLockHandle>
  statPath(path: string): Promise<{ dev: bigint; ino: bigint } | undefined>
  tryLock(fd: number): Promise<void>
}

/** Node-backed POSIX lock operations. */
export const nodePosixLockIo: PosixLockIo = {
  ensureDir: async (path) => {
    await mkdir(path, { recursive: true })
  },
  open: (path) => open(path, 'a'),
  statPath: (path) =>
    stat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    }),
  tryLock: (fd) => tryLockExclusive(fd),
}

function operation<A>(
  name: string,
  path: string,
  run: () => Promise<A>,
): Effect.Effect<A, FileSystemFailure> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new FileSystemFailure({ operation: name, path, cause }),
  })
}

/** Whether a flock failure means another descriptor currently holds the lock. */
function isLockContention(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code
  return code === 'EAGAIN' || code === 'EWOULDBLOCK'
}

function acquireAttempt(
  io: PosixLockIo,
  lockPath: string,
): Effect.Effect<SyncLockHandle | undefined, SyncLocked | FileSystemFailure> {
  return Effect.gen(function* () {
    const handle = yield* operation('openLock', lockPath, () => io.open(lockPath))
    const close: Effect.Effect<void> = Effect.promise(async () => {
      await handle.close().catch(() => undefined)
    })

    const locked = yield* Effect.either(operation('flock', lockPath, () => io.tryLock(handle.fd)))
    if (Either.isLeft(locked)) {
      yield* close
      if (isLockContention(locked.left.cause)) {
        return yield* Effect.fail(new SyncLocked({ lockPath }))
      }
      return yield* Effect.fail(locked.left)
    }

    const verified = yield* Effect.either(
      Effect.gen(function* () {
        const held = yield* operation('verifyLock', lockPath, () => handle.stat({ bigint: true }))
        const current = yield* operation('verifyLock', lockPath, () => io.statPath(lockPath))
        return current !== undefined && current.dev === held.dev && current.ino === held.ino
      }),
    )
    if (Either.isLeft(verified)) {
      yield* close
      return yield* Effect.fail(verified.left)
    }
    if (!verified.right) {
      yield* close
      return undefined
    }
    return { release: close }
  })
}

/**
 * Build a POSIX flock-backed sync lock.
 * @param io - file operations, injectable for tests.
 * @param attempts - lock-file open attempts before verification fails.
 * @returns the lock service.
 */
export function makePosixSyncLock(
  io: PosixLockIo = nodePosixLockIo,
  attempts: number = POSIX_LOCK_ATTEMPTS,
): SyncLockShape {
  return {
    acquire: (lockPath) =>
      Effect.gen(function* () {
        const directory = dirname(lockPath)
        yield* operation('ensureLockDir', directory, () => io.ensureDir(directory))
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          const handle = yield* acquireAttempt(io, lockPath)
          if (handle !== undefined) return handle
        }
        return yield* Effect.fail(
          new FileSystemFailure({
            operation: 'verifyLock',
            path: lockPath,
            cause: new Error('the lock file was replaced during acquisition'),
          }),
        )
      }),
  }
}

/** The live POSIX sync lock. */
export const posixSyncLock: SyncLockShape = makePosixSyncLock()
