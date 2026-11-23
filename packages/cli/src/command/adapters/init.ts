/**
 * `eedsh init`: create the XDG config project, install its dependencies, and
 * print what to do next.
 * @module @eedsh/cli/command/adapters/init
 */
import type { InstallationAnchor } from '@eedsh/runtime/installation-anchor'
import { Effect } from 'effect'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import { configDirectory } from '../../config-path'
import { EXIT_OK } from '../../exit'
import { INIT_PROFILE_NAME, resolveInitDependencySpecs, runInit } from '../../init'
import {
  anchorForInstallation,
  installationAnchorPathForEnv,
  installationFromSelection,
} from '../../installation-anchor'
import { type CliServices, Environment, Output } from '../../internal/effect/services'
import { dshFlag, noInstallFlag } from '../../surface'
import { asEedshError } from '../errors'
import type { Parsed } from '../options'
import { failWith } from '../report'

/** The `eedsh init` flag record. */
export const initOptions = { noInstall: noInstallFlag, dsh: dshFlag }

/** The parsed input for {@link runInitCommand}. */
export type InitInput = Parsed<typeof initOptions>

/** Create the XDG config project and print what to do next. */
export function runInitCommand(input: InitInput): Effect.Effect<number, never, CliServices> {
  return Effect.gen(function* () {
    const output = yield* Output
    const { env, cwd } = yield* Environment
    let anchorRecord: InstallationAnchor | undefined
    if (Option.isSome(input.dsh)) {
      const selected = yield* installationFromSelection(input.dsh.value, cwd, {
        requireSupported: true,
      })
      if (Result.isFailure(selected)) return yield* Effect.fail(selected.failure)
      anchorRecord = anchorForInstallation(selected.success, { recordedBy: 'init' })
    }
    const specs = yield* resolveInitDependencySpecs()
    const configDir = configDirectory(env)
    const anchorPath = installationAnchorPathForEnv(env)
    const result = yield* runInit({
      configDir,
      specs,
      install: !input.noInstall,
      stdout: output.stdout,
      anchorPath,
      ...(anchorRecord === undefined ? {} : { anchorRecord }),
      warn: output.stderr,
    })

    output.stdout(`eedsh: initialized ${configDir}`)
    output.stdout(`eedsh: profiles: ${INIT_PROFILE_NAME}`)
    if (result.kept.length > 0) {
      output.stdout(`eedsh: kept existing files: ${result.kept.join(', ')}`)
    }
    if (input.noInstall) output.stdout(`eedsh: ${result.installCommand}`)
    else output.stdout('eedsh: installed dependencies with pnpm')
    if (result.recordedAnchor !== undefined) {
      const version =
        result.recordedAnchor.version === undefined ? '' : ` (DSH ${result.recordedAnchor.version})`
      output.stdout(
        `eedsh: recorded installation anchor${version} at ${result.recordedAnchor.installAnchor}`,
      )
    } else if (result.existingAnchor !== undefined) {
      const version =
        result.existingAnchor.version === undefined ? '' : ` (DSH ${result.existingAnchor.version})`
      output.stdout(`eedsh: installation: ${result.existingAnchor.installAnchor}${version}`)
    } else {
      output.stdout(
        'eedsh: no installation anchor; the first "eedsh sync" bootstraps one through pnpm or npm, or pass --dsh <package dir|package.json>',
      )
    }
    output.stdout('eedsh: next: eedsh check')
    output.stdout('eedsh: next: eedsh sync')
    output.stdout('eedsh: next: eedsh run')
    return EXIT_OK
  }).pipe(Effect.catch((error) => failWith(asEedshError(error))))
}
