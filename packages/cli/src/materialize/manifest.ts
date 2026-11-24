/**
 * Profile manifest reconciliation. Managed bundles and packages are computed
 * from the plan; bundles and dependencies the previous generation did not
 * manage are user-owned and preserved. Everything else eedsh managed before
 * and no longer manages is removed, so code is the source of truth.
 *
 * The manifest arrives as the reader's typed view: reconciliation never
 * navigates the raw document except to clone it for rewriting. An entry whose
 * value is not a package specification string is preserved verbatim and
 * reported, because dropping it would silently change the installed set.
 * @module @eedsh/cli/materialize/manifest
 */
import type { ProfilePlan } from '@eedsh/plan'
import { Option } from 'effect'
import { readRecord } from '../internal/schema-readers'
import { type Diagnostic, notice, warning } from './diagnostics'
import { GENERATED_PACKAGE_NAME, RUNTIME_PACKAGE_NAME } from './generated-bundle'
import type { PreviousGeneration } from './generation-record'
import {
  declaredPackageSpecs,
  type ManifestDependencies,
  type ProfileDependencySections,
  type ProfileManifest,
} from './profile-manifest'

export type { PreviousGeneration } from './generation-record'

/** Inputs for {@link reconcileManifest}. */
export interface ReconcileManifestInput {
  profileName: string
  plan: ProfilePlan
  /** The typed view of the existing profile manifest, when the profile already exists. */
  manifest: Option.Option<ProfileManifest>
  /** The previous generation's managed sets, when one was published. */
  previous: Option.Option<PreviousGeneration>
  /** Dependency specification for `@eedsh/runtime`. */
  runtimeSpec: string
  /** Dependency specification for `@eedsh/generated`. */
  generatedSpec: string
  /** Dependency specifications derived for provisioned sources, keyed by package. */
  sourceSpecs?: Readonly<Record<string, string>>
}

/** The reconciled manifest and the sets it declares. */
export interface ReconcileManifestResult {
  manifest: Record<string, unknown>
  /** Final bundle list: managed bundles, then user-added bundles. */
  bundles: string[]
  /** Managed bundle order, including the runtime and generated bundles. */
  managedBundles: string[]
  /** Final dependency map, including preserved entries that are not specifications. */
  dependencies: Record<string, unknown>
  /** Managed package specifications. */
  managedPackages: Record<string, string>
  /** Readable package specifications in each section of the reconciled manifest. */
  sections: ProfileDependencySections
  /** Structured diagnostics for changes eedsh made or could not reconcile. */
  notices: Diagnostic[]
}

/**
 * Compute the managed bundle order for a plan: the runtime bundle sits
 * immediately before the generated bundle, which occupies the authored marker
 * position or, without a marker, follows every managed bundle.
 * @param plan - the validated plan.
 * @returns managed bundle names in application order.
 */
export function managedBundleOrder(plan: ProfilePlan): string[] {
  const order: string[] = []
  let placed = false
  for (const item of plan.bundles) {
    if (item.kind === 'generated') {
      order.push(RUNTIME_PACKAGE_NAME, GENERATED_PACKAGE_NAME)
      placed = true
    } else if (item.kind === 'bundle') {
      order.push(item.name)
    }
  }
  if (!placed) order.push(RUNTIME_PACKAGE_NAME, GENERATED_PACKAGE_NAME)
  return order
}

/**
 * Read the bundle list of an existing profile manifest.
 * @param manifest - the typed manifest view, when one exists.
 * @returns the listed bundle names, ignoring malformed entries.
 */
export function readProfileBundles(manifest: Option.Option<ProfileManifest>): string[] {
  return Option.isNone(manifest) ? [] : [...manifest.value.bundles.names]
}

/**
 * Every package name the manifest declares in an install-relevant section.
 * @param manifest - the typed manifest view, when one exists.
 * @returns the unique package specifications, in section order.
 */
export function declaredDependencyNames(manifest: Option.Option<ProfileManifest>): string[] {
  if (Option.isNone(manifest)) return []
  return Object.keys(declaredPackageSpecs(manifest.value))
}

