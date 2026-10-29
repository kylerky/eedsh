/**
 * Builds the generated bundle package: versioned patch files, the generation
 * record, and the package manifest that DSH reads as a bundle. The manifest is
 * the publication commit point, so it is emitted last.
 * @module @eedsh/cli/materialize/generated-bundle
 */
import { dirname, join } from 'node:path'
import { canonicalJson, type ProfilePlan } from '@eedsh/plan'
import { Effect, Schema } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'
import { writeFileAtomic } from '../internal/atomic-write'
import { sha256 } from '../internal/sha256'
import { emitPatchesYaml } from './yaml'

/** The generated bundle's package name. */
export const GENERATED_PACKAGE_NAME = '@eedsh/generated'

/** The static runtime bundle's package name. */
export const RUNTIME_PACKAGE_NAME = '@eedsh/runtime'

/** The generation-record format identifier. */
export const GENERATION_FORMAT = 'eedsh/generation'

/** The generation-record format version. */
export const GENERATION_VERSION = 1

/** Schema for one emitted layer file. */
export const GenerationLayerSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  /** Package-relative patch file path. */
  file: Schema.NonEmptyString,
  /** SHA-256 of the emitted YAML content. */
  hash: Schema.NonEmptyString,
})

/** One emitted layer file. */
export type GenerationLayer = Schema.Schema.Type<typeof GenerationLayerSchema>

const planHashSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

const managedBundlesSchema = Schema.Array(Schema.NonEmptyString).check(
  Schema.isNonEmpty(),
  Schema.makeFilter(
    (bundles: readonly string[]) =>
      bundles.includes(RUNTIME_PACKAGE_NAME) && bundles.includes(GENERATED_PACKAGE_NAME),
  ),
)

const managedPackagesSchema = Schema.Record(Schema.NonEmptyString, Schema.NonEmptyString).check(
  Schema.makeFilter(
    (packages: Readonly<Record<string, string>>) => Object.keys(packages).length > 0,
  ),
)

/** Schema for the generation record stored under `eedsh`. */
export const GenerationRecordSchema = Schema.Struct({
  format: Schema.Literal(GENERATION_FORMAT),
  version: Schema.Literal(GENERATION_VERSION),
  generationId: Schema.NonEmptyString,
  planHash: planHashSchema,
  eedshVersion: Schema.String,
  dshVersion: Schema.String,
  /** Layers in application order. */
  layers: Schema.Array(GenerationLayerSchema),
  /** Managed bundle order, including the runtime and generated bundles. */
  bundles: managedBundlesSchema,
  /** Managed package specifications. */
  packages: managedPackagesSchema,
})

/** Provenance for one published generation. */
export type GenerationRecord = Schema.Schema.Type<typeof GenerationRecordSchema>

/** Schema for the generated package manifest fields the reader trusts. */
export const GenerationManifestSchema = Schema.Struct({
  name: Schema.Literal(GENERATED_PACKAGE_NAME),
  eedsh: GenerationRecordSchema,
})

/** The generated package manifest. */
export interface GeneratedManifest {
  name: typeof GENERATED_PACKAGE_NAME
  version: string
  private: true
  description: string
  engines: { dsh: string }
  dsh: { bundle: { patch: string[] } }
  eedsh: GenerationRecord
}

/** One file to write below the generated package directory. */
export interface GeneratedBundleFile {
  /** Package-relative path. */
  path: string
  content: string
}

/** The complete generated bundle, ready to publish. */
export interface GeneratedBundle {
  generationId: string
  planHash: string
  generation: GenerationRecord
  manifest: GeneratedManifest
  /** Files in publication order; the authoritative plan precedes the manifest. */
  files: GeneratedBundleFile[]
  /** Generated-package-relative path of the authoritative plan. */
  authoritativePlanPath: string
  /** Canonical plan bytes without a trailing newline; hashes to `planHash`. */
  authoritativePlanContent: string
  /** Profile-relative path of the inspectable plan mirror. */
  planPath: string
  /** Mirror content: the canonical plan plus a trailing newline. */
  planContent: string
}

/**
 * Derive the authoritative plan path from the generation id, so the record
 * locates its plan without storing a second path.
 * @param generationId - the published generation identifier.
 * @returns the generated-package-relative plan path.
 */
export function authoritativePlanPath(generationId: string): string {
  return `plans/${generationId}.json`
}

