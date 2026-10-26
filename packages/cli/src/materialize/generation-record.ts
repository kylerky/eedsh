/**
 * The strict generation-record reader shared by `sync` and `doctor`. It
 * classifies the generated package manifest as absent, valid, or invalid with
 * a stable reason, so no caller has to decide on its own that a malformed
 * record means "no previous generation".
 * @module @eedsh/cli/materialize/generation-record
 */
import { Effect, Option, Schema } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'
import * as Result from 'effect/Result'
import type * as SchemaIssue from 'effect/SchemaIssue'
import { messageOf } from '../internal/error-message'
import { readRecord, readStringArray } from '../internal/schema-readers'
import {
  GENERATED_PACKAGE_NAME,
  GENERATION_FORMAT,
  GENERATION_VERSION,
  GenerationManifestSchema,
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

type ClassifiedReason = Exclude<GenerationInvalidReason, 'missing'>

const versionProbeSchema = Schema.Struct({
  eedsh: Schema.Struct({ version: Schema.Number }),
})

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

/** Follow the first issue path through pointer and composite nodes. */
function firstIssuePath(issue: SchemaIssue.Issue): PropertyKey[] {
  if (issue._tag === 'Pointer') return [...issue.path, ...firstIssuePath(issue.issue)]
  if (issue._tag === 'Composite' && issue.issues[0] !== undefined) {
    return firstIssuePath(issue.issues[0])
  }
  return []
}

/** Map the first schema issue path to the reader's stable reason. */
function reasonForPath(path: readonly PropertyKey[]): ClassifiedReason {
  const [root, field] = path
  if (root === undefined) return 'unparseable'
  if (root === 'name') return 'name'
  if (root !== 'eedsh') return 'format'
  if (
    field === undefined ||
    field === 'format' ||
    field === 'eedshVersion' ||
    field === 'dshVersion'
  ) {
    return 'format'
  }
  if (field === 'version') return 'version'
  if (field === 'generationId') return 'generation-id'
  if (field === 'planHash') return 'plan-hash'
  if (field === 'layers') return 'layers'
  if (field === 'bundles') return 'bundles'
  if (field === 'packages') return 'packages'
  return 'format'
}

/** Keep the existing detail text and adoptability for one failed decode. */
function failureDetail(
  reason: ClassifiedReason,
  path: readonly PropertyKey[],
  value: unknown,
): { detail: string; adoptable: boolean } {
  const manifest = readRecord(value)
  const metadata = readRecord(manifest.eedsh)
  switch (reason) {
    case 'unparseable':
      return { detail: 'the document is not a JSON object', adoptable: true }
    case 'name':
      return {
        detail: `the generated package is named ${String(manifest.name)} instead of "${GENERATED_PACKAGE_NAME}"`,
        adoptable: true,
      }
    case 'format':
      if (path.length === 1) {
        return { detail: 'the manifest has no eedsh generation record', adoptable: true }
      }
      if (path[1] === 'eedshVersion' || path[1] === 'dshVersion') {
        return {
          detail: 'the record is missing its eedsh or dsh version',
          adoptable: true,
        }
      }
      return {
        detail: `the generation format is ${String(metadata.format)} instead of "${GENERATION_FORMAT}"`,
        adoptable: true,
      }
    case 'version': {
      const probe = Schema.decodeUnknownOption(versionProbeSchema)(value)
      if (Option.isSome(probe) && probe.value.eedsh.version > GENERATION_VERSION) {
        return {
          detail: `record format version ${probe.value.eedsh.version} is newer than the supported version ${GENERATION_VERSION}; upgrade eedsh`,
          adoptable: false,
        }
      }
      return {
        detail: `record format version ${String(metadata.version)} is not the supported version ${GENERATION_VERSION}`,
        adoptable: true,
      }
    }
    case 'generation-id':
      return {
        detail: 'the generation identifier is missing or empty',
        adoptable: true,
      }
    case 'plan-hash':
      return {
        detail: 'the plan hash is not a 64-character SHA-256 hex digest',
        adoptable: true,
      }
    case 'layers':
      return { detail: 'the layer list is missing or malformed', adoptable: true }
    case 'bundles': {
      const raw = Array.isArray(metadata.bundles) ? metadata.bundles : []
      const valid = readStringArray(metadata.bundles)
      const malformed = raw.length !== valid.length || valid.some((item) => item === '')
      if (raw.length === 0 || malformed) {
        return {
          detail: 'the managed bundle list must be a non-empty list of bundle names',
          adoptable: true,
        }
      }
      return {
        detail: `the managed bundle list does not include "${RUNTIME_PACKAGE_NAME}" and "${GENERATED_PACKAGE_NAME}"`,
        adoptable: true,
      }
    }
    case 'packages':
      return {
        detail: 'the managed package map must be a non-empty record of package specifications',
        adoptable: true,
      }
  }
}

/**
 * Classify an already-parsed generated package manifest. Structural
 * validation is exhaustive: the returned record is safe to trust.
 * @param value - the parsed JSON document.
 * @param path - absolute path of the generated package manifest.
 * @returns the classification.
 */
export function classifyGenerationRecord(value: unknown, path: string): GenerationLookup {
  const decoded = Schema.decodeUnknownResult(GenerationManifestSchema, { errors: 'first' })(value)
  if (Result.isFailure(decoded)) {
    const issuePath = firstIssuePath(decoded.failure.issue)
    const reason = reasonForPath(issuePath)
    const { detail, adoptable } = failureDetail(reason, issuePath, value)
    return invalidRecord(path, reason, detail, adoptable)
  }
  const record = decoded.success.eedsh
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
