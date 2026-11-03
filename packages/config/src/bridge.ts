/**
 * The capability bridge the CLI installs for the selected DSH installation.
 * Authoring queries read bundle contents through it instead of importing DSH
 * directly. The registry uses a global symbol so it is shared by every
 * physical copy of this package loaded in one process.
 * @module @eedsh/config/bridge
 */
import { ResolutionError } from './errors'

/** The global registry key shared across `@eedsh/config` module instances. */
export const DSH_BRIDGE_KEY = Symbol.for('@eedsh/config.dsh-bridge')

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

function store(): Record<PropertyKey, unknown> {
  return globalThis as unknown as Record<PropertyKey, unknown>
}

/**
 * Install the bridge for the selected installation, replacing any earlier one.
 * @param bridge - the validated bridge.
 */
export function installDshBridge(bridge: DshBridge): void {
  store()[DSH_BRIDGE_KEY] = bridge
}

/** Remove the active bridge. Each invocation installs its own. */
export function clearDshBridge(): void {
  delete store()[DSH_BRIDGE_KEY]
}

/**
 * The active bridge, when the CLI installed one.
 * @returns the bridge, or undefined outside eedsh.
 */
export function activeDshBridge(): DshBridge | undefined {
  const value = store()[DSH_BRIDGE_KEY]
  if (value === null || typeof value !== 'object') return undefined
  return value as DshBridge
}

/**
 * Return one required capability, or fail with the tagged bridge failure.
 * @param bridge - the active bridge.
 * @param capability - the capability name.
 * @param bundle - the query's bundle, for the diagnostic.
 * @returns the callable capability.
 */
export function bridgeCapability<K extends DshCapability>(
  bridge: DshBridge,
  capability: K,
  bundle: string,
): DshBridge[K] {
  const value = bridge[capability]
  if (typeof value !== 'function') {
    throw new ResolutionError({
      code: 'resolution.bridge_capability_missing',
      bundle,
      message: `the active DSH bridge is missing the "${capability}" capability; reinstall or select another DSH installation`,
    })
  }
  return value as DshBridge[K]
}

/**
 * The exact version of the selected DSH installation. It reads the active
 * bridge only and never selects or installs DSH.
 * @returns the selected version.
 * @throws {ResolutionError} with `resolution.bridge_missing` without a bridge.
 */
export function dshVersion(): string {
  const bridge = activeDshBridge()
  if (bridge === undefined) {
    throw new ResolutionError({
      code: 'resolution.bridge_missing',
      bundle: '',
      message:
        'dshVersion() needs the active DSH installation; run "eedsh sync" or "eedsh run", or select one with --dsh <path>',
    })
  }
  return bridge.version
}
