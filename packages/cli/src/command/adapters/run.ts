/**
 * `eedsh run`: sync the selected profile unless `--no-sync`, then boot the
 * discovered launcher with the passthrough arguments.
 * @module @eedsh/cli/command/adapters/run
 */
import { Effect } from 'effect'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import type { ConfigLoadFailure } from '../../config'
import { EXIT_FAILURE } from '../../exit'
import type { DshFailure, MaterializeError, SpawnFailure } from '../../internal/effect/errors'
import { selectProfile } from '../../selection'
import { configFlag, dshFlag, noSyncFlag, runProfileFlag } from '../../surface'
import { runBoot } from '../boot'
import type { CommandContext, CommandRuntime } from '../context'
import { NO_PROVISIONING_MODE, syncOnce } from '../materialize'
import type { Parsed } from '../options'
import {
  loadConfigValue,
  reportProfileFailure,
  requireDsh,
  resolveConfigPath,
  selectionFailure,
} from '../prepare'
import { printResult } from '../report'

/** The `eedsh run` flag record. */
export const runOptions = {
  config: configFlag,
  profile: runProfileFlag,
  dsh: dshFlag,
  noSync: noSyncFlag,
}

/** The parsed input for {@link runRunCommand}; `dshArgs` comes from `--`. */
export type RunInput = Parsed<typeof runOptions> & { dshArgs: readonly string[] }

export function runRunCommand(
  input: RunInput,
  runtime: CommandRuntime,
): Effect.Effect<number, ConfigLoadFailure | MaterializeError | DshFailure | SpawnFailure> {
  return Effect.gen(function* () {
    runtime.setFailureContext(input.noSync ? undefined : { sync: true, explain: false })
    const requestedConfig = input.config
    const configPath = resolveConfigPath(requestedConfig, runtime)
    if (Option.isNone(configPath)) return EXIT_FAILURE
    const installation = yield* requireDsh(runtime, input.dsh, { bootstrap: !input.noSync })
    const loaded = yield* loadConfigValue(configPath.value, runtime)
    const selection = selectProfile(loaded.config, input.profile)
    if (Result.isFailure(selection)) return selectionFailure(runtime, selection.failure)
    const entry = selection.success
    if (Result.isFailure(entry.plan)) {
      reportProfileFailure(runtime.stderr, entry.name, entry.plan.failure)
      return EXIT_FAILURE
    }
    const plan = entry.plan.success
    const context: CommandContext = {
      ...runtime,
      configPath: configPath.value,
      installation,
      plan,
      provenance: loaded.provenance,
      configDir: loaded.configDir,
      profile: input.profile,
    }
    if (!input.noSync) {
      const result = yield* syncOnce(context, false, false, false, NO_PROVISIONING_MODE)
      yield* Effect.sync(() => printResult(runtime.stdout, runtime.stderr, plan, result, false))
    }
    return yield* runBoot(context, installation, input.dshArgs)
  })
}
