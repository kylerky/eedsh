/**
 * Bundle resolution for one invocation. The CLI owns this phase: it resolves
 * every recorded query descriptor against the selected DSH installation, reads
 * package manifests through the file-system service, composes the declared
 * patch files through the installation's own capabilities, and validates the
 * requested row and preset ids. Every expected failure is a tagged
 * {@link ResolutionError} in the Effect error channel.
 * @module @eedsh/cli/resolve
 */
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import {
  type BundleQueryDescriptor,
  DSH_ANCHOR_ENV,
  type DshBridge,
  type PlanEntry,
  PROFILE_ROOT_OVERRIDE_ENV,
  type QueryRoot,
  queryKey,
  ResolutionError,
  type ResolutionOrigin,
  type ResolutionTable,
  type ResolutionTrace,
  type ResolvedBundle,
} from '@eedsh/config'
import { Effect } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import * as Result from 'effect/Result'
import { resolveDshHome, resolveProfileDir } from './internal/dsh-home'

/** The selected installation and invocation facts resolution needs. */
export interface ResolutionContext {
  /** The installation selected for the invocation. */
  readonly installation: {
    readonly version: string
    readonly installAnchor: string
    readonly packageDir: string
    readonly binPath: string
  }
  /** The absolute directory of the evaluated config file. */
  readonly configDir: string
  /** The invocation environment, for the preview profile-root override. */
  readonly env: Record<string, string | undefined>
}

/** The result of one resolution phase. */
export interface ResolutionOutcome {
  /** The table the terminal build consumes. */
  readonly table: ResolutionTable
  /** Every resolved bundle, in first-seen order. */
  readonly bundles: readonly ResolvedBundle[]
  /** One trace per resolved bundle and root pair. */
  readonly traces: readonly ResolutionTrace[]
}

