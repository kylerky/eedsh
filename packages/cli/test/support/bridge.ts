import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DshBridge } from '@eedsh/config'
import type { DiscoveredDshInstallation } from '../../src/dsh'

/**
 * Load a real capability bridge from the workspace's dev-only DSH copy. The
 * value is returned to the caller; nothing global is installed.
 * @param version - the selected installation version.
 * @returns the loaded bridge.
 */
export async function loadTestBridge(version = '0.2.1-rc.2'): Promise<DshBridge> {
  const require = createRequire(import.meta.url)
  const anchor = require.resolve('@deepseek-ai/dsh/package.json')
  const boot = (await import(
    pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href
  )) as Record<string, (...args: never[]) => unknown>
  return {
    version,
    installation: {
      installAnchor: anchor,
      packageDir: dirname(anchor),
      binPath: require.resolve('@deepseek-ai/dsh/lib/bin.js'),
    },
    resolveProfileDir: boot.resolveProfileDir as DshBridge['resolveProfileDir'],
    resolveBundleDir: boot.resolveBundleDir as DshBridge['resolveBundleDir'],
    readProfileManifest: boot.readProfileManifest as DshBridge['readProfileManifest'],
    bundlePatchFiles: boot.bundlePatchFiles as DshBridge['bundlePatchFiles'],
    loadOverlayPatches: boot.loadOverlayPatches as DshBridge['loadOverlayPatches'],
    composeEntries: boot.composeEntries as DshBridge['composeEntries'],
  }
}

/**
 * The workspace's dev-only DSH installation as a discovery result.
 * @returns the selected installation.
 */
export function devDshInstallation(): DiscoveredDshInstallation {
  const require = createRequire(import.meta.url)
  const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')
  const manifest = JSON.parse(readFileSync(installAnchor, 'utf8')) as { version: string }
  const binPath = require.resolve('@deepseek-ai/dsh/lib/bin.js')
  return {
    version: manifest.version,
    installAnchor,
    packageDir: dirname(installAnchor),
    binPath,
    launcher: binPath,
    source: 'project',
  }
}
