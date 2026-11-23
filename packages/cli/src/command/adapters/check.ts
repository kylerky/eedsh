/**
 * `eedsh check`: typecheck the config project with its own compiler.
 * @module @eedsh/cli/command/adapters/check
 */
import { Effect } from 'effect'
import * as Option from 'effect/Option'
import { runCheck } from '../../check'
import { EXIT_FAILURE } from '../../exit'
import { type CliServices, Environment, Output, Spawner } from '../../internal/effect/services'
import { configFlag } from '../../surface'
import { asEedshError } from '../errors'
import type { Parsed } from '../options'
import { resolveConfigPath } from '../prepare'
import { failWith } from '../report'

/** The `eedsh check` flag record. */
export const checkOptions = { config: configFlag }

/** The parsed input for {@link runCheckCommand}; `tscArgs` comes from `--`. */
export type CheckInput = Parsed<typeof checkOptions> & { tscArgs: readonly string[] }

export function runCheckCommand(input: CheckInput): Effect.Effect<number, never, CliServices> {
  return Effect.gen(function* () {
    const output = yield* Output
    const { env, cwd } = yield* Environment
    const spawn = yield* Spawner
    const configPath = yield* resolveConfigPath(input.config)
    if (Option.isNone(configPath)) return EXIT_FAILURE
    return yield* runCheck({
      configPath: configPath.value,
      tscArgs: input.tscArgs,
      stdout: output.stdout,
      stderr: output.stderr,
      env,
      cwd,
      spawn,
    })
  }).pipe(Effect.catch((error) => failWith(asEedshError(error))))
}
