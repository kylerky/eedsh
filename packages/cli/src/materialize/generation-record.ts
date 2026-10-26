/**
 * The strict generation-record reader shared by `sync` and `doctor`. It
 * classifies the generated package manifest as absent, valid, or invalid with
 * a stable reason, so no caller has to decide on its own that a malformed
 * record means "no previous generation".
 * @module @eedsh/cli/materialize/generation-record
 */
import { Effect } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'
import * as Result from 'effect/Result'
import { messageOf } from '../internal/error-message'
import { asRecord } from '../internal/record'
import {
  GENERATED_PACKAGE_NAME,
  GENERATION_FORMAT,
  GENERATION_VERSION,
  type GenerationLayer,
  type GenerationRecord,
  RUNTIME_PACKAGE_NAME,
} from './generated-bundle'

/** What the previous published generation owned. */
export interface PreviousGeneration {
  /** Managed bundle order, including the runtime and generated bundles. */
  bundles: readonly string[]
  /** Managed package specifications. */
  packages: Readonly<Record<string, string>>
}

/** Why a generation record cannot be used. */
export type GenerationInvalidReason =
  | 'unparseable'
  | 'missing'
  | 'name'
  | 'format'
  | 'version'
  | 'generation-id'
  | 'plan-hash'
  | 'layers'
  | 'bundles'
  | 'packages'

/** A record that exists but does not satisfy the generation-record contract. */
export interface InvalidGenerationRecord {
  readonly _tag: 'invalid'
  /** Absolute path of the generated package manifest. */
  readonly path: string
  readonly reason: GenerationInvalidReason
  /** Human-readable explanation naming the offending field or value. */
  readonly detail: string
  /** Whether `--adopt-ownership` can re-baseline this record. */
  readonly adoptable: boolean
}

/** A record that satisfies the generation-record contract. */
export interface ValidGenerationRecord {
  readonly _tag: 'valid'
  readonly record: GenerationRecord
  /** The managed sets of the last successful publication. */
  readonly previous: PreviousGeneration
}

/** The classification of the generated package manifest. */
export type GenerationLookup =
  | { readonly _tag: 'missing' }
  | InvalidGenerationRecord
  | ValidGenerationRecord

const PLAN_HASH = /^[0-9a-f]{64}$/

function invalidRecord(
  path: string,
  reason: GenerationInvalidReason,
  detail: string,
  adoptable = true,
): InvalidGenerationRecord {
  return { _tag: 'invalid', path, reason, detail, adoptable }
}

/**
 * Build the invalid classification for a record that should exist but does not.
 * @param path - absolute path of the expected generated package manifest.
 * @returns an invalid lookup with reason `missing`.
 */
export function missingGenerationRecord(path: string): InvalidGenerationRecord {
  return invalidRecord(path, 'missing', 'the generated package manifest does not exist')
}

/**
 * Format an invalid record as one recovery-oriented diagnostic.
 * @param invalid - the invalid classification.
 * @returns the message without the `eedsh:` prefix.
 */
export function describeInvalidRecord(invalid: {
  readonly path: string
  readonly detail: string
  readonly adoptable: boolean
}): string {
  const message = `cannot use the generation record at ${invalid.path}: ${invalid.detail}`
  return invalid.adoptable
    ? `${message}; run "eedsh sync --adopt-ownership" to re-baseline ownership from the current manifest`
    : message
}

function readLayers(value: unknown): GenerationLayer[] | undefined {
  if (!Array.isArray(value)) return undefined
  const layers: GenerationLayer[] = []
  for (const item of value) {
    const layer = asRecord(item)
    if (layer === undefined) return undefined
    const { id, file, hash } = layer
    if (typeof id !== 'string' || id === '') return undefined
    if (typeof file !== 'string' || file === '') return undefined
    if (typeof hash !== 'string' || hash === '') return undefined
    layers.push({ id, file, hash })
  }
  return layers
}

function readStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item === '') return undefined
    items.push(item)
  }
  return items
}

function readStringMap(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const map: Record<string, string> = {}
  for (const [key, item] of Object.entries(record)) {
    if (key === '' || typeof item !== 'string' || item === '') return undefined
    map[key] = item
  }
  return map
}

/**
 * Classify an already-parsed generated package manifest. Structural
 * validation is exhaustive: the returned record is safe to trust.
 * @param value - the parsed JSON document.
 * @param path - absolute path of the generated package manifest.
 * @returns the classification.
 */
