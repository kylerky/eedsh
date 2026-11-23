/**
 * Typed bundle query descriptors. `bundle(name)` is both a plan selection and
 * a query handle; rooting it or selecting a row, preset, or collection records
 * plain data that the invocation resolves before `build()`. No call here reads
 * a file or an ambient installation.
 * @module @eedsh/config/query
 */
import type { JsonValue, NamedBundle, PlanPatch } from '@eedsh/plan'
import { AUTHORING_KIND, authoringKind, isAuthoringObject } from './authoring'
import type { PlanEntry } from './builders'
import { AuthoringDefect } from './errors'
import {
  findResolved,
  type QueryRoot,
  queryKey,
  type ResolutionTable,
  type ResolvedBundle,
} from './resolution'

/** A value a layer patch may target. */
export type PatchTarget = string | Row | Preset | RowCollection | PresetCollection

/** One recorded query: a bundle, its root, and what was requested from it. */
export interface BundleQueryDescriptor {
  /** The queried bundle package name. */
  readonly bundle: string
  /** The recorded resolution root. */
  readonly root: QueryRoot
  /** The requested Loader row id. */
  readonly row?: string
  /** The requested preset id. */
  readonly preset?: string
  /** Every declared row was requested. */
  readonly rows?: true
  /** Every declared preset was requested. */
  readonly presets?: true
}

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

/** The Loader row name every installed preset carries. */
const PRESET_ROW_NAME = '@deepseek-ai/dsh-agent-preset'

/**
 * Whether one composed Loader row is an installed preset.
 * @param entry - one composed row.
 * @returns whether the row is a preset.
 */
export function isPresetEntry(entry: PlanEntry): boolean {
  if (entry.name === PRESET_ROW_NAME) return true
  const id = stringField(entry, 'id')
  const config = isRecord(entry.config) ? entry.config : undefined
  return id?.startsWith('preset-') === true && typeof config?.id === 'string'
}

/**
 * The installed preset rows of one composed bundle.
 * @param rows - every composed row.
 * @returns the preset rows in bundle order.
 */
export function presetEntries(rows: readonly PlanEntry[]): PlanEntry[] {
  return rows.filter(isPresetEntry)
}

/** Describe a root for a defect message. */
function rootText(root: QueryRoot): string {
  if (root.profile !== undefined) return `profile ${JSON.stringify(root.profile)}`
  if (root.packageDir !== undefined) return `package directory ${JSON.stringify(root.packageDir)}`
  return 'the invocation installation'
}

/** The resolved bundle one descriptor needs, or a defect. */
function resolvedBundle(
  table: ResolutionTable,
  bundle: string,
  root: QueryRoot,
  detail: string,
): ResolvedBundle {
  const resolved = findResolved(table, bundle, root)
  if (resolved === undefined) {
    throw new AuthoringDefect({
      code: 'authoring.missing_resolution',
      bundle,
      message:
        `the build table has no resolution for bundle ${JSON.stringify(bundle)} from ${rootText(root)}` +
        (detail === '' ? '' : ` (${detail})`) +
        '; the invocation must resolve every descriptor the builder reports',
    })
  }
  return resolved
}

function missingEntry(bundle: string, message: string, facts: Record<string, string>): never {
  throw new AuthoringDefect({
    code: 'authoring.missing_entry',
    bundle,
    message,
    ...facts,
  })
}

/**
 * One immutable row descriptor. Its patch methods target the explicit row id,
 * and its plain data is produced only when the invocation resolves the bundle.
 */
export class Row {
  /** The bundle package the row came from. */
  readonly bundle: string
  /** The root the row is resolved from. */
  readonly root: QueryRoot
  /** The Loader row id. */
  readonly id: string
  /** The recorded request, spelled as the descriptor fact. */
  readonly row: string
  readonly [AUTHORING_KIND] = 'row' as const

  constructor(bundle: string, id: string, root: QueryRoot = {}) {
    this.bundle = bundle
    this.id = id
    this.row = id
    this.root = root
  }

