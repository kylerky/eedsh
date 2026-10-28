/**
 * Synchronous author-time bundle resolution. A query reads the rows a bundle
 * contributes from one explicit root: the pinned DSH installation named by
 * `EEDSH_DSH_ANCHOR`, a profile's installed copy, or a package directory.
 * Results are detached JSON data; every failure is a tagged
 * {@link ResolutionError} with a stable code.
 * @module @eedsh/config/resolve
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bundlePatchFiles,
  composeEntries,
  loadOverlayPatches,
  resolveProfileDir,
} from '@deepseek-ai/dsh-app-boot'
import type { PlanEntry } from './api'

/** The environment variable naming the pinned DSH installation's manifest. */
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
export type ResolutionOrigin = 'pinned' | 'profile' | 'packageDir' | 'preview'

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

/** Stable failure codes for author-time resolution. */
export type ResolutionErrorCode =
  | 'resolution.anchor_missing'
  | 'resolution.anchor_unreadable'
  | 'resolution.anchor_invalid'
  | 'resolution.root_conflict'
  | 'resolution.profile_invalid'
  | 'resolution.profile_missing'
  | 'resolution.bundle_not_installed'
  | 'resolution.bundle_not_found'
  | 'resolution.package_dir_missing'
  | 'resolution.package_dir_invalid'
  | 'resolution.not_a_bundle'
  | 'resolution.patch_invalid'
  | 'resolution.row_not_found'
  | 'resolution.profile_override_invalid'

/** A structured author-time resolution failure. */
export class ResolutionError extends Error {
  readonly _tag = 'ResolutionError'
  readonly code: ResolutionErrorCode
  readonly bundle: string
  readonly path?: string
  readonly profile?: string

  constructor(input: {
    readonly code: ResolutionErrorCode
    readonly bundle: string
    readonly message: string
    readonly path?: string
    readonly profile?: string
  }) {
    super(input.message)
    this.name = 'ResolutionError'
    this.code = input.code
    this.bundle = input.bundle
    if (input.path !== undefined) this.path = input.path
    if (input.profile !== undefined) this.profile = input.profile
  }
}

interface DshManifest {
  readonly name: string
  readonly version?: string
  readonly [key: string]: unknown
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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item)
  }
  return value
}

function readJsonObject(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (!isRecord(parsed)) throw new Error('manifest must hold a JSON object')
  return parsed
}

function manifestPathAt(input: string): string {
  const absolute = isAbsolute(input) ? input : resolvePath(input)
  try {
    return statSync(absolute).isDirectory() ? join(absolute, 'package.json') : absolute
  } catch (cause) {
    throw new Error(`cannot read ${absolute}: ${messageOf(cause)}`)
  }
}

