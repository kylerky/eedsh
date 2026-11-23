/**
 * Read-only exploration views over the loaded config. The CLI builds them from
 * the validated config value and snapshots taken while the session loads; they
 * never import the config project's authoring module, never write profile
 * files, and never publish. A view is a snapshot for one evaluation and is
 * rebuilt by the session on load, reload, profile switch, preview change, and a
 * successful sync.
 * @module @eedsh/cli/repl/views
 */
import { join } from 'node:path'
import {
  isPresetEntry,
  type NamedBundle,
  type PlanEntry,
  type ResolutionOrigin,
  type ResolvedBundle,
} from '@eedsh/config'
import type { EedshConfig, PlanLayer, ProfilePlan } from '@eedsh/plan'
import { Effect } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import * as Result from 'effect/Result'
import type * as Schema from 'effect/Schema'
import type { DoctorFinding } from '../doctor'
import type { GenerationRecord } from '../materialize/generated-bundle'
import { GENERATED_PACKAGE_NAME, RUNTIME_PACKAGE_NAME } from '../materialize/generated-bundle'
import type { GenerationLookup } from '../materialize/generation-record'

/** A view failure shaped like a session failure, so the prompt can print it. */
export class ViewError extends Error {
  readonly _tag = 'ReplSessionError'
  readonly code: string
  readonly lines: readonly string[]

  constructor(input: {
    readonly code: string
    readonly message: string
    readonly lines?: readonly string[]
  }) {
    super(input.message)
    this.name = 'ViewError'
    this.code = input.code
    this.lines = input.lines ?? [input.message]
  }
}

/** One resolved row exposed by a bundle view. */
export class BundleRowView {
  /** The Loader row id. */
  readonly id: string
  /** The composed row data. */
  readonly data: PlanEntry
  /** The bundle package the row came from. */
  readonly bundle: string

  constructor(bundle: string, data: PlanEntry) {
    this.bundle = bundle
    this.data = data
    this.id = typeof data.id === 'string' ? data.id : ''
  }

  /** The row as plain plan data. */
  toJSON(): PlanEntry {
    return this.data
  }

  /** Disable this row. */
  disable(): { readonly id: string; readonly disabled: true } {
    return { id: this.id, disabled: true }
  }

  /** Enable this row. */
  enable(): { readonly id: string; readonly disabled: false } {
    return { id: this.id, disabled: false }
  }

  /**
   * Replace this row's whole config.
   * @param config - the complete replacement config.
   * @returns an id-targeted patch.
   */
  override(config: unknown): { readonly id: string; readonly config: unknown } {
    return { id: this.id, config }
  }
}

/** One resolved preset exposed by a bundle view. */
export class BundlePresetView {
  /** The preset's own id from its config. */
  readonly id: string
  /** The inserted Loader row id patches target. */
  readonly rowId: string
  /** The composed row data. */
  readonly data: PlanEntry
  /** The bundle package the preset came from. */
  readonly bundle: string
  /** The preset order, when declared. */
  readonly order?: number
  /** The preset display name, when declared. */
  readonly name?: string
  /** The row's disabled flag, when boolean. */
  readonly disabled?: boolean

  constructor(bundle: string, data: PlanEntry) {
    this.bundle = bundle
    this.data = data
    this.rowId = typeof data.id === 'string' ? data.id : ''
    const config = isRecord(data.config) ? data.config : {}
    this.id = typeof config.id === 'string' ? config.id : this.rowId
    if (typeof config.order === 'number') this.order = config.order
    const name =
      typeof config.name === 'string'
        ? config.name
        : typeof data.name === 'string'
          ? data.name
          : undefined
    if (name !== undefined) this.name = name
    if (typeof data.disabled === 'boolean') this.disabled = data.disabled
  }

  /** The preset row as plain plan data. */
  toJSON(): PlanEntry {
    return this.data
  }

  /** Disable this preset's row. */
  disable(): { readonly id: string; readonly disabled: true } {
    return { id: this.rowId, disabled: true }
  }

