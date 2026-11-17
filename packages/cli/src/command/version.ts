/**
 * The CLI's own version and the `@eedsh/runtime` link specification. Both the
 * composition root and the materialization module need them, so they live here
 * rather than in either importer.
 * @module @eedsh/cli/command/version
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import { ConfigError } from '../config'
import { messageOf } from '../internal/error-message'
import { readVersion } from '../internal/schema-readers'

export function runtimeLinkSpec(): Result.Result<string, ConfigError> {
  return Result.try({
    try: () => {
      const require = createRequire(import.meta.url)
      const manifest = require.resolve('@eedsh/runtime/package.json')
      return `link:${dirname(manifest)}`
    },
    catch: (cause) =>
      new ConfigError('runtime.not_found', `cannot resolve @eedsh/runtime: ${messageOf(cause)}`),
  })
}

export function cliVersion(): string {
  const parsed = Result.try({
    try: () =>
      JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
        version?: unknown
      },
    catch: () => undefined,
  })
  return Result.isSuccess(parsed)
    ? Option.getOrElse(readVersion(parsed.success.version), () => '0.0.0')
    : '0.0.0'
}