export function classifyGenerationRecord(value: unknown, path: string): GenerationLookup {
  const manifest = asRecord(value)
  if (manifest === undefined) {
    return invalidRecord(path, 'unparseable', 'the document is not a JSON object')
  }
  if (manifest.name !== GENERATED_PACKAGE_NAME) {
    return invalidRecord(
      path,
      'name',
      `the generated package is named ${String(manifest.name)} instead of "${GENERATED_PACKAGE_NAME}"`,
    )
  }

  const metadata = asRecord(manifest.eedsh)
  if (metadata === undefined) {
    return invalidRecord(path, 'format', 'the manifest has no eedsh generation record')
  }
  if (metadata.format !== GENERATION_FORMAT) {
    return invalidRecord(
      path,
      'format',
      `the generation format is ${String(metadata.format)} instead of "${GENERATION_FORMAT}"`,
    )
  }
  if (metadata.version !== GENERATION_VERSION) {
    if (typeof metadata.version === 'number' && metadata.version > GENERATION_VERSION) {
      return invalidRecord(
        path,
        'version',
        `record format version ${metadata.version} is newer than the supported version ${GENERATION_VERSION}; upgrade eedsh`,
        false,
      )
    }
    return invalidRecord(
      path,
      'version',
      `record format version ${String(metadata.version)} is not the supported version ${GENERATION_VERSION}`,
    )
  }
  const generationId = metadata.generationId
  if (typeof generationId !== 'string' || generationId === '') {
    return invalidRecord(path, 'generation-id', 'the generation identifier is missing or empty')
  }
  const planHash = metadata.planHash
  if (typeof planHash !== 'string' || !PLAN_HASH.test(planHash)) {
    return invalidRecord(
      path,
      'plan-hash',
      'the plan hash is not a 64-character SHA-256 hex digest',
    )
  }
  if (typeof metadata.eedshVersion !== 'string' || typeof metadata.dshVersion !== 'string') {
    return invalidRecord(path, 'format', 'the record is missing its eedsh or dsh version')
  }
  const layers = readLayers(metadata.layers)
  if (layers === undefined) {
    return invalidRecord(path, 'layers', 'the layer list is missing or malformed')
  }
  const bundles = readStringList(metadata.bundles)
  if (bundles === undefined || bundles.length === 0) {
    return invalidRecord(
      path,
      'bundles',
      'the managed bundle list must be a non-empty list of bundle names',
    )
  }
  if (!bundles.includes(RUNTIME_PACKAGE_NAME) || !bundles.includes(GENERATED_PACKAGE_NAME)) {
    return invalidRecord(
      path,
      'bundles',
      `the managed bundle list does not include "${RUNTIME_PACKAGE_NAME}" and "${GENERATED_PACKAGE_NAME}"`,
    )
  }
  const packages = readStringMap(metadata.packages)
  if (packages === undefined || Object.keys(packages).length === 0) {
    return invalidRecord(
      path,
      'packages',
      'the managed package map must be a non-empty record of package specifications',
    )
  }

  const record: GenerationRecord = {
    format: GENERATION_FORMAT,
    version: GENERATION_VERSION,
    generationId,
    planHash,
    eedshVersion: metadata.eedshVersion,
    dshVersion: metadata.dshVersion,
    layers,
    bundles,
    packages,
  }
  return {
    _tag: 'valid',
    record,
    previous: { bundles: record.bundles, packages: record.packages },
  }
}

/** Parse JSON text into the classification, reporting a parse failure as invalid. */
function classifyText(text: string, path: string): Effect.Effect<GenerationLookup> {
  return Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (cause) => cause,
    }).pipe(Effect.result)
    if (Result.isFailure(parsed)) {
      const detail = messageOf(parsed.failure)
      return invalidRecord(path, 'unparseable', `the file is not valid JSON (${detail})`)
    }
    return classifyGenerationRecord(parsed.success, path)
  })
}

/**
 * Read and classify the generated package manifest.
 * @param path - absolute path of the generated package manifest.
 * @param fs - the platform file-system service.
 * @returns the classification; a missing file is `missing`, not a failure.
 */
export function lookupGenerationRecord(
  path: string,
  fs: FileSystem.FileSystem,
): Effect.Effect<GenerationLookup, PlatformError.PlatformError> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(path))) return { _tag: 'missing' } as const
    const text = yield* fs.readFileString(path)
    return yield* classifyText(text, path)
  })
}

/**
 * Read the published generation identifier without validating the rest of the
 * record. Used to detect a generation change while a read-only check runs.
 * @param generatedManifest - parsed generated package manifest.
 * @returns the generation identifier, or undefined when it cannot be read.
 */
export function readGenerationId(generatedManifest: unknown): string | undefined {
  const manifest = asRecord(generatedManifest)
  if (manifest === undefined) return undefined
  const metadata = asRecord(manifest.eedsh)
  if (metadata === undefined || metadata.format !== GENERATION_FORMAT) return undefined
  return typeof metadata.generationId === 'string' && metadata.generationId !== ''
    ? metadata.generationId
    : undefined
}
