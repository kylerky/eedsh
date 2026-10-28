/**
 * Publication: write every artifact before the generated package manifest is
 * committed. The profile manifest, lockfile, and plan mirror are snapshotted
 * first and restored on any later failure, so no failed run publishes a new
 * generation, leaves a half-updated dependency set, or leaves a stale mirror.
 * @module @eedsh/cli/materialize/publish
 */
import { dirname, join } from 'node:path'
import { canonicalJson, type ProfilePlan } from '@eedsh/plan'
import { Effect, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'
import { writeFileAtomic } from '../internal/atomic-write'
import type { MaterializeError } from '../internal/effect/errors'
import {
  PackageManager,
  type PackageManagerShape,
  Preflight,
  type PreflightShape,
} from '../internal/effect/services'
import { readOptional } from '../internal/read-optional'
import type { Diagnostic } from './diagnostics'
import { type GeneratedBundle, writeGeneratedBundle } from './generated-bundle'
import { readProfileDependencies } from './manifest'
import { ensureProfileFiles, GENERATED_DIRNAME, PLAN_RELATIVE_PATH } from './profile'

/** Inputs for {@link publishProfile}. */
export interface PublishProfileInput {
  plan: ProfilePlan
  profileDir: string
  /** The reconciled profile manifest to persist. */
  manifest: Record<string, unknown>
  generated: GeneratedBundle
  /** The profile manifest as it was before this run, when it existed. */
  previousManifest: Option.Option<Record<string, unknown>>
  strict: boolean
  /** Attribute preflight warnings to their source layers. */
  explain: boolean
  /** Reconciliation diagnostics to report with the publication. */
  notices: readonly Diagnostic[]
}

/** What publication did. */
export interface PublishProfileResult {
  warnings: string[]
  installed: boolean
  /** Reconciliation diagnostics, passed through for the CLI to print. */
  notices: Diagnostic[]
}

/** The profile files publication snapshots before changing them. */
interface ProfileSnapshot {
  manifestPath: string
  lockfilePath: string
  mirrorPath: string
  manifestContent: Option.Option<string>
  lockfileContent: Option.Option<string>
  mirrorContent: Option.Option<string>
}

/** Write profile scaffolding, generated layers, and the authoritative plan. */
function writePublicationArtifacts(
  input: PublishProfileInput,
  generatedDir: string,
  fs: FileSystem.FileSystem,
): Effect.Effect<void, PlatformError.PlatformError> {
  return Effect.gen(function* () {
    yield* ensureProfileFiles(input.profileDir, fs)
    yield* fs.makeDirectory(generatedDir, { recursive: true })
    yield* writeGeneratedBundle(generatedDir, input.generated, fs, { includeManifest: false })
  })
}

/** Write the stable plan mirror at the publication commit point. */
function writePlanMirror(
  fs: FileSystem.FileSystem,
  path: string,
  content: string,
): Effect.Effect<void, PlatformError.PlatformError> {
  return Effect.gen(function* () {
    yield* fs.makeDirectory(dirname(path), { recursive: true })
    yield* writeFileAtomic(fs, path, content)
  })
}

/** Snapshot the profile manifest, lockfile, and mirror before any write. */
function snapshotProfileFiles(
  fs: FileSystem.FileSystem,
  profileDir: string,
): Effect.Effect<ProfileSnapshot, PlatformError.PlatformError> {
  return Effect.gen(function* () {
    const manifestPath = join(profileDir, 'package.json')
    const lockfilePath = join(profileDir, 'pnpm-lock.yaml')
    const mirrorPath = join(profileDir, PLAN_RELATIVE_PATH)
    const manifestContent = yield* readOptional(fs, manifestPath)
    const lockfileContent = yield* readOptional(fs, lockfilePath)
    const mirrorContent = yield* readOptional(fs, mirrorPath)
    return {
      manifestPath,
      lockfilePath,
      mirrorPath,
      manifestContent,
      lockfileContent,
      mirrorContent,
    }
  })
}

/** Whether publication changes any dependency specification. */
function profileDependenciesChanged(
  previousManifest: Option.Option<Record<string, unknown>>,
  manifest: Record<string, unknown>,
): boolean {
  return (
    canonicalJson(readProfileDependencies(previousManifest)) !==
    canonicalJson(readProfileDependencies(Option.some(manifest)))
  )
}

/** Write the reconciled profile manifest in its formatted on-disk form. */
function writeProfileManifest(
  fs: FileSystem.FileSystem,
  path: string,
  manifest: Record<string, unknown>,
): Effect.Effect<void, PlatformError.PlatformError> {
  return writeFileAtomic(fs, path, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** Restore one snapshotted profile file, removing it when it did not exist. */
function restoreFile(
  fs: FileSystem.FileSystem,
  path: string,
  content: Option.Option<string>,
): Effect.Effect<void, PlatformError.PlatformError> {
  if (Option.isNone(content)) return fs.remove(path, { force: true })
  return writeFileAtomic(fs, path, content.value)
}

/** Restore the manifest, lockfile, and mirror to their pre-publication state. */
function restoreProfileFiles(
  fs: FileSystem.FileSystem,
  snapshot: ProfileSnapshot,
): Effect.Effect<void, PlatformError.PlatformError> {
  return Effect.gen(function* () {
    yield* restoreFile(fs, snapshot.manifestPath, snapshot.manifestContent)
    yield* restoreFile(fs, snapshot.lockfilePath, snapshot.lockfileContent)
    yield* restoreFile(fs, snapshot.mirrorPath, snapshot.mirrorContent)
  })
}

/** Run a publication step, restoring the profile snapshots if it fails. */
function restoreOnFailure<A, E>(
  effect: Effect.Effect<A, E>,
  restore: Effect.Effect<void, PlatformError.PlatformError>,
): Effect.Effect<A, E | PlatformError.PlatformError> {
  return effect.pipe(Effect.catch((error) => Effect.andThen(restore, Effect.fail(error))))
}

/** Write the generated package manifest last; it is the publication commit point. */
function commitGeneratedManifest(
  fs: FileSystem.FileSystem,
  generatedDir: string,
  generated: GeneratedBundle,
): Effect.Effect<void, PlatformError.PlatformError> {
  return Effect.gen(function* () {
    const manifestFile = Option.fromUndefinedOr(generated.files.at(-1))
    if (Option.isNone(manifestFile) || manifestFile.value.path !== 'package.json') {
      return yield* Effect.die(new Error('generated bundle is missing its package manifest'))
    }
    yield* writeFileAtomic(
      fs,
      join(generatedDir, manifestFile.value.path),
      manifestFile.value.content,
    )
  })
}

/**
 * Publish a generation. The generated package manifest is the commit point and
 * is written last; the plan mirror is written immediately before it. A failed
 * install, preflight, mirror write, or commit restores the manifest, lockfile,
 * and mirror snapshots first.
 * @param input - plan, reconciled manifest, generated artifacts, and mode.
 * @returns preflight diagnostics and whether packages were installed.
 */
export function publishProfile(
  input: PublishProfileInput,
): Effect.Effect<
  PublishProfileResult,
  MaterializeError,
  FileSystem.FileSystem | PackageManagerShape | PreflightShape
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const packages = yield* PackageManager
    const preflight = yield* Preflight

    const generatedDir = join(input.profileDir, GENERATED_DIRNAME)
    const snapshot = yield* snapshotProfileFiles(fs, input.profileDir)
    yield* writePublicationArtifacts(input, generatedDir, fs)

    const dependenciesChanged = profileDependenciesChanged(input.previousManifest, input.manifest)
    yield* writeProfileManifest(fs, snapshot.manifestPath, input.manifest)
    const restore = restoreProfileFiles(fs, snapshot)

    if (dependenciesChanged) {
      yield* restoreOnFailure(packages.install(input.profileDir), restore)
    }

    const checked = yield* restoreOnFailure(
      preflight.check({
        plan: input.plan,
        profileDir: input.profileDir,
        generated: input.generated,
        strict: input.strict,
        explain: input.explain,
      }),
      restore,
    )

    yield* restoreOnFailure(
      writePlanMirror(fs, snapshot.mirrorPath, input.generated.planContent),
      restore,
    )
    yield* restoreOnFailure(commitGeneratedManifest(fs, generatedDir, input.generated), restore)

    return {
      warnings: checked.warnings,
      installed: dependenciesChanged,
      notices: [...input.notices],
    }
  })
}
