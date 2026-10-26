/**
 * The materialization program: take the profile lock, read the previous
 * generation, reconcile the profile, and publish only when something changed.
 * @module @eedsh/cli/materialize/program
 */
import { join } from 'node:path'
import { canonicalJson, type ProfilePlan } from '@eedsh/config'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as PlatformError from 'effect/PlatformError'
import * as Predicate from 'effect/Predicate'
import { type MaterializeError, OwnershipRecordInvalid } from '../internal/effect/errors'
import {
  DshInstallation,
  type DshInstallationShape,
  type PackageManagerShape,
  type PreflightShape,
  type SyncLockShape,
} from '../internal/effect/services'
import { withSyncLock } from '../internal/lock'
import type { Diagnostic } from './diagnostics'
import { notice } from './diagnostics'
import {
  buildGeneratedBundle,
  GENERATED_PACKAGE_NAME,
  type GeneratedBundle,
  RUNTIME_PACKAGE_NAME,
} from './generated-bundle'
import {
  type GenerationLookup,
  lookupGenerationRecord,
  missingGenerationRecord,
} from './generation-record'
import {
  declaredDependencyNames,
  hasManagedBundles,
  managedBundleOrder,
  type PreviousGeneration,
  readProfileBundles,
  reconcileManifest,
} from './manifest'
import {
  GENERATED_DIRNAME,
  GENERATED_MANIFEST_RELATIVE_PATH,
  LOCK_RELATIVE_PATH,
  PLAN_RELATIVE_PATH,
} from './profile'
import { publishProfile } from './publish'

/** Inputs for {@link materialize}. */
export interface MaterializeOptions {
  plan: ProfilePlan
  /** Absolute target profile directory. */
  profileDir: string
  /** eedsh version recorded in the generation. */
  eedshVersion: string
  /** Dependency specification for `@eedsh/runtime`. */
  runtimeSpec: string
  /** Dependency specification for `@eedsh/generated`. */
  generatedSpec: string
  /** Treat unmatched patch targets as failures. */
  strict: boolean
  /** Attribute preflight warnings to their source layers. */
  explain: boolean
  /** Re-baseline ownership from the current manifest when the record is invalid. */
  adoptOwnership?: boolean
}

/** What a materialization run did. */
export interface MaterializeResult {
  generationId: string
  /** Whether a new generation or manifest was published. */
  changed: boolean
  warnings: string[]
  /** Structured reconciliation diagnostics. */
  notices: Diagnostic[]
  createdProfile: boolean
}

function readJsonFile(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<Record<string, unknown> | undefined, PlatformError.PlatformError> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(path))) return undefined
    const text = yield* fs.readFileString(path)
    return yield* Effect.try({
      try: () => {
        const parsed: unknown = JSON.parse(text)
        return Predicate.isObject(parsed) ? (parsed as Record<string, unknown>) : undefined
      },
      catch: (cause) =>
        PlatformError.systemError({
          _tag: 'InvalidData',
          module: 'FileSystem',
          method: 'parseJson',
          pathOrDescriptor: path,
          cause,
        }),
    })
  })
}

/** The ownership baseline and diagnostics a materialization starts from. */
interface GenerationBaseline {
  previous: PreviousGeneration | undefined
  notices: Diagnostic[]
}

/**
 * Whether the profile already contains an eedsh artifact, which makes an
 * absent generation record invalid rather than a first run.
 */
function hasPublishedArtifacts(
  fs: FileSystem.FileSystem,
  profileDir: string,
  manifest: Record<string, unknown> | undefined,
): Effect.Effect<boolean, PlatformError.PlatformError> {
  return Effect.gen(function* () {
    if (hasManagedBundles(manifest)) return true
    if (yield* fs.exists(join(profileDir, PLAN_RELATIVE_PATH))) return true
    return yield* fs.exists(join(profileDir, GENERATED_DIRNAME))
  })
}

/** Names the live manifest declares that the plan does not manage. */
function adoptedNames(plan: ProfilePlan, manifest: Record<string, unknown> | undefined): string[] {
  if (manifest === undefined) return []
  const managedBundles = new Set(managedBundleOrder(plan))
  const managedPackages = new Set([
    ...Object.keys(plan.packages),
    RUNTIME_PACKAGE_NAME,
    GENERATED_PACKAGE_NAME,
  ])
  const bundles = readProfileBundles(manifest).filter((name) => !managedBundles.has(name))
  const packages = declaredDependencyNames(manifest).filter((name) => !managedPackages.has(name))
  return [...bundles, ...packages]
}

