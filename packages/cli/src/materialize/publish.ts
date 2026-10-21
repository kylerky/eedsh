/**
 * Publication: write every artifact before the generated package manifest is
 * committed. Package installation and preflight failures restore the profile
 * manifest and lockfile snapshots, so no failed run publishes a new
 * generation or leaves a half-updated dependency set.
 * @module @eedsh/cli/materialize/publish
 */
import { dirname, join } from 'node:path'
import { canonicalJson, type ProfilePlan } from '@eedsh/config'
import { Effect } from 'effect'
import type { FileSystemFailure, MaterializeError } from '../internal/effect/errors'
import {
  FileSystem,
  type FileSystemShape,
  PackageManager,
  type PackageManagerShape,
  Preflight,
  type PreflightShape,
} from '../internal/effect/services'
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
  previousManifest: Record<string, unknown> | undefined
  strict: boolean
  /** Attribute preflight warnings to their source layers. */
  explain: boolean
}

/** What publication did. */
export interface PublishProfileResult {
  warnings: string[]
  installed: boolean
}

/** The profile files publication snapshots before changing them. */
interface ProfileSnapshot {
  manifestPath: string
  lockfilePath: string
  manifestContent: string | undefined
  lockfileContent: string | undefined
}

function readOptional(
  fs: FileSystemShape,
  path: string,
): Effect.Effect<string | undefined, FileSystemFailure> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(path))) return undefined
    return yield* fs.readFile(path)
  })
}

/** Write profile scaffolding, generated layers, and the plan copy. */
function writePublicationArtifacts(
  input: PublishProfileInput,
  generatedDir: string,
  fs: FileSystemShape,
): Effect.Effect<void, FileSystemFailure> {
  return Effect.gen(function* () {
    yield* ensureProfileFiles(input.profileDir, fs)
    yield* fs.ensureDir(generatedDir)
    yield* writeGeneratedBundle(generatedDir, input.generated, fs, { includeManifest: false })
    const planPath = join(input.profileDir, PLAN_RELATIVE_PATH)
    yield* fs.ensureDir(dirname(planPath))
    yield* fs.writeFileAtomic(planPath, input.generated.planContent)
  })
}

/** Snapshot the profile manifest and lockfile before publication changes them. */
function snapshotProfileFiles(
  fs: FileSystemShape,
  profileDir: string,
): Effect.Effect<ProfileSnapshot, FileSystemFailure> {
  return Effect.gen(function* () {
    const manifestPath = join(profileDir, 'package.json')
    const lockfilePath = join(profileDir, 'pnpm-lock.yaml')
    const manifestContent = yield* readOptional(fs, manifestPath)
    const lockfileContent = yield* readOptional(fs, lockfilePath)
    return { manifestPath, lockfilePath, manifestContent, lockfileContent }
  })
}

/** Whether publication changes any dependency specification. */
function profileDependenciesChanged(
  previousManifest: Record<string, unknown> | undefined,
  manifest: Record<string, unknown>,
): boolean {
  return (
    canonicalJson(readProfileDependencies(previousManifest)) !==
    canonicalJson(readProfileDependencies(manifest))
  )
}

/** Write the reconciled profile manifest in its formatted on-disk form. */
function writeProfileManifest(
  fs: FileSystemShape,
  path: string,
  manifest: Record<string, unknown>,
): Effect.Effect<void, FileSystemFailure> {
  return fs.writeFileAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** Restore one snapshotted profile file, removing it when it did not exist. */
function restoreFile(
  fs: FileSystemShape,
  path: string,
  content: string | undefined,
): Effect.Effect<void, FileSystemFailure> {
  return content === undefined ? fs.remove(path) : fs.writeFileAtomic(path, content)
}

/** Restore the profile manifest and lockfile to their pre-publication state. */
function restoreProfileFiles(
  fs: FileSystemShape,
  snapshot: ProfileSnapshot,
): Effect.Effect<void, FileSystemFailure> {
  return Effect.gen(function* () {
    yield* restoreFile(fs, snapshot.manifestPath, snapshot.manifestContent)
    yield* restoreFile(fs, snapshot.lockfilePath, snapshot.lockfileContent)
  })
}

/** Run a publication step, restoring the profile snapshots if it fails. */
function restoreOnFailure<A, E>(
  effect: Effect.Effect<A, E>,
  restore: Effect.Effect<void, FileSystemFailure>,
): Effect.Effect<A, E | FileSystemFailure> {
  return effect.pipe(Effect.catchAll((error) => restore.pipe(Effect.zipRight(Effect.fail(error)))))
}

/** Write the generated package manifest last; it is the publication commit point. */
function commitGeneratedManifest(
  fs: FileSystemShape,
  generatedDir: string,
  generated: GeneratedBundle,
): Effect.Effect<void, FileSystemFailure> {
  return Effect.gen(function* () {
    const manifestFile = generated.files.at(-1)
    if (manifestFile === undefined || manifestFile.path !== 'package.json') {
      return yield* Effect.die(new Error('generated bundle is missing its package manifest'))
    }
    yield* fs.writeFileAtomic(join(generatedDir, manifestFile.path), manifestFile.content)
  })
}

/**
 * Publish a generation. The generated package manifest is the commit point and
 * is written last; a failed install or preflight restores the manifest and
 * lockfile snapshots first.
 * @param input - plan, reconciled manifest, generated artifacts, and mode.
 * @returns preflight diagnostics and whether packages were installed.
 */
export function publishProfile(
  input: PublishProfileInput,
): Effect.Effect<
  PublishProfileResult,
  MaterializeError,
  FileSystemShape | PackageManagerShape | PreflightShape
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem
    const packages = yield* PackageManager
    const preflight = yield* Preflight

    const generatedDir = join(input.profileDir, GENERATED_DIRNAME)
    yield* writePublicationArtifacts(input, generatedDir, fs)

    const snapshot = yield* snapshotProfileFiles(fs, input.profileDir)
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

    yield* commitGeneratedManifest(fs, generatedDir, input.generated)

    return { warnings: checked.warnings, installed: dependenciesChanged }
  })
}
