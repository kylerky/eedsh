/**
 * The CLI's own version and the `@eedsh/runtime` link specification. Both the
 * composition root and the materialization module need them, so they live here
 * rather than in either importer.
 * @module @eedsh/cli/command/version
 */
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Result from 'effect/Result'
import { ConfigError } from '../config'
import { messageOf } from '../internal/error-message'
import { readVersion } from '../internal/schema-readers'

/** The CLI's own package manifest, resolved beside this module. */
const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))

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

/**
 * Read the CLI's own version from its package manifest.
 * @returns the version, or `0.0.0` when the manifest cannot be read.
 */
export function cliVersion(): Effect.Effect<string, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs
      .readFileString(manifestPath)
      .pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (text === undefined) return '0.0.0'
    const parsed = Result.try({
      try: () => JSON.parse(text) as { version?: unknown },
      catch: () => undefined,
    })
    return Result.isSuccess(parsed)
      ? Option.getOrElse(readVersion(parsed.success.version), () => '0.0.0')
      : '0.0.0'
  })
}
