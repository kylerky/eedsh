/**
 * The capability contract the CLI loads from the selected DSH installation.
 * Authoring never reads it: the CLI's bundle resolver owns the loaded value and
 * resolves recorded descriptors against it. The contract stays pure data here
 * so both packages agree on the capability names without importing DSH.
 * @module @eedsh/config/bridge
 */

/** The capabilities every bridge must provide. */
export const REQUIRED_DSH_CAPABILITIES = [
  'resolveProfileDir',
  'resolveBundleDir',
  'readProfileManifest',
  'bundlePatchFiles',
  'loadOverlayPatches',
  'composeEntries',
] as const

/** One required capability name. */
export type DshCapability = (typeof REQUIRED_DSH_CAPABILITIES)[number]

/** The selected installation's absolute paths. */
export interface DshBridgeInstallation {
  readonly installAnchor: string
  readonly packageDir: string
  readonly binPath: string
}

/** A structural bundle manifest read through the bridge. */
export interface DshBridgeManifest {
  readonly version?: string
  readonly dsh?: { readonly bundle?: unknown }
  readonly [key: string]: unknown
}

/** The composition capabilities loaded from the selected DSH installation. */
export interface DshBridge {
  /** The exact selected DSH version. */
  readonly version: string
  /** The selected installation's paths. */
  readonly installation: DshBridgeInstallation
  resolveProfileDir(name: string, home?: string): string
  resolveBundleDir(
    binName: string,
    packageName: string,
    installAnchor: string,
    profileDir: string,
  ): string
  readProfileManifest(binName: string, dir: string): DshBridgeManifest
  bundlePatchFiles(bundle: unknown): string[]
  loadOverlayPatches(binName: string, path: string): unknown[]
  composeEntries(
    layers: readonly (readonly Record<string, unknown>[])[],
    warn?: (message: string) => void,
  ): unknown[]
}
