/**
 * `eedsh doctor`: inspect a published profile without changing it.
 * @module @eedsh/cli/command/adapters/doctor
 */
import { isSafeProfileName } from '@eedsh/plan'
import { Effect } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import { defaultCommandRunner, versionProbe } from '../../command-runner'
import type { ConfigLoadFailure } from '../../config'
import { doctor, doctorExitCode, formatDoctorReport } from '../../doctor'
import { type DiscoveredDshInstallation, discoverDshInstallation } from '../../dsh'
import { loadDshBridge } from '../../dsh-bridge'
import { EXIT_FAILURE, EXIT_USAGE } from '../../exit'
import { defaultInstallationAnchorStore } from '../../installation-anchor'
import { resolveDshHome } from '../../internal/dsh-home'
import { selectProfile } from '../../selection'
import type { CommandRuntime } from '../context'
import { loadConfigValue, profileDirForName, resolveConfigPath, selectionFailure } from '../prepare'

export interface DoctorCommandInput {
  configPath: Option.Option<string>
  profile: Option.Option<string>
  dsh: Option.Option<string>
  strict: boolean
}

/** Inspect one published profile and print its findings. */
export function runDoctorCommand(
  input: DoctorCommandInput,
  runtime: CommandRuntime,
): Effect.Effect<number, ConfigLoadFailure, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    runtime.setFailureContext(undefined)
    if (Option.isSome(input.profile) && Option.isSome(input.configPath)) {
      runtime.stderr('eedsh: doctor accepts either --profile or --config, not both')
      return EXIT_USAGE
    }
    const store = runtime.options.installationAnchor ?? defaultInstallationAnchorStore
    const runner = runtime.options.commandRunner ?? defaultCommandRunner
    const discovery = runtime.options.discoverDsh ?? discoverDshInstallation
    const discovered = discovery({
      ...(Option.isSome(input.dsh) ? { explicit: input.dsh.value } : {}),
      env: runtime.env,
      cwd: runtime.cwd,
      readAnchor: () => store.read(runtime.env),
      probeVersion: versionProbe(runner, runtime.env),
    })
    let doctorDsh: DiscoveredDshInstallation | undefined
    if (Result.isSuccess(discovered)) {
      doctorDsh = discovered.success
      const load = runtime.options.loadDshBridge ?? loadDshBridge
      const loaded = yield* Effect.promise(() => load(discovered.success))
      if (Result.isSuccess(loaded)) runtime.installation = discovered.success
    }

    let profileName: string
    if (Option.isSome(input.profile)) {
      if (!isSafeProfileName(input.profile.value)) {
        runtime.stderr(
          `eedsh: profile name "${input.profile.value}" is not usable as a profile directory`,
        )
        return EXIT_USAGE
      }
      profileName = input.profile.value
    } else {
      const configPath = resolveConfigPath(input.configPath, runtime)
      if (Option.isNone(configPath)) return EXIT_FAILURE
      const loaded = yield* loadConfigValue(configPath.value, runtime)
      const selection = selectProfile(loaded.config, Option.none())
      if (Result.isFailure(selection)) return selectionFailure(runtime, selection.failure)
      profileName = selection.success.name
    }
    const result = yield* doctor({
      profileDir: profileDirForName(profileName, runtime.env),
      dshHome: resolveDshHome(undefined, runtime.env),
      ...(doctorDsh === undefined ? {} : { dsh: doctorDsh }),
    })
    yield* Effect.sync(() => {
      for (const line of formatDoctorReport(result)) runtime.stdout(line)
    })
    return doctorExitCode(result, input.strict)
  })
}
