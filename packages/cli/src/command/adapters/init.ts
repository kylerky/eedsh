/**
 * `eedsh init`: create the XDG config project, install its dependencies, and
 * print what to do next.
 * @module @eedsh/cli/command/adapters/init
 */
import type { InstallationAnchor } from '@eedsh/runtime/installation-anchor'
import { Effect } from 'effect'
import * as Option from 'effect/Option'
import type * as PlatformError from 'effect/PlatformError'
import * as Result from 'effect/Result'
import { configDirectory } from '../../config-path'
import { EXIT_OK } from '../../exit'
import {
  defaultInitServices,
  INIT_PROFILE_NAME,
  type InitError,
  resolveInitDependencySpecs,
  runInit,
} from '../../init'
import {
  anchorForInstallation,
  installationAnchorPathForEnv,
  installationFromSelection,
} from '../../installation-anchor'
import type { DshFailure, PackageInstallFailure } from '../../internal/effect/errors'
import { dshFlag, noInstallFlag } from '../../surface'
import type { CommandRuntime } from '../context'
import type { Parsed } from '../options'

/** The `eedsh init` flag record. */
export const initOptions = { noInstall: noInstallFlag, dsh: dshFlag }

/** The parsed input for {@link runInitCommand}. */
export type InitInput = Parsed<typeof initOptions>

/** Create the XDG config project and print what to do next. */
export function runInitCommand(
  input: InitInput,
  runtime: CommandRuntime,
): Effect.Effect<
  number,
  InitError | PackageInstallFailure | PlatformError.PlatformError | DshFailure
> {
  return Effect.gen(function* () {
    runtime.setFailureContext(undefined)
    let anchorRecord: InstallationAnchor | undefined
    if (Option.isSome(input.dsh)) {
      const selected = installationFromSelection(input.dsh.value, runtime.cwd, {
        requireSupported: true,
      })
      if (Result.isFailure(selected)) return yield* Effect.fail(selected.failure)
      anchorRecord = anchorForInstallation(selected.success, { recordedBy: 'init' })
    }
    const specs = resolveInitDependencySpecs()
    if (Result.isFailure(specs)) return yield* Effect.fail(specs.failure)
    const configDir = configDirectory(runtime.env)
    const anchorPath = installationAnchorPathForEnv(runtime.env)
    const result = yield* runInit({
      configDir,
      specs: specs.success,
      install: !input.noInstall,
      stdout: runtime.stdout,
      anchorPath,
      ...(anchorRecord === undefined ? {} : { anchorRecord }),
      warn: (line: string) => runtime.stderr(line),
    }).pipe(Effect.provide((runtime.options.initServices ?? defaultInitServices)()))

    runtime.stdout(`eedsh: initialized ${configDir}`)
    runtime.stdout(`eedsh: profiles: ${INIT_PROFILE_NAME}`)
    if (result.kept.length > 0) {
      runtime.stdout(`eedsh: kept existing files: ${result.kept.join(', ')}`)
    }
    if (input.noInstall) runtime.stdout(`eedsh: ${result.installCommand}`)
    else runtime.stdout('eedsh: installed dependencies with pnpm')
    if (result.recordedAnchor !== undefined) {
      const version =
        result.recordedAnchor.version === undefined ? '' : ` (DSH ${result.recordedAnchor.version})`
      runtime.stdout(
        `eedsh: recorded installation anchor${version} at ${result.recordedAnchor.installAnchor}`,
      )
    } else if (result.existingAnchor !== undefined) {
      const version =
        result.existingAnchor.version === undefined ? '' : ` (DSH ${result.existingAnchor.version})`
      runtime.stdout(`eedsh: installation: ${result.existingAnchor.installAnchor}${version}`)
    } else {
      runtime.stdout(
        'eedsh: no installation anchor; the first "eedsh sync" bootstraps one through pnpm or npm, or pass --dsh <package dir|package.json>',
      )
    }
    runtime.stdout('eedsh: next: eedsh check')
    runtime.stdout('eedsh: next: eedsh sync')
    runtime.stdout('eedsh: next: eedsh run')
    return EXIT_OK
  })
}
