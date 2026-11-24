/**
 * The classified reader for a profile's package manifest. It separates a
 * missing document from an unusable one, keeps a file-system failure in the
 * failure channel, and preserves the parsed document for rewriting. Every
 * consumer that interprets `<profile>/package.json` reads it here, so no
 * caller decides on its own that an unreadable manifest means "no profile"
 * or interprets a raw field twice.
 * @module @eedsh/cli/materialize/profile-manifest
 */
import { Effect, Option, Schema } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'
import * as Result from 'effect/Result'
import { readRecord } from '../internal/schema-readers'

/** Why a profile manifest cannot be interpreted. */
export type ProfileManifestInvalidReason = 'unparseable' | 'not-an-object'

/** A profile manifest that exists but is not a JSON object document. */
export interface InvalidProfileManifest {
  readonly _tag: 'invalid'
  /** Absolute path of the profile manifest. */
  readonly path: string
  /** Stable reason code: `unparseable` or `not-an-object`. */
  readonly reason: ProfileManifestInvalidReason
  /** Short phrase naming the failure, usable after "is". */
  readonly detail: string
}

/** How much of a manifest field could be interpreted. */
export type ManifestSectionState = 'absent' | 'valid' | 'partially-readable' | 'malformed'

/** The `dsh.profile.bundles` list of a profile manifest. */
export interface ManifestBundles {
  readonly state: ManifestSectionState
  /** The bundle names that could be read, in document order. */
  readonly names: readonly string[]
  /** The indexes of entries that are not bundle names. */
  readonly unreadable: readonly number[]
}

/** One install-relevant dependency section of a profile manifest. */
export interface ManifestDependencies {
  readonly state: ManifestSectionState
  /** The entries whose value is a package-specification string, in document order. */
  readonly specs: Readonly<Record<string, string>>
  /** Every entry verbatim, including values that are not package specifications. */
  readonly entries: Readonly<Record<string, unknown>>
  /** The names of entries whose value is not a package-specification string. */
  readonly unreadable: readonly string[]
}

/** Package names in the advisory sections that may pin a managed package. */
export interface ManifestConflicts {
  readonly peerDependencies: readonly string[]
  readonly pnpmOverrides: readonly string[]
  readonly overrides: readonly string[]
  readonly resolutions: readonly string[]
}

/** A profile manifest and the typed interpretation of its fields. */
export interface ProfileManifest {
  readonly _tag: 'valid'
  /** Absolute path of the profile manifest. */
  readonly path: string
  /** The parsed document, preserved for rewriting. */
  readonly document: Record<string, unknown>
  /** The managed bundle list read from `dsh.profile.bundles`. */
  readonly bundles: ManifestBundles
  /** The `dependencies` section. */
  readonly dependencies: ManifestDependencies
  /** The `devDependencies` section. */
  readonly devDependencies: ManifestDependencies
  /** The `optionalDependencies` section. */
  readonly optionalDependencies: ManifestDependencies
  /** The advisory sections that may pin a managed package. */
  readonly conflicts: ManifestConflicts
}

/** The readable package specifications of each install-relevant section. */
export interface ProfileDependencySections {
  readonly dependencies: Readonly<Record<string, string>>
  readonly devDependencies: Readonly<Record<string, string>>
  readonly optionalDependencies: Readonly<Record<string, string>>
}

/**
 * The readable package specifications of a manifest's dependency sections.
 * @param manifest - the typed manifest view.
 * @returns the specifications by section, in section order.
 */
export function dependencySections(manifest: ProfileManifest): ProfileDependencySections {
  return {
    dependencies: manifest.dependencies.specs,
    devDependencies: manifest.devDependencies.specs,
    optionalDependencies: manifest.optionalDependencies.specs,
  }
}

/** The classification of `<profile>/package.json`. */
export type ProfileManifestRead =
  | { readonly _tag: 'missing' }
  | InvalidProfileManifest
  | ProfileManifest

/** The document as JSON text; a parse failure is the only way this fails. */
const documentSchema = Schema.fromJsonString(Schema.Unknown)

/**
 * Decode a value as its schema, or as the named fallback when it is not one.
 * The fallback must itself decode, and it is what makes a section that is
 * absent or not an object read as empty.
 */
function tolerant<A>(schema: Schema.Codec<A>, fallback: A): Schema.Codec<A> {
  return schema.pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(fallback))))
}

/** `dsh.profile`, with the bundle list kept raw for its own classification. */
const profileSectionSchema = Schema.Struct({ bundles: Schema.optionalKey(Schema.Unknown) })

/** `dsh`, tolerant of a missing or non-object section. */
const dshSectionSchema = tolerant(
  Schema.Struct({ profile: Schema.optionalKey(profileSectionSchema) }),
  {},
)

