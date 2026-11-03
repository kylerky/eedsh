import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { clearDshBridge, type DshBridge, installDshBridge } from '@eedsh/config'

/**
 * Install a real capability bridge from the workspace's dev-only DSH copy.
 * Tests that exercise composition or authoring queries call this once.
 * @param version - the selected installation version.
 * @returns the installed bridge.
 */
export async function installTestBridge(version = '0.2.1-rc.2'): Promise<DshBridge> {
  const require = createRequire(import.meta.url)
  const anchor = require.resolve('@deepseek-ai/dsh/package.json')
  const boot = (await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)) as Record<
    string,
    (...args: never[]) => unknown
  >
  const bridge: DshBridge = {
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
  installDshBridge(bridge)
  return bridge
}

export { clearDshBridge, clearDshBridge as clearTestBridge }
