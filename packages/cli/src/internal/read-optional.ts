/**
 * Optional file reads shared by publication and doctor.
 * @module @eedsh/cli/internal/read-optional
 */
import { Effect } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'

/**
 * Read a file's text, or undefined when the file does not exist.
 * @param fs - the platform file-system service.
 * @param path - absolute file path.
 * @returns an effect carrying the text or undefined.
 */
export function readOptional(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<string | undefined, PlatformError.PlatformError> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(path))) return undefined
    return yield* fs.readFileString(path)
  })
}