/** Re-baseline ownership from the current manifest and report what was adopted. */
function adoptionBaseline(
  plan: ProfilePlan,
  manifest: Record<string, unknown> | undefined,
): GenerationBaseline {
  const names = adoptedNames(plan, manifest)
  return {
    previous: undefined,
    notices: names.length === 0 ? [] : [notice(`adopted ownership of ${names.join(', ')}`)],
  }
}

/**
 * Decide the ownership baseline. A missing record is a first run only when no
 * eedsh artifact exists; otherwise materialization fails closed unless the run
 * explicitly adopts ownership.
 */
function resolveGenerationBaseline(
  lookup: GenerationLookup,
  options: MaterializeOptions,
  manifest: Record<string, unknown> | undefined,
  fs: FileSystem.FileSystem,
): Effect.Effect<GenerationBaseline, PlatformError.PlatformError | OwnershipRecordInvalid> {
  return Effect.gen(function* () {
    if (lookup._tag === 'valid') return { previous: lookup.previous, notices: [] }
    const invalid =
      lookup._tag === 'invalid'
        ? lookup
        : (yield* hasPublishedArtifacts(fs, options.profileDir, manifest))
          ? missingGenerationRecord(join(options.profileDir, GENERATED_MANIFEST_RELATIVE_PATH))
          : undefined
    if (invalid === undefined) return { previous: undefined, notices: [] }
    if (options.adoptOwnership === true && invalid.adoptable) {
      return adoptionBaseline(options.plan, manifest)
    }
    return yield* Effect.fail(
      new OwnershipRecordInvalid({
        path: invalid.path,
        reason: invalid.reason,
        detail: invalid.detail,
        adoptable: invalid.adoptable,
      }),
    )
  })
}

/** Whether the committed generation's authoritative plan is present and byte-exact. */
function authoritativePlanIntact(
  fs: FileSystem.FileSystem,
  profileDir: string,
  generated: GeneratedBundle,
): Effect.Effect<boolean, PlatformError.PlatformError> {
  return Effect.gen(function* () {
    const path = join(profileDir, GENERATED_DIRNAME, generated.authoritativePlanPath)
    if (!(yield* fs.exists(path))) return false
    return (yield* fs.readFileString(path)) === generated.authoritativePlanContent
  })
}

/**
 * Materialize a validated plan into a profile.
 * @param options - plan, profile location, dependency specs, and mode.
 * @returns the published generation id and diagnostics.
 */
export function materialize(
  options: MaterializeOptions,
): Effect.Effect<
  MaterializeResult,
  MaterializeError,
  | FileSystem.FileSystem
  | PackageManagerShape
  | DshInstallationShape
  | PreflightShape
  | SyncLockShape
> {
  return withSyncLock(
    join(options.profileDir, LOCK_RELATIVE_PATH),
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dsh = yield* DshInstallation

      const manifestPath = join(options.profileDir, 'package.json')
      const generatedManifestPath = join(options.profileDir, GENERATED_MANIFEST_RELATIVE_PATH)
      const existingManifest = yield* readJsonFile(fs, manifestPath)
      const lookup = yield* lookupGenerationRecord(generatedManifestPath, fs)
      const baseline = yield* resolveGenerationBaseline(lookup, options, existingManifest, fs)
      const previous = baseline.previous

      const reconcileInput = {
        profileName: options.plan.profile.name,
        plan: options.plan,
        runtimeSpec: options.runtimeSpec,
        generatedSpec: options.generatedSpec,
        ...(existingManifest === undefined ? {} : { manifest: existingManifest }),
        ...(previous === undefined ? {} : { previous }),
      }
      const reconciled = reconcileManifest(reconcileInput)
      const generated = buildGeneratedBundle({
        plan: options.plan,
        managedBundles: reconciled.managedBundles,
        packages: reconciled.managedPackages,
        eedshVersion: options.eedshVersion,
        dshVersion: dsh.version,
      })

      const unchanged =
        existingManifest !== undefined &&
        lookup._tag === 'valid' &&
        lookup.record.generationId === generated.generationId &&
        canonicalJson(existingManifest) === canonicalJson(reconciled.manifest) &&
        (yield* authoritativePlanIntact(fs, options.profileDir, generated))

      if (unchanged) {
        return {
          generationId: generated.generationId,
          changed: false,
          warnings: [],
          notices: [...baseline.notices, ...reconciled.notices],
          createdProfile: false,
        }
      }

      const published = yield* publishProfile({
        plan: options.plan,
        profileDir: options.profileDir,
        manifest: reconciled.manifest,
        generated,
        previousManifest: existingManifest,
        strict: options.strict,
        explain: options.explain,
        notices: reconciled.notices,
      })

      return {
        generationId: generated.generationId,
        changed: true,
        warnings: published.warnings,
        notices: [...baseline.notices, ...published.notices],
        createdProfile: existingManifest === undefined,
      }
    }),
  )
}