/**
 * Whether the manifest already selects a bundle eedsh manages. Either bundle
 * means the profile was materialized before, even when its generation record
 * is unreadable.
 * @param manifest - the existing typed manifest view, when one exists.
 * @returns whether eedsh already owns part of the profile.
 */
export function hasManagedBundles(manifest: Option.Option<ProfileManifest>): boolean {
  return readProfileBundles(manifest).some(
    (name) => name === RUNTIME_PACKAGE_NAME || name === GENERATED_PACKAGE_NAME,
  )
}

/** Sections reconciliation may rewrite in place. */
export interface CleanedDependencySections {
  devDependencies: Option.Option<Record<string, unknown>>
  optionalDependencies: Option.Option<Record<string, unknown>>
}

function buildManifest(
  existing: Option.Option<ProfileManifest>,
  profileName: string,
  bundles: string[],
  dependencies: Record<string, unknown>,
  sections: CleanedDependencySections,
): Record<string, unknown> {
  const base: Record<string, unknown> = Option.isNone(existing)
    ? { name: `dsh-profile-${profileName}`, private: true }
    : structuredClone(existing.value.document)
  if (Option.isSome(sections.devDependencies)) base.devDependencies = sections.devDependencies.value
  if (Option.isSome(sections.optionalDependencies)) {
    base.optionalDependencies = sections.optionalDependencies.value
  }
  const dsh = readRecord(base.dsh)
  return {
    ...base,
    dsh: {
      ...dsh,
      profile: { ...readRecord(dsh.profile), bundles: [...bundles] },
    },
    dependencies,
  }
}

function sortedRecord<T>(value: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const key of Object.keys(value).sort()) out[key] = value[key] as T
  return out
}

/** Reconcile the managed bundle order with user-added bundles. */
function reconcileBundles(input: ReconcileManifestInput): {
  bundles: string[]
  managedBundles: string[]
} {
  const managedBundles = managedBundleOrder(input.plan)
  const seen = new Set(managedBundles)
  const previousBundles = new Set(Option.isNone(input.previous) ? [] : input.previous.value.bundles)
  const userBundles: string[] = []
  for (const name of readProfileBundles(input.manifest)) {
    if (seen.has(name) || previousBundles.has(name)) continue
    seen.add(name)
    userBundles.push(name)
  }
  return { bundles: [...managedBundles, ...userBundles], managedBundles }
}

/**
 * Build the managed package map: plan packages, the derived source
 * specifications, and the runtime and generated specs. A derived source
 * specification is managed exactly like an authored one, so a moved location
 * rewrites it and a removed declaration removes it.
 */
function managedPackageSpecs(input: ReconcileManifestInput): Record<string, string> {
  return sortedRecord({
    ...input.plan.packages,
    ...input.sourceSpecs,
    [RUNTIME_PACKAGE_NAME]: input.runtimeSpec,
    [GENERATED_PACKAGE_NAME]: input.generatedSpec,
  })
}

/**
 * Reconcile managed package specifications with user-owned dependencies. A
 * managed specification wins over a user declaration; an entry whose value is
 * not a specification is preserved verbatim and reported, unless the managed
 * specification replaces it. A section that is not a record is rebuilt from
 * the managed specifications and the loss is reported.
 */
function reconcileDependencies(
  input: ReconcileManifestInput,
  managedPackages: Record<string, string>,
): { dependencies: Record<string, unknown>; rebuilt: boolean } {
  const managedNames = new Set(Object.keys(managedPackages))
  const previousNames = new Set(
    Option.isNone(input.previous) ? [] : Object.keys(input.previous.value.packages),
  )
  const section = Option.match(input.manifest, {
    onNone: () => undefined,
    onSome: (manifest) => manifest.dependencies,
  })
  if (section !== undefined && section.state === 'malformed') {
    return { dependencies: sortedRecord({ ...managedPackages }), rebuilt: true }
  }
  const userDependencies: Record<string, unknown> = {}
  if (section !== undefined) {
    for (const [name, spec] of Object.entries(section.specs)) {
      if (managedNames.has(name) || previousNames.has(name)) continue
      userDependencies[name] = spec
    }
    for (const [name, entry] of Object.entries(section.entries)) {
      if (typeof entry === 'string' || managedNames.has(name)) continue
      userDependencies[name] = entry
    }
  }
  return {
    dependencies: sortedRecord({ ...userDependencies, ...managedPackages }),
    rebuilt: false,
  }
}

