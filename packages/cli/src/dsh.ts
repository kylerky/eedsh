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
import { Option } from 'effect'
import * as Result from 'effect/Result'
import { DshResolveFailure } from './internal/effect/errors'
import { readVersion } from './internal/schema-readers'

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
  const resolved = Result.try({
    try: () => {
      const packageDir = resolveBundleDir('eedsh', packageName, installAnchor, profileDir)
      const manifest = readProfileManifest('eedsh', packageDir)
      return { packageDir, bundle: manifest.dsh?.bundle }
    },
    catch: (cause) => new DshResolveFailure({ packageName, cause }),
  })
  if (Result.isFailure(resolved)) return Result.fail(resolved.failure)
  const { packageDir, bundle } = resolved.success
  if (bundle === undefined) {
    return Result.fail(
      new DshResolveFailure({
        packageName,
        cause: new Error(`profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle`),
      }),
    )
  }
  return Result.try({
    try: () => {
      const files = bundlePatchFiles(bundle as Parameters<typeof bundlePatchFiles>[0])
      return files.flatMap((file) => loadOverlayPatches('eedsh', join(packageDir, file))) as Record<
        string,
        unknown
      >[]
    },
    catch: (cause) => new DshResolveFailure({ packageName, cause }),
  })
}
