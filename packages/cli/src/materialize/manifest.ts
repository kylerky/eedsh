/**
 * Profile manifest reconciliation. Managed bundles and packages are computed
 * from the plan; bundles and dependencies the previous generation did not
 * manage are user-owned and preserved. Everything else eedsh managed before
 * and no longer manages is removed, so code is the source of truth.
 * @module @eedsh/cli/materialize/manifest
 */
import type { ProfilePlan } from '@eedsh/config'
import * as Predicate from 'effect/Predicate'
import { type Diagnostic, notice, warning } from './diagnostics'
import { GENERATED_PACKAGE_NAME, RUNTIME_PACKAGE_NAME } from './generated-bundle'
import type { PreviousGeneration } from './generation-record'

export type { PreviousGeneration } from './generation-record'

/** Inputs for {@link reconcileManifest}. */
export interface ReconcileManifestInput {
  profileName: string
  plan: ProfilePlan
  /** The existing profile manifest, when the profile already exists. */
  manifest?: Record<string, unknown> | undefined
  /** The previous generation's managed sets, when one was published. */
  previous?: PreviousGeneration | undefined
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

/** Read a value as a plain record, when it is one. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return Predicate.isObject(value) ? (value as Record<string, unknown>) : undefined
}

function stringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value)
  if (record === undefined) return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string') out[key] = item
  }
  return out
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
 * Read a child node as a record, or an empty record when it is absent or not a
 * record, so callers can treat the manifest shape as total.
 * @param parent - the containing record, when it exists.
 * @param key - the child key.
 * @returns the child record, or an empty record.
 */
function childRecord(
  parent: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> {
  return asRecord(parent?.[key]) ?? {}
}

/**
 * Read the bundle list of an existing profile manifest.
 * @param manifest - the profile manifest, when one exists.
 * @returns the listed bundle names, ignoring malformed entries.
 */
export function readProfileBundles(manifest: Record<string, unknown> | undefined): string[] {
  const dsh = childRecord(manifest, 'dsh')
  return stringArray(childRecord(dsh, 'profile').bundles)
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
  manifest: Record<string, unknown> | undefined,
): ProfileDependencies {
  return {
    dependencies: stringRecord(manifest?.dependencies),
    devDependencies: stringRecord(manifest?.devDependencies),
    optionalDependencies: stringRecord(manifest?.optionalDependencies),
  }
}

/**
 * Every package name the manifest declares in an install-relevant section.
 * @param manifest - the profile manifest, when one exists.
 * @returns the unique package names, in section order.
 */
export function declaredDependencyNames(manifest: Record<string, unknown> | undefined): string[] {
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
export function hasManagedBundles(manifest: Record<string, unknown> | undefined): boolean {
  return readProfileBundles(manifest).some(
    (name) => name === RUNTIME_PACKAGE_NAME || name === GENERATED_PACKAGE_NAME,
  )
}

/** Sections reconciliation may rewrite in place. */
export interface CleanedDependencySections {
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

function buildManifest(
  existing: Record<string, unknown> | undefined,
  profileName: string,
  bundles: string[],
  dependencies: Record<string, string>,
  sections: CleanedDependencySections,
): Record<string, unknown> {
  const base: Record<string, unknown> = existing
    ? structuredClone(existing)
    : { name: `dsh-profile-${profileName}`, private: true }
  if (sections.devDependencies !== undefined) base.devDependencies = sections.devDependencies
  if (sections.optionalDependencies !== undefined) {
    base.optionalDependencies = sections.optionalDependencies
  }
  const dsh = childRecord(base, 'dsh')
  return {
    ...base,
    dsh: {
      ...dsh,
      profile: { ...childRecord(dsh, 'profile'), bundles: [...bundles] },
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
  const previousBundles = new Set(input.previous?.bundles ?? [])
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
  const previousNames = new Set(Object.keys(input.previous?.packages ?? {}))
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

type ConflictField = (typeof CONFLICT_FIELDS)[number]

type SectionRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'valid'; readonly value: Record<string, string> }
  | { readonly kind: 'malformed' }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Read a section strictly: a malformed section is reported, never rewritten. */
function readStrictSection(value: unknown): SectionRead {
  if (value === undefined) return { kind: 'absent' }
  if (!isPlainRecord(value)) return { kind: 'malformed' }
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return { kind: 'malformed' }
    out[key] = item
  }
  return { kind: 'valid', value: out }
}

/** Read the value a conflict field resolves to, including `pnpm.overrides`. */
function conflictValue(
  manifest: Record<string, unknown> | undefined,
  field: ConflictField,
): unknown {
  if (field !== 'pnpm.overrides') return manifest?.[field]
  const pnpm = asRecord(manifest?.pnpm)
  return pnpm?.overrides
}

/** Remove managed names from the owned sections and report every diagnostic. */
function reconcileDependencySections(
  input: ReconcileManifestInput,
  managedPackages: Record<string, string>,
): CleanedDependencySections & { notices: Diagnostic[] } {
  const owned = new Set([
    ...Object.keys(managedPackages),
    ...Object.keys(input.previous?.packages ?? {}),
  ])
  const entries: { key: string; diagnostic: Diagnostic }[] = []
  const cleaned: CleanedDependencySections = {}

  for (const section of OWNED_SECTIONS) {
    const read = readStrictSection(input.manifest?.[section])
    if (read.kind === 'absent') continue
    if (read.kind === 'malformed') {
      entries.push({
        key: `${section}\u0000`,
        diagnostic: warning(
          `cannot reconcile ${section}: it is not a record of package specifications; left unchanged`,
        ),
      })
      continue
    }
    const value = { ...read.value }
    for (const name of Object.keys(read.value).sort()) {
      if (!owned.has(name)) continue
      delete value[name]
      entries.push({
        key: `${section}\u0000${name}`,
        diagnostic: notice(`removed ${name} from ${section}`),
      })
    }
    if (section === 'devDependencies') cleaned.devDependencies = value
    else cleaned.optionalDependencies = value
  }

  for (const field of CONFLICT_FIELDS) {
    const value = asRecord(conflictValue(input.manifest, field))
    if (value === undefined) continue
    for (const name of Object.keys(value).sort()) {
      if (!owned.has(name)) continue
      entries.push({
        key: `${field}\u0000${name}`,
        diagnostic: warning(
          `managed package ${name} is also declared in ${field}; the resolved version may differ`,
        ),
      })
    }
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