  /** Enable this preset's row. */
  enable(): { readonly id: string; readonly disabled: false } {
    return { id: this.rowId, disabled: false }
  }

  /**
   * Replace this preset row's whole config.
   * @param config - the complete replacement config.
   * @returns an id-targeted patch.
   */
  override(config: unknown): { readonly id: string; readonly config: unknown } {
    return { id: this.rowId, config }
  }
}

/** One bundle selection in a profile, over the invocation resolution. */
export class BundleView {
  /** The bundle package name. */
  readonly name: string
  /** The authored source override, when one was declared. */
  readonly source: string | undefined
  /** The profile the queries resolve against. */
  readonly profile: string
  private readonly resolved: ResolvedBundle | undefined

  constructor(selection: NamedBundle, profile: string, resolved?: ResolvedBundle) {
    this.name = selection.name
    this.source = selection.source
    this.profile = profile
    this.resolved = resolved
  }

  /** The bundle selection as plain plan data. */
  toJSON(): NamedBundle {
    return this.source === undefined
      ? { kind: 'bundle', name: this.name }
      : { kind: 'bundle', name: this.name, source: this.source }
  }

  /** Every declared row, from the invocation resolution. */
  rows(): readonly BundleRowView[] {
    return this.bundle().rows.map((entry) => new BundleRowView(this.name, entry))
  }

  /** Every declared preset, from the invocation resolution. */
  presets(): readonly BundlePresetView[] {
    return this.bundle()
      .rows.filter(isPresetEntry)
      .map((entry) => new BundlePresetView(this.name, entry))
  }

  /**
   * One row by Loader id.
   * @param id - the Loader row id.
   * @returns the typed row view.
   */
  row(id: string): BundleRowView {
    const found = this.rows().find((entry) => entry.id === id)
    if (found === undefined) {
      throw new ViewError({
        code: 'repl.row_not_found',
        message: `bundle ${JSON.stringify(this.name)} declares no row ${JSON.stringify(id)}; available rows: ${this.rows()
          .map((entry) => entry.id)
          .join(', ')}`,
      })
    }
    return found
  }

  /**
   * One preset by preset id.
   * @param id - the preset's own config id.
   * @returns the typed preset view.
   */
  preset(id: string): BundlePresetView {
    const found = this.presets().find((entry) => entry.id === id)
    if (found === undefined) {
      throw new ViewError({
        code: 'repl.preset_not_found',
        message: `bundle ${JSON.stringify(this.name)} declares no preset ${JSON.stringify(id)}; available presets: ${this.presets()
          .map((entry) => entry.id)
          .join(', ')}`,
      })
    }
    return found
  }

  /** The resolved bundle package version. */
  version(): string {
    return this.bundle().version
  }

  /** The resolved bundle package directory. */
  packageDir(): string {
    return this.bundle().packageDir
  }

  /** Where the bundle was resolved from. */
  origin(): ResolutionOrigin {
    return this.bundle().origin
  }

  private bundle(): ResolvedBundle {
    if (this.resolved === undefined) {
      throw new ViewError({
        code: 'repl.bundle_unresolved',
        message: `bundle ${JSON.stringify(this.name)} is not resolved for profile ${JSON.stringify(this.profile)}; the invocation resolution has no entry for it`,
      })
    }
    return this.resolved
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** One composed row with its last-touch provenance. */
export class EntryView {
  /** The Loader row id. */
  readonly id: string
  /** The composed entry data. */
  readonly data: Record<string, unknown>
  /** The last layer or bundle that touched the row. */
  readonly source: string | undefined

  constructor(data: Record<string, unknown>, sources: Readonly<Record<string, string>>) {
    this.data = data
    this.id = typeof data.id === 'string' ? data.id : ''
    this.source = this.id === '' ? undefined : sources[this.id]
  }

  /** The composed entry as plain data. */
  toJSON(): Record<string, unknown> {
    return this.data
  }
}

/** The composition snapshot one profile view exposes. */
export interface CompositionSnapshot {
  /** The composed row count. */
  readonly rowCount: number
  /** The composed entries in application order. */
  readonly entries: readonly Record<string, unknown>[]
  /** Row id to the last layer or bundle that touched it. */
  readonly sources: Readonly<Record<string, string>>
  /** Preflight warnings, raw. */
  readonly warnings: readonly string[]
  /** Why composition failed, when it did. */
  readonly error: string | undefined
}

/** One package as the profile view reports it. */
export interface PackageInfo {
  /** The package name. */
  readonly name: string
  /** The declared or manifest specification, when one exists. */
  readonly spec: string | undefined
  /** Whether eedsh manages the package. */
  readonly managed: boolean
  /** The installed package version, when it is installed. */
  readonly installedVersion: string | undefined
}

function stringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[key] = item
  }
  return out
}

