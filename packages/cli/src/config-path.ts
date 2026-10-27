/**
 * The one XDG-based config location. There is no working-directory discovery:
 * every command resolves the same default path, and `--config` is the explicit
 * override.
 * @module @eedsh/cli/config-path
 */
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** The single accepted default config filename. */
export const CONFIG_FILENAME = 'config.ts'

/** Environment variables the config location is derived from. */
export type ConfigEnvironment = Readonly<Record<string, string | undefined>>

function homeDirectory(env: ConfigEnvironment): string {
  const home = env.HOME ?? env.USERPROFILE
  return home === undefined || home === '' ? homedir() : home
}

/**
 * Resolve the XDG config home. An absolute `XDG_CONFIG_HOME` wins; unset,
 * empty, or relative falls back to `~/.config`.
 * @param env - the process environment.
 * @returns the absolute config home.
 */
export function configHome(env: ConfigEnvironment): string {
  const xdg = env.XDG_CONFIG_HOME
  return xdg !== undefined && xdg !== '' && isAbsolute(xdg)
    ? xdg
    : join(homeDirectory(env), '.config')
}

/**
 * Resolve eedsh's own config directory below the config home.
 * @param env - the process environment.
 * @returns the absolute eedsh config directory.
 */
export function configDirectory(env: ConfigEnvironment): string {
  return join(configHome(env), 'eedsh')
}

/**
 * Resolve the default config file path.
 * @param env - the process environment.
 * @returns the absolute `<config home>/eedsh/config.ts` path.
 */
export function defaultConfigPath(env: ConfigEnvironment): string {
  return join(configDirectory(env), CONFIG_FILENAME)
}