  /**
   * The row as plain plan data, from the invocation resolution.
   * @param table - the invocation resolution.
   * @returns the frozen inserted Loader entry.
   */
  resolve(table: ResolutionTable): PlanEntry {
    const resolved = resolvedBundle(table, this.bundle, this.root, `row ${JSON.stringify(this.id)}`)
    const found = resolved.rows.find((entry) => stringField(entry, 'id') === this.id)
    if (found === undefined) {
      missingEntry(
        this.bundle,
        `bundle ${JSON.stringify(this.bundle)} declares no row ${JSON.stringify(this.id)} at build time; the invocation must validate every requested row`,
        { rowId: this.id },
      )
    }
    return found
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

  /** The recorded query this descriptor needs. */
  queries(): readonly BundleQueryDescriptor[] {
    return [{ bundle: this.bundle, root: this.root, row: this.id }]
  }
}

/**
 * One immutable preset descriptor. Its patch methods target the preset row id,
 * which is known only from the invocation resolution.
 */
export class Preset {
  /** The bundle package the preset came from. */
  readonly bundle: string
  /** The root the preset is resolved from. */
  readonly root: QueryRoot
  /** The preset's own id from its config. */
  readonly id: string
  /** The recorded request, spelled as the descriptor fact. */
  readonly preset: string
  readonly [AUTHORING_KIND] = 'preset' as const

  constructor(bundle: string, id: string, root: QueryRoot = {}) {
    this.bundle = bundle
    this.id = id
    this.preset = id
    this.root = root
  }

  /**
   * The preset's inserted Loader row, from the invocation resolution.
   * @param table - the invocation resolution.
   * @returns the frozen inserted Loader entry.
   */
  resolve(table: ResolutionTable): PlanEntry {
    const resolved = resolvedBundle(
      table,
      this.bundle,
      this.root,
      `preset ${JSON.stringify(this.id)}`,
    )
    for (const entry of resolved.rows) {
      if (!isPresetEntry(entry)) continue
      const config = isRecord(entry.config) ? entry.config : {}
      if (config.id === this.id) return entry
    }
    return missingEntry(
      this.bundle,
      `bundle ${JSON.stringify(this.bundle)} declares no preset ${JSON.stringify(this.id)} at build time; the invocation must validate every requested preset`,
      { presetId: this.id },
    )
  }

  /** Disable this preset's row. */
  disable(): PatchDescriptor {
    return new PatchDescriptor(this, { kind: 'disable' })
  }

  /** Enable this preset's row. */
  enable(): PatchDescriptor {
    return new PatchDescriptor(this, { kind: 'enable' })
  }

  /**
   * Replace this preset row's whole config.
   * @param config - the complete replacement config.
   * @returns a deferred id-targeted patch.
   */
  override(config: JsonValue): PatchDescriptor {
    return new PatchDescriptor(this, { kind: 'override', config })
  }

  /** The recorded query this descriptor needs. */
  queries(): readonly BundleQueryDescriptor[] {
    return [{ bundle: this.bundle, root: this.root, preset: this.id }]
  }
}

/** Every declared row, resolved during build. */
export class RowCollection {
  /** The queried bundle package name. */
  readonly bundle: string
  /** The recorded root. */
  readonly root: QueryRoot
  readonly [AUTHORING_KIND] = 'rows' as const
  /** The recorded request, spelled as the descriptor fact. */
  readonly rows = true as const

  constructor(bundle: string, root: QueryRoot = {}) {
    this.bundle = bundle
    this.root = root
  }

  /**
   * Every declared row, from the invocation resolution.
   * @param table - the invocation resolution.
   * @returns the frozen rows in bundle order.
   */
  resolve(table: ResolutionTable): readonly PlanEntry[] {
    return resolvedBundle(table, this.bundle, this.root, 'every row').rows
  }

  /** Disable every row in this collection. */
  disable(): PatchDescriptor {
    return new PatchDescriptor(this, { kind: 'disable' })
  }

