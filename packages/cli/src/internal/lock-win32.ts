/**
 * Windows kernel sync lock: a named semaphore (count 1) derived from the
 * canonical profile lock path. It has no filesystem footprint; the kernel
 * releases the object when its last handle closes, including on any process
 * death. Contenders wait with a zero timeout and close their handle on failure.
 * @module @eedsh/cli/internal/lock-win32
 */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { Effect } from 'effect'
import * as PlatformError from 'effect/PlatformError'
import * as Result from 'effect/Result'
import { SyncLocked } from './effect/errors'
import type { SyncLockHandle, SyncLockShape } from './effect/services'

const LOCK_NAMESPACE = 'Local\\'

/** WAIT_OBJECT_0: the semaphore was acquired. */
export const WAIT_OBJECT_0 = 0
/** WAIT_TIMEOUT: another holder owns the semaphore. */
export const WAIT_TIMEOUT = 258

/** The kernel32 calls the semaphore lock needs. */
export interface Win32Binding {
  createSemaphoreW(
    attributes: null,
    initialCount: number,
    maximumCount: number,
    name: string,
  ): number
  waitForSingleObject(handle: number, milliseconds: number): number
  releaseSemaphore(handle: number, releaseCount: number, previousCount: null): number
  closeHandle(handle: number): number
  getLastError(): number
}

/**
 * Derive the Local-namespace semaphore name for a lock path. Windows paths are
 * case-insensitive, so the canonical path is case-folded before hashing.
 * @param lockPath - the profile lock path used only as a name seed.
 * @returns the kernel object name.
 */
export function win32LockName(lockPath: string): string {
  const canonical = resolve(lockPath).toLowerCase()
  const digest = createHash('sha256').update(canonical).digest('hex')
  return `${LOCK_NAMESPACE}eedsh-profile-lock-${digest}`
}

let bindings: Promise<Win32Binding> | undefined

/** Load koffi and bind kernel32's semaphore calls once, on first use. */
export function loadWin32Binding(): Promise<Win32Binding> {
  bindings ??= loadKernel32().catch((error: unknown) => {
    bindings = undefined
    throw error
  })
  return bindings
}

async function loadKernel32(): Promise<Win32Binding> {
  const kernel32 = (await import('koffi')).default.load('kernel32.dll')
  const createSemaphoreW = kernel32.func('__stdcall', 'CreateSemaphoreW', 'intptr', [
    'void*',
    'int',
    'int',
    'str16',
  ])
  const waitForSingleObject = kernel32.func('__stdcall', 'WaitForSingleObject', 'uint', [
    'intptr',
    'uint',
  ])
  const releaseSemaphore = kernel32.func('__stdcall', 'ReleaseSemaphore', 'int', [
    'intptr',
    'int',
    'void*',
  ])
  const closeHandle = kernel32.func('__stdcall', 'CloseHandle', 'int', ['intptr'])
  const getLastError = kernel32.func('__stdcall', 'GetLastError', 'uint', [])
  return {
    createSemaphoreW: (_attributes, initialCount, maximumCount, name) =>
      Number(createSemaphoreW(null, initialCount, maximumCount, name)),
    waitForSingleObject: (handle, milliseconds) =>
      Number(waitForSingleObject(handle, milliseconds)),
    releaseSemaphore: (handle, releaseCount) =>
      Number(releaseSemaphore(handle, releaseCount, null)),
    closeHandle: (handle) => Number(closeHandle(handle)),
    getLastError: () => Number(getLastError()),
  }
}

function ignore(run: () => void): void {
  try {
    run()
  } catch {
    // The kernel releases the object with its last handle, so a failed release
    // or close must not replace the primary error.
  }
}

function closeQuietly(binding: Win32Binding, handle: number): void {
  ignore(() => {
    binding.closeHandle(handle)
  })
}

function platformError(
  method: string,
  path: string,
  options: { description?: string; cause?: unknown } = {},
): PlatformError.PlatformError {
  return PlatformError.systemError({
    _tag: 'Unknown',
    module: 'SyncLock',
    method,
    pathOrDescriptor: path,
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  })
}

function releasedHandle(binding: Win32Binding, handle: number): SyncLockHandle {
  let released = false
  return {
    release: Effect.sync(() => {
      if (released) return
      released = true
      ignore(() => {
        binding.releaseSemaphore(handle, 1, null)
      })
      ignore(() => {
        binding.closeHandle(handle)
      })
    }),
  }
}

/**
 * Build the Windows semaphore-backed sync lock.
 * @param loadBinding - binding loader, injectable for tests.
 * @returns the lock service.
 */
export function makeWin32SyncLock(
  loadBinding: () => Promise<Win32Binding> = loadWin32Binding,
): SyncLockShape {
  return {
    acquire: (lockPath) =>
      Effect.gen(function* () {
        const binding = yield* Effect.tryPromise({
          try: loadBinding,
          catch: (cause) => platformError('loadWin32Lock', lockPath, { cause }),
        })
        const name = win32LockName(lockPath)
        const handle = yield* Effect.try({
          try: () => binding.createSemaphoreW(null, 1, 1, name),
          catch: (cause) => platformError('lock', lockPath, { cause }),
        })
        if (handle === 0) {
          return yield* Effect.fail(
            platformError('lock', lockPath, {
              description: `CreateSemaphoreW failed (Win32 ${String(binding.getLastError())})`,
            }),
          )
        }

        const waited = yield* Effect.result(
          Effect.try({
            try: () => binding.waitForSingleObject(handle, 0),
            catch: (cause) => platformError('lock', lockPath, { cause }),
          }),
        )
        if (Result.isSuccess(waited) && waited.success === WAIT_OBJECT_0) {
          return releasedHandle(binding, handle)
        }
        closeQuietly(binding, handle)
        if (Result.isFailure(waited)) return yield* Effect.fail(waited.failure)
        if (waited.success === WAIT_TIMEOUT) {
          return yield* Effect.fail(new SyncLocked({ lockPath }))
        }
        return yield* Effect.fail(
          platformError('lock', lockPath, {
            description: `WaitForSingleObject failed (Win32 ${String(binding.getLastError())})`,
          }),
        )
      }),
  }
}

/** The live Windows sync lock. */
export const win32SyncLock: SyncLockShape = makeWin32SyncLock()
