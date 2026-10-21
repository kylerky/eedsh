/**
 * Builds the generated bundle package: versioned patch files, the generation
 * record, and the package manifest that DSH reads as a bundle. The manifest is
 * the publication commit point, so it is emitted last.
 * @module @eedsh/cli/materialize/generated-bundle
 */
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { canonicalJson, hashPlan, type ProfilePlan } from '@eedsh/config'
import { Effect } from 'effect'
import type { FileSystemFailure } from '../internal/effect/errors'
import { emitPatchesYaml } from './yaml'

export { emitPatchesYaml } from './yaml'

/** The generated bundle's package name. */
export const GENERATED_PACKAGE_NAME = '@eedsh/generated'

/** The static runtime bundle's package name. */
export const RUNTIME_PACKAGE_NAME = '@eedsh/runtime'

/** The generation-record format identifier. */
export const GENERATION_FORMAT = 'eedsh/generation'

/** The generation-record format version. */
export const GENERATION_VERSION = 1

/** One emitted layer file. */
export interface GenerationLayer {
  id: string
  /** Package-relative patch file path. */
  file: string
  /** SHA-256 of the emitted YAML content. */
  hash: string
}

/** Provenance for one published generation. */
export interface GenerationRecord {
  format: typeof GENERATION_FORMAT
  version: typeof GENERATION_VERSION
  generationId: string
  planHash: string
  eedshVersion: string
  dshVersion: string
  /** Layers in application order. */
  layers: GenerationLayer[]
  /** Managed bundle order, including the runtime and generated bundles. */
  bundles: string[]
  /** Managed package specifications. */
  packages: Record<string, string>
}

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
  /** Files in publication order; the package manifest is last. */
  files: GeneratedBundleFile[]
  /** Profile-relative path of the inspectable plan copy. */
  planPath: string
  planContent: string
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

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
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
  const emitted = input.plan.layers.map((item) => ({
    id: item.id,
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

  const files: GeneratedBundleFile[] = emitted.map((item, index) => ({
    path: layers[index]!.file,
    content: item.content,
  }))
  files.push({ path: 'package.json', content: `${JSON.stringify(manifest, null, 2)}\n` })

  return {
    generationId,
    planHash,
    generation,
    manifest,
    files,
    planPath: '.eedsh/plan.json',
    planContent: `${canonicalJson(input.plan)}\n`,
  }
}

/** File operations the generated-bundle writer needs. */
export interface GeneratedBundleIo {
  /** Create a directory hierarchy. */
  ensureDir(path: string): Effect.Effect<void, FileSystemFailure>
  /** Write a file atomically. */
  writeFileAtomic(path: string, content: string): Effect.Effect<void, FileSystemFailure>
}

/**
 * Write generated artifacts, in publication order, below the generated package
 * directory. The package manifest is written last by publication, so it is
 * skipped here unless explicitly included.
 * @param packageDir - absolute generated bundle directory.
 * @param bundle - the bundle to write.
 * @param io - injected file operations.
 * @param options - set `includeManifest: false` to defer the commit point.
 * @returns an effect that writes every requested artifact.
 */
export function writeGeneratedBundle(
  packageDir: string,
  bundle: GeneratedBundle,
  io: GeneratedBundleIo,
  options: { includeManifest?: boolean } = {},
): Effect.Effect<void, FileSystemFailure> {
  return Effect.gen(function* () {
    yield* io.ensureDir(packageDir)
    for (const file of bundle.files) {
      if (options.includeManifest === false && file.path === 'package.json') continue
      const target = join(packageDir, file.path)
      yield* io.ensureDir(dirname(target))
      yield* io.writeFileAtomic(target, file.content)
    }
  })
}