interface BundleManifest {
  readonly name?: string
  readonly version?: string
  readonly dsh?: {
    readonly bundle?: { readonly patch?: string | readonly string[] }
  }
  readonly [key: string]: unknown
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function failure(input: {
  readonly code: ConstructorParameters<typeof ResolutionError>[0]['code']
  readonly bundle: string
  readonly message: string
  readonly path?: string
  readonly profile?: string
}): ResolutionError {
  return new ResolutionError(input)
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * Convert DSH's parsed runtime-expression marker to the plan's expression
 * node. The conversion is shape-exact: only a record whose sole key is
 * `__jsExpr` with a string value is converted.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The session-local profile-root override, parsed as plain data. */
function rootOverride(env: Record<string, string | undefined>): Record<string, string> {
  const raw = env[PROFILE_ROOT_OVERRIDE_ENV]
  if (raw === undefined || raw.trim() === '') return {}
  const parsed = Result.try(() => JSON.parse(raw) as unknown)
  if (Result.isFailure(parsed) || !isRecord(parsed.success)) return {}
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(parsed.success)) {
    if (typeof value === 'string' && value !== '') out[name] = value
  }
  return out
}

/**
 * The absolute profile directory a name resolves to, honouring the session
 * preview override.
 * @param bridge - the loaded installation capabilities.
 * @param profile - the profile name.
 * @param bundle - the queried bundle, for the diagnostic.
 * @param env - the invocation environment.
 * @returns the profile directory.
 */
function profileDirectory(profile: string, env: Record<string, string | undefined>): string {
  const override = rootOverride(env)[profile]
  if (override !== undefined) return override
  return resolveProfileDir(profile, resolveDshHome(undefined, env))
}

/**
 * Resolve a package directory through one manifest's Node resolution paths.
 * @param fs - the file-system service.
 * @param anchor - the manifest whose resolution paths to search.
 * @param packageName - the package to locate.
 * @returns the package directory, or undefined.
 */
function packageDirFromAnchor(
  fs: FileSystem.FileSystem,
  anchor: string,
  packageName: string,
): Effect.Effect<string | undefined> {
  return Effect.gen(function* () {
    const searchPaths = Result.try(() => createRequire(anchor).resolve.paths(packageName) ?? [])
    if (Result.isFailure(searchPaths)) return undefined
    for (const searchPath of searchPaths.success) {
      const candidate = join(searchPath, packageName)
      if (
        yield* fs.exists(join(candidate, 'package.json')).pipe(Effect.orElseSucceed(() => false))
      ) {
        return candidate
      }
    }
    return undefined
  })
}

interface SelectedRoot {
  readonly packageDir: string
  readonly origin: ResolutionOrigin
  readonly profile?: string
}

function explicitRoot(
  fs: FileSystem.FileSystem,
  bundle: string,
  root: QueryRoot,
  context: ResolutionContext,
): Effect.Effect<SelectedRoot, ResolutionError> {
  return Effect.gen(function* () {
    if (root.profile !== undefined && root.packageDir !== undefined) {
      return yield* Effect.fail(
        failure({
          code: 'resolution.root_conflict',
          bundle,
          message: `bundle ${JSON.stringify(bundle)} names both { profile } and { packageDir }; supply exactly one root`,
        }),
      )
    }
    if (root.profile !== undefined) {
      const profile = root.profile
      const override = rootOverride(context.env)[profile]
      const selected = Result.succeed(profileDirectory(profile, context.env))
      if (Result.isFailure(selected)) return yield* Effect.fail(selected.failure)
      const dir = selected.success
      const profileManifest = join(dir, 'package.json')
      const exists = yield* fs.exists(profileManifest).pipe(Effect.orElseSucceed(() => false))
      if (!exists) {
        return yield* Effect.fail(
          failure({
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
          }),
        )
      }
      const packageDir = yield* packageDirFromAnchor(fs, profileManifest, bundle)
      if (packageDir === undefined) {
        return yield* Effect.fail(
          failure({
            code: 'resolution.bundle_not_installed',
            bundle,
            profile,
            path: dir,
            message: `profile ${JSON.stringify(profile)} has not installed bundle ${JSON.stringify(bundle)}; pass { packageDir } for a checkout or use the session .resolve command`,
          }),
        )
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
        : resolvePath(context.configDir, root.packageDir)
      return { packageDir: absolute, origin: 'packageDir' }
    }
    const installed = yield* packageDirFromAnchor(fs, context.installation.installAnchor, bundle)
    if (installed === undefined) {
      return yield* Effect.fail(
        failure({
          code: 'resolution.bundle_not_found',
          bundle,
          path: context.installation.installAnchor,
          message: `bundle ${JSON.stringify(bundle)} is not shipped by the active DSH installation at ${context.installation.installAnchor}; pass { profile } or { packageDir } as an explicit root`,
        }),
      )
    }
    return { packageDir: installed, origin: 'active' }
  })
}

function assertPackageDir(
  fs: FileSystem.FileSystem,
  bundle: string,
  packageDir: string,
  origin: ResolutionOrigin,
  profile?: string,
): Effect.Effect<string, ResolutionError> {
  return Effect.gen(function* () {
    const manifestPath = join(packageDir, 'package.json')
    const exists = yield* fs.exists(manifestPath).pipe(Effect.orElseSucceed(() => false))
    if (!exists) {
      return yield* Effect.fail(
        failure({
          code:
            origin === 'packageDir'
              ? 'resolution.package_dir_missing'
              : 'resolution.bundle_not_found',
          bundle,
          path: manifestPath,
          ...(profile === undefined ? {} : { profile }),
          message:
            origin === 'packageDir'
              ? `bundle directory ${packageDir} for ${JSON.stringify(bundle)} has no package.json`
              : `bundle ${JSON.stringify(bundle)} has no readable package manifest at ${manifestPath}`,
        }),
      )
    }
    return manifestPath
  })
}

function readManifest(
  fs: FileSystem.FileSystem,
  bundle: string,
  manifestPath: string,
  origin: ResolutionOrigin,
  profile?: string,
): Effect.Effect<BundleManifest, ResolutionError> {
  return Effect.gen(function* () {
    const read = yield* Effect.result(fs.readFileString(manifestPath))
    if (read._tag === 'Failure') {
      return yield* Effect.fail(
        failure({
          code:
            origin === 'packageDir'
              ? 'resolution.package_dir_invalid'
              : 'resolution.bundle_not_found',
          bundle,
          path: manifestPath,
          ...(profile === undefined ? {} : { profile }),
          message: `cannot read the manifest of bundle ${JSON.stringify(bundle)} at ${manifestPath}`,
        }),
      )
    }
    const parsed = Result.try(() => JSON.parse(read.success) as unknown)
    if (Result.isFailure(parsed) || !isRecord(parsed.success)) {
      return yield* Effect.fail(
        failure({
          code:
            origin === 'packageDir'
              ? 'resolution.package_dir_invalid'
              : 'resolution.bundle_not_found',
          bundle,
          path: manifestPath,
          ...(profile === undefined ? {} : { profile }),
          message: `cannot read the manifest of bundle ${JSON.stringify(bundle)} at ${manifestPath}`,
        }),
      )
    }
    return parsed.success as BundleManifest
  })
}

function loadRows(
  bridge: DshBridge,
  bundle: string,
  manifest: BundleManifest,
  packageDir: string,
): Effect.Effect<readonly PlanEntry[], ResolutionError> {
  return Effect.gen(function* () {
    const declaration = manifest.dsh?.bundle
    if (declaration === undefined) {
      return yield* Effect.fail(
        failure({
          code: 'resolution.not_a_bundle',
          bundle,
          path: packageDir,
          message: `package ${JSON.stringify(bundle)} at ${packageDir} declares no dsh.bundle`,
        }),
      )
    }
    const files = Result.try(() => bridge.bundlePatchFiles(declaration))
    if (Result.isFailure(files)) {
      return yield* Effect.fail(
        failure({
          code: 'resolution.patch_invalid',
          bundle,
          path: packageDir,
          message: `bundle ${JSON.stringify(bundle)} declares an invalid patch set: ${errorText(files.failure)}`,
        }),
      )
    }
    const layers: Record<string, unknown>[][] = []
    for (const file of files.success) {
      const path = join(packageDir, file)
      const patches = Result.try(() => bridge.loadOverlayPatches('eedsh', path))
      if (Result.isFailure(patches)) {
        return yield* Effect.fail(
          failure({
            code: 'resolution.patch_invalid',
            bundle,
            path,
            message: `cannot read patch file ${path} for bundle ${JSON.stringify(bundle)}: ${errorText(patches.failure)}`,
          }),
        )
      }
      layers.push(patches.success as Record<string, unknown>[])
    }
    const composed = Result.try(() => bridge.composeEntries(layers))
    if (Result.isFailure(composed)) {
      return yield* Effect.fail(
        failure({
          code: 'resolution.patch_invalid',
          bundle,
          path: packageDir,
          message: `cannot compose patches for bundle ${JSON.stringify(bundle)}: ${errorText(composed.failure)}`,
        }),
      )
    }
    return deepFreeze(planExpressionNodes(jsonClone(composed.success))) as unknown as PlanEntry[]
  })
}

/**
 * Resolve one bundle from one explicit root. No result is cached here; the
 * service resolves each distinct pair once per invocation.
 * @param fs - the file-system service.
 * @param bridge - the selected installation's capabilities.
 * @param bundle - the bundle package name.
 * @param root - the recorded root.
 * @param context - the selected installation and invocation facts.
 * @returns the resolved bundle with frozen rows.
 */
export function resolveOne(
  fs: FileSystem.FileSystem,
  bridge: DshBridge,
  bundle: string,
  root: QueryRoot,
  context: ResolutionContext,
): Effect.Effect<ResolvedBundle, ResolutionError> {
  return Effect.gen(function* () {
    const selected = yield* explicitRoot(fs, bundle, root, context)
    const manifestPath = yield* assertPackageDir(
      fs,
      bundle,
      selected.packageDir,
      selected.origin,
      selected.profile,
    )
    const manifest = yield* readManifest(
      fs,
      bundle,
      manifestPath,
      selected.origin,
      selected.profile,
    )
    const rows = yield* loadRows(bridge, bundle, manifest, selected.packageDir)
    const version = typeof manifest.version === 'string' ? manifest.version : 'unknown'
    return deepFreeze({
      bundle,
      root,
      packageDir: selected.packageDir,
      manifestPath,
      version,
      origin: selected.origin,
      ...(selected.profile === undefined ? {} : { profile: selected.profile }),
      rows,
    })
  }).pipe(
    Effect.mapError((cause) =>
      cause.root === undefined
        ? new ResolutionError({
            code: cause.code,
            bundle: cause.bundle,
            message: cause.message,
            root,
            ...(cause.path === undefined ? {} : { path: cause.path }),
            ...(cause.profile === undefined ? {} : { profile: cause.profile }),
          })
        : cause,
    ),
  )
}

function rowIdOf(entry: PlanEntry): string | undefined {
  return typeof entry.id === 'string' ? entry.id : undefined
}

function isPresetRow(entry: PlanEntry): boolean {
  if (entry.name === '@deepseek-ai/dsh-agent-preset') return true
  const id = rowIdOf(entry)
  const config = isRecord(entry.config) ? entry.config : undefined
  return id?.startsWith('preset-') === true && typeof config?.id === 'string'
}

/**
 * Validate the row and preset ids one descriptor requested from its resolved
 * bundle.
 * @param descriptor - the recorded descriptor.
 * @param resolved - its resolved bundle.
 * @returns the failure, or undefined when every requested id exists.
 */
function validateSelection(
  descriptor: BundleQueryDescriptor,
  resolved: ResolvedBundle,
): ResolutionError | undefined {
  if (descriptor.row !== undefined) {
    if (resolved.rows.some((entry) => rowIdOf(entry) === descriptor.row)) return undefined
    return failure({
      code: 'resolution.row_not_found',
      bundle: descriptor.bundle,
      message: `bundle ${JSON.stringify(descriptor.bundle)} declares no row ${JSON.stringify(descriptor.row)}`,
    })
  }
  if (descriptor.preset !== undefined) {
    for (const entry of resolved.rows) {
      if (!isPresetRow(entry)) continue
      const config = isRecord(entry.config) ? entry.config : {}
      if (config.id === descriptor.preset) return undefined
    }
    return failure({
      code: 'resolution.preset_not_found',
      bundle: descriptor.bundle,
      message: `bundle ${JSON.stringify(descriptor.bundle)} declares no preset ${JSON.stringify(descriptor.preset)}`,
    })
  }
  return undefined
}

interface QueryGroup {
  readonly bundle: string
  readonly root: QueryRoot
  readonly descriptors: BundleQueryDescriptor[]
}

/**
 * Resolve every recorded descriptor in one pass. Each distinct bundle and root
 * pair is resolved once; the returned table is total over the descriptors.
 * @param fs - the file-system service.
 * @param bridge - the selected installation's capabilities.
 * @param descriptors - the descriptors `builder.queries()` reported.
 * @param context - the selected installation and invocation facts.
 * @returns the resolution table, bundles, and traces.
 */
export function resolveDescriptors(
  fs: FileSystem.FileSystem,
  bridge: DshBridge,
  descriptors: readonly BundleQueryDescriptor[],
  context: ResolutionContext,
): Effect.Effect<ResolutionOutcome, ResolutionError> {
  return Effect.gen(function* () {
    const groups = new Map<string, QueryGroup>()
    for (const descriptor of descriptors) {
      const key = queryKey(descriptor.bundle, descriptor.root)
      const existing = groups.get(key)
      if (existing === undefined) {
        groups.set(key, {
          bundle: descriptor.bundle,
          root: descriptor.root,
          descriptors: [descriptor],
        })
      } else {
        existing.descriptors.push(descriptor)
      }
    }
    const bundles: ResolvedBundle[] = []
    const traces: ResolutionTrace[] = []
    for (const group of groups.values()) {
      const resolved = yield* resolveOne(fs, bridge, group.bundle, group.root, context)
      for (const descriptor of group.descriptors) {
        const invalid = validateSelection(descriptor, resolved)
        if (invalid !== undefined) return yield* Effect.fail(invalid)
      }
      bundles.push(resolved)
      traces.push({
        bundle: resolved.bundle,
        packageDir: resolved.packageDir,
        manifestPath: resolved.manifestPath,
        version: resolved.version,
        origin: resolved.origin,
        ...(resolved.profile === undefined ? {} : { profile: resolved.profile }),
      })
    }
    return { table: { bundles }, bundles, traces }
  })
}

/**
 * The raw patch layers one profile bundle contributes, for preflight. It uses
 * the installation's own resolution and composition capabilities, exactly as
 * boot does.
 * @param bridge - the selected installation's capabilities.
 * @param packageName - the bundle package name.
 * @param profileDir - absolute profile directory.
 * @param installAnchor - absolute DSH package.json path.
 * @returns the bundle's patches in application order, or a tagged failure.
 */
export function bundlePatchLayers(
  bridge: DshBridge,
  packageName: string,
  profileDir: string,
  installAnchor: string,
): Result.Result<Record<string, unknown>[], Error> {
  const located = Result.try({
    try: () => {
      const packageDir = bridge.resolveBundleDir('eedsh', packageName, installAnchor, profileDir)
      return { packageDir, manifest: bridge.readProfileManifest('eedsh', packageDir) }
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })
  if (Result.isFailure(located)) return Result.fail(located.failure)
  const bundle = located.success.manifest.dsh?.bundle
  if (bundle === undefined) {
    return Result.fail(
      new Error(`profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle`),
    )
  }
  return Result.try({
    try: () =>
      bridge
        .bundlePatchFiles(bundle)
        .flatMap(
          (file) =>
            bridge.loadOverlayPatches('eedsh', join(located.success.packageDir, file)) as Record<
              string,
              unknown
            >[],
        ),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })
}

/** The environment variable that selects a DSH installation explicitly. */
export const ANCHOR_ENV = DSH_ANCHOR_ENV
