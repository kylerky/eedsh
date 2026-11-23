/**
 * The data one command passes down to the programs it runs: the resolved config
 * path, the installation selected for the invocation, the plan being
 * materialized, and the provenance the evaluated config recorded. Capabilities
 * are services, so this module holds no seams.
 * @module @eedsh/cli/command/context
 */
import type { ConfigProvenance } from '@eedsh/config'
import type { ProfilePlan } from '@eedsh/plan'
import type * as Option from 'effect/Option'
import type { DiscoveredDshInstallation } from '../dsh-discovery'

/** Everything one materialization pass needs besides its mode. */
export interface CommandContext {
  configPath: string
  installation: DiscoveredDshInstallation
  plan: ProfilePlan
  /** The evaluated config's recorded provenance, when it has any. */
  provenance: ConfigProvenance | undefined
  /** Absolute directory of the evaluated config file. */
  configDir: string
  /** The `--profile` value the run was started with, for watch reruns. */
  profile: Option.Option<string>
}
