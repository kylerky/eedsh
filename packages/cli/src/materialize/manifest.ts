/**
 * Profile manifest reconciliation. Managed bundles and packages are computed
 * from the plan; bundles and dependencies the previous generation did not
 * manage are user-owned and preserved. Everything else eedsh managed before
 * and no longer manages is removed, so code is the source of truth.
 * @module @eedsh/cli/materialize/manifest
 */
import type { ProfilePlan } from '@eedsh/config'
import { Option, Schema } from 'effect'
import { readRecord, readStringArray, readStringRecord } from '../internal/schema-readers'
import { type Diagnostic, notice, warning } from './diagnostics'
import { GENERATED_PACKAGE_NAME, RUNTIME_PACKAGE_NAME } from './generated-bundle'
import type { PreviousGeneration } from './generation-record'

export type { PreviousGeneration } from './generation-record'

/** Inputs for {@link reconcileManifest}. */
export interface ReconcileManifestInput {
  profileName: string
  plan: ProfilePlan
  /** The existing profile manifest, when the profile already exists. */
  manifest: Option.Option<Record<string, unknown>>
  /** The previous generation's managed sets, when one was published. */
  previous: Option.Option<PreviousGeneration>
  /** Dependency specification for `@eedsh/runtime`. */
  runtimeSpec: string
  /** Dependency specification for `@eedsh/generated`. */
  generatedSpec: string
}

