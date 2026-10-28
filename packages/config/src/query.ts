/**
 * Typed bundle query handles. `bundle(name)` is both a plan selection and a
 * query handle; `.fromProfile()` and `.fromPackageDir()` return a rooted
 * query that is deliberately not a plan selection. Rows and presets are
 * immutable typed handles over one resolution snapshot.
 * @module @eedsh/config/query
 */
import type { JsonValue, NamedBundle, PlanEntry, PlanPatch } from '@eedsh/plan'
import { AUTHORING_KIND, authoringKind } from './authoring'
import {
  type QueryRoot,
  ResolutionError,
  type ResolutionOrigin,
  type ResolvedBundle,
  resolveBundle,
} from './resolve'

/** Options for a bundle selection. */
export interface BundleOptions {
  /** Optional profile-local package specifier for the bundle. */
  readonly source?: string
}

/** A value a layer patch may target. */
export type PatchTarget = string | Row | Preset

/** The kind discriminator a rooted query carries (it has no plan brand). */
type QueryKind = 'bundle' | 'bundle-query'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'object') {
    const name = (value as { constructor?: { name?: string } }).constructor?.name
    return name === undefined || name === '' ? 'an object' : `a ${name}`
  }
  return typeof value
}

function stringField(entry: PlanEntry, key: string): string | undefined {
  const value = entry[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * One immutable row handle. Its `toJSON()` is the inserted Loader entry, and
 * its patch methods target the row id.
 */
export class Row {
  /** The bundle package the row came from. */
  readonly bundle: string
  /** The Loader row id. */
  readonly id: string
  /** The frozen inserted Loader entry. */
  readonly data: PlanEntry
  readonly [AUTHORING_KIND] = 'row' as const

  constructor(bundle: string, data: PlanEntry) {
    this.bundle = bundle
    this.data = data
    this.id = stringField(data, 'id') ?? ''
  }

  /** The row as plain plan data. */
  toJSON(): PlanEntry {
    return this.data
  }

  /** Disable this row. */
  disable(): PlanPatch {
    return { id: this.id, disabled: true }
  }

  /** Enable this row. */
  enable(): PlanPatch {
    return { id: this.id, disabled: false }
  }

  /**
   * Replace this row's whole config.
   * @param config - the complete replacement config.
   * @returns an id-targeted patch.
   */
  override(config: JsonValue): PlanPatch {
    return { id: this.id, config }
  }
}

/**
 * One immutable preset handle. The plan data is the preset's inserted Loader
 * row; patches target that row's id, not the preset's config id.
 */
export class Preset {
  /** The bundle package the preset came from. */
  readonly bundle: string
  /** The inserted Loader row id patches must target. */
  readonly rowId: string
  /** The preset's own id from its config. */
  readonly id: string
  /** The preset order, when declared. */
  readonly order?: number
  /** The preset display name, when declared. */
  readonly name?: string
  /** The row's disabled flag, when boolean. */
  readonly disabled?: boolean
  /** The frozen inserted Loader entry. */
  readonly data: PlanEntry
  readonly [AUTHORING_KIND] = 'preset' as const

  constructor(bundle: string, data: PlanEntry) {
    this.bundle = bundle
    this.data = data
    this.rowId = stringField(data, 'id') ?? ''
    const config = isRecord(data.config) ? data.config : {}
    const presetId = stringField(config as PlanEntry, 'id')
    this.id = presetId ?? this.rowId
    const order = config.order
    if (typeof order === 'number') this.order = order
    const name = stringField(config as PlanEntry, 'name') ?? stringField(data, 'name')
    if (name !== undefined) this.name = name
    const disabled = data.disabled
    if (typeof disabled === 'boolean') this.disabled = disabled
  }

  /** The preset row as plain plan data. */
  toJSON(): PlanEntry {
    return this.data
  }

  /** Disable this preset's row. */
  disable(): PlanPatch {
    return { id: this.rowId, disabled: true }
  }

  /** Enable this preset's row. */
  enable(): PlanPatch {
    return { id: this.rowId, disabled: false }
  }

  /**
   * Replace this preset row's whole config.
   * @param config - the complete replacement config.
   * @returns an id-targeted patch.
   */
  override(config: JsonValue): PlanPatch {
    return { id: this.rowId, config }
  }
}

function isPresetEntry(entry: PlanEntry): boolean {
  if (entry.name === '@deepseek-ai/dsh-agent-preset') return true
  const id = stringField(entry, 'id')
  const config = isRecord(entry.config) ? entry.config : undefined
  return id?.startsWith('preset-') === true && typeof config?.id === 'string'
}

function presetEntries(rows: readonly PlanEntry[]): PlanEntry[] {
  return rows.filter(isPresetEntry)
}

/**
 * A rooted or unrooted bundle query handle. Constructing a `BundleQuery`
 * directly is possible but the supported roots are `.fromProfile()` and
 * `.fromPackageDir()` on a `Bundle`. The snapshot is resolved once per handle.
 */
export class BundleQuery {
  /** The queried bundle package name. */
  readonly bundle: string
  /** The bundle name, mirrored for structural handles. */
  readonly name: string
  /** The optional profile-local package specifier. */
  readonly source?: string
  /** The handle kind; a rooted query is never a plan selection. */
  readonly kind: QueryKind = 'bundle-query'
  protected readonly root: QueryRoot
  private snapshot: ResolvedBundle | undefined

  constructor(name: string, root: QueryRoot = {}, options: BundleOptions = {}) {
    this.bundle = name
    this.name = name
    this.root = root
    if (options.source !== undefined) this.source = options.source
  }

  protected resolved(): ResolvedBundle {
    this.snapshot ??= resolveBundle(this.bundle, this.root)
    return this.snapshot
  }

  /** Every declared row, as typed immutable handles. */
  rows(): readonly Row[] {
    return this.resolved().rows.map((entry) => new Row(this.bundle, entry))
  }

  /** Every declared preset, as typed immutable handles. */
  presets(): readonly Preset[] {
    return presetEntries(this.resolved().rows).map((entry) => new Preset(this.bundle, entry))
  }

  /**
   * One row by Loader id.
   * @param id - the Loader row id.
   * @returns the typed row.
   */
  row(id: string): Row {
    const found = this.resolved().rows.find((entry) => stringField(entry, 'id') === id)
    if (found === undefined) {
      throw new ResolutionError({
        code: 'resolution.row_not_found',
        bundle: this.bundle,
        message: `bundle ${JSON.stringify(this.bundle)} declares no row ${JSON.stringify(id)}`,
      })
    }
    return new Row(this.bundle, found)
  }

  /**
   * One preset by preset id.
   * @param id - the preset's own config id.
   * @returns the typed preset.
   */
  preset(id: string): Preset {
    for (const entry of this.resolved().rows) {
      if (!isPresetEntry(entry)) continue
      const config = isRecord(entry.config) ? entry.config : {}
      if (config.id === id) return new Preset(this.bundle, entry)
    }
    throw new ResolutionError({
      code: 'resolution.preset_not_found',
      bundle: this.bundle,
      message: `bundle ${JSON.stringify(this.bundle)} declares no preset ${JSON.stringify(id)}`,
    })
  }

  /** The resolved bundle package version. */
  version(): string {
    return this.resolved().version
  }

  /** The resolved bundle package directory. */
  packageDir(): string {
    return this.resolved().packageDir
  }

  /** Where the bundle was resolved from. */
  origin(): ResolutionOrigin {
    return this.resolved().origin
  }
}

/**
 * A bundle selection that is also a query handle. It is a plan selection
 * (its `toJSON()` is the named bundle) and queries the pinned installation
 * until rooted with `.fromProfile()` or `.fromPackageDir()`.
 */
export class Bundle extends BundleQuery {
  override readonly kind: QueryKind = 'bundle'
  readonly [AUTHORING_KIND] = 'bundle' as const

  constructor(name: string, options: BundleOptions = {}) {
    super(name, {}, options)
  }

  /** The plan selection data. */
  toJSON(): NamedBundle {
    return this.source === undefined
      ? { kind: 'bundle', name: this.bundle }
      : { kind: 'bundle', name: this.bundle, source: this.source }
  }

  /**
   * Resolve this bundle from a profile's installed copy.
   * @param profile - a profile name or a structural handle carrying one.
   * @returns a query-only handle.
   */
  fromProfile(profile: string | { readonly name?: unknown }): BundleQuery {
    return new BundleQuery(
      this.bundle,
      { profile: this.profileName(profile) },
      this.options(),
    )
  }

  /**
   * Resolve this bundle from a package directory.
   * @param dir - the package directory; a relative path resolves against the
   * directory of the config file.
   * @returns a query-only handle.
   */
  fromPackageDir(dir: string): BundleQuery {
    return new BundleQuery(this.bundle, { packageDir: dir }, this.options())
  }

  private options(): BundleOptions {
    return this.source === undefined ? {} : { source: this.source }
  }

  private profileName(profile: string | { readonly name?: unknown }): string {
    if (typeof profile === 'string') return profile
    const name = profile === null || typeof profile !== 'object' ? undefined : profile.name
    if (typeof name === 'string' && name !== '') return name
    throw new ResolutionError({
      code: 'resolution.profile_invalid',
      bundle: this.bundle,
      message: `a profile root must be a profile name or a handle carrying a name; received ${describe(profile)}`,
    })
  }
}

/**
 * Select a bundle at this position or query it.
 * @param name - the bundle package name.
 * @param options - optional source override.
 * @returns the typed bundle selection and query handle.
 */
export function bundle(name: string, options: BundleOptions = {}): Bundle {
  return new Bundle(name, options)
}

/**
 * Read an authored bundle selection as plain plan data, rejecting a rooted
 * query so a profile cannot silently drop its root.
 * @param value - a bundle name or an unrooted `Bundle`.
 * @returns the named bundle selection.
 */
export function bundleSelection(value: string | Bundle): NamedBundle {
  if (typeof value === 'string') return { kind: 'bundle', name: value }
  if (authoringKind(value) === 'bundle') return value.toJSON()
  const candidate = value as unknown as { name?: unknown }
  const name = typeof candidate?.name === 'string' ? candidate.name : 'unknown'
  throw new ResolutionError({
    code: 'resolution.rooted_query',
    bundle: name,
    message:
      'a rooted bundle query is query-only and cannot be a plan selection; pass the bundle name instead',
  })
}

/**
 * The Loader id a patch targets.
 * @param target - a row id, a `Row`, or a `Preset`.
 * @returns the row id.
 */
export function patchTargetId(target: PatchTarget): string {
  if (typeof target === 'string') return target
  const kind = authoringKind(target)
  if (kind === 'row') return (target as Row).id
  if (kind === 'preset') return (target as Preset).rowId
  const bundle = isRecord(target) && typeof target.bundle === 'string' ? target.bundle : ''
  throw new ResolutionError({
    code: 'resolution.invalid_target',
    bundle,
    message: `a layer patch target must be a row id, a Row, or a Preset; received ${describe(target)}`,
  })
}
