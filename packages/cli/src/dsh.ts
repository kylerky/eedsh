/**
 * The pinned DSH installation: its launcher, version, and bundle resolution.
 * Node resolution happens here so the Effect service layer stays thin.
 * @module @eedsh/cli/dsh
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { activeDshBridge, bridgeCapability } from '@eedsh/config'
import { Option } from 'effect'
import * as Result from 'effect/Result'
import { DshResolveFailure } from './internal/effect/errors'
import { readVersion } from './internal/schema-readers'

export { SUPPORTED_DSH_RANGE, supportsDshVersion } from './dsh-policy'
export { discoverDshInstallation, validateDshVersion } from './dsh-discovery'
export type {
  DiscoveredDshInstallation,
  DiscoverDshOptions,
  DshSource,
} from './dsh-discovery'

/** Resolved facts about the DSH installation this CLI is pinned to. */
export interface DshInstallationInfo {
  /** Installed DSH version. */
  version: string
  /** Absolute path of the DSH package.json, the first bundle-resolution anchor. */
  installAnchor: string
  /** Absolute path of the DSH launcher script. */
  binPath: string
}

/**
 * Resolve the pinned `@deepseek-ai/dsh` package from this CLI's own
 * dependencies.
 * @returns a success Result carrying the installation's version, manifest
 * anchor, and launcher path, or a resolution failure.
 */
export function resolveDshInstallation(): Result.Result<DshInstallationInfo, DshResolveFailure> {
  return Result.try({
    try: () => {
      const require = createRequire(import.meta.url)
      const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')
      const manifest = JSON.parse(readFileSync(installAnchor, 'utf8')) as { version?: unknown }
      return {
        version: Option.getOrElse(readVersion(manifest.version), () => 'unknown'),
        installAnchor,
        binPath: require.resolve('@deepseek-ai/dsh/lib/bin.js'),
      }
    },
    catch: (cause) => new DshResolveFailure({ packageName: '@deepseek-ai/dsh', cause }),
  })
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
