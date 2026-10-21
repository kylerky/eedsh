/**
 * The materialization program: take the profile lock, read the previous
 * generation, reconcile the profile, and publish only when something changed.
 * @module @eedsh/cli/materialize/program
 */
import { join } from 'node:path'
import { canonicalJson, type ProfilePlan } from '@eedsh/config'
import { Effect } from 'effect'
import { FileSystemFailure, type MaterializeError } from '../internal/effect/errors'
import {
  DshInstallation,
  type DshInstallationShape,
  FileSystem,
  type FileSystemShape,
  type PackageManagerShape,
  type PreflightShape,
} from '../internal/effect/services'
import { type SyncLockOptions, withSyncLock } from '../internal/lock'
import { buildGeneratedBundle } from './generated-bundle'
import { readGenerationId, readPreviousGeneration, reconcileManifest } from './manifest'
import { GENERATED_MANIFEST_RELATIVE_PATH, LOCK_RELATIVE_PATH } from './profile'
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
  /** PID liveness probe for stale-lock recovery. */
  isPidAlive?: (pid: number) => boolean
}

/** What a materialization run did. */
export interface MaterializeResult {
  generationId: string
  /** Whether a new generation or manifest was published. */
  changed: boolean
  warnings: string[]
  createdProfile: boolean
}

function readJsonFile(
  fs: FileSystemShape,
  path: string,
): Effect.Effect<Record<string, unknown> | undefined, FileSystemFailure> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(path))) return undefined
    const text = yield* fs.readFile(path)
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
      return parsed as Record<string, unknown>
    } catch (cause) {
      return yield* Effect.fail(new FileSystemFailure({ operation: 'parseJson', path, cause }))
    }
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
  FileSystemShape | PackageManagerShape | DshInstallationShape | PreflightShape
> {
  const lockOptions: SyncLockOptions = { lockPath: join(options.profileDir, LOCK_RELATIVE_PATH) }
  if (options.isPidAlive !== undefined) lockOptions.isPidAlive = options.isPidAlive

  return withSyncLock(
    lockOptions,
    Effect.gen(function* () {
      const fs = yield* FileSystem
      const dsh = yield* DshInstallation

      const manifestPath = join(options.profileDir, 'package.json')
      const generatedManifestPath = join(options.profileDir, GENERATED_MANIFEST_RELATIVE_PATH)
      const existingManifest = yield* readJsonFile(fs, manifestPath)
      const existingGenerated = yield* readJsonFile(fs, generatedManifestPath)
      const previous = readPreviousGeneration(existingGenerated)

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
        readGenerationId(existingGenerated) === generated.generationId &&
        canonicalJson(existingManifest) === canonicalJson(reconciled.manifest)

      if (unchanged) {
        return {
          generationId: generated.generationId,
          changed: false,
          warnings: [],
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
      })

      return {
        generationId: generated.generationId,
        changed: true,
        warnings: published.warnings,
        createdProfile: existingManifest === undefined,
      }
    }),
  )
}
