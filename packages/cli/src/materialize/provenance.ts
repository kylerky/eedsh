/**
 * The advisory provenance sidecar. It sits next to the plan mirror, names the
 * generation it describes, and records the authoring site of every generated
 * patch. Sites are relativized against the config file's directory so no host
 * path is persisted, and nothing in DSH reads this file.
 * @module @eedsh/cli/materialize/provenance
 */
import { isAbsolute, relative } from 'node:path'
import type { AuthoringSite, PatchGroupProvenance } from '@eedsh/config'
import { Option, Schema } from 'effect'

/** The provenance-sidecar format identifier. */
export const PROVENANCE_FORMAT = 'eedsh/provenance'

/** The provenance-sidecar format version. */
export const PROVENANCE_VERSION = 1

const positionSchema = Schema.Int.check(Schema.isGreaterThan(0))

/** One relativized authoring site. */
export const ProvenanceSiteSchema = Schema.Struct({
  /** Path relative to the config file's directory. */
  file: Schema.NonEmptyString,
  /** One-based line of the builder call. */
  line: positionSchema,
  /** One-based column of the builder call. */
  column: positionSchema,
})

/** One generated patch group's recorded provenance. */
export const ProvenanceGroupSchema = Schema.Struct({
  /** One-based plan position; the group's identity. */
  position: positionSchema,
  /** The optional authoring label. */
  label: Schema.optional(Schema.String),
  /** One entry per patch; `null` when the site is unknown. */
  patches: Schema.Array(Schema.NullOr(ProvenanceSiteSchema)),
})

/** The advisory sidecar written next to the plan mirror. */
export const ProvenanceSidecarSchema = Schema.Struct({
  format: Schema.Literal(PROVENANCE_FORMAT),
  version: Schema.Literal(PROVENANCE_VERSION),
  /** The committed generation this record describes. */
  generationId: Schema.NonEmptyString,
  /** Generated groups in plan order. */
  groups: Schema.Array(ProvenanceGroupSchema),
})

/** One relativized authoring site. */
export type ProvenanceSite = Schema.Schema.Type<typeof ProvenanceSiteSchema>

/** One generated group's sidecar record. */
export type ProvenanceGroup = Schema.Schema.Type<typeof ProvenanceGroupSchema>

/** The complete provenance sidecar. */
export type ProvenanceSidecar = Schema.Schema.Type<typeof ProvenanceSidecarSchema>

/**
 * Read a parsed sidecar document without trusting it. A malformed, older, or
 * generational-mismatched document is simply unavailable.
 * @param value - the parsed JSON document.
 * @returns the sidecar, or undefined when it does not match the schema.
 */
export function readProvenanceSidecar(value: unknown): ProvenanceSidecar | undefined {
  const decoded = Schema.decodeUnknownOption(ProvenanceSidecarSchema)(value)
  return Option.isSome(decoded) ? decoded.value : undefined
}

/**
 * Express one site relative to the config directory. An absolute site below or
 * beside the config directory becomes relative; one that cannot be expressed
 * relatively (a different drive, or an already-relative value that stays
 * absolute) is refused and recorded as unknown.
 * @param site - the captured absolute site, when one was captured.
 * @param configDir - absolute config directory.
 * @returns the relative site, or null when it cannot be persisted safely.
 */
export function relativizeSite(
  site: AuthoringSite | undefined,
  configDir: string,
): ProvenanceSite | null {
  if (site === undefined) return null
  const file = isAbsolute(site.file) ? relative(configDir, site.file) : site.file
  if (file === '' || isAbsolute(file)) return null
  return { file, line: site.line, column: site.column }
}

/** Inputs for {@link buildProvenanceSidecar}. */
export interface BuildProvenanceSidecarInput {
  /** The committed generation identifier. */
  generationId: string
  /** Absolute directory of the evaluated config file. */
  configDir: string
  /** The evaluated profile's groups in plan order. */
  groups: readonly PatchGroupProvenance[]
}

/**
 * Build the sidecar for one published generation.
 * @param input - generation id, config directory, and recorded groups.
 * @returns the relative, host-path-free sidecar document.
 */
export function buildProvenanceSidecar(input: BuildProvenanceSidecarInput): ProvenanceSidecar {
  return {
    format: PROVENANCE_FORMAT,
    version: PROVENANCE_VERSION,
    generationId: input.generationId,
    groups: input.groups.map((group, index) => ({
      position: index + 1,
      ...(group.label === undefined ? {} : { label: group.label }),
      patches: group.sites.map((site) => relativizeSite(site, input.configDir)),
    })),
  }
}

/**
 * Serialize the sidecar for writing. The JSON is pretty-printed so the
 * advisory artifact stays diffable.
 * @param input - generation id, config directory, and recorded groups.
 * @returns the sidecar file content.
 */
export function provenanceSidecarContent(input: BuildProvenanceSidecarInput): string {
  return `${JSON.stringify(buildProvenanceSidecar(input), null, 2)}\n`
}
