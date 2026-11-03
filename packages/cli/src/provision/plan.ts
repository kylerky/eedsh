/**
 * Provision every source one plan declares, in declaration order, and derive
 * the profile dependency specification for each. A source's specification is a
 * link to its provisioned directory, computed here because this is where the
 * DSH home and the published profile are both known.
 * @module @eedsh/cli/provision/plan
 */
import type { ProfilePlan } from '@eedsh/plan'
import { Effect } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'
import type { ChildProcessSpawner } from 'effect/process'
import type { ProvisionFailure, SyncLocked } from '../internal/effect/errors'
import type { SyncLockShape } from '../internal/effect/services'
import type { ProvisionCommand } from './command'
import { type ProvisionedSource, provisionSource } from './git'
import { sourceLinkSpec } from './source'

/** Inputs for {@link provisionPlanSources}. */
export interface ProvisionPlanSourcesInput {
  /** The absolute DSH home. */
  readonly home: string
  /** The absolute directory holding the config file. */
  readonly configDir: string
  /** The validated plan. */
  readonly plan: ProfilePlan
  /** Override the command seam; defaults to the core child-process runner. */
  readonly command?: ProvisionCommand
  /** Force preparation even when the recorded state is unchanged. */
  readonly rebuild?: boolean
  /** Fail instead of preparing when preparation would be needed. */
  readonly noBuild?: boolean
  /** Receives non-fatal provisioning warnings. */
  readonly warn?: (message: string) => void
  /** Override the recorded preparation time, for tests. */
  readonly now?: () => Date
}

/** What provisioning every declared source produced. */
export interface ProvisionedPlanSources {
  readonly sources: readonly ProvisionedSource[]
  /** The derived dependency specifications, keyed by package name. */
  readonly specs: Record<string, string>
  readonly warnings: readonly string[]
}

/**
 * Provision every source the plan declares.
 * @param input - the plan, the DSH home, the config directory, and the seams.
 * @returns the provisioned sources, their derived link specifications, and warnings.
 */
export function provisionPlanSources(
  input: ProvisionPlanSourcesInput,
): Effect.Effect<
  ProvisionedPlanSources,
  ProvisionFailure | PlatformError.PlatformError | SyncLocked,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | SyncLockShape
> {
  return Effect.gen(function* () {
    const sources: ProvisionedSource[] = []
    const warnings: string[] = []
    for (const [name, declaration] of Object.entries(input.plan.sources ?? {})) {
      const source = yield* provisionSource({
        home: input.home,
        configDir: input.configDir,
        name,
        declaration,
        ...(input.command === undefined ? {} : { command: input.command }),
        ...(input.rebuild === undefined ? {} : { rebuild: input.rebuild }),
        ...(input.noBuild === undefined ? {} : { noBuild: input.noBuild }),
        ...(input.now === undefined ? {} : { now: input.now }),
        ...(input.warn === undefined ? {} : { warn: input.warn }),
      })
      sources.push(source)
      warnings.push(...source.warnings)
    }
    return {
      sources,
      specs: Object.fromEntries(
        sources.map((source) => [source.name, sourceLinkSpec(source.checkoutDir)]),
      ),
      warnings,
    }
  })
}
