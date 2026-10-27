/**
 * Optional file reads shared by publication and doctor.
 * @module @eedsh/cli/internal/read-optional
 */
import { Effect, Option } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'

/**
 * Read a file's text, or None when the file does not exist.
 * @param fs - the platform file-system service.
 * @param path - absolute file path.
 * @returns an effect carrying the text as Some, or None when it is absent.
 */
export function readOptional(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<Option.Option<string>, PlatformError.PlatformError> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(path))) return Option.none()
    return Option.some(yield* fs.readFileString(path))
  })
}
