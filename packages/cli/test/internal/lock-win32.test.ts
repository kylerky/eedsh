import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Effect } from 'effect'
import * as PlatformError from 'effect/PlatformError'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import { SyncLocked } from '../../src/internal/effect/errors'
import { syncLockLayer } from '../../src/internal/effect/layer'
import type { SyncLockHandle, SyncLockShape } from '../../src/internal/effect/services'
import { withSyncLock } from '../../src/internal/lock'
import {
  makeWin32SyncLock,
  WAIT_OBJECT_0,
  WAIT_TIMEOUT,
  type Win32Binding,
  win32LockName,
} from '../../src/internal/lock-win32'
import { fakeSyncLock } from '../support/fakes'

const lockPath = '/profiles/work/.eedsh/sync.lock'

function acquire(lock: SyncLockShape, path: string): Promise<SyncLockHandle> {
  return Effect.runPromise(lock.acquire(path))
}

function release(handle: SyncLockHandle): Promise<void> {
  return Effect.runPromise(handle.release)
}

async function failureOf(effect: Effect.Effect<unknown, unknown>): Promise<any> {
  const result = await Effect.runPromise(Effect.result(effect))
  if (Result.isSuccess(result)) throw new Error('expected the effect to fail')
  return result.failure
}

function fakeWin32(
  options: { contended?: boolean; createFailure?: boolean; waitResult?: number } = {},
) {
  const calls: string[] = []
  let nextHandle = 0
  let count = options.contended === true ? 0 : 1
  let lastError = 0
  const binding: Win32Binding = {
    createSemaphoreW: (_attributes, initialCount, maximumCount, name) => {
      calls.push(`create(${String(initialCount)},${String(maximumCount)},${name})`)
      if (options.createFailure === true) {
        lastError = 5
        return 0
      }
      nextHandle += 1
      return nextHandle
    },
    waitForSingleObject: (handle, milliseconds) => {
      calls.push(`wait(${String(handle)},${String(milliseconds)})`)
      if (options.waitResult !== undefined) return options.waitResult
      if (count === 0) return WAIT_TIMEOUT
      count = 0
      return WAIT_OBJECT_0
    },
    releaseSemaphore: (handle, releaseCount) => {
      calls.push(`release(${String(handle)},${String(releaseCount)})`)
      count += releaseCount
      return 1
    },
    closeHandle: (handle) => {
      calls.push(`close(${String(handle)})`)
      return 1
    },
    getLastError: () => lastError,
  }
  return { binding, calls }
}

describe('Windows semaphore name', () => {
  it('derives a Local-namespace name from the case-folded canonical path', () => {
    const canonical = resolve('/profiles/work/.eedsh/sync.lock').toLowerCase()
    const digest = createHash('sha256').update(canonical).digest('hex')
    const expected = `${String.raw`Local\eedsh-profile-lock-`}${digest}`
    expect(win32LockName('/profiles/work/.eedsh/sync.lock')).toBe(expected)
    expect(win32LockName('/PROFILES/WORK/.EEDSH/SYNC.LOCK')).toBe(expected)
  })
})

