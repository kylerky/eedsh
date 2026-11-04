/**
 * Local DSH home and profile paths. These resolve without an installed DSH so
 * `eedsh doctor --profile` and path displays work on a bare machine.
 * @module @eedsh/cli/internal/dsh-home
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Directory below the DSH home that holds profiles. */
export const PROFILES_DIR = 'profiles'

/** The home directory an environment mapping resolves, falling back to the OS home. */
function homeDirectory(env: Record<string, string | undefined>): string {
  return env.HOME !== undefined && env.HOME.trim().length > 0 ? env.HOME : homedir()
}

function defaultDshHome(env: Record<string, string | undefined>): string {
  return join(homeDirectory(env), '.dsh')
}

/** Expand `~`, `~/`, and `~\\` prefixes against the environment's home directory. */
function expandHomePath(path: string, env: Record<string, string | undefined>): string {
  const home = homeDirectory(env)
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return path
}

/**
 * Resolve the DSH home. An explicit value wins, then a non-blank DSH_HOME,
 * then `~/.dsh`. The result is absolute.
 * @param configured - explicit home override.
 * @param env - environment mapping to read.
 * @returns the absolute DSH home.
 */
export function resolveDshHome(
  configured?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const fromEnv = env.DSH_HOME
  const chosen =
    configured ??
    (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : defaultDshHome(env))
  return resolve(expandHomePath(chosen, env))
}

/**
 * Resolve one profile directory below a DSH home.
 * @param name - the profile name, which must be one safe path segment.
 * @param home - the DSH home; resolved from the environment when omitted.
 * @returns the absolute profile directory.
 */
export function resolveProfileDir(name: string, home: string = resolveDshHome()): string {
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    name === 'node_modules' ||
    name.includes('/') ||
    name.includes('\\')
  ) {
    throw new Error(`dsh: invalid profile name ${JSON.stringify(name)}`)
  }
  return join(home, PROFILES_DIR, name)
}