  /** Enable every row in this collection. */
  enable(): PatchDescriptor {
    return new PatchDescriptor(this, { kind: 'enable' })
  }

  /**
   * Replace every row's whole config.
   * @param config - the complete replacement config.
   * @returns deferred id-targeted patches.
   */
  override(config: JsonValue): PatchDescriptor {
    return new PatchDescriptor(this, { kind: 'override', config })
  }

  /** The recorded query this descriptor needs. */
  queries(): readonly BundleQueryDescriptor[] {
    return [{ bundle: this.bundle, root: this.root, rows: true }]
  }
}

/** Every declared preset, resolved during build. */
export class PresetCollection {
  /** The queried bundle package name. */
  readonly bundle: string
  /** The recorded root. */
  readonly root: QueryRoot
  readonly [AUTHORING_KIND] = 'presets' as const
  /** The recorded request, spelled as the descriptor fact. */
  readonly presets = true as const

  constructor(bundle: string, root: QueryRoot = {}) {
    this.bundle = bundle
    this.root = root
  }

  /**
   * Every declared preset row, from the invocation resolution.
   * @param table - the invocation resolution.
   * @returns the frozen preset rows in bundle order.
   */
  resolve(table: ResolutionTable): readonly PlanEntry[] {
    return presetEntries(resolvedBundle(table, this.bundle, this.root, 'every preset').rows)
  }

  /** Disable every preset row in this collection. */
  disable(): PatchDescriptor {
    return new PatchDescriptor(this, { kind: 'disable' })
  }

  /** Enable every preset row in this collection. */
  enable(): PatchDescriptor {
    return new PatchDescriptor(this, { kind: 'enable' })
  }

  /**
   * Replace every preset row's whole config.
   * @param config - the complete replacement config.
   * @returns deferred id-targeted patches.
   */
  override(config: JsonValue): PatchDescriptor {
    return new PatchDescriptor(this, { kind: 'override', config })
  }

  /** The recorded query this descriptor needs. */
  queries(): readonly BundleQueryDescriptor[] {
    return [{ bundle: this.bundle, root: this.root, presets: true }]
  }
}

/** The deferred target of a collection or preset patch. */
export type DeferredPatchTarget = Preset | RowCollection | PresetCollection

type PatchOperation =
  | { readonly kind: 'disable' }
  | { readonly kind: 'enable' }
  | { readonly kind: 'override'; readonly config: JsonValue }

/**
 * A patch whose id (or ids) are known only after resolution. The layer keeps
 * it until `build(table)` expands it into plain plan patches.
 */
export class PatchDescriptor {
  readonly [AUTHORING_KIND] = 'patch' as const
  private readonly target: DeferredPatchTarget
  private readonly operation: PatchOperation

  constructor(target: DeferredPatchTarget, operation: PatchOperation) {
    this.target = target
    this.operation = operation
  }

  /**
   * Expand this deferred patch against the invocation resolution.
   * @param table - the invocation resolution.
   * @returns the plain plan patches in target order.
   */
  resolve(table: ResolutionTable): PlanPatch[] {
    const entries = this.entries(table)
    return entries.map((entry) => {
      const id = stringField(entry, 'id')
      if (id === undefined) {
        return missingEntry(
          this.target.bundle,
          `a resolved row of bundle ${JSON.stringify(this.target.bundle)} has no string id; the plan patch cannot be targeted`,
          {},
        )
      }
      switch (this.operation.kind) {
        case 'disable':
          return { id, disabled: true }
        case 'enable':
          return { id, disabled: false }
        case 'override':
          return { id, config: this.operation.config }
        default:
          return missingEntry(
            this.target.bundle,
            'the stored patch operation is not one this build understands',
            {},
          )
      }
    })
  }

  /** The recorded queries this deferred patch needs. */
  queries(): readonly BundleQueryDescriptor[] {
    return this.target.queries()
  }