/** Sections whose managed entries reconciliation removes. */
const OWNED_SECTIONS = ['devDependencies', 'optionalDependencies'] as const

/** Fields that may pin a managed package outside reconciliation; reported only. */
const CONFLICT_FIELDS = ['peerDependencies', 'pnpm.overrides', 'overrides', 'resolutions'] as const

/** A dependency section eedsh reads for managed names. */
export type DependencyConflictField =
  | (typeof OWNED_SECTIONS)[number]
  | (typeof CONFLICT_FIELDS)[number]

/** One managed name found in a dependency section. */
export interface DependencyConflict {
  readonly field: DependencyConflictField
  readonly name: string
}

/** One dependency section entry that is not a package specification string. */
export interface DependencyEntryProblem {
  readonly field: 'dependencies' | (typeof OWNED_SECTIONS)[number]
  readonly name: string
}

/** What a scan of the dependency sections found. */
export interface DependencySectionScan {
  /** Managed names in every section, in section and package order. */
  readonly conflicts: DependencyConflict[]
  /** Owned sections that are not a record of string specifications. */
  readonly malformed: readonly (typeof OWNED_SECTIONS)[number][]
  /** Entries whose value is not a package specification string, in section order. */
  readonly unreadable: readonly DependencyEntryProblem[]
}

function manifestConflictNames(
  manifest: ProfileManifest,
): [(typeof CONFLICT_FIELDS)[number], readonly string[]][] {
  return [
    ['peerDependencies', manifest.conflicts.peerDependencies],
    ['pnpm.overrides', manifest.conflicts.pnpmOverrides],
    ['overrides', manifest.conflicts.overrides],
    ['resolutions', manifest.conflicts.resolutions],
  ]
}

function ownedSection(
  manifest: ProfileManifest,
  section: (typeof OWNED_SECTIONS)[number],
): ManifestDependencies {
  return section === 'devDependencies' ? manifest.devDependencies : manifest.optionalDependencies
}

/**
 * Find managed names in every dependency section eedsh inventories. Sync turns
 * owned-section hits into removals and the rest into warnings; doctor reports
 * all of them. Sharing the scan keeps the two commands from drifting.
 * @param manifest - the typed manifest view.
 * @param names - the package names eedsh manages.
 * @returns the conflicts, unreadable owned sections, and unreadable entries.
 */
export function scanDependencyConflicts(
  manifest: ProfileManifest,
  names: ReadonlySet<string>,
): DependencySectionScan {
  const conflicts: DependencyConflict[] = []
  const malformed: (typeof OWNED_SECTIONS)[number][] = []
  const unreadable: DependencyEntryProblem[] = []
  for (const section of OWNED_SECTIONS) {
    const read = ownedSection(manifest, section)
    if (read.state === 'malformed') {
      malformed.push(section)
      continue
    }
    for (const name of Object.keys(read.specs).sort()) {
      if (names.has(name)) conflicts.push({ field: section, name })
    }
    for (const name of read.unreadable) unreadable.push({ field: section, name })
  }
  for (const name of manifest.dependencies.unreadable) {
    unreadable.push({ field: 'dependencies', name })
  }
  for (const [field, declared] of manifestConflictNames(manifest)) {
    for (const name of declared) {
      if (names.has(name)) conflicts.push({ field, name })
    }
  }
  return { conflicts, malformed, unreadable }
}

interface KeyedDiagnostic {
  readonly key: string
  readonly diagnostic: Diagnostic
}

function orderNotices(entries: KeyedDiagnostic[]): Diagnostic[] {
  return [...entries]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => entry.diagnostic)
}

