/**
 * Synchronous author-time bundle resolution. A query reads the rows a bundle
 * contributes through the capability bridge for the active DSH installation,
 * from a profile's installed copy, or from a package directory. Results are
 * detached JSON data; every failure is a tagged {@link ResolutionError} with a
 * stable code.
 * @module @eedsh/config/resolve
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  activeDshBridge,
  bridgeCapability,
  type DshBridge,
  REQUIRED_DSH_CAPABILITIES,
} from './bridge'
import type { PlanEntry } from './builders'
import { ResolutionError } from './errors'

export { ResolutionError, type ResolutionErrorCode } from './errors'

/** The environment variable that selects a DSH installation explicitly. */
export const DSH_ANCHOR_ENV = 'EEDSH_DSH_ANCHOR'

/** The environment variable naming the config project's directory. */
export const CONFIG_DIR_ENV = 'EEDSH_CONFIG_DIR'

/** The session-local profile-root override, a JSON object of name to directory. */
export const PROFILE_ROOT_OVERRIDE_ENV = 'EEDSH_PROFILE_ROOT_OVERRIDE'

/** One query root. Supply at most one of `profile` and `packageDir`. */
export interface QueryRoot {
  /** A profile name under the shared DSH home. */
  readonly profile?: string
  /** A package directory, absolute or relative to the containing config file. */
  readonly packageDir?: string
}

/** Where a resolved bundle came from. */
export type ResolutionOrigin = 'active' | 'profile' | 'packageDir' | 'preview'

/** The facts behind one successful bundle resolution. */
export interface ResolvedBundle {
  /** The queried bundle package name. */
  readonly bundle: string
  /** Absolute directory of the bundle package. */
  readonly packageDir: string
  /** Absolute path of the bundle's package.json. */
  readonly manifestPath: string
  /** The bundle package version, or `unknown` when it declares none. */
  readonly version: string
  /** The selected root. */
  readonly origin: ResolutionOrigin
  /** The profile name for a profile or preview root. */
  readonly profile?: string
  /** The composed rows the bundle declares, as frozen JSON. */
  readonly rows: readonly PlanEntry[]
}

/** One resolution event, used by the REPL to print provenance. */
export interface ResolutionTrace {
  readonly bundle: string
  readonly packageDir: string
  readonly manifestPath: string
  readonly version: string
  readonly origin: ResolutionOrigin
  readonly profile?: string
}

interface BundleManifest {
  readonly name?: string
  readonly version?: string
  readonly dsh?: {
    readonly bundle?: { readonly patch?: string | readonly string[] }
  }
  readonly [key: string]: unknown
}

const TRACE_KEY = Symbol.for('@eedsh/config.resolution-trace')

function traceStore(): ResolutionTrace[] {
  const global = globalThis as typeof globalThis & { [key: symbol]: unknown }
  const existing = global[TRACE_KEY]
  if (Array.isArray(existing)) return existing as ResolutionTrace[]
  const created: ResolutionTrace[] = []
  global[TRACE_KEY] = created
  return created
}

/** Read the resolution events recorded since the last clear, without clearing. */
export function resolutionTrace(): readonly ResolutionTrace[] {
  return [...traceStore()]
}

/** Read and clear the resolution events. */
export function takeResolutionTrace(): ResolutionTrace[] {
  return traceStore().splice(0, traceStore().length)
}

/** Clear the resolution event log. */
export function clearResolutionTrace(): void {
  traceStore().splice(0, traceStore().length)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * Convert DSH's parsed runtime-expression marker to the plan's expression
 * node. The conversion is shape-exact: only a record whose sole key is
 * `__jsExpr` with a string value is converted, so every other opaque config
 * value stays untouched.
 * @param value - one detached bundle row.
 * @returns the row with plan expression nodes.
 */
function planExpressionNodes<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => planExpressionNodes(item)) as T
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.length === 1 && keys[0] === '__jsExpr' && typeof record.__jsExpr === 'string') {
      return { $eedsh: { expr: record.__jsExpr } } as T
    }
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(record)) out[key] = planExpressionNodes(item)
    return out as T
  }
  return value
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item)
  }
  return value
}

function requireBridge(bundle: string): DshBridge {
  const bridge = activeDshBridge()
  if (bridge === undefined) {
    throw new ResolutionError({
      code: 'resolution.bridge_missing',
      bundle,
      message: `bundle queries need the active DSH installation; run "eedsh sync" or "eedsh run", or select one with --dsh <path>`,
    })
  }
  for (const capability of REQUIRED_DSH_CAPABILITIES) {
    bridgeCapability(bridge, capability, bundle)
  }
  return bridge
}