  private entries(table: ResolutionTable): readonly PlanEntry[] {
    if (this.target instanceof Preset) return [this.target.resolve(table)]
    return this.target.resolve(table) as readonly PlanEntry[]
  }
}

/**
 * A rooted or unrooted bundle query handle. Constructing a `BundleQuery`
 * directly is possible but the supported roots are `.fromProfile()` and
 * `.fromPackageDir()` on a `Bundle`. Every call records a descriptor.
 */
export class BundleQuery {
  /** The queried bundle package name. */
  readonly bundle: string
  /** The bundle name, mirrored for structural handles. */
  readonly name: string
  /** The recorded root. */
  readonly root: QueryRoot

  constructor(name: string, root: QueryRoot = {}) {
    this.bundle = name
    this.name = name
    this.root = root
  }

  /** Every declared row, as a descriptor expanded during build. */
  rows(): RowCollection {
    return new RowCollection(this.bundle, this.root)
  }

  /** Every declared preset, as a descriptor expanded during build. */
  presets(): PresetCollection {
    return new PresetCollection(this.bundle, this.root)
  }

  /**
   * One row by Loader id.
   * @param id - the Loader row id.
   * @returns the row descriptor.
   */
  row(id: string): Row {
    return new Row(this.bundle, id, this.root)
  }

  /**
   * One preset by preset id.
   * @param id - the preset's own config id.
   * @returns the preset descriptor.
   */
  preset(id: string): Preset {
    return new Preset(this.bundle, id, this.root)
  }
}

/**
 * A bundle selection that is also a query handle. It is a plan selection (its
 * `toJSON()` is the named bundle) and queries the installation selected for
 * the invocation until rooted.
 */
export class Bundle extends BundleQuery {
  readonly [AUTHORING_KIND] = 'bundle' as const

  constructor(name: string) {
    super(name)
  }

  /** The plan selection data. */
  toJSON(): NamedBundle {
    return { kind: 'bundle', name: this.bundle }
  }

  /** The plan selection data; a selection needs no resolution. */
  resolve(): NamedBundle {
    return this.toJSON()
  }

  /**
   * Resolve this bundle from a profile's installed copy.
   * @param profile - a profile name or a structural handle carrying one.
   * @returns a query-only handle.
   */
  fromProfile(profile: string | { readonly name?: unknown }): BundleQuery {
    return new BundleQuery(this.bundle, { profile: this.profileName(profile) })
  }

  /**
   * Resolve this bundle from a package directory.
   * @param dir - the package directory; a relative path resolves against the
   * directory of the config file.
   * @returns a query-only handle.
   */
  fromPackageDir(dir: string): BundleQuery {
    return new BundleQuery(this.bundle, { packageDir: dir })
  }