function anchorManifest(bundle: string): { path: string; manifest: DshManifest } {
  const configured = process.env[DSH_ANCHOR_ENV]
  if (configured === undefined || configured.trim() === '') {
    throw new ResolutionError({
      code: 'resolution.anchor_missing',
      bundle,
      message: `${DSH_ANCHOR_ENV} is not set; bundle queries need the pinned DSH installation (set ${DSH_ANCHOR_ENV} to its package.json)`,
    })
  }
  let path: string
  try {
    path = manifestPathAt(configured)
  } catch (cause) {
    throw new ResolutionError({
      code: 'resolution.anchor_unreadable',
      bundle,
      path: configured,
      message: `cannot read ${DSH_ANCHOR_ENV} at ${configured}: ${messageOf(cause)}`,
    })
  }
  let manifest: Record<string, unknown>
  try {
    manifest = readJsonObject(path)
  } catch (cause) {
    throw new ResolutionError({
      code: 'resolution.anchor_unreadable',
      bundle,
      path,
      message: `cannot read ${DSH_ANCHOR_ENV} at ${path}: ${messageOf(cause)}`,
    })
  }
  const name = manifest.name
  if (name !== '@deepseek-ai/dsh' && name !== 'dsh') {
    throw new ResolutionError({
      code: 'resolution.anchor_invalid',
      bundle,
      path,
      message: `${DSH_ANCHOR_ENV} points at ${path}, which is not a DSH package manifest (name ${JSON.stringify(name)})`,
    })
  }
  return { path, manifest: manifest as DshManifest }
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

function profileDirectory(profile: string, bundle: string): string {
  const override = rootOverride()[profile]
  if (override !== undefined) return override
  try {
    const home = process.env.DSH_HOME
    return home === undefined || home.trim() === ''
      ? resolveProfileDir(profile)
      : resolveProfileDir(profile, home)
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
    const dir = profileDirectory(profile, bundle)
    const profileManifest = join(dir, 'package.json')
    if (!existsSync(profileManifest)) {
      throw new ResolutionError({
        code: override === undefined ? 'resolution.profile_missing' : 'resolution.profile_override_invalid',
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
  return { packageDir: '', origin: 'pinned' }
}

function assertPackageDir(bundle: string, packageDir: string, origin: ResolutionOrigin, profile?: string): string {
  const manifestPath = join(packageDir, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new ResolutionError({
      code: origin === 'packageDir' ? 'resolution.package_dir_missing' : 'resolution.bundle_not_found',
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

function loadRows(bundle: string, manifest: BundleManifest, packageDir: string): readonly PlanEntry[] {
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
    files = bundlePatchFiles(declaration as Parameters<typeof bundlePatchFiles>[0])
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
      layers.push(loadOverlayPatches('eedsh', path) as unknown as Record<string, unknown>[])
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
    const entries = composeEntries(layers as unknown as Parameters<typeof composeEntries>[0])
    return deepFreeze(jsonClone(entries) as unknown as PlanEntry[])
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
  const selected = explicitRoot(bundle, root)
  let packageDir = selected.packageDir
  let origin = selected.origin
  if (origin === 'pinned') {
    const anchor = anchorManifest(bundle)
    const installed = packageDirFromAnchor(anchor.path, bundle)
    if (installed === undefined) {
      throw new ResolutionError({
        code: 'resolution.bundle_not_found',
        bundle,
        path: anchor.path,
        message: `bundle ${JSON.stringify(bundle)} is not shipped by the pinned DSH installation at ${anchor.path}; pass { profile } or { packageDir } as an explicit root`,
      })
    }
    packageDir = installed
  }
  const manifestPath = assertPackageDir(bundle, packageDir, origin, selected.profile)
  let manifest: BundleManifest
  try {
    manifest = readJsonObject(manifestPath) as BundleManifest
  } catch (cause) {
    throw new ResolutionError({
      code: origin === 'packageDir' ? 'resolution.package_dir_invalid' : 'resolution.bundle_not_found',
      bundle,
      path: manifestPath,
      ...(selected.profile === undefined ? {} : { profile: selected.profile }),
      message: `cannot read the manifest of bundle ${JSON.stringify(bundle)} at ${manifestPath}: ${messageOf(cause)}`,
    })
  }
  const rows = loadRows(bundle, manifest, packageDir)
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

/** A frozen preset summary that can target the row without carrying its plugin tree. */
export interface PresetSummary {
  /** The inserted Loader row id. */
  readonly rowId: string
  /** The preset's own id from its config. */
  readonly id: string
  /** The preset order, when declared. */
  readonly order?: number
  /** The preset display name, when declared. */
  readonly name?: string
  /** The row's disabled flag, when boolean. */
  readonly disabled?: boolean
}

function isPresetRow(entry: PlanEntry): boolean {
  if (entry.name === '@deepseek-ai/dsh-agent-preset') return true
  const id = typeof entry.id === 'string' ? entry.id : undefined
  const config = isRecord(entry.config) ? entry.config : undefined
  return id !== undefined && id.startsWith('preset-') && typeof config?.id === 'string'
}

/**
 * List the preset rows a bundle declares as compact, frozen summaries.
 * @param bundle - bundle package name.
 * @param root - optional explicit root.
 * @returns preset summaries in bundle row order.
 */
export function presets(bundle: string, root: QueryRoot = {}): readonly PresetSummary[] {
  const resolved = resolveBundle(bundle, root)
  const summaries: PresetSummary[] = []
  for (const entry of resolved.rows) {
    if (!isPresetRow(entry)) continue
    const rowId = typeof entry.id === 'string' ? entry.id : undefined
    const config = isRecord(entry.config) ? entry.config : undefined
    const presetId = typeof config?.id === 'string' ? config.id : undefined
    if (rowId === undefined || presetId === undefined) continue
    const summary: {
      rowId: string
      id: string
      order?: number
      name?: string
      disabled?: boolean
    } = { rowId, id: presetId }
    if (typeof config?.order === 'number') summary.order = config.order
    if (typeof config?.name === 'string') summary.name = config.name
    else if (typeof entry.name === 'string') summary.name = entry.name
    if (typeof entry.disabled === 'boolean') summary.disabled = entry.disabled
    summaries.push(summary)
  }
  return deepFreeze(summaries)
}

/**
 * Return every declared row a bundle contributes.
 * @param bundle - bundle package name.
 * @param root - optional explicit root.
 * @returns frozen rows in bundle order.
 */
export function rows(bundle: string, root: QueryRoot = {}): readonly PlanEntry[] {
  return resolveBundle(bundle, root).rows
}

/**
 * Return one declared row by its Loader id.
 * @param bundle - bundle package name.
 * @param rowId - the Loader row id.
 * @param root - optional explicit root.
 * @returns the frozen row.
 */
export function row(bundle: string, rowId: string, root: QueryRoot = {}): PlanEntry {
  const resolved = resolveBundle(bundle, root)
  const found = resolved.rows.find((entry) => entry.id === rowId)
  if (found === undefined) {
    throw new ResolutionError({
      code: 'resolution.row_not_found',
      bundle,
      message: `bundle ${JSON.stringify(bundle)} declares no row ${JSON.stringify(rowId)}`,
    })
  }
  return found
}