/**
 * Read one installed package version, or undefined when it is not installed.
 * @param fileSystem - the file-system service.
 * @param profileDir - the profile directory to inspect; empty means none.
 * @param name - the package name.
 * @returns the installed version, when the manifest is readable and valid.
 */
async function installedVersion(
  fileSystem: FileSystem.FileSystem,
  profileDir: string,
  name: string,
): Promise<string | undefined> {
  if (profileDir === '') return undefined
  try {
    const path = join(profileDir, 'node_modules', ...name.split('/'), 'package.json')
    if (!(await Effect.runPromise(fileSystem.exists(path)))) return undefined
    const parsed = JSON.parse(await Effect.runPromise(fileSystem.readFileString(path))) as {
      version?: unknown
    }
    return typeof parsed.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

/** The dependency specifications one profile manifest declares. */
function manifestPackageSpecs(
  manifest: Record<string, unknown> | undefined,
): Record<string, string> {
  return {
    ...stringRecord(manifest?.dependencies),
    ...stringRecord(manifest?.devDependencies),
    ...stringRecord(manifest?.optionalDependencies),
  }
}

/** The package names a profile view reports, sorted. */
function packageNames(
  plan: ProfilePlan | undefined,
  manifest: Record<string, unknown> | undefined,
): string[] {
  const managed = new Set([
    ...Object.keys(plan?.packages ?? {}),
    RUNTIME_PACKAGE_NAME,
    GENERATED_PACKAGE_NAME,
  ])
  return [...new Set([...managed, ...Object.keys(manifestPackageSpecs(manifest))])].sort()
}

/** Declared, managed, and installed package information for one profile. */
export class PackageView {
  /** The plan's declared package specifications. */
  readonly declared: Readonly<Record<string, string>>
  /** The packages eedsh manages: declared, runtime, and generated. */
  readonly managed: readonly string[]
  /** Installed package versions by name. */
  readonly installed: Readonly<Record<string, string>>
  private readonly infos: readonly PackageInfo[]

  constructor(
    plan: ProfilePlan | undefined,
    manifest: Record<string, unknown> | undefined,
    installed: Readonly<Record<string, string>> = {},
  ) {
    this.declared = { ...(plan?.packages ?? {}) }
    const manifestSpecs = manifestPackageSpecs(manifest)
    const managed = new Set([
      ...Object.keys(this.declared),
      RUNTIME_PACKAGE_NAME,
      GENERATED_PACKAGE_NAME,
    ])
    const infos: PackageInfo[] = []
    for (const name of packageNames(plan, manifest)) {
      const version = installed[name]
      infos.push({
        name,
        spec: this.declared[name] ?? manifestSpecs[name],
        managed: managed.has(name),
        installedVersion: version,
      })
    }
    this.managed = [...managed].sort()
    this.installed = installed
    this.infos = infos
  }

  /**
   * Read one profile's package view, including the installed versions.
   * @param plan - the profile plan, when the profile is valid.
   * @param profileDir - the profile directory to inspect; empty means none.
   * @param manifest - the profile manifest, when readable.
   * @param fileSystem - the file-system service.
   * @returns the declared, managed, and installed package information.
   */
  static async read(
    plan: ProfilePlan | undefined,
    profileDir: string,
    manifest: Record<string, unknown> | undefined,
    fileSystem: FileSystem.FileSystem,
  ): Promise<PackageView> {
    const installed: Record<string, string> = {}
    for (const name of packageNames(plan, manifest)) {
      const version = await installedVersion(fileSystem, profileDir, name)
      if (version !== undefined) installed[name] = version
    }
    return new PackageView(plan, manifest, installed)
  }

  /** Every known package, sorted by name. */
  all(): readonly PackageInfo[] {
    return this.infos
  }

  /**
   * One package by name.
   * @param name - the package name.
   * @returns the package information, or undefined.
   */
  get(name: string): PackageInfo | undefined {
    return this.infos.find((info) => info.name === name)
  }

  /** Every known package name, sorted. */
  names(): readonly string[] {
    return this.infos.map((info) => info.name)
  }
}

/** One published profile's manifest, generation record, plan, and findings. */
export interface PublishedSnapshot {
  /** The inspected profile directory. */
  readonly dir: string
  /** Whether the profile directory exists. */
  readonly exists: boolean
  /** The profile manifest, when readable. */
  readonly manifest: Record<string, unknown> | undefined
  /** The generation-record classification, when a record exists. */
  readonly generation: GenerationLookup | undefined
  /** The valid generation record, when one exists. */
  readonly record: GenerationRecord | undefined
  /** The authoritative plan document, when one exists. */
  readonly plan: unknown
  /** The authoritative plan path, when one exists. */
  readonly planPath: string | undefined
  /** The doctor findings for this profile. */
  readonly findings: readonly DoctorFinding[]
  /** Doctor error count. */
  readonly errors: number
  /** Doctor warning count. */
  readonly warnings: number
}

/** The read-only published state of one profile. */
export class PublishedProfileView {
  /** The inspected profile directory. */
  readonly dir: string
  /** Whether the profile directory exists; a missing profile is not an error. */
  readonly exists: boolean
  /** The profile manifest, when readable. */
  readonly manifest: Record<string, unknown> | undefined
  /** The generation-record classification, when a record exists. */
  readonly generation: GenerationLookup | undefined
  /** The valid generation record, when one exists. */
  readonly record: GenerationRecord | undefined
  /** The authoritative plan document, when one exists. */
  readonly plan: unknown
  /** The authoritative plan path, when one exists. */
  readonly planPath: string | undefined
  /** The doctor findings for this profile. */
  readonly findings: readonly DoctorFinding[]
  /** Doctor error count. */
  readonly errors: number
  /** Doctor warning count. */
  readonly warnings: number

  constructor(snapshot: PublishedSnapshot) {
    this.dir = snapshot.dir
    this.exists = snapshot.exists
    this.manifest = snapshot.manifest
    this.generation = snapshot.generation
    this.record = snapshot.record
    this.plan = snapshot.plan
    this.planPath = snapshot.planPath
    this.findings = snapshot.findings
    this.errors = snapshot.errors
    this.warnings = snapshot.warnings
  }
}

/** The snapshot the session takes for one declared profile. */
export interface ProfileSnapshot {
  /** The profile directory the snapshot inspected. */
  readonly profileDir: string
  /** The composition snapshot, when the profile is valid and composed. */
  readonly composition: CompositionSnapshot | undefined
  /** The published-state snapshot. */
  readonly published: PublishedSnapshot
  /** Package information read when the snapshot was taken, when available. */
  readonly packages?: PackageView
  /** Resolved bundle selections, keyed by bundle name. */
  readonly resolvedBundles?: ReadonlyMap<string, ResolvedBundle>
}

function emptyPublished(dir: string): PublishedSnapshot {
  return {
    dir,
    exists: false,
    manifest: undefined,
    generation: undefined,
    record: undefined,
    plan: undefined,
    planPath: undefined,
    findings: [],
    errors: 0,
    warnings: 0,
  }
}

function emptySnapshot(dir: string): ProfileSnapshot {
  return { profileDir: dir, composition: undefined, published: emptyPublished(dir) }
}

/** One declared profile and its validated-plan result. */
export class ProfileView {
  /** The profile key. */
  readonly name: string
  /** Whether the declared profile is a valid plan. */
  readonly valid: boolean
  /** The native schema failure message when the profile is invalid. */
  readonly error: string | undefined
  private readonly outcome: Result.Result<ProfilePlan, Schema.SchemaError>
  private readonly snapshot: ProfileSnapshot

  constructor(
    name: string,
    outcome: Result.Result<ProfilePlan, Schema.SchemaError>,
    snapshot: ProfileSnapshot = emptySnapshot(''),
  ) {
    this.name = name
    this.outcome = outcome
    this.valid = Result.isSuccess(outcome)
    this.error = Result.isFailure(outcome) ? outcome.failure.message : undefined
    this.snapshot = snapshot
  }

  /** The per-profile validation result. */
  result(): Result.Result<ProfilePlan, Schema.SchemaError> {
    return this.outcome
  }

  /**
   * The validated plan, or a tagged failure for an invalid profile.
   * @returns the profile plan.
   */
  plan(): ProfilePlan {
    if (Result.isFailure(this.outcome)) {
      const lines = [
        `profile ${JSON.stringify(this.name)} is invalid`,
        ...this.outcome.failure.message.split('\n'),
      ]
      throw new ViewError({
        code: 'repl.invalid_profile',
        message: lines[0] ?? `profile ${JSON.stringify(this.name)} is invalid`,
        lines,
      })
    }
    return this.outcome.success
  }

  /** The profile's ordered bundle selections, over the invocation resolution. */
  bundles(): readonly BundleView[] {
    return this.plan().bundles.flatMap((selection) =>
      selection.kind === 'bundle'
        ? [new BundleView(selection, this.name, this.snapshot.resolvedBundles?.get(selection.name))]
        : [],
    )
  }

  /** The profile's ordered generated patch layers. */
  layers(): readonly PlanLayer[] {
    return this.plan().layers
  }

  /** Declared, managed, and installed package information. */
  packages(): PackageView {
    return (
      this.snapshot.packages ??
      new PackageView(
        Result.isSuccess(this.outcome) ? this.outcome.success : undefined,
        this.snapshot.published.manifest,
      )
    )
  }

  /** The composed entries, their provenance, and any composition failure. */
  composition(): {
    readonly rowCount: number
    readonly entries: readonly EntryView[]
    readonly warnings: readonly string[]
    readonly error: string | undefined
  } {
    const snapshot = this.snapshot.composition
    if (snapshot === undefined) {
      return { rowCount: 0, entries: [], warnings: [], error: undefined }
    }
    return {
      rowCount: snapshot.rowCount,
      entries: snapshot.entries.map((entry) => new EntryView(entry, snapshot.sources)),
      warnings: snapshot.warnings,
      error: snapshot.error,
    }
  }

  /** The composed rows with their last-touch provenance. */
  entries(): readonly EntryView[] {
    return this.composition().entries
  }

  /** The read-only published state; a missing profile has `exists: false`. */
  published(): PublishedProfileView {
    return new PublishedProfileView(this.snapshot.published)
  }
}

/** The loaded config as an exploration entry point. */
export class ConfigView {
  /** The declared default profile, when one is named. */
  readonly defaultProfile: string | undefined
  private readonly views: ReadonlyMap<string, ProfileView>

  constructor(config: EedshConfig, snapshots: ReadonlyMap<string, ProfileSnapshot> = new Map()) {
    this.defaultProfile = config.defaultProfile
    this.views = new Map(
      Object.entries(config.profiles).map(([name, outcome]) => [
        name,
        new ProfileView(name, outcome, snapshots.get(name) ?? emptySnapshot('')),
      ]),
    )
  }

  /** Every declared profile in authored order. */
  profiles(): readonly ProfileView[] {
    return [...this.views.values()]
  }

  /**
   * One declared profile by name.
   * @param name - the profile key.
   * @returns the profile view, or undefined when undeclared.
   */
  profile(name: string): ProfileView | undefined {
    return this.views.get(name)
  }
}
