/**
 * `eedsh doctor`: inspect a published profile without changing it.
 * @module @eedsh/cli/command/adapters/doctor
 */
import { isSafeProfileName } from '@eedsh/plan'
import { Effect } from 'effect'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import { versionProbe } from '../../command-runner'
import { doctor, doctorExitCode, formatDoctorReport } from '../../doctor'
import type { DiscoveredDshInstallation } from '../../dsh'
import { EXIT_FAILURE, EXIT_USAGE } from '../../exit'
import { resolveDshHome } from '../../internal/dsh-home'
import {
  BundleResolver,
  type CliServices,
  CommandRunner,
  DshDiscovery,
  Environment,
  InstallationAnchor,
  Output,
} from '../../internal/effect/services'
import { selectProfile } from '../../selection'
import { configFlag, doctorStrictFlag, dshFlag, profileFlag } from '../../surface'
import { asEedshError } from '../errors'
import type { Parsed } from '../options'
import { loadConfigValue, profileDirForName, resolveConfigPath, selectionFailure } from '../prepare'
import { failWith } from '../report'

/** The `eedsh doctor` flag record. */
export const doctorOptions = {
  config: configFlag,
  profile: profileFlag,
  dsh: dshFlag,
  strict: doctorStrictFlag,
}

/** The parsed input for {@link runDoctorCommand}. */
export type DoctorInput = Parsed<typeof doctorOptions>

/** Inspect one published profile and print its findings. */
export function runDoctorCommand(input: DoctorInput): Effect.Effect<number, never, CliServices> {
  return Effect.gen(function* () {
    const output = yield* Output
    const { env, cwd } = yield* Environment
    if (Option.isSome(input.profile) && Option.isSome(input.config)) {
      output.stderr('eedsh: doctor accepts either --profile or --config, not both')
      return EXIT_USAGE
    }
    const store = yield* InstallationAnchor
    const runner = yield* CommandRunner
    const discovery = yield* DshDiscovery
    const discovered = discovery.discover({
      ...(Option.isSome(input.dsh) ? { explicit: input.dsh.value } : {}),
      env,
      cwd,
      readAnchor: () => store.read(env),
      probeVersion: versionProbe(runner, env),
    })
    let doctorDsh: DiscoveredDshInstallation | undefined
    if (Result.isSuccess(discovered)) {
      doctorDsh = discovered.success
      const resolver = yield* BundleResolver
      // The bridge makes config evaluation see the selected installation; a
      // failure here is reported by the profile inspection, not by discovery.
      yield* Effect.exit(resolver.loadBridge(discovered.success))
    }

    let profileName: string
    if (Option.isSome(input.profile)) {
      if (!isSafeProfileName(input.profile.value)) {
        output.stderr(
          `eedsh: profile name "${input.profile.value}" is not usable as a profile directory`,
        )
        return EXIT_USAGE
      }
      profileName = input.profile.value
    } else {
      const configPath = yield* resolveConfigPath(input.config)
      if (Option.isNone(configPath)) return EXIT_FAILURE
      const loaded = yield* loadConfigValue(configPath.value)
      const selection = selectProfile(loaded.config, Option.none())
      if (Result.isFailure(selection)) return yield* selectionFailure(selection.failure)
      profileName = selection.success.name
    }
    const result = yield* doctor({
      profileDir: profileDirForName(profileName, env),
      dshHome: resolveDshHome(undefined, env),
      ...(doctorDsh === undefined ? {} : { dsh: doctorDsh }),
    })
    for (const line of formatDoctorReport(result)) output.stdout(line)
    return doctorExitCode(result, input.strict)
  }).pipe(Effect.catch((error) => failWith(asEedshError(error))))
}
