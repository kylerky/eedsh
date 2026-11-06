/**
 * File operations for a generated bundle patch: atomic write and drift
 * checking. Paths are resolved against the process working directory, so a
 * plugin build script can pass its package-relative `cordis.patch.yml`.
 * @module @eedsh/bundle/artifacts
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { BundlePatch } from './patch'
import { emitBundlePatch } from './yaml'

/** The outcome of comparing a definition with its committed artifact. */
export interface BundlePatchCheck {
  /** Whether the file equals the current emission. */
  readonly ok: boolean
  /** The resolved file path. */
  readonly path: string
  /** Why the check failed, when it did. */
  readonly message?: string
}

/** Platform rename errors that can clear up when a retry runs. */
const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES'])
const RETRY_LIMIT = 5
const RETRY_WAIT_MS = 50

function renameWithRetry(from: string, to: string): void {
  let attempt = 0
  for (;;) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (attempt >= RETRY_LIMIT || typeof code !== 'string' || !RETRYABLE.has(code)) throw error
      attempt += 1
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_WAIT_MS)
    }
  }
}

/**
 * Write a bundle patch to a file atomically: a same-directory temporary file
 * is renamed over the target, so a failed write keeps the previous file.
 * @param patch - the bundle patch.
 * @param path - the target path, relative to the working directory or absolute.
 */
export function writeBundlePatch(patch: BundlePatch, path: string): void {
  const content = emitBundlePatch(patch)
  const target = resolve(path)
  const directory = dirname(target)
  mkdirSync(directory, { recursive: true })
  const temporary = join(directory, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, content, 'utf8')
    renameWithRetry(temporary, target)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/** Find the first differing line for an actionable drift message. */
function firstDifference(expected: string, actual: string): string {
  const expectedLines = expected.split('\n')
  const actualLines = actual.split('\n')
  const limit = Math.max(expectedLines.length, actualLines.length)
  for (let index = 0; index < limit; index += 1) {
    if (expectedLines[index] !== actualLines[index]) {
      return `first difference at line ${index + 1}`
    }
  }
  return 'contents differ'
}

/**
 * Compare a bundle patch with an existing file without modifying it.
 * @param patch - the bundle patch.
 * @param path - the target path, relative to the working directory or absolute.
 * @returns the comparison result.
 */
export function checkBundlePatch(patch: BundlePatch, path: string): BundlePatchCheck {
  const expected = emitBundlePatch(patch)
  const target = resolve(path)
  let actual: string
  try {
    actual = readFileSync(target, 'utf8')
  } catch {
    return {
      ok: false,
      path: target,
      message: `${target} does not exist; regenerate it from the bundle definition`,
    }
  }
  if (actual === expected) return { ok: true, path: target }
  return {
    ok: false,
    path: target,
    message: `${target} is stale (${firstDifference(expected, actual)}); regenerate it from the bundle definition`,
  }
}
