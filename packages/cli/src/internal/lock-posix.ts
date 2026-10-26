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
import * as PlatformError from 'effect/PlatformError'
import * as Result from 'effect/Result'
import { SyncLocked } from './effect/errors'
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
  statPath: (path) => stat(path, { bigint: true }),
  tryLock: (fd) => tryLockExclusive(fd),
}

function platformError(name: string, path: string, cause: unknown): PlatformError.PlatformError {
  return PlatformError.systemError({
    _tag: 'Unknown',
    module: 'SyncLock',
    method: name,
    pathOrDescriptor: path,
    cause,
  })
}

function operation<A>(
  name: string,
  path: string,
  run: () => Promise<A>,
): Effect.Effect<A, PlatformError.PlatformError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => platformError(name, path, cause),
  })
}

/** Whether a flock failure means another descriptor currently holds the lock. */
function isLockContention(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code
  return code === 'EAGAIN' || code === 'EWOULDBLOCK'
}

function isMissingLockFile(error: PlatformError.PlatformError): boolean {
  const cause = error.reason.cause as NodeJS.ErrnoException | undefined
  return cause?.code === 'ENOENT'
}

function acquireAttempt(
  io: PosixLockIo,
  lockPath: string,
): Effect.Effect<SyncLockHandle | undefined, SyncLocked | PlatformError.PlatformError> {
  return Effect.gen(function* () {
    const handle = yield* operation('openLock', lockPath, () => io.open(lockPath))
    const close: Effect.Effect<void> = Effect.tryPromise({
      try: () => handle.close(),
      catch: (cause) => platformError('closeLock', lockPath, cause),
    }).pipe(Effect.ignore)

    const locked = yield* Effect.result(operation('flock', lockPath, () => io.tryLock(handle.fd)))
    if (Result.isFailure(locked)) {
      yield* close
      if (isLockContention(locked.failure.reason.cause)) {
        return yield* Effect.fail(new SyncLocked({ lockPath }))
      }
      return yield* Effect.fail(locked.failure)
    }

    const verified = yield* Effect.result(
      Effect.gen(function* () {
        const held = yield* operation('verifyLock', lockPath, () => handle.stat({ bigint: true }))
        const current = yield* operation('verifyLock', lockPath, () => io.statPath(lockPath)).pipe(
          Effect.catch((error) =>
            isMissingLockFile(error) ? Effect.succeed(undefined) : Effect.fail(error),
          ),
        )
        return current !== undefined && current.dev === held.dev && current.ino === held.ino
      }),
    )
    if (Result.isFailure(verified)) {
      yield* close
      return yield* Effect.fail(verified.failure)
    }
    if (!verified.success) {
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
          platformError(
            'verifyLock',
            lockPath,
            new Error('the lock file was replaced during acquisition'),
          ),
        )
      }),
  }
}

/** The live POSIX sync lock. */
export const posixSyncLock: SyncLockShape = makePosixSyncLock()