describe('Windows sync lock protocol', () => {
  it('acquires, rejects a second holder, releases, and reacquires', async () => {
    const fake = fakeWin32()
    const lock = makeWin32SyncLock(async () => Result.succeed(fake.binding))
    const handle = await acquire(lock, lockPath)
    expect(fake.calls).toEqual([`create(1,1,${win32LockName(lockPath)})`, 'wait(1,0)'])

    const error = await failureOf(lock.acquire(lockPath))
    expect(error).toBeInstanceOf(SyncLocked)
    expect(error.lockPath).toBe(lockPath)
    expect(fake.calls.slice(-2)).toEqual(['wait(2,0)', 'close(2)'])

    await release(handle)
    expect(fake.calls.slice(-2)).toEqual(['release(1,1)', 'close(1)'])

    const again = await acquire(lock, lockPath)
    await release(again)
    expect(fake.calls.slice(-2)).toEqual(['release(3,1)', 'close(3)'])
  })

  it('maps WAIT_TIMEOUT to SyncLocked and closes the contender handle', async () => {
    const fake = fakeWin32({ contended: true })
    const error = await failureOf(
      makeWin32SyncLock(async () => Result.succeed(fake.binding)).acquire(lockPath),
    )
    expect(error).toBeInstanceOf(SyncLocked)
    expect(error.lockPath).toBe(lockPath)
    expect(fake.calls).toEqual([`create(1,1,${win32LockName(lockPath)})`, 'wait(1,0)', 'close(1)'])
  })

  it('fails with a platform error when CreateSemaphoreW returns no handle', async () => {
    const fake = fakeWin32({ createFailure: true })
    const error = await failureOf(
      makeWin32SyncLock(async () => Result.succeed(fake.binding)).acquire(lockPath),
    )
    expect(PlatformError.isPlatformError(error)).toBe(true)
    expect(error.reason.method).toBe('lock')
    expect(error.reason.pathOrDescriptor).toBe(lockPath)
    expect(String(error.reason.description)).toContain('Win32 5')
  })

  it('fails with a platform error on an unexpected wait result and closes the handle', async () => {
    const fake = fakeWin32({ waitResult: 0xffff_ffff })
    const error = await failureOf(
      makeWin32SyncLock(async () => Result.succeed(fake.binding)).acquire(lockPath),
    )
    expect(PlatformError.isPlatformError(error)).toBe(true)
    expect(error.reason.method).toBe('lock')
    expect(error.reason.pathOrDescriptor).toBe(lockPath)
    expect(fake.calls.slice(-1)).toEqual(['close(1)'])
  })

  it('fails closed when the kernel32 binding cannot be loaded', async () => {
    const error = await failureOf(
      makeWin32SyncLock(async () => Result.fail(new Error('koffi unavailable'))).acquire(lockPath),
    )
    expect(PlatformError.isPlatformError(error)).toBe(true)
    expect(error.reason.method).toBe('loadWin32Lock')
    expect(error.reason.pathOrDescriptor).toBe(lockPath)
    expect(String(error.reason.cause)).toContain('koffi unavailable')
  })

  it('ignores a close failure while rejecting a contender', async () => {
    const binding: Win32Binding = {
      createSemaphoreW: () => 1,
      waitForSingleObject: () => WAIT_TIMEOUT,
      releaseSemaphore: () => 1,
      closeHandle: () => {
        throw new Error('close failed')
      },
      getLastError: () => 0,
    }
    const error = await failureOf(
      makeWin32SyncLock(async () => Result.succeed(binding)).acquire(lockPath),
    )
    expect(error).toBeInstanceOf(SyncLocked)
  })

  it('closes the handle even when ReleaseSemaphore fails, once', async () => {
    let closes = 0
    const binding: Win32Binding = {
      createSemaphoreW: () => 1,
      waitForSingleObject: () => WAIT_OBJECT_0,
      releaseSemaphore: () => {
        throw new Error('release failed')
      },
      closeHandle: () => {
        closes += 1
        return 1
      },
      getLastError: () => 0,
    }
    const handle = await acquire(
      makeWin32SyncLock(async () => Result.succeed(binding)),
      lockPath,
    )
    await release(handle)
    await release(handle)
    expect(closes).toBe(1)
  })
})

describe('Windows platform selection', () => {
  it('selects the injected Windows implementation on win32 without loading kernel32', async () => {
    const lock = fakeSyncLock()
    await Effect.runPromise(
      withSyncLock(lockPath, Effect.void).pipe(
        Effect.provide(syncLockLayer('win32', { win32: lock.shape })),
      ),
    )
    expect(lock.acquires).toEqual([lockPath])
    expect(lock.releases).toEqual([lockPath])
  })
})

describe.skipIf(process.platform !== 'win32')('Windows semaphore with the real binding', () => {
  it('excludes a second holder and leaves no lock file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eedsh-win32-lock-'))
    const profileLock = join(dir, '.eedsh', 'sync.lock')
    const lock = makeWin32SyncLock()
    try {
      const first = await acquire(lock, profileLock)
      const error = await failureOf(lock.acquire(profileLock))
      expect(error).toBeInstanceOf(SyncLocked)
      await release(first)

      const second = await acquire(lock, profileLock)
      await release(second)
      expect(existsSync(profileLock)).toBe(false)
      expect(existsSync(dirname(profileLock))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
