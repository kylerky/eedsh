/**
 * `eedsh run`: sync the selected profile unless `--no-sync`, then boot the
 * discovered launcher with the passthrough arguments.
 * @module @eedsh/cli/command/adapters/run
 */
import { Effect } from 'effect'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import { EXIT_FAILURE } from '../../exit'
import { type CliServices, Output } from '../../internal/effect/services'
import { selectProfile } from '../../selection'
import { configFlag, dshFlag, noSyncFlag, runProfileFlag } from '../../surface'
import { runBoot } from '../boot'
import type { CommandContext } from '../context'
import { asEedshError } from '../errors'
import { NO_PROVISIONING_MODE, syncOnce } from '../materialize'
import type { Parsed } from '../options'
import {
  loadConfigValue,
  reportProfileFailure,
  requireDsh,
  resolveConfigPath,
  selectionFailure,
} from '../prepare'
import { failWith, printResult } from '../report'

/** The `eedsh run` flag record. */
export const runOptions = {
  config: configFlag,
  profile: runProfileFlag,
  dsh: dshFlag,
  noSync: noSyncFlag,
}

/** The parsed input for {@link runRunCommand}; `dshArgs` comes from `--`. */
export type RunInput = Parsed<typeof runOptions> & { dshArgs: readonly string[] }

export function runRunCommand(input: RunInput): Effect.Effect<number, never, CliServices> {
  return Effect.gen(function* () {
    const output = yield* Output
    const configPath = yield* resolveConfigPath(input.config)
    if (Option.isNone(configPath)) return EXIT_FAILURE
    const installation = yield* requireDsh(input.dsh, { bootstrap: !input.noSync })
    const loaded = yield* loadConfigValue(configPath.value, installation)
    const selection = selectProfile(loaded.config, input.profile)
    if (Result.isFailure(selection)) return yield* selectionFailure(selection.failure)
    const entry = selection.success
    if (Result.isFailure(entry.plan)) {
      reportProfileFailure(output.stderr, entry.name, entry.plan.failure)
      return EXIT_FAILURE
    }
    const plan = entry.plan.success
    const context: CommandContext = {
      configPath: configPath.value,
      installation,
      plan,
      provenance: loaded.provenance,
      configDir: loaded.configDir,
      profile: input.profile,
    }
    if (!input.noSync) {
      const result = yield* syncOnce(context, false, false, false, NO_PROVISIONING_MODE)
      printResult(output.stdout, output.stderr, plan, result, false)
    }
    return yield* runBoot(context, installation, input.dshArgs)
  }).pipe(
    Effect.catch((error) => failWith(asEedshError(error), { sync: !input.noSync, explain: false })),
  )
}
