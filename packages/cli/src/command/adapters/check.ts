/**
 * `eedsh check`: typecheck the config project with its own compiler.
 * @module @eedsh/cli/command/adapters/check
 */
import { Effect } from 'effect'
import * as Option from 'effect/Option'
import type * as Schema from 'effect/Schema'
import { runCheck } from '../../check'
import type { ConfigError } from '../../config'
import { EXIT_FAILURE } from '../../exit'
import type { CheckFailure } from '../../internal/effect/errors'
import { defaultSpawn } from '../../spawn'
import { configFlag } from '../../surface'
import type { CommandRuntime } from '../context'
import type { Parsed } from '../options'
import { resolveConfigPath } from '../prepare'

/** The `eedsh check` flag record. */
export const checkOptions = { config: configFlag }

/** The parsed input for {@link runCheckCommand}; `tscArgs` comes from `--`. */
export type CheckInput = Parsed<typeof checkOptions> & { tscArgs: readonly string[] }

export function runCheckCommand(
  input: CheckInput,
  runtime: CommandRuntime,
): Effect.Effect<number, ConfigError | Schema.SchemaError | CheckFailure> {
  return Effect.gen(function* () {
    runtime.setFailureContext(undefined)
    const configPath = resolveConfigPath(input.config, runtime)
    if (Option.isNone(configPath)) return EXIT_FAILURE
    return yield* runCheck({
      configPath: configPath.value,
      tscArgs: input.tscArgs,
      stdout: runtime.stdout,
      stderr: runtime.stderr,
      env: runtime.env,
      cwd: runtime.cwd,
      spawn: runtime.options.spawn ?? defaultSpawn,
    })
  })
}
