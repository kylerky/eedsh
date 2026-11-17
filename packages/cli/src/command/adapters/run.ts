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
import { runBoot } from '../boot'
import type { CommandContext, CommandRuntime } from '../context'
import { NO_PROVISIONING_MODE, syncOnce } from '../materialize'
import {
  loadConfigValue,
  reportProfileFailure,
  requireDsh,
  resolveConfigPath,
  selectionFailure,
} from '../prepare'
import { printResult } from '../report'

export interface RunCommandInput {
  configPath: Option.Option<string>
  profile: Option.Option<string>
  dsh: Option.Option<string>
  noSync: boolean
  dshArgs: readonly string[]
}

export function runRunCommand(
  input: RunCommandInput,
  runtime: CommandRuntime,
): Effect.Effect<number, ConfigLoadFailure | MaterializeError | DshFailure | SpawnFailure> {
  return Effect.gen(function* () {
    runtime.setFailureContext(input.noSync ? undefined : { sync: true, explain: false })
    const configPath = resolveConfigPath(input.configPath, runtime)
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
