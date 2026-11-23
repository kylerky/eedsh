/**
 * Nearest tsconfig lookup shared by config evaluation and `eedsh check`. The
 * lookup walks the directory tree through the FileSystem service, so a test can
 * answer it without touching disk.
 * @module @eedsh/cli/internal/tsconfig
 */
import { dirname, join } from 'node:path'
import { Effect, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'

/** The TypeScript project filename both commands look for. */
export const TSCONFIG_FILENAME = 'tsconfig.json'

/**
 * Find the nearest tsconfig.json at or above a file.
 * @param filePath - absolute path of the config or checked file.
 * @returns the absolute tsconfig path, or None when there is none.
 */
export function findTsconfigPath(
  filePath: string,
): Effect.Effect<Option.Option<string>, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    let dir = dirname(filePath)
    for (;;) {
      const candidate = join(dir, TSCONFIG_FILENAME)
      if (yield* fs.exists(candidate)) return Option.some(candidate)
      const parent = dirname(dir)
      if (parent === dir) return Option.none()
      dir = parent
    }
  })
}
