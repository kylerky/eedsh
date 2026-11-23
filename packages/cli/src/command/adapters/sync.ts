/**
 * `eedsh sync`: evaluate the config, preflight the layers, and publish. Watch
 * mode repeats the pass whenever the config directory changes.
 * @module @eedsh/cli/command/adapters/sync
 */
import { Cause, Effect, Exit } from 'effect'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../../exit'
import { type CliServices, Output } from '../../internal/effect/services'
import { selectSyncProfiles } from '../../selection'
import {
  adoptOwnershipFlag,
  configFlag,
  dshFlag,
  explainFlag,
  noBuildFlag,
  rebuildFlag,
  strictFlag,
  syncProfileFlag,
  watchFlag,
} from '../../surface'
import type { CommandContext } from '../context'
import { type ProvisioningMode, syncOnce } from '../materialize'
import type { Parsed } from '../options'
import {
  loadConfigValue,
  reportProfileFailure,
  reportProfileSyncFailure,
  requireDsh,
  resolveConfigPath,
  selectionFailure,
} from '../prepare'
import { failWith, printResult } from '../report'
import { syncWatch, type WatchContext } from '../watch'

/** The `eedsh sync` flag record. */
export const syncOptions = {
  config: configFlag,
  profile: syncProfileFlag,
  dsh: dshFlag,
  strict: strictFlag,
  watch: watchFlag,
  explain: explainFlag,
  adoptOwnership: adoptOwnershipFlag,
  rebuild: rebuildFlag,
  noBuild: noBuildFlag,
}

/** The parsed input for {@link runSyncCommand}. */
export type SyncInput = Parsed<typeof syncOptions>

/** One sync pass over the selected profiles. */
function syncSelection(input: SyncInput, provisioning: ProvisioningMode) {
  return Effect.gen(function* () {
    const output = yield* Output
    const configPath = yield* resolveConfigPath(input.config)
    if (Option.isNone(configPath)) return EXIT_FAILURE
    const path = configPath.value
    const installation = yield* requireDsh(input.dsh, { bootstrap: true })

    if (input.watch) {
      const context: WatchContext = {
        configPath: path,
        profile: input.profile,
        installation,
      }
      yield* syncWatch(context, input.strict, input.explain, input.adoptOwnership, provisioning)
      return EXIT_OK
    }

    const loaded = yield* loadConfigValue(path)
    const selection = selectSyncProfiles(loaded.config, input.profile)
    if (Result.isFailure(selection)) return yield* selectionFailure(selection.failure)
    const entries = selection.success

    const multiple = entries.length > 1
    let failed = false
    for (const entry of entries) {
      if (Result.isFailure(entry.plan)) {
        failed = true
        reportProfileFailure(output.stderr, entry.name, entry.plan.failure)
        continue
      }
      const plan = entry.plan.success
      if (multiple) output.stdout(`eedsh: profile "${entry.name}"`)
      const context: CommandContext = {
        configPath: path,
        installation,
        plan,
        provenance: loaded.provenance,
        configDir: loaded.configDir,
        profile: input.profile,
      }
      const runExit = yield* Effect.exit(
        syncOnce(context, input.strict, input.explain, input.adoptOwnership, provisioning),
      )
      if (Exit.isFailure(runExit)) {
        if (Cause.hasInterruptsOnly(runExit.cause)) return yield* Effect.interrupt
        failed = true
        reportProfileSyncFailure(
          output.stderr,
          entry.name,
          Cause.squash(runExit.cause),
          input.explain,
        )
        continue
      }
      printResult(output.stdout, output.stderr, plan, runExit.value, input.explain)
    }
    return failed ? EXIT_FAILURE : EXIT_OK
  })
}

export function runSyncCommand(input: SyncInput): Effect.Effect<number, never, CliServices> {
  return Effect.gen(function* () {
    const output = yield* Output
    if (input.rebuild && input.noBuild) {
      output.stderr('eedsh: --rebuild and --no-build are mutually exclusive')
      return EXIT_USAGE
    }
    const provisioning: ProvisioningMode = {
      rebuild: input.rebuild,
      noBuild: input.noBuild,
    }
    return yield* syncSelection(input, provisioning)
  }).pipe(Effect.catch((error) => failWith(error, { sync: true, explain: input.explain })))
}
