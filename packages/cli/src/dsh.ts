/**
 * The pinned DSH installation: its launcher, version, and bundle resolution.
 * Node resolution happens here so the Effect service layer stays thin.
 * @module @eedsh/cli/dsh
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
  bundlePatchFiles,
  loadOverlayPatches,
  readProfileManifest,
  resolveBundleDir,
} from '@deepseek-ai/dsh-app-boot'

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
 * @returns the installation's version, manifest anchor, and launcher path.
 */
export function resolveDshInstallation(): DshInstallationInfo {
  const require = createRequire(import.meta.url)
  const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')
  const manifest = JSON.parse(readFileSync(installAnchor, 'utf8')) as { version?: unknown }
  return {
    version: typeof manifest.version === 'string' ? manifest.version : 'unknown',
    installAnchor,
    binPath: require.resolve('@deepseek-ai/dsh/lib/bin.js'),
  }
}

/**
 * Read the ordered patch lists a selected bundle contributes, resolving the
 * bundle from the DSH installation first and the profile second, exactly as
 * boot does.
 * @param packageName - the bundle package name.
 * @param profileDir - absolute profile directory.
 * @param installAnchor - absolute DSH package.json path.
 * @returns the bundle's patches in application order.
 * @throws when the bundle cannot be resolved or declares no dsh.bundle.
 */
export function resolveBundleLayers(
  packageName: string,
  profileDir: string,
  installAnchor: string,
): Record<string, unknown>[] {
  const packageDir = resolveBundleDir('eedsh', packageName, installAnchor, profileDir)
  const manifest = readProfileManifest('eedsh', packageDir)
  const bundle = manifest.dsh?.bundle
  if (bundle === undefined) {
    throw new Error(`profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle`)
  }
  const files = bundlePatchFiles(bundle as Parameters<typeof bundlePatchFiles>[0])
  return files.flatMap((file) => loadOverlayPatches('eedsh', join(packageDir, file))) as Record<
    string,
    unknown
  >[]
}