/** The reconciled manifest and the sets it declares. */
export interface ReconcileManifestResult {
  manifest: Record<string, unknown>
  /** Final bundle list: managed bundles, then user-added bundles. */
  bundles: string[]
  /** Managed bundle order, including the runtime and generated bundles. */
  managedBundles: string[]
  /** Final dependency map. */
  dependencies: Record<string, string>
  /** Managed package specifications. */
  managedPackages: Record<string, string>
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

/** Read one top-level manifest field, preserving the absent case. */
function manifestField(manifest: Option.Option<Record<string, unknown>>, key: string): unknown {
  if (Option.isNone(manifest)) return undefined
  return manifest.value[key]
}

/**
 * Read the bundle list of an existing profile manifest.
 * @param manifest - the profile manifest, when one exists.
 * @returns the listed bundle names, ignoring malformed entries.
 */
export function readProfileBundles(manifest: Option.Option<Record<string, unknown>>): string[] {
  const dsh = readRecord(manifestField(manifest, 'dsh'))
  return readStringArray(readRecord(dsh.profile).bundles)
}

/** The install-relevant dependency sections of a profile manifest. */
export interface ProfileDependencies {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  optionalDependencies: Record<string, string>
}

/**
 * Read the dependency sections eedsh reconciles.
 * @param manifest - the profile manifest, when one exists.
 * @returns the three install-relevant sections, omitting malformed entries.
 */
export function readProfileDependencies(
  manifest: Option.Option<Record<string, unknown>>,
): ProfileDependencies {
  return {
    dependencies: readStringRecord(manifestField(manifest, 'dependencies')),
    devDependencies: readStringRecord(manifestField(manifest, 'devDependencies')),
    optionalDependencies: readStringRecord(manifestField(manifest, 'optionalDependencies')),
  }
}

/**
 * Every package name the manifest declares in an install-relevant section.
 * @param manifest - the profile manifest, when one exists.
 * @returns the unique package names, in section order.
 */
export function declaredDependencyNames(
  manifest: Option.Option<Record<string, unknown>>,
): string[] {
  const sections = readProfileDependencies(manifest)
  return [
    ...new Set([
      ...Object.keys(sections.dependencies),
      ...Object.keys(sections.devDependencies),
      ...Object.keys(sections.optionalDependencies),
    ]),
  ]
}

/**
 * Whether the manifest already selects a bundle eedsh manages. Either bundle
 * means the profile was materialized before, even when its generation record
 * is unreadable.
 * @param manifest - the existing profile manifest, when one exists.
 * @returns whether eedsh already owns part of the profile.
 */
export function hasManagedBundles(manifest: Option.Option<Record<string, unknown>>): boolean {
  return readProfileBundles(manifest).some(
    (name) => name === RUNTIME_PACKAGE_NAME || name === GENERATED_PACKAGE_NAME,
  )
}

/** Sections reconciliation may rewrite in place. */
export interface CleanedDependencySections {
  devDependencies: Option.Option<Record<string, string>>
  optionalDependencies: Option.Option<Record<string, string>>
}

function buildManifest(
  existing: Option.Option<Record<string, unknown>>,
  profileName: string,
  bundles: string[],
  dependencies: Record<string, string>,
  sections: CleanedDependencySections,
): Record<string, unknown> {
  const base: Record<string, unknown> = Option.isNone(existing)
    ? { name: `dsh-profile-${profileName}`, private: true }
    : structuredClone(existing.value)
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

function sortedRecord(value: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(value).sort()) out[key] = value[key] as string
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

/** Build the managed package map: plan packages plus the runtime and generated specs. */
function managedPackageSpecs(input: ReconcileManifestInput): Record<string, string> {
  return sortedRecord({
    ...input.plan.packages,
    [RUNTIME_PACKAGE_NAME]: input.runtimeSpec,
    [GENERATED_PACKAGE_NAME]: input.generatedSpec,
  })
}

/** Reconcile managed package specifications with user-owned dependencies. */
function reconcileDependencies(
  input: ReconcileManifestInput,
  managedPackages: Record<string, string>,
): Record<string, string> {
  const managedNames = new Set(Object.keys(managedPackages))
  const previousNames = new Set(
    Option.isNone(input.previous) ? [] : Object.keys(input.previous.value.packages),
  )
  const userDependencies: Record<string, string> = {}
  for (const [name, spec] of Object.entries(readProfileDependencies(input.manifest).dependencies)) {
    if (managedNames.has(name) || previousNames.has(name)) continue
    userDependencies[name] = spec
  }
  return sortedRecord({ ...userDependencies, ...managedPackages })
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

/** What a scan of the dependency sections found. */
export interface DependencySectionScan {
  /** Managed names in every section, in section and package order. */
  readonly conflicts: DependencyConflict[]
  /** Owned sections that are not a record of string specifications. */
  readonly malformed: readonly (typeof OWNED_SECTIONS)[number][]
}

type SectionRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'valid'; readonly value: Record<string, string> }
  | { readonly kind: 'malformed' }

const strictSectionSchema = Schema.Record(Schema.String, Schema.String)

/** Read a section strictly: a malformed section is reported, never rewritten. */
function readStrictSection(value: unknown): SectionRead {
  if (value === undefined) return { kind: 'absent' }
  const decoded = Schema.decodeUnknownOption(strictSectionSchema)(value)
  if (Option.isNone(decoded)) return { kind: 'malformed' }
  return { kind: 'valid', value: { ...decoded.value } }
}

/** Read the value a conflict field resolves to, including `pnpm.overrides`. */
function conflictValue(
  manifest: Option.Option<Record<string, unknown>>,
  field: (typeof CONFLICT_FIELDS)[number],
): unknown {
  if (field !== 'pnpm.overrides') return manifestField(manifest, field)
  const pnpm = readRecord(manifestField(manifest, 'pnpm'))
  return pnpm.overrides
}

/**
 * Find managed names in every dependency section eedsh inventories. Sync turns
 * owned-section hits into removals and the rest into warnings; doctor reports
 * all of them. Sharing the scan keeps the two commands from drifting.
 * @param manifest - the profile manifest, when one exists.
 * @param names - the package names eedsh manages.
 * @returns the conflicts and any owned sections that cannot be read.
 */
export function scanDependencyConflicts(
  manifest: Option.Option<Record<string, unknown>>,
  names: ReadonlySet<string>,
): DependencySectionScan {
  const conflicts: DependencyConflict[] = []
  const malformed: (typeof OWNED_SECTIONS)[number][] = []
  for (const section of OWNED_SECTIONS) {
    const read = readStrictSection(manifestField(manifest, section))
    if (read.kind === 'malformed') {
      malformed.push(section)
      continue
    }
    if (read.kind === 'absent') continue
    for (const name of Object.keys(read.value).sort()) {
      if (names.has(name)) conflicts.push({ field: section, name })
    }
  }
  for (const field of CONFLICT_FIELDS) {
    const value = readRecord(conflictValue(manifest, field))
    for (const name of Object.keys(value).sort()) {
      if (names.has(name)) conflicts.push({ field, name })
    }
  }
  return { conflicts, malformed }
}

/** Remove managed names from the owned sections and report every diagnostic. */
function reconcileDependencySections(
  input: ReconcileManifestInput,
  managedPackages: Record<string, string>,
): CleanedDependencySections & { notices: Diagnostic[] } {
  const owned = new Set([
    ...Object.keys(managedPackages),
    ...(Option.isNone(input.previous) ? [] : Object.keys(input.previous.value.packages)),
  ])
  const scan = scanDependencyConflicts(input.manifest, owned)
  const entries: { key: string; diagnostic: Diagnostic }[] = []
  const cleaned: CleanedDependencySections = {
    devDependencies: Option.none(),
    optionalDependencies: Option.none(),
  }

  for (const section of OWNED_SECTIONS) {
    const read = readStrictSection(manifestField(input.manifest, section))
    if (read.kind !== 'valid') continue
    const value = { ...read.value }
    for (const name of Object.keys(value)) {
      if (owned.has(name)) delete value[name]
    }
    if (section === 'devDependencies') cleaned.devDependencies = Option.some(value)
    else cleaned.optionalDependencies = Option.some(value)
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

  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return { ...cleaned, notices: entries.map((entry) => entry.diagnostic) }
}

/**
 * Reconcile the managed bundle list, package map, and dependency map with
 * user-owned state.
 * @param input - plan, existing manifest, previous managed sets, and link specs.
 * @returns the reconciled manifest and its declared sets.
 */
export function reconcileManifest(input: ReconcileManifestInput): ReconcileManifestResult {
  const { bundles, managedBundles } = reconcileBundles(input)
  const managedPackages = managedPackageSpecs(input)
  const dependencies = reconcileDependencies(input, managedPackages)
  const sections = reconcileDependencySections(input, managedPackages)

  return {
    manifest: buildManifest(input.manifest, input.profileName, bundles, dependencies, sections),
    bundles,
    managedBundles,
    dependencies,
    managedPackages,
    notices: sections.notices,
  }
}