/**
 * Hash a validated plan canonically for the generation record. A formatting-only
 * difference in the plan never changes its hash.
 * @param plan - the validated plan.
 * @returns the SHA-256 hex digest of the canonical plan.
 */
export function hashPlan(plan: ProfilePlan): string {
  return sha256(canonicalJson(plan))
}

/** Inputs for {@link buildGeneratedBundle}. */
export interface BuildGeneratedBundleInput {
  plan: ProfilePlan
  /** Managed bundle order, including the runtime and generated bundles. */
  managedBundles: readonly string[]
  /** Managed package specifications. */
  packages: Readonly<Record<string, string>>
  eedshVersion: string
  dshVersion: string
}

/**
 * Compute the generation id from the plan hash and every layer file hash, so a
 * plan change or an emitter-format change publishes a new generation.
 * @param input - plan hash and layer hashes in order.
 * @returns the SHA-256 hex generation id.
 */
export function generationIdFor(input: {
  planHash: string
  layers: readonly { id: string; hash: string }[]
}): string {
  return sha256(
    canonicalJson({
      planHash: input.planHash,
      layers: input.layers.map((layer) => ({ id: layer.id, hash: layer.hash })),
    }),
  )
}

/**
 * Build every artifact of a generated bundle.
 * @param input - plan, managed bundles and packages, and version provenance.
 * @returns the bundle, its file list, and the plan copy.
 */
export function buildGeneratedBundle(input: BuildGeneratedBundleInput): GeneratedBundle {
  const planHash = hashPlan(input.plan)
  const emitted = input.plan.layers.map((item, index) => ({
    id: item.id ?? String(index + 1),
    content: emitPatchesYaml(item.patches),
  }))
  const hashes = emitted.map((item) => ({ id: item.id, hash: sha256(item.content) }))
  const generationId = generationIdFor({ planHash, layers: hashes })
  const layers: GenerationLayer[] = hashes.map((item) => ({
    id: item.id,
    file: `patches/${generationId}/${item.id}.yml`,
    hash: item.hash,
  }))

  const generation: GenerationRecord = {
    format: GENERATION_FORMAT,
    version: GENERATION_VERSION,
    generationId,
    planHash,
    eedshVersion: input.eedshVersion,
    dshVersion: input.dshVersion,
    layers,
    bundles: [...input.managedBundles],
    packages: { ...input.packages },
  }

  const manifest: GeneratedManifest = {
    name: GENERATED_PACKAGE_NAME,
    version: '0.0.0',
    private: true,
    description: 'eedsh-managed generated bundle. Do not edit; run "eedsh sync" instead.',
    engines: { dsh: input.dshVersion },
    dsh: { bundle: { patch: layers.map((layer) => `./${layer.file}`) } },
    eedsh: generation,
  }

  const authoritativeContent = canonicalJson(input.plan)
  const files: GeneratedBundleFile[] = emitted.map((item, index) => ({
    path: layers[index]!.file,
    content: item.content,
  }))
  files.push({ path: authoritativePlanPath(generationId), content: authoritativeContent })
  files.push({ path: 'package.json', content: `${JSON.stringify(manifest, null, 2)}\n` })

  return {
    generationId,
    planHash,
    generation,
    manifest,
    files,
    authoritativePlanPath: authoritativePlanPath(generationId),
    authoritativePlanContent: authoritativeContent,
    planPath: '.eedsh/plan.json',
    planContent: `${authoritativeContent}\n`,
  }
}

/**
 * Write generated artifacts, in publication order, below the generated package
 * directory. The package manifest is written last by publication, so it is
 * skipped here unless explicitly included.
 * @param packageDir - absolute generated bundle directory.
 * @param bundle - the bundle to write.
 * @param fs - the platform file-system service.
 * @param options - set `includeManifest: false` to defer the commit point.
 * @returns an effect that writes every requested artifact.
 */
export function writeGeneratedBundle(
  packageDir: string,
  bundle: GeneratedBundle,
  fs: FileSystem.FileSystem,
  options: { includeManifest?: boolean } = {},
): Effect.Effect<void, PlatformError.PlatformError> {
  return Effect.gen(function* () {
    yield* fs.makeDirectory(packageDir, { recursive: true })
    for (const file of bundle.files) {
      if (options.includeManifest === false && file.path === 'package.json') continue
      const target = join(packageDir, file.path)
      yield* fs.makeDirectory(dirname(target), { recursive: true })
      yield* writeFileAtomic(fs, target, file.content)
    }
  })
}
