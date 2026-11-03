/**
 * The discovered DSH installation's bundle resolution. Discovery and bridge
 * loading live in `dsh-discovery` and `dsh-bridge`; this module reads the
 * installed bundles through the active bridge so the service layer stays thin.
 * @module @eedsh/cli/dsh
 */
import { join } from 'node:path'
import { activeDshBridge, bridgeCapability } from '@eedsh/config'
import * as Result from 'effect/Result'
import { DshResolveFailure } from './internal/effect/errors'

export { SUPPORTED_DSH_RANGE, supportsDshVersion } from './dsh-policy'
export { discoverDshInstallation, validateDshVersion } from './dsh-discovery'
export type {
  DiscoveredDshInstallation,
  DiscoverDshOptions,
  DshSource,
} from './dsh-discovery'

/** Resolved facts about one DSH installation. */
export interface DshInstallationInfo {
  /** Installed DSH version. */
  version: string
  /** Absolute path of the DSH package.json, the bundle-resolution anchor. */
  installAnchor: string
  /** Absolute path of the DSH launcher script. */
  binPath: string
}

/**
 * Read the ordered patch lists a selected bundle contributes, resolving the
 * bundle from the DSH installation first and the profile second, exactly as
 * boot does.
 * @param packageName - the bundle package name.
 * @param profileDir - absolute profile directory.
 * @param installAnchor - absolute DSH package.json path.
 * @returns the bundle's patches in application order, or a resolution failure.
 */
export function resolveBundleLayers(
  packageName: string,
  profileDir: string,
  installAnchor: string,
): Result.Result<Record<string, unknown>[], DshResolveFailure> {
  const bridge = activeDshBridge()
  if (bridge === undefined) {
    return Result.fail(
      new DshResolveFailure({
        packageName,
        cause: new Error(
          'bundle resolution needs the active DSH bridge; run "eedsh sync" or "eedsh run", or select one with --dsh',
        ),
      }),
    )
  }
  return Result.try({
    try: () => {
      const resolveBundleDir = bridgeCapability(bridge, 'resolveBundleDir', packageName)
      const packageDir = resolveBundleDir('eedsh', packageName, installAnchor, profileDir)
      const readManifest = bridgeCapability(bridge, 'readProfileManifest', packageName)
      const manifest = readManifest('eedsh', packageDir)
      const bundle = manifest.dsh?.bundle
      if (bundle === undefined) {
        throw new Error(`profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle`)
      }
      const files = bridgeCapability(bridge, 'bundlePatchFiles', packageName)(bundle)
      const loadPatches = bridgeCapability(bridge, 'loadOverlayPatches', packageName)
      return files.flatMap((file) => loadPatches('eedsh', join(packageDir, file))) as Record<
        string,
        unknown
      >[]
    },
    catch: (cause) => new DshResolveFailure({ packageName, cause }),
  })
}