/**
 * Materialization wiring: build the program for one plan and run one one-shot
 * sync. Services come from the invocation's layer, so this module provides no
 * layer of its own.
 * @module @eedsh/cli/command/materialize
 */
import type { ConfigProvenance } from '@eedsh/config'
import type { ProfilePlan } from '@eedsh/plan'
import { Effect } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import type { ChildProcessSpawner } from 'effect/process'
import type { ConfigError } from '../config'
import type { DshInstallationInfo } from '../dsh'
import { resolveDshHome } from '../internal/dsh-home'
import type { MaterializeError } from '../internal/effect/errors'
import {
  Environment,
  type EnvironmentShape,
  type PackageManagerShape,
  type PreflightShape,
  type SyncLockShape,
} from '../internal/effect/services'
import { type MaterializeResult, materialize } from '../materialize/program'
import { provisionPlanSources } from '../provision/plan'
import type { CommandContext } from './context'
import { profileDirFor } from './prepare'
import { cliVersion, runtimeLinkSpec } from './version'

/** The services one materialization program needs. */
export type MaterializeServices =
  | FileSystem.FileSystem
  | PackageManagerShape
  | SyncLockShape
  | PreflightShape
  | ChildProcessSpawner.ChildProcessSpawner

export function programFor(
  env: Record<string, string | undefined>,
  plan: ProfilePlan,
  strict: boolean,
  explain: boolean,
  adoptOwnership: boolean,
  provenance: ConfigProvenance | undefined,
  configDir: string,
  dsh: DshInstallationInfo,
  provisioning: ProvisioningMode,
): Effect.Effect<MaterializeResult, MaterializeError | ConfigError, MaterializeServices> {
  return Effect.gen(function* () {
    // Kept pure-computation seam: the CLI's own runtime dependency.
    const runtimeSpec = yield* Effect.fromResult(runtimeLinkSpec())
    // Provision declared sources before reconciliation so the derived link
    // specifications take part in the same managed dependency decision.
    const provisioned = yield* provisionPlanSources({
      home: resolveDshHome(undefined, env),
      configDir,
      plan,
      ...(provisioning.rebuild ? { rebuild: true } : {}),
      ...(provisioning.noBuild ? { noBuild: true } : {}),
    })
    const result = yield* materialize({
      plan,
      profileDir: profileDirFor(plan, env),
      eedshVersion: cliVersion(),
      dsh,
      runtimeSpec,
      generatedSpec: 'link:./.eedsh/generated',
      strict,
      explain,
      adoptOwnership,
      ...(provenance === undefined ? {} : { provenance }),
      configDir,
      sourceSpecs: provisioned.specs,
    })
    return { ...result, warnings: [...provisioned.warnings, ...result.warnings] }
  })
}

/** The materialization program for one plan, before the layer is provided. */
export function syncProgram(
  env: Record<string, string | undefined>,
  plan: ProfilePlan,
  strict: boolean,
  explain: boolean,
  adoptOwnership: boolean,
  provenance: ConfigProvenance | undefined,
  configDir: string,
  dsh: DshInstallationInfo,
  provisioning: ProvisioningMode,
): Effect.Effect<MaterializeResult, MaterializeError | ConfigError, MaterializeServices> {
  return programFor(
    env,
    plan,
    strict,
    explain,
    adoptOwnership,
    provenance,
    configDir,
    dsh,
    provisioning,
  )
}

/** Run one one-shot materialization against the invocation's services. */
export function syncOnce(
  context: CommandContext,
  strict: boolean,
  explain: boolean,
  adoptOwnership: boolean,
  provisioning: ProvisioningMode,
): Effect.Effect<
  MaterializeResult,
  MaterializeError | ConfigError,
  MaterializeServices | EnvironmentShape
> {
  return Effect.gen(function* () {
    const { env } = yield* Environment
    return yield* syncProgram(
      env,
      context.plan,
      strict,
      explain,
      adoptOwnership,
      context.provenance,
      context.configDir,
      context.installation,
      provisioning,
    )
  })
}

/** Whether provisioning forces preparation or refuses to prepare. */
export interface ProvisioningMode {
  readonly rebuild: boolean
  readonly noBuild: boolean
}

/** The mode for the sync step of a command that takes no provisioning flags. */
export const NO_PROVISIONING_MODE: ProvisioningMode = { rebuild: false, noBuild: false }