  private profileName(profile: string | { readonly name?: unknown }): string {
    if (typeof profile === 'string') return profile
    const name = profile === null || typeof profile !== 'object' ? undefined : profile.name
    if (typeof name === 'string' && name !== '') return name
    throw new AuthoringDefect({
      code: 'authoring.profile_invalid',
      bundle: this.bundle,
      message: `a profile root must be a profile name or a handle carrying a name; received ${describe(profile)}`,
    })
  }
}

/**
 * Select a bundle at this position or query it.
 * @param name - the bundle package name.
 * @returns the typed bundle selection and query handle.
 */
export function bundle(name: string): Bundle {
  return new Bundle(name)
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
  throw new AuthoringDefect({
    code: 'authoring.rooted_query',
    bundle: name,
    message:
      'a rooted bundle query is query-only and cannot be a plan selection; pass the bundle name instead',
  })
}

/**
 * The Loader id a plain patch targets.
 * @param target - a row id or a `Row`.
 * @returns the row id.
 */
export function patchTargetId(target: PatchTarget): string {
  if (typeof target === 'string') return target
  if (target instanceof Row) return target.id
  const bundle = isRecord(target) && typeof target.bundle === 'string' ? target.bundle : ''
  throw new AuthoringDefect({
    code: 'authoring.invalid_target',
    bundle,
    message: `a layer patch target must be a row id or a Row when its id is known; received ${describe(target)}`,
  })
}

/**
 * Resolve one authored patch target into the patch (or patches) a build emits.
 * @param target - the authored target.
 * @param operation - the patch operation.
 * @param config - the replacement config for an override.
 * @returns the eager plan patch or the deferred descriptor.
 */
export function patchTargetValue(
  target: PatchTarget,
  operation: { readonly kind: 'disable' } | { readonly kind: 'enable' },
): PlanPatch | PatchDescriptor
export function patchTargetValue(
  target: PatchTarget,
  operation: { readonly kind: 'override'; readonly config: JsonValue },
): PlanPatch | PatchDescriptor
export function patchTargetValue(
  target: PatchTarget,
  operation:
    | { readonly kind: 'disable' }
    | { readonly kind: 'enable' }
    | { readonly kind: 'override'; readonly config: JsonValue },
): PlanPatch | PatchDescriptor {
  if (typeof target === 'string') {
    if (operation.kind === 'override') return { id: target, config: operation.config }
    return operation.kind === 'disable'
      ? { id: target, disabled: true }
      : { id: target, disabled: false }
  }
  const kind = authoringKind(target)
  if (kind === 'row') {
    if (operation.kind === 'override') return target.override(operation.config)
    return operation.kind === 'disable' ? target.disable() : target.enable()
  }
  if (kind === 'preset' || kind === 'rows' || kind === 'presets') {
    const deferred = target as DeferredPatchTarget
    if (operation.kind === 'override') return new PatchDescriptor(deferred, operation)
    return new PatchDescriptor(deferred, operation)
  }
  const bundle = isRecord(target) && typeof target.bundle === 'string' ? target.bundle : ''
  throw new AuthoringDefect({
    code: 'authoring.invalid_target',
    bundle,
    message: `a layer patch target must be a row id, a Row, a Preset, or a row or preset collection; received ${describe(target)}`,
  })
}

/**
 * The queries one authored patch target records.
 * @param target - the authored target.
 * @returns the recorded descriptors.
 */
export function patchTargetQueries(target: PatchTarget): readonly BundleQueryDescriptor[] {
  if (typeof target === 'string') return []
  const kind = authoringKind(target)
  if (kind === 'row' || kind === 'preset' || kind === 'rows' || kind === 'presets') {
    return (target as Row | Preset | RowCollection | PresetCollection).queries()
  }
  return []
}

/**
 * Recursively collect the query descriptors one authored value needs. The walk
 * visits arrays and plain objects, so a descriptor nested in a raw patch is
 * still reported to the invocation.
 * @param value - the authored value.
 * @param seen - cycle guard.
 * @returns the descriptors in first-seen order.
 */
export function authoringQueries(
  value: unknown,
  seen: Map<object, unknown> = new Map(),
): BundleQueryDescriptor[] {
  if (value === null || typeof value !== 'object') return []
  const visited = seen.get(value)
  if (visited !== undefined) return []
  seen.set(value, true)
  if (isAuthoringObject(value)) {
    const kind = authoringKind(value)
    if (kind === 'row' || kind === 'preset' || kind === 'rows' || kind === 'presets') {
      return [...(value as Row | Preset | RowCollection | PresetCollection).queries()]
    }
    if (kind === 'patch') {
      return [...(value as PatchDescriptor).queries()]
    }
    if (kind === 'preset-definition') {
      const queries = (value as { queries?: () => readonly BundleQueryDescriptor[] }).queries
      return typeof queries === 'function' ? [...queries.call(value)] : []
    }
    return []
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => authoringQueries(item, seen))
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return []
  return Object.values(value).flatMap((item) => authoringQueries(item, seen))
}

/** The distinct-key form of one query descriptor. */
export function queryDescriptorKey(descriptor: BundleQueryDescriptor): string {
  const detail =
    descriptor.row !== undefined
      ? `row:${descriptor.row}`
      : descriptor.preset !== undefined
        ? `preset:${descriptor.preset}`
        : descriptor.rows === true
          ? 'rows'
          : 'presets'
  return `${queryKey(descriptor.bundle, descriptor.root)}\u0000${detail}`
}
