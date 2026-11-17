/**
 * Materialization wiring: build the program for one plan, provide it a service
 * layer, and run one one-shot sync.
 * @module @eedsh/cli/command/materialize
 */
import type { ConfigProvenance } from '@eedsh/config'
import type { ProfilePlan } from '@eedsh/plan'
import { Effect } from 'effect'
import type { ConfigError } from '../config'
import type { DiscoveredDshInstallation } from '../dsh'
import { resolveDshHome } from '../internal/dsh-home'
import type { DshFailure, MaterializeError } from '../internal/effect/errors'
import { type MaterializeResult, materialize } from '../materialize/program'
import { provisionPlanSources } from '../provision/plan'
import {
  type CliRunOptions,
  type CliService,
  type CliServiceLayer,
  type CommandContext,
  defaultServices,
} from './context'
import { profileDirFor } from './prepare'
import { cliVersion, runtimeLinkSpec } from './version'

export function programFor(
  env: Record<string, string | undefined>,
  plan: ProfilePlan,
  strict: boolean,
  explain: boolean,
  adoptOwnership: boolean,
  provenance: ConfigProvenance | undefined,
  configDir: string,
  provisioning: ProvisioningMode,
): Effect.Effect<MaterializeResult, MaterializeError | ConfigError, CliService> {
  return Effect.gen(function* () {
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

/** Build the materializer's service layer for one command invocation. */
export function serviceLayerFor(
  options: CliRunOptions,
  installation: DiscoveredDshInstallation,
): CliServiceLayer {
  if (options.services !== undefined) return options.services()
  return defaultServices(installation)
}

/** The materialization program before its service layer is provided. */
export function syncProgram(
  env: Record<string, string | undefined>,
  plan: ProfilePlan,
  strict: boolean,
  explain: boolean,
  adoptOwnership: boolean,
  provenance: ConfigProvenance | undefined,
  configDir: string,
  provisioning: ProvisioningMode,
): Effect.Effect<MaterializeResult, MaterializeError | ConfigError, CliService> {
  return programFor(env, plan, strict, explain, adoptOwnership, provenance, configDir, provisioning)
}

/** Run one one-shot materialization with its own service layer. */
export function syncOnce(
  context: CommandContext,
  strict: boolean,
  explain: boolean,
  adoptOwnership: boolean,
  provisioning: ProvisioningMode,
): Effect.Effect<MaterializeResult, MaterializeError | ConfigError | DshFailure> {
  return Effect.suspend(() =>
    syncProgram(
      context.env,
      context.plan,
      strict,
      explain,
      adoptOwnership,
      context.provenance,
      context.configDir,
      provisioning,
    ).pipe(Effect.provide(serviceLayerFor(context.options, context.installation))),
  )
}

/** Whether provisioning forces preparation or refuses to prepare. */
export interface ProvisioningMode {
  readonly rebuild: boolean
  readonly noBuild: boolean
}

/** The mode for the sync step of a command that takes no provisioning flags. */
export const NO_PROVISIONING_MODE: ProvisioningMode = { rebuild: false, noBuild: false }
