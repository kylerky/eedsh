import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Deferred, Effect, Exit, Fiber } from 'effect'
import * as PlatformError from 'effect/PlatformError'
import * as Result from 'effect/Result'
import { afterEach, describe, expect, it } from 'vitest'
import { SyncLocked } from '../../src/internal/effect/errors'
import { syncLockLayer } from '../../src/internal/effect/layer'
import {
  SyncLock,
  type SyncLockHandle,
  type SyncLockShape,
} from '../../src/internal/effect/services'
import { withSyncLock } from '../../src/internal/lock'
import { makePosixSyncLock, type PosixLockIo } from '../../src/internal/lock-posix'
import { fakeSyncLock } from '../support/fakes'

const tempRoot = join(process.cwd(), '.tmp')
const dirs: string[] = []

async function tempLockPath(): Promise<string> {
  await mkdir(tempRoot, { recursive: true })
  const dir = await mkdtemp(join(tempRoot, 'lock-'))
  dirs.push(dir)
  return join(dir, '.eedsh', 'sync.lock')
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function failureOf(effect: Effect.Effect<unknown, unknown>): Promise<any> {
  const result = await Effect.runPromise(Effect.result(effect))
  if (Result.isSuccess(result)) throw new Error('expected the effect to fail')
  return result.failure
}

function acquire(lock: SyncLockShape, lockPath: string): Promise<SyncLockHandle> {
  return Effect.runPromise(lock.acquire(lockPath))
}

function release(handle: SyncLockHandle): Promise<void> {
  return Effect.runPromise(handle.release)
}

function statOf(ino: bigint) {
  return { dev: 1n, ino }
}

describe('withSyncLock service boundary', () => {
  it('runs the scoped effect between acquisition and release', async () => {
    const events: string[] = []
    const lockPath = '/profiles/work/.eedsh/sync.lock'
    const lock: SyncLockShape = {
      acquire: (path) =>
        Effect.sync(() => {
          events.push(`acquire ${path}`)
          return {
            release: Effect.sync(() => {
              events.push(`release ${path}`)
            }),
          }
        }),
    }
    const result = await Effect.runPromise(
      withSyncLock(
        lockPath,
        Effect.sync(() => {
          events.push('materialize')
          return 42
        }),
      ).pipe(Effect.provideService(SyncLock, lock)),
    )
    expect(result).toBe(42)
    expect(events).toEqual([`acquire ${lockPath}`, 'materialize', `release ${lockPath}`])
  })

  it('releases the lock when the scoped effect fails', async () => {
    const events: string[] = []
    const lock: SyncLockShape = {
      acquire: () =>
        Effect.succeed({
          release: Effect.sync(() => {
            events.push('release')
          }),
        }),
    }
    const result = await Effect.runPromise(
      Effect.result(
        withSyncLock('/profiles/work/.eedsh/sync.lock', Effect.fail(new Error('boom'))).pipe(
          Effect.provideService(SyncLock, lock),
        ),
      ),
    )
    expect(result._tag).toBe('Failure')
    expect(events).toEqual(['release'])
  })

  it('releases the lock exactly once when the scoped effect dies', async () => {
    const releases: string[] = []
    const lock: SyncLockShape = {
      acquire: () =>
        Effect.succeed({
          release: Effect.sync(() => {
            releases.push('release')
          }),
        }),
    }
    const exit = await Effect.runPromiseExit(
      withSyncLock('/profiles/work/.eedsh/sync.lock', Effect.die(new Error('boom'))).pipe(
        Effect.provideService(SyncLock, lock),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(releases).toEqual(['release'])
  })

  it('releases the lock exactly once when the scoped effect is interrupted', async () => {
    const releases: string[] = []
    const lock: SyncLockShape = {
      acquire: () =>
        Effect.succeed({
          release: Effect.sync(() => {
            releases.push('release')
          }),
        }),
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const fiber = yield* Effect.forkChild(
          withSyncLock(
            '/profiles/work/.eedsh/sync.lock',
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          ).pipe(Effect.provideService(SyncLock, lock)),
        )
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
      }),
    )
    expect(releases).toEqual(['release'])
  })
})

describe('sync lock platform selection', () => {
  it('selects the POSIX implementation on linux and darwin', async () => {
    const lock = fakeSyncLock()
    for (const platform of ['linux', 'darwin'] as const) {
      const result = await Effect.runPromise(
        withSyncLock('/profiles/work/.eedsh/sync.lock', Effect.succeed(platform)).pipe(
          Effect.provide(syncLockLayer(platform, { posix: lock.shape })),
        ),
      )
      expect(result).toBe(platform)
    }
    expect(lock.acquires).toEqual([
      '/profiles/work/.eedsh/sync.lock',
      '/profiles/work/.eedsh/sync.lock',
    ])
  })

  it('fails closed on an unsupported platform before running the effect', async () => {
    let ran = false
    const error = await failureOf(
      withSyncLock(
        '/profiles/work/.eedsh/sync.lock',
        Effect.sync(() => {
          ran = true
        }),
      ).pipe(Effect.provide(syncLockLayer('aix'))),
    )
    expect(PlatformError.isPlatformError(error)).toBe(true)
    expect(error.reason.method).toBe('syncLock')
    expect(error.reason.pathOrDescriptor).toBe('/profiles/work/.eedsh/sync.lock')
    expect(ran).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('POSIX sync lock', () => {
  it('creates the lock file and rejects a second acquisition', async () => {
    const lockPath = await tempLockPath()
    const lock = makePosixSyncLock()
    const first = await acquire(lock, lockPath)
    expect(existsSync(lockPath)).toBe(true)

    const error = await failureOf(lock.acquire(lockPath))
    expect(error).toBeInstanceOf(SyncLocked)
    expect(error.lockPath).toBe(lockPath)

    await release(first)
    expect(existsSync(lockPath)).toBe(true)

    const second = await acquire(lock, lockPath)
    await release(second)
    expect(existsSync(lockPath)).toBe(true)
  })

  it('keeps the lock file after a successful and a failed scoped run', async () => {
    const lockPath = await tempLockPath()
    const layer = syncLockLayer('linux')
    await Effect.runPromise(
      withSyncLock(lockPath, Effect.succeed('ok')).pipe(Effect.provide(layer)),
    )
    expect(existsSync(lockPath)).toBe(true)

    const failed = await Effect.runPromise(
      Effect.result(
        withSyncLock(lockPath, Effect.fail(new Error('boom'))).pipe(Effect.provide(layer)),
      ),
    )
    expect(failed._tag).toBe('Failure')
    expect(existsSync(lockPath)).toBe(true)

    const handle = await acquire(makePosixSyncLock(), lockPath)
    await release(handle)
  })

  it('lets different lock paths proceed independently', async () => {
    const firstPath = await tempLockPath()
    const secondPath = await tempLockPath()
    const lock = makePosixSyncLock()
    const first = await acquire(lock, firstPath)
    const second = await acquire(lock, secondPath)
    await release(first)
    await release(second)
  })

  it('maps EAGAIN to the lock diagnostic and closes its descriptor', async () => {
    let closes = 0
    const io: PosixLockIo = {
      ensureDir: async () => undefined,
      open: async () => ({
        fd: 7,
        close: async () => {
          closes += 1
        },
        stat: async () => statOf(1n),
      }),
      statPath: async () => statOf(1n),
      tryLock: async () => {
        throw Object.assign(new Error('EAGAIN: flock failed'), { code: 'EAGAIN' })
      },
    }
    const error = await failureOf(makePosixSyncLock(io).acquire('/p/.eedsh/sync.lock'))
    expect(error).toBeInstanceOf(SyncLocked)
    expect(error.lockPath).toBe('/p/.eedsh/sync.lock')
    expect(closes).toBe(1)
  })

  it('treats an ENOENT stat as an unverified attempt and closes the descriptor', async () => {
    let closes = 0
    const io: PosixLockIo = {
      ensureDir: async () => undefined,
      open: async () => ({
        fd: 1,
        close: async () => {
          closes += 1
        },
        stat: async () => statOf(1n),
      }),
      statPath: async () => {
        throw Object.assign(new Error('ENOENT: missing lock path'), { code: 'ENOENT' })
      },
      tryLock: async () => undefined,
    }
    const error = await failureOf(makePosixSyncLock(io, 1).acquire('/p/.eedsh/sync.lock'))
    expect(PlatformError.isPlatformError(error)).toBe(true)
    expect(error.reason.method).toBe('verifyLock')
    expect(closes).toBe(1)
  })

  it('ignores a close failure while reporting contention', async () => {
    const io: PosixLockIo = {
      ensureDir: async () => undefined,
      open: async () => ({
        fd: 1,
        close: async () => {
          throw new Error('close failed')
        },
        stat: async () => statOf(1n),
      }),
      statPath: async () => statOf(1n),
      tryLock: async () => {
        throw Object.assign(new Error('EAGAIN: flock failed'), { code: 'EAGAIN' })
      },
    }
    const error = await failureOf(makePosixSyncLock(io).acquire('/p/.eedsh/sync.lock'))
    expect(error).toBeInstanceOf(SyncLocked)
  })

  it('retries when the locked inode no longer matches the path', async () => {
    const held = statOf(1n)
    const observations = [statOf(2n), held]
    const handles: { closed: number }[] = []
    let opens = 0
    const io: PosixLockIo = {
      ensureDir: async () => undefined,
      open: async () => {
        opens += 1
        const record = { closed: 0 }
        handles.push(record)
        return {
          fd: opens,
          close: async () => {
            record.closed += 1
          },
          stat: async () => held,
        }
      },
      statPath: async () => observations.shift(),
      tryLock: async () => undefined,
    }
    const handle = await acquire(makePosixSyncLock(io), '/p/.eedsh/sync.lock')
    expect(opens).toBe(2)
    expect(handles.map((record) => record.closed)).toEqual([1, 0])
    await release(handle)
    expect(handles.map((record) => record.closed)).toEqual([1, 1])
  })

  it('fails verification after three replaced attempts and closes every descriptor', async () => {
    let opens = 0
    let closes = 0
    const io: PosixLockIo = {
      ensureDir: async () => undefined,
      open: async () => {
        opens += 1
        return {
          fd: opens,
          close: async () => {
            closes += 1
          },
          stat: async () => statOf(1n),
        }
      },
      statPath: async () => statOf(2n),
      tryLock: async () => undefined,
    }
    const error = await failureOf(makePosixSyncLock(io).acquire('/p/.eedsh/sync.lock'))
    expect(PlatformError.isPlatformError(error)).toBe(true)
    expect(error.reason.method).toBe('verifyLock')
    expect(error.reason.pathOrDescriptor).toBe('/p/.eedsh/sync.lock')
    expect(opens).toBe(3)
    expect(closes).toBe(3)
  })
})
