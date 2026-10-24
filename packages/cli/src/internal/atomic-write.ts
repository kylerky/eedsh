/**
 * Atomic file replacement: write a same-directory temporary file, then rename
 * it over the target. The temporary file is a scoped resource, so a failed
 * write or rename removes it while the target keeps its previous content.
 * Windows may briefly refuse the rename while another process holds the
 * target, so retryable platform errors are retried.
 * @module @eedsh/cli/internal/atomic-write
 */
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { Effect } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'

/** The platform error reasons that can clear up when a retry runs. */
const RETRYABLE = new Set(['Busy', 'PermissionDenied'])
const RETRY_LIMIT = 5
const RETRY_DELAY_MS = 50

function renameWithRetry(
  fs: FileSystem.FileSystem,
  from: string,
  to: string,
  attempt = 0,
): Effect.Effect<void, PlatformError.PlatformError> {
  return fs.rename(from, to).pipe(
    Effect.catch((error) =>
      attempt >= RETRY_LIMIT || !RETRYABLE.has(error.reason._tag)
        ? Effect.fail(error)
        : Effect.andThen(
            Effect.sleep(RETRY_DELAY_MS),
            renameWithRetry(fs, from, to, attempt + 1),
          ),
    ),
  )
}

/**
 * Replace a file atomically.
 *
 * The write and rename run after acquiring a same-directory temporary path;
 * the release removes that path with `force` and ignores cleanup errors. A
 * successful rename has already moved the temporary path away, so release is a
 * no-op on success. A failed write or rename keeps the target untouched and
 * leaves cleanup to the release.
 * @param fs - the platform file-system service.
 * @param path - absolute target path.
 * @param content - UTF-8 content.
 * @returns an effect that succeeds when the target holds the new content.
 */
export function writeFileAtomic(
  fs: FileSystem.FileSystem,
  path: string,
  content: string,
): Effect.Effect<void, PlatformError.PlatformError> {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  return Effect.acquireUseRelease(
    Effect.succeed(temp),
    (tempPath) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(tempPath, content)
        yield* renameWithRetry(fs, tempPath, path)
      }),
    (tempPath) => fs.remove(tempPath, { force: true }).pipe(Effect.ignore),
  )
}