/** Remove managed names from the owned sections and report every diagnostic. */
function reconcileDependencySections(
  input: ReconcileManifestInput,
  managedPackages: Record<string, string>,
  rebuiltDependencies: boolean,
): {
  cleaned: CleanedDependencySections
  specs: { devDependencies: Record<string, string>; optionalDependencies: Record<string, string> }
  notices: KeyedDiagnostic[]
} {
  const cleaned: CleanedDependencySections = {
    devDependencies: Option.none(),
    optionalDependencies: Option.none(),
  }
  const specs = {
    devDependencies: {} as Record<string, string>,
    optionalDependencies: {} as Record<string, string>,
  }
  if (Option.isNone(input.manifest)) return { cleaned, specs, notices: [] }
  const manifest = input.manifest.value
  const owned = new Set([
    ...Object.keys(managedPackages),
    ...(Option.isNone(input.previous) ? [] : Object.keys(input.previous.value.packages)),
  ])
  const scan = scanDependencyConflicts(manifest, owned)
  for (const section of OWNED_SECTIONS) {
    const read = ownedSection(manifest, section)
    if (read.state === 'absent' || read.state === 'malformed') continue
    const value: Record<string, unknown> = {}
    const sectionSpecs: Record<string, string> = {}
    for (const [name, entry] of Object.entries(read.entries)) {
      const readableManaged = owned.has(name) && typeof entry === 'string'
      if (readableManaged) continue
      value[name] = entry
      if (typeof entry === 'string') sectionSpecs[name] = entry
    }
    if (section === 'devDependencies') {
      cleaned.devDependencies = Option.some(value)
      specs.devDependencies = sectionSpecs
    } else {
      cleaned.optionalDependencies = Option.some(value)
      specs.optionalDependencies = sectionSpecs
    }
  }
  const entries: KeyedDiagnostic[] = []
  if (rebuiltDependencies) {
    entries.push({
      key: `dependencies\u0000`,
      diagnostic: warning(
        'dependencies is not a record of package specifications; rebuilt from the managed specifications, so its previous contents could not be preserved',
      ),
    })
  }
  for (const section of scan.malformed) {
    entries.push({
      key: `${section}\u0000`,
      diagnostic: warning(
        `cannot reconcile ${section}: it is not a record of package specifications; left unchanged`,
      ),
    })
  }
  for (const conflict of scan.conflicts) {
    entries.push({
      key: `${conflict.field}\u0000${conflict.name}`,
      diagnostic:
        conflict.field === 'devDependencies' || conflict.field === 'optionalDependencies'
          ? notice(`removed ${conflict.name} from ${conflict.field}`)
          : warning(
              `managed package ${conflict.name} is also declared in ${conflict.field}; the resolved version may differ`,
            ),
    })
  }
  const managedNames = new Set(Object.keys(managedPackages))
  for (const problem of scan.unreadable) {
    if (problem.field === 'dependencies' && managedNames.has(problem.name)) continue
    entries.push({
      key: `${problem.field}\u0000${problem.name}`,
      diagnostic: warning(
        `cannot reconcile ${problem.name} in ${problem.field}: its value is not a package specification string; left unchanged`,
      ),
    })
  }
  return { cleaned, specs, notices: entries }
}

/**
 * Reconcile the managed bundle list, package map, and dependency map with
 * user-owned state.
 * @param input - plan, typed manifest view, previous managed sets, and link specs.
 * @returns the reconciled manifest and its declared sets.
 */
export function reconcileManifest(input: ReconcileManifestInput): ReconcileManifestResult {
  const { bundles, managedBundles } = reconcileBundles(input)
  const managedPackages = managedPackageSpecs(input)
  const dependencies = reconcileDependencies(input, managedPackages)
  const sections = reconcileDependencySections(input, managedPackages, dependencies.rebuilt)
  const dependencySpecs: Record<string, string> = {}
  for (const [name, entry] of Object.entries(dependencies.dependencies)) {
    if (typeof entry === 'string') dependencySpecs[name] = entry
  }
  return {
    manifest: buildManifest(
      input.manifest,
      input.profileName,
      bundles,
      dependencies.dependencies,
      sections.cleaned,
    ),
    bundles,
    managedBundles,
    dependencies: dependencies.dependencies,
    managedPackages,
    sections: {
      dependencies: dependencySpecs,
      devDependencies: sections.specs.devDependencies,
      optionalDependencies: sections.specs.optionalDependencies,
    },
    notices: orderNotices(sections.notices),
  }
}
