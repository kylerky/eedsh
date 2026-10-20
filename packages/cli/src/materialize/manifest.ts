/**
 * Profile manifest reconciliation. Managed bundles and packages are computed
 * from the plan; bundles and dependencies the previous generation did not
 * manage are user-owned and preserved. Everything else eedsh managed before
 * and no longer manages is removed, so code is the source of truth.
 * @module @eedsh/cli/materialize/manifest
 */
import type { ProfilePlan } from '@eedsh/config'
import {
  GENERATED_PACKAGE_NAME,
  GENERATION_FORMAT,
  RUNTIME_PACKAGE_NAME,
} from './generated-bundle.js'

/** What the previous published generation owned. */
export interface PreviousGeneration {
  /** Managed bundle order, including the runtime and generated bundles. */
  bundles: readonly string[]
  /** Managed package specifications. */
  packages: Readonly<Record<string, string>>
}

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
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isObject(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
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

/** Read the bundle list of an existing profile manifest. */
export function readProfileBundles(manifest: Record<string, unknown> | undefined): string[] {
  if (!manifest) return []
  const dsh = isObject(manifest.dsh) ? manifest.dsh : {}
  const profile = isObject(dsh.profile) ? dsh.profile : {}
  return stringArray(profile.bundles)
}

/** Read the dependency map of an existing profile manifest. */
export function readProfileDependencies(
  manifest: Record<string, unknown> | undefined,
): Record<string, string> {
  return stringRecord(manifest?.dependencies)
}

/**
 * Read the previous generation's managed sets from the generated package
 * manifest. Only a record written by eedsh is trusted.
 * @param generatedManifest - parsed generated package manifest.
 * @returns the managed sets, or undefined when no eedsh generation is recorded.
 */
export function readPreviousGeneration(generatedManifest: unknown): PreviousGeneration | undefined {
  if (!isObject(generatedManifest)) return undefined
  const metadata = generatedManifest.eedsh
  if (!isObject(metadata) || metadata.format !== GENERATION_FORMAT) return undefined
  const bundles = stringArray(metadata.bundles)
  const packages = stringRecord(metadata.packages)
  if (bundles.length === 0 && Object.keys(packages).length === 0) return undefined
  return { bundles, packages }
}

/** Read the published generation id from a generated package manifest. */
export function readGenerationId(generatedManifest: unknown): string | undefined {
  if (!isObject(generatedManifest)) return undefined
  const metadata = generatedManifest.eedsh
  if (!isObject(metadata) || metadata.format !== GENERATION_FORMAT) return undefined
  return typeof metadata.generationId === 'string' ? metadata.generationId : undefined
}

function buildManifest(
  existing: Record<string, unknown> | undefined,
  profileName: string,
  bundles: string[],
  dependencies: Record<string, string>,
): Record<string, unknown> {
  const base: Record<string, unknown> = existing
    ? (structuredClone(existing) as Record<string, unknown>)
    : { name: `dsh-profile-${profileName}`, private: true }
  const dsh = isObject(base.dsh) ? { ...base.dsh } : {}
  const profile = isObject(dsh.profile) ? { ...dsh.profile } : {}
  profile.bundles = [...bundles]
  dsh.profile = profile
  base.dsh = dsh
  base.dependencies = dependencies
  return base
}

function sortedRecord(value: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(value).sort()) out[key] = value[key] as string
  return out
}

/**
 * Reconcile the managed bundle list and dependency map with user-owned state.
 * @param input - plan, existing manifest, previous managed sets, and link specs.
 * @returns the reconciled manifest and its declared sets.
 */
export function reconcileManifest(input: ReconcileManifestInput): ReconcileManifestResult {
  const managedBundles = managedBundleOrder(input.plan)
  const managedSet = new Set(managedBundles)
  const previousBundles = new Set(input.previous?.bundles ?? [])

  const existingBundles = readProfileBundles(input.manifest)
  const userBundles: string[] = []
  const seen = new Set(managedSet)
  for (const name of existingBundles) {
    if (seen.has(name) || previousBundles.has(name)) continue
    seen.add(name)
    userBundles.push(name)
  }
  const bundles = [...managedBundles, ...userBundles]

  const managedPackages: Record<string, string> = {
    ...input.plan.packages,
    [RUNTIME_PACKAGE_NAME]: input.runtimeSpec,
    [GENERATED_PACKAGE_NAME]: input.generatedSpec,
  }
  const managedPackageNames = new Set(Object.keys(managedPackages))
  const previousPackageNames = new Set(Object.keys(input.previous?.packages ?? {}))

  const userDependencies: Record<string, string> = {}
  for (const [name, spec] of Object.entries(readProfileDependencies(input.manifest))) {
    if (managedPackageNames.has(name) || previousPackageNames.has(name)) continue
    userDependencies[name] = spec
  }
  const dependencies = sortedRecord({ ...userDependencies, ...managedPackages })

  return {
    manifest: buildManifest(input.manifest, input.profileName, bundles, dependencies),
    bundles,
    managedBundles,
    dependencies,
    managedPackages: sortedRecord(managedPackages),
  }
}
