/**
 * Read-only exploration views over the loaded config. The CLI builds them from
 * the validated config value and snapshots taken while the session loads; they
 * never import the config project's authoring module, never write profile
 * files, and never publish. A view is a snapshot for one evaluation and is
 * rebuilt by the session on load, reload, profile switch, preview change, and a
 * successful sync.
 * @module @eedsh/cli/repl/views
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type BundleQuery,
  bundle as bundleHandle,
  type NamedBundle,
  type Preset,
  type ResolutionOrigin,
  type Row,
} from '@eedsh/config'
import type { EedshConfig, PlanLayer, ProfilePlan } from '@eedsh/plan'
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

/**
 * One bundle selection in a profile, querying that profile's installed copy.
 * A rooted bundle is query-only and never becomes a plan selection here.
 */
export class BundleView {
  /** The bundle package name. */
  readonly name: string
  /** The authored source override, when one was declared. */
  readonly source: string | undefined
  /** The profile the queries resolve against. */
  readonly profile: string
  private readonly query: BundleQuery

  constructor(selection: NamedBundle, profile: string) {
    this.name = selection.name
    this.source = selection.source
    this.profile = profile
    this.query = bundleHandle(selection.name).fromProfile(profile)
  }

  /** The bundle selection as plain plan data. */
  toJSON(): NamedBundle {
    return this.source === undefined
      ? { kind: 'bundle', name: this.name }
      : { kind: 'bundle', name: this.name, source: this.source }
  }

  /** Every declared row, as typed immutable handles. */
  rows(): readonly Row[] {
    return this.query.rows()
  }

  /** Every declared preset, as typed immutable handles. */
  presets(): readonly Preset[] {
    return this.query.presets()
  }

  /**
   * One row by Loader id.
   * @param id - the Loader row id.
   * @returns the typed row.
   */
  row(id: string): Row {
    return this.query.row(id)
  }

  /**
   * One preset by preset id.
   * @param id - the preset's own config id.
   * @returns the typed preset.
   */
  preset(id: string): Preset {
    return this.query.preset(id)
  }

  /** The resolved bundle package version. */
  version(): string {
    return this.query.version()
  }

  /** The resolved bundle package directory. */
  packageDir(): string {
    return this.query.packageDir()
  }

  /** Where the bundle was resolved from. */
  origin(): ResolutionOrigin {
    return this.query.origin()
  }
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

function installedVersion(profileDir: string, name: string): string | undefined {
  if (profileDir === '') return undefined
  try {
    const path = join(profileDir, 'node_modules', ...name.split('/'), 'package.json')
    if (!existsSync(path)) return undefined
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
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
    profileDir: string,
    manifest: Record<string, unknown> | undefined,
  ) {
    this.declared = { ...(plan?.packages ?? {}) }
    const manifestSpecs = {
      ...stringRecord(manifest?.dependencies),
      ...stringRecord(manifest?.devDependencies),
      ...stringRecord(manifest?.optionalDependencies),
    }
    const managed = new Set([
      ...Object.keys(this.declared),
      RUNTIME_PACKAGE_NAME,
      GENERATED_PACKAGE_NAME,
    ])
    const names = [...new Set([...managed, ...Object.keys(manifestSpecs)])].sort()
    const installed: Record<string, string> = {}
    const infos: PackageInfo[] = []
    for (const name of names) {
      const version = installedVersion(profileDir, name)
      if (version !== undefined) installed[name] = version
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

  /** The profile's ordered bundle selections, queryable against the profile. */
  bundles(): readonly BundleView[] {
    return this.plan().bundles.flatMap((selection) =>
      selection.kind === 'bundle' ? [new BundleView(selection, this.name)] : [],
    )
  }

  /** The profile's ordered generated patch layers. */
  layers(): readonly PlanLayer[] {
    return this.plan().layers
  }

  /** Declared, managed, and installed package information. */
  packages(): PackageView {
    return new PackageView(
      Result.isSuccess(this.outcome) ? this.outcome.success : undefined,
      this.snapshot.profileDir,
      this.snapshot.published.manifest,
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
