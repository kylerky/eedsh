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

function readOptional(
  fs: FileSystemShape,
  path: string,
): Effect.Effect<string | undefined, FileSystemFailure> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(path))) return undefined
    return yield* fs.readFile(path)
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

    yield* ensureProfileFiles(input.profileDir, fs)

    const generatedDir = join(input.profileDir, GENERATED_DIRNAME)
    yield* fs.ensureDir(generatedDir)
    yield* writeGeneratedBundle(generatedDir, input.generated, fs, { includeManifest: false })
    yield* fs.ensureDir(dirname(join(input.profileDir, PLAN_RELATIVE_PATH)))
    yield* fs.writeFileAtomic(
      join(input.profileDir, PLAN_RELATIVE_PATH),
      input.generated.planContent,
    )

    const manifestPath = join(input.profileDir, 'package.json')
    const lockfilePath = join(input.profileDir, 'pnpm-lock.yaml')
    const manifestSnapshot = yield* readOptional(fs, manifestPath)
    const lockfileSnapshot = yield* readOptional(fs, lockfilePath)
    const dependenciesChanged =
      canonicalJson(readProfileDependencies(input.previousManifest)) !==
      canonicalJson(readProfileDependencies(input.manifest))

    yield* fs.writeFileAtomic(manifestPath, `${JSON.stringify(input.manifest, null, 2)}\n`)

    const restore = Effect.gen(function* () {
      if (manifestSnapshot === undefined) yield* fs.remove(manifestPath)
      else yield* fs.writeFileAtomic(manifestPath, manifestSnapshot)
      if (lockfileSnapshot === undefined) yield* fs.remove(lockfilePath)
      else yield* fs.writeFileAtomic(lockfilePath, lockfileSnapshot)
    })

    if (dependenciesChanged) {
      yield* packages
        .install(input.profileDir)
        .pipe(Effect.catchAll((error) => restore.pipe(Effect.zipRight(Effect.fail(error)))))
    }

    const checked = yield* preflight
      .check({
        plan: input.plan,
        profileDir: input.profileDir,
        generated: input.generated,
        strict: input.strict,
        explain: input.explain,
      })
      .pipe(Effect.catchAll((error) => restore.pipe(Effect.zipRight(Effect.fail(error)))))

    const manifestFile = input.generated.files.at(-1)
    if (manifestFile === undefined || manifestFile.path !== 'package.json') {
      return yield* Effect.die(new Error('generated bundle is missing its package manifest'))
    }
    yield* fs.writeFileAtomic(join(generatedDir, manifestFile.path), manifestFile.content)

    return { warnings: checked.warnings, installed: dependenciesChanged }
  })
}
