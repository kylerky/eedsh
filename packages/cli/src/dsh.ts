/**
 * Discovered DSH installation facts. Discovery and bridge loading live in
 * `dsh-discovery` and `dsh-bridge`; bundle resolution for an invocation lives
 * in {@link ./resolve} and runs through the BundleResolver service.
 * @module @eedsh/cli/dsh
 */

export type {
  DiscoverDshOptions,
  DiscoveredDshInstallation,
  DshSource,
} from './dsh-discovery'
export { discoverDshInstallation, validateDshVersion } from './dsh-discovery'
export { SUPPORTED_DSH_RANGE, supportsDshVersion } from './dsh-policy'

/** Resolved facts about one DSH installation. */
export interface DshInstallationInfo {
  /** Installed DSH version. */
  version: string
  /** Absolute path of the DSH package.json, the bundle-resolution anchor. */
  installAnchor: string
  /** Absolute path of the DSH launcher script. */
  binPath: string
}
