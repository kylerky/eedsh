/**
 * Atomic file replacement: write a same-directory temporary file, then rename
 * it over the target. The temporary file is a scoped resource, so a failed
 * write or rename removes it while the target keeps its previous content.
 * Windows may briefly refuse the rename while another process holds the
 * target, so retryable errors are retried.
 * @module @eedsh/cli/internal/atomic-write
 */
import { randomUUID } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Effect } from 'effect'
import { FileSystemFailure } from './effect/errors'

const RETRYABLE = new Set(['EACCES', 'EBUSY', 'EPERM'])
const RETRY_LIMIT = 5
const RETRY_DELAY_MS = 50

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= RETRY_LIMIT || code === undefined || !RETRYABLE.has(code)) throw error
      await delay(RETRY_DELAY_MS)
    }
  }
}

/** The file operations atomic replacement needs. */
export interface AtomicWriteIo {
  /** Write the content to the temporary path; `signal` cancels the write. */
  writeFile(path: string, content: string, signal: AbortSignal): Promise<void>
  /** Rename the temporary path over the target. */
  rename(from: string, to: string): Promise<void>
  /** Remove a leftover temporary path; missing paths are ignored. */
  remove(path: string): Promise<void>
}

/** Node-backed implementation of {@link AtomicWriteIo}. */
export const nodeAtomicWriteIo: AtomicWriteIo = {
  writeFile: (path, content, signal) => writeFile(path, content, { encoding: 'utf8', signal }),
  rename: (from, to) => renameWithRetry(from, to),
  remove: (path) => rm(path, { force: true }),
}

function atomicFailure(path: string, cause: unknown): FileSystemFailure {
  return new FileSystemFailure({ operation: 'writeFileAtomic', path, cause })
}

/**
 * Replace a file atomically.
 *
 * The write and rename run after acquiring a same-directory temporary path;
 * the release removes that path with `force` and ignores cleanup errors. A
 * successful rename has already moved the temporary path away, so release is a
 * no-op on success. A failed write or rename keeps the target untouched and
 * leaves cleanup to the release.
 * @param path - absolute target path.
 * @param content - UTF-8 content.
 * @param io - injected file operations; defaults to Node's `fs/promises`.
 * @returns an effect that succeeds when the target holds the new content.
 */
export function writeFileAtomic(
  path: string,
  content: string,
  io: AtomicWriteIo = nodeAtomicWriteIo,
): Effect.Effect<void, FileSystemFailure> {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  return Effect.acquireUseRelease(
    Effect.sync(() => temp),
    (tempPath) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: (signal) => io.writeFile(tempPath, content, signal),
          catch: (cause) => atomicFailure(path, cause),
        })
        yield* Effect.tryPromise({
          try: () => io.rename(tempPath, path),
          catch: (cause) => atomicFailure(path, cause),
        })
      }),
    (tempPath) =>
      Effect.tryPromise({
        try: () => io.remove(tempPath),
        catch: (cause) => cause,
      }).pipe(Effect.ignore),
  )
}
