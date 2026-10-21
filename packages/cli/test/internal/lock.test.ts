import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Effect } from 'effect'
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
  const result = await Effect.runPromise(Effect.either(effect))
  if (result._tag === 'Right') throw new Error('expected the effect to fail')
  return result.left
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
      Effect.either(
        withSyncLock('/profiles/work/.eedsh/sync.lock', Effect.fail(new Error('boom'))).pipe(
          Effect.provideService(SyncLock, lock),
        ),
      ),
    )
    expect(result._tag).toBe('Left')
    expect(events).toEqual(['release'])
  })
})

describe('sync lock platform selection', () => {
  it('selects the POSIX implementation on linux and darwin', async () => {
    const lockPath = await tempLockPath()
    for (const platform of ['linux', 'darwin'] as const) {
      const result = await Effect.runPromise(
        withSyncLock(lockPath, Effect.succeed(platform)).pipe(
          Effect.provide(syncLockLayer(platform)),
        ),
      )
      expect(result).toBe(platform)
    }
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
    expect(error._tag).toBe('FileSystemFailure')
    expect(error.operation).toBe('syncLock')
    expect(error.path).toBe('/profiles/work/.eedsh/sync.lock')
    expect(ran).toBe(false)
  })
})

describe('POSIX sync lock', () => {
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

  it('ignores arbitrary existing content and never rewrites the file', async () => {
    const lockPath = await tempLockPath()
    await mkdir(dirname(lockPath), { recursive: true })
    const stale = JSON.stringify({ pid: 4242, startedAt: 'yesterday' })
    await writeFile(lockPath, stale)

    const lock = makePosixSyncLock()
    const handle = await acquire(lock, lockPath)
    expect(await readFile(lockPath, 'utf8')).toBe(stale)
    await release(handle)
    expect(await readFile(lockPath, 'utf8')).toBe(stale)

    const again = await acquire(lock, lockPath)
    await release(again)
    expect(await readFile(lockPath, 'utf8')).toBe(stale)
  })

  for (const [name, content] of [
    ['a dead PID', JSON.stringify({ pid: 999_999 })],
    ['malformed JSON', 'not-json'],
    ['a non-numeric PID', JSON.stringify({ pid: '4242' })],
  ] as const) {
    it(`acquires over a lock file containing ${name}`, async () => {
      const lockPath = await tempLockPath()
      await mkdir(dirname(lockPath), { recursive: true })
      await writeFile(lockPath, content)
      const handle = await acquire(makePosixSyncLock(), lockPath)
      await release(handle)
      expect(existsSync(lockPath)).toBe(true)
      expect(await readFile(lockPath, 'utf8')).toBe(content)
    })
  }

  it('keeps the lock file after a successful and a failed scoped run', async () => {
    const lockPath = await tempLockPath()
    const layer = syncLockLayer('linux')
    await Effect.runPromise(
      withSyncLock(lockPath, Effect.succeed('ok')).pipe(Effect.provide(layer)),
    )
    expect(existsSync(lockPath)).toBe(true)

    const failed = await Effect.runPromise(
      Effect.either(
        withSyncLock(lockPath, Effect.fail(new Error('boom'))).pipe(Effect.provide(layer)),
      ),
    )
    expect(failed._tag).toBe('Left')
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
    expect(error._tag).toBe('FileSystemFailure')
    expect(error.operation).toBe('verifyLock')
    expect(error.path).toBe('/p/.eedsh/sync.lock')
    expect(opens).toBe(3)
    expect(closes).toBe(3)
  })
})