/** The config file's directory for a relative package root. */
function configDirectory(): string {
  const configured = process.env[CONFIG_DIR_ENV]
  if (configured !== undefined && isAbsolute(configured)) return configured
  const stack = new Error().stack ?? ''
  for (const line of stack.split('\n').slice(1)) {
    const match = line.match(/(file:\/\/[^):]+|\/[^):]+\.(?:ts|tsx|js|mjs|cjs))(?::\d+){1,2}/)
    if (match === null) continue
    const raw = match[1] as string
    const path = raw.startsWith('file:') ? fileURLToPath(raw) : raw
    if (path.includes('/packages/config/src/') || path.includes('/@eedsh/config/')) continue
    if (path.includes('node:internal') || path.includes('/node_modules/')) continue
    return dirname(path)
  }
  return process.cwd()
}

/** Resolve a package directory through one manifest's Node resolution paths. */
function packageDirFromAnchor(anchor: string, packageName: string): string | undefined {
  for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

function rootOverride(): Record<string, string> {
  const raw = process.env[PROFILE_ROOT_OVERRIDE_ENV]
  if (raw === undefined || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value !== '') out[name] = value
    }
    return out
  } catch {
    return {}
  }
}

function profileDirectory(profile: string, bundle: string, bridge: DshBridge): string {
  const override = rootOverride()[profile]
  if (override !== undefined) return override
  try {
    const resolveProfileDir = bridgeCapability(bridge, 'resolveProfileDir', bundle)
    return resolveProfileDir(profile)
  } catch (cause) {
    throw new ResolutionError({
      code: 'resolution.profile_invalid',
      bundle,
      profile,
      message: `profile ${JSON.stringify(profile)} is not a usable profile name: ${messageOf(cause)}`,
    })
  }
}

function explicitRoot(
  bundle: string,
  root: QueryRoot,
  bridge: DshBridge,
): { packageDir: string; origin: ResolutionOrigin; profile?: string } {
  if (root.profile !== undefined && root.packageDir !== undefined) {
    throw new ResolutionError({
      code: 'resolution.root_conflict',
      bundle,
      message: `bundle ${JSON.stringify(bundle)} names both { profile } and { packageDir }; supply exactly one root`,
    })
  }
  if (root.profile !== undefined) {
    const profile = root.profile
    const override = rootOverride()[profile]
    const dir = profileDirectory(profile, bundle, bridge)
    const profileManifest = join(dir, 'package.json')
    if (!existsSync(profileManifest)) {
      throw new ResolutionError({
        code:
          override === undefined
            ? 'resolution.profile_missing'
            : 'resolution.profile_override_invalid',
        bundle,
        profile,
        path: dir,
        message:
          override === undefined
            ? `profile ${JSON.stringify(profile)} has no installed manifest at ${profileManifest}; install the profile first`
            : `the session preview for profile ${JSON.stringify(profile)} is missing at ${dir}; run .resolve again`,
      })
    }
    const packageDir = packageDirFromAnchor(profileManifest, bundle)
    if (packageDir === undefined) {
      throw new ResolutionError({
        code: 'resolution.bundle_not_installed',
        bundle,
        profile,
        path: dir,
        message: `profile ${JSON.stringify(profile)} has not installed bundle ${JSON.stringify(bundle)}; pass { packageDir } for a checkout or use the session .resolve command`,
      })
    }
    return {
      packageDir,
      origin: override === undefined ? 'profile' : 'preview',
      profile,
    }
  }
  if (root.packageDir !== undefined) {
    const absolute = isAbsolute(root.packageDir)
      ? root.packageDir
      : resolvePath(configDirectory(), root.packageDir)
    return { packageDir: absolute, origin: 'packageDir' }
  }
  return { packageDir: '', origin: 'active' }
}

function assertPackageDir(
  bundle: string,
  packageDir: string,
  origin: ResolutionOrigin,
  profile?: string,
): string {
  const manifestPath = join(packageDir, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new ResolutionError({
      code:
        origin === 'packageDir' ? 'resolution.package_dir_missing' : 'resolution.bundle_not_found',
      bundle,
      path: manifestPath,
      ...(profile === undefined ? {} : { profile }),
      message:
        origin === 'packageDir'
          ? `bundle directory ${packageDir} for ${JSON.stringify(bundle)} has no package.json`
          : `bundle ${JSON.stringify(bundle)} has no readable package manifest at ${manifestPath}`,
    })
  }
  return manifestPath
}

