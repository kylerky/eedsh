/**
 * Nearest tsconfig lookup shared by config evaluation and `eedsh check`.
 * @module @eedsh/cli/internal/tsconfig
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Option } from 'effect'

/** The TypeScript project filename both commands look for. */
export const TSCONFIG_FILENAME = 'tsconfig.json'

/**
 * Find the nearest tsconfig.json at or above a file.
 * @param filePath - absolute path of the config or checked file.
 * @returns the absolute tsconfig path, or None when there is none.
 */
export function findTsconfigPath(filePath: string): Option.Option<string> {
  let dir = dirname(filePath)
  for (;;) {
    const candidate = join(dir, TSCONFIG_FILENAME)
    if (existsSync(candidate)) return Option.some(candidate)
    const parent = dirname(dir)
    if (parent === dir) return Option.none()
    dir = parent
  }
}