/**
 * The fields the reader interprets. Every field is optional, so the decode
 * fails only when the document is not a JSON object; the section values stay
 * raw because each section is classified with its unreadable entries named.
 */
const manifestFieldsSchema = Schema.Struct({
  dsh: Schema.optionalKey(dshSectionSchema),
  dependencies: Schema.optionalKey(Schema.Unknown),
  devDependencies: Schema.optionalKey(Schema.Unknown),
  optionalDependencies: Schema.optionalKey(Schema.Unknown),
  peerDependencies: Schema.optionalKey(Schema.Unknown),
  pnpm: Schema.optionalKey(Schema.Unknown),
  overrides: Schema.optionalKey(Schema.Unknown),
  resolutions: Schema.optionalKey(Schema.Unknown),
})

function invalidManifest(
  path: string,
  reason: ProfileManifestInvalidReason,
  detail: string,
): InvalidProfileManifest {
  return { _tag: 'invalid', path, reason, detail }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Classify the bundle list, naming the indexes that are not bundle names. */
function classifyBundles(value: unknown): ManifestBundles {
  if (value === undefined) return { state: 'absent', names: [], unreadable: [] }
  if (!Array.isArray(value)) return { state: 'malformed', names: [], unreadable: [] }
  const names: string[] = []
  const unreadable: number[] = []
  for (const [index, entry] of value.entries()) {
    if (typeof entry === 'string') names.push(entry)
    else unreadable.push(index)
  }
  return {
    state: unreadable.length === 0 ? 'valid' : 'partially-readable',
    names,
    unreadable,
  }
}

/** Classify one dependency section, naming the entries that are not specifications. */
function classifyDependencies(value: unknown): ManifestDependencies {
  if (value === undefined) return { state: 'absent', specs: {}, entries: {}, unreadable: [] }
  if (!isRecord(value)) return { state: 'malformed', specs: {}, entries: {}, unreadable: [] }
  const specs: Record<string, string> = {}
  const entries: Record<string, unknown> = {}
  const unreadable: string[] = []
  for (const [name, entry] of Object.entries(value)) {
    entries[name] = entry
    if (typeof entry === 'string') specs[name] = entry
    else unreadable.push(name)
  }
  return {
    state: unreadable.length === 0 ? 'valid' : 'partially-readable',
    specs,
    entries,
    unreadable,
  }
}

/** The package names an advisory section declares, sorted. */
function conflictNames(value: unknown): string[] {
  return Object.keys(readRecord(value)).sort()
}

/**
 * Classify an already-parsed profile manifest.
 * @param document - the parsed JSON document.
 * @param path - absolute path of the profile manifest.
 * @returns the classification; a non-object document is `invalid`.
 */
export function classifyProfileManifest(document: unknown, path: string): ProfileManifestRead {
  const fields = Schema.decodeUnknownResult(manifestFieldsSchema)(document)
  if (Result.isFailure(fields)) return invalidManifest(path, 'not-an-object', 'not a JSON object')
  const value = fields.success
  const pnpm = readRecord(value.pnpm)
  return {
    _tag: 'valid',
    path,
    document: readRecord(document),
    bundles: classifyBundles(value.dsh?.profile?.bundles),
    dependencies: classifyDependencies(value.dependencies),
    devDependencies: classifyDependencies(value.devDependencies),
    optionalDependencies: classifyDependencies(value.optionalDependencies),
    conflicts: {
      peerDependencies: conflictNames(value.peerDependencies),
      pnpmOverrides: conflictNames(pnpm.overrides),
      overrides: conflictNames(value.overrides),
      resolutions: conflictNames(value.resolutions),
    },
  }
}

/**
 * Parse and classify profile-manifest text.
 * @param text - the file contents.
 * @param path - absolute path of the profile manifest.
 * @returns the classification; malformed JSON is `invalid` with reason `unparseable`.
 */
export function parseProfileManifest(text: string, path: string): ProfileManifestRead {
  const parsed = Schema.decodeUnknownResult(documentSchema)(text)
  if (Result.isFailure(parsed)) {
    return invalidManifest(path, 'unparseable', `not valid JSON (${parsed.failure.message})`)
  }
  return classifyProfileManifest(parsed.success, path)
}

/**
 * Read and classify the profile manifest.
 * @param path - absolute path of the profile manifest.
 * @param fs - the platform file-system service.
 * @returns the classification; a missing file is `missing`, a read failure is a platform failure.
 */
export function readProfileManifest(
  path: string,
  fs: FileSystem.FileSystem,
): Effect.Effect<ProfileManifestRead, PlatformError.PlatformError> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(path))) return { _tag: 'missing' } as const
    const text = yield* fs.readFileString(path)
    return parseProfileManifest(text, path)
  })
}