function loadRows(
  bundle: string,
  manifest: BundleManifest,
  packageDir: string,
  bridge: DshBridge,
): readonly PlanEntry[] {
  const declaration = manifest.dsh?.bundle
  if (declaration === undefined) {
    throw new ResolutionError({
      code: 'resolution.not_a_bundle',
      bundle,
      path: packageDir,
      message: `package ${JSON.stringify(bundle)} at ${packageDir} declares no dsh.bundle`,
    })
  }
  let files: string[]
  try {
    const readPatchFiles = bridgeCapability(bridge, 'bundlePatchFiles', bundle)
    files = readPatchFiles(declaration)
  } catch (cause) {
    throw new ResolutionError({
      code: 'resolution.patch_invalid',
      bundle,
      path: packageDir,
      message: `bundle ${JSON.stringify(bundle)} declares an invalid patch set: ${messageOf(cause)}`,
    })
  }
  const layers: Record<string, unknown>[][] = []
  for (const file of files) {
    const path = join(packageDir, file)
    try {
      const readPatches = bridgeCapability(bridge, 'loadOverlayPatches', bundle)
      layers.push(readPatches('eedsh', path) as Record<string, unknown>[])
    } catch (cause) {
      throw new ResolutionError({
        code: 'resolution.patch_invalid',
        bundle,
        path,
        message: `cannot read patch file ${path} for bundle ${JSON.stringify(bundle)}: ${messageOf(cause)}`,
      })
    }
  }
  try {
    const compose = bridgeCapability(bridge, 'composeEntries', bundle)
    const entries = compose(layers)
    const detached = planExpressionNodes(jsonClone(entries))
    return deepFreeze(detached) as unknown as PlanEntry[]
  } catch (cause) {
    throw new ResolutionError({
      code: 'resolution.patch_invalid',
      bundle,
      path: packageDir,
      message: `cannot compose patches for bundle ${JSON.stringify(bundle)}: ${messageOf(cause)}`,
    })
  }
}

/**
 * Resolve one bundle and compose its declared rows. No result is cached, so a
 * changed anchor or profile is observed by the next query.
 * @param bundle - bundle package name.
 * @param root - optional explicit profile or package directory root.
 * @returns the package provenance and frozen rows.
 */
export function resolveBundle(bundle: string, root: QueryRoot = {}): ResolvedBundle {
  const bridge = requireBridge(bundle)
  const selected = explicitRoot(bundle, root, bridge)
  let packageDir = selected.packageDir
  const origin = selected.origin
  if (origin === 'active') {
    const anchor = bridge.installation.installAnchor
    const installed = packageDirFromAnchor(anchor, bundle)
    if (installed === undefined) {
      throw new ResolutionError({
        code: 'resolution.bundle_not_found',
        bundle,
        path: anchor,
        message: `bundle ${JSON.stringify(bundle)} is not shipped by the active DSH installation at ${anchor}; pass { profile } or { packageDir } as an explicit root`,
      })
    }
    packageDir = installed
  }
  const manifestPath = assertPackageDir(bundle, packageDir, origin, selected.profile)
  let manifest: BundleManifest
  try {
    const readManifest = bridgeCapability(bridge, 'readProfileManifest', bundle)
    manifest = readManifest('eedsh', packageDir) as BundleManifest
  } catch (cause) {
    throw new ResolutionError({
      code:
        origin === 'packageDir' ? 'resolution.package_dir_invalid' : 'resolution.bundle_not_found',
      bundle,
      path: manifestPath,
      ...(selected.profile === undefined ? {} : { profile: selected.profile }),
      message: `cannot read the manifest of bundle ${JSON.stringify(bundle)} at ${manifestPath}: ${messageOf(cause)}`,
    })
  }
  const rows = loadRows(bundle, manifest, packageDir, bridge)
  const version = typeof manifest.version === 'string' ? manifest.version : 'unknown'
  const trace: ResolutionTrace = {
    bundle,
    packageDir,
    manifestPath,
    version,
    origin,
    ...(selected.profile === undefined ? {} : { profile: selected.profile }),
  }
  traceStore().push(trace)
  return deepFreeze({
    bundle,
    packageDir,
    manifestPath,
    version,
    origin,
    ...(selected.profile === undefined ? {} : { profile: selected.profile }),
    rows,
  })
}