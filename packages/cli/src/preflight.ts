/**
 * Preflight: compose the selected bundle layers with the generated layers
 * through DSH's own patch algorithm before the generation is committed, so a
 * plan that cannot compose never becomes the published profile.
 * @module @eedsh/cli/preflight
 */
import { entryListSchema } from './materialize/yaml-schema'
import {
  activeDshBridge,
  type AuthoringSite,
  bridgeCapability,
  type DshBridge,
  type PatchGroupProvenance,
} from '@eedsh/config'
import type { ProfilePlan } from '@eedsh/plan'
import { Effect, Layer, Option, Schema } from 'effect'
import * as Result from 'effect/Result'
import * as yaml from 'js-yaml'
import { PreflightFailure } from './internal/effect/errors'
import {
  DshInstallation,
  type DshInstallationShape,
  Preflight,
  type PreflightShape,
} from './internal/effect/services'
import { readRecord } from './internal/schema-readers'
import type { GeneratedBundle } from './materialize/generated-bundle'

/** The selected DSH's entry composer. */
type ComposeEntries = DshBridge['composeEntries']

/**
 * The active bridge's composer.
 * @returns the entry composer.
 * @throws {PreflightFailure} when no bridge is installed.
 */
function activeCompose(): ComposeEntries {
  const bridge = activeDshBridge()
  if (bridge === undefined) {
    throw new PreflightFailure({
      message:
        'preflight needs the active DSH installation; run "eedsh sync" or "eedsh run", or select one with --dsh',
      warnings: [],
    })
  }
  return bridgeCapability(bridge, 'composeEntries', 'preflight')
}

/** The recorded identity of one generated patch group. */
export interface GeneratedGroup {
  /** One-based position in `plan.layers`; a group's identity. */
  readonly position: number
  /** The optional display label supplied with `.layer(label, build)`. */
  readonly label: string | undefined
  /** The captured authoring site per patch, aligned with the patches. */
  readonly sites: readonly (AuthoringSite | undefined)[]
}

/** One preflight composition layer. */
export interface PreflightLayer {
  /** Source label used for bundle layers (`bundle:<name>`). */
  label: string
  patches: Record<string, unknown>[]
  /** Present for a generated patch group; a group's identity is its position. */
  generated?: GeneratedGroup
}

/** One preflight diagnostic attributed to its group. */
export interface PreflightWarning {
  /** The group description, such as `bundle:<name>` or `generated #<n>`. */
  layer: string
  message: string
}

const patchEntrySchema = Schema.Record(Schema.String, Schema.Unknown)
const patchListSchema = Schema.Array(patchEntrySchema)

/** The result of composing a preflight layer stack. */
export interface PreflightComposition {
  entries: Record<string, unknown>[]
  /**
   * Raw diagnostics: DSH composition warnings in patch application order,
   * followed by one empty-group warning per empty generated group.
   */
  warnings: string[]
  /** Descriptions of the generated groups that contributed no patches. */
  emptyLayerLabels: string[]
  /** Row ids inserted twice by generated groups. */
  duplicateInsertIds: string[]
}

/** A site's file, relative to the config directory when it is below it. */
function relativeFile(file: string, configDir: string | undefined): string {
  if (configDir === undefined) return file
  const prefix = configDir.endsWith('/') ? configDir : `${configDir}/`
  return file.startsWith(prefix) ? file.slice(prefix.length) : file
}

function siteText(
  site: AuthoringSite | undefined,
  configDir: string | undefined,
): string | undefined {
  return site === undefined
    ? undefined
    : `${relativeFile(site.file, configDir)}:${site.line}:${site.column}`
}

/** Every row id a patch list touches, deduplicated in application order. */
export function touchedRowIds(patches: readonly Record<string, unknown>[]): string[] {
  const ids: string[] = []
  const visitEntry = (entry: unknown): void => {
    const record = readRecord(entry)
    if (typeof record.id === 'string') ids.push(record.id)
    if (record.group === true && Array.isArray(record.config)) record.config.forEach(visitEntry)
  }
  for (const patch of patches) {
    if (typeof patch.id === 'string') ids.push(patch.id)
    if (Array.isArray(patch.insert)) patch.insert.forEach(visitEntry)
  }
  return ids
}

/**
 * Describe a generated group by position, label, authoring site, and touched
 * row ids as each becomes available. With an offset, the description belongs to
 * that patch; without one it introduces the group itself (for an empty group).
 */
function groupDescription(
  layer: PreflightLayer,
  offset: number | undefined,
  configDir: string | undefined,
): string {
  const group = layer.generated
  if (group === undefined) return layer.label
  let text = `generated #${group.position}`
  if (group.label !== undefined) text += ` ${JSON.stringify(group.label)}`
  if (offset === undefined) return text
  const site = siteText(group.sites[offset], configDir)
  if (site !== undefined) text += ` (${site})`
  const patch = layer.patches[offset]
  const ids = patch === undefined ? [] : [...new Set(touchedRowIds([patch]))]
  if (ids.length > 0) text += ` [${ids.join(', ')}]`
  return text
}

/** Collect ids inserted by a layer, including nested group children. */
function insertedIds(patches: readonly Record<string, unknown>[]): string[] {
  const ids: string[] = []
  const visitEntry = (entry: unknown) => {
    const record = readRecord(entry)
    if (typeof record.id === 'string') ids.push(record.id)
    if (record.group === true && Array.isArray(record.config)) record.config.forEach(visitEntry)
  }
  for (const patch of patches) {
    if (Array.isArray(patch.insert)) patch.insert.forEach(visitEntry)
  }
  return ids
}

/** Compose one flat patch list through the selected installation. */
function composeWarnings(
  patches: readonly Record<string, unknown>[],
  compose: ComposeEntries,
): string[] {
  if (patches.length === 0) return []
  const warnings: string[] = []
  compose([patches], (message) => warnings.push(message))
  return warnings
}

/**
 * Compose preflight layers in application order. Bundle layers are composed
 * first; the generated layers sit at the plan's marker position. Warnings are
 * kept raw, and duplicate ids inserted by generated groups are reported.
 * @param layers - layers in application order.
 * @returns the composed entries, raw warnings, and duplicate ids.
 */
export function composePreflightLayers(
  layers: readonly PreflightLayer[],
  compose: ComposeEntries = activeCompose(),
): PreflightComposition {
  const warnings: string[] = []
  const entries = compose(
    layers.map((layer) => layer.patches),
    (message) => warnings.push(message),
  ) as Record<string, unknown>[]

  const emptyLayerLabels: string[] = []
  for (const layer of layers) {
    if (layer.generated === undefined || layer.patches.length > 0) continue
    const description = groupDescription(layer, undefined, undefined)
    emptyLayerLabels.push(description)
    warnings.push(`${description}: contains no patches`)
  }

  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const layer of layers) {
    if (layer.generated === undefined) continue
    for (const id of insertedIds(layer.patches)) {
      if (seen.has(id)) duplicates.add(id)
      else seen.add(id)
    }
  }

  return {
    entries,
    warnings,
    emptyLayerLabels,
    duplicateInsertIds: [...duplicates].sort(),
  }
}

interface FlatPatch {
  readonly layer: PreflightLayer
  readonly offset: number
  readonly patch: Record<string, unknown>
}

/** Every patch in application order, with its group and offset. */
function flattenPatches(layers: readonly PreflightLayer[]): FlatPatch[] {
  const flat: FlatPatch[] = []
  for (const layer of layers) {
    for (const [offset, patch] of layer.patches.entries()) {
      flat.push({ layer, offset, patch })
    }
  }
  return flat
}

/**
 * Attribute raw warnings to the patch whose application produced them.
 * Composition warnings are attributed by recomposing prefixes over the flat
 * patch list; empty-group warnings are synthetic and belong to their group.
 * Prefixes are recomposed only when warnings exist.
 * @param layers - layers in application order.
 * @param warnings - the raw warning list from one-pass composition.
 * @param options - the config directory used to relativize authoring sites.
 * @returns warnings paired with their group, in raw order.
 */
export function attributePreflightWarnings(
  layers: readonly PreflightLayer[],
  warnings: readonly string[],
  options: { readonly configDir?: string; readonly compose?: ComposeEntries } = {},
): PreflightWarning[] {
  if (warnings.length === 0) return []
  const emptyLayers = layers.filter(
    (layer) => layer.generated !== undefined && layer.patches.length === 0,
  )
  const syntheticCount = Math.min(emptyLayers.length, warnings.length)
  const composeWarningsRaw =
    syntheticCount === 0 ? warnings : warnings.slice(0, warnings.length - syntheticCount)
  const synthetic = syntheticCount === 0 ? [] : warnings.slice(warnings.length - syntheticCount)

  const compose = options.compose ?? activeCompose()
  const attributed: PreflightWarning[] = []
  const flat = flattenPatches(layers)
  let placed = 0
  for (let index = 0; index < flat.length && placed < composeWarningsRaw.length; index += 1) {
    const prefix = composeWarnings(
      flat.slice(0, index + 1).map((item) => item.patch),
      compose,
    )
    const added = Math.min(prefix.length - placed, composeWarningsRaw.length - placed)
    if (added <= 0) continue
    const item = flat[index]!
    const layer = groupDescription(item.layer, item.offset, options.configDir)
    for (const message of composeWarningsRaw.slice(placed, placed + added)) {
      attributed.push({ layer, message })
    }
    placed += added
  }
  const last = flat.at(-1)
  for (const message of composeWarningsRaw.slice(placed)) {
    attributed.push({
      layer:
        last === undefined
          ? (layers.at(-1)?.label ?? 'generated')
          : groupDescription(last.layer, last.offset, options.configDir),
      message,
    })
  }

  for (const [index, layer] of emptyLayers.entries()) {
    const message = synthetic[index]
    if (message !== undefined) {
      attributed.push({
        layer: groupDescription(layer, undefined, undefined),
        message: 'contains no patches',
      })
    }
  }
  return attributed
}

function fail(message: string, warnings: readonly string[] = []): PreflightFailure {
  return new PreflightFailure({ message, warnings: [...warnings] })
}

function checkNoPlanExpression(
  value: unknown,
  group: string,
): Result.Result<void, PreflightFailure> {
  if (Array.isArray(value)) {
    for (const item of value) {
      const checked = checkNoPlanExpression(item, group)
      if (Result.isFailure(checked)) return checked
    }
    return Result.succeed(undefined)
  }
  const record = readRecord(value)
  if ('$eedsh' in record) {
    return Result.fail(fail(`${group} contains a plan expression node; emit !!js scalars instead`))
  }
  for (const item of Object.values(record)) {
    const checked = checkNoPlanExpression(item, group)
    if (Result.isFailure(checked)) return checked
  }
  return Result.succeed(undefined)
}

/** Authoring provenance for the generated groups of one profile. */
export interface ParseGeneratedLayersOptions {
  /** Groups in plan order, aligned with the emitted files. */
  readonly groups?: readonly PatchGroupProvenance[]
}

/**
 * Parse the emitted generated group files back into DSH patch lists.
 * @param generated - the generated bundle.
 * @param options - the evaluated profile's recorded provenance.
 * @returns one preflight layer per emitted file in application order, or a
 * preflight failure for malformed content.
 */
export function parseGeneratedLayers(
  generated: GeneratedBundle,
  options: ParseGeneratedLayersOptions = {},
): Result.Result<PreflightLayer[], PreflightFailure> {
  const files = generated.files.filter((file) => file.path.endsWith('.yml'))
  const layers: PreflightLayer[] = []
  for (const [index, file] of files.entries()) {
    const position = index + 1
    const group = `generated #${position}`
    const parsed = Result.try({
      try: () => yaml.load(file.content, { schema: entryListSchema }),
      catch: (cause) => fail(`cannot parse ${group}: ${String(cause)}`),
    })
    if (Result.isFailure(parsed)) return Result.fail(parsed.failure)
    const decoded = Schema.decodeUnknownOption(patchListSchema)(parsed.success)
    if (Option.isNone(decoded)) {
      return Result.fail(
        fail(
          Array.isArray(parsed.success)
            ? `${group} contains a non-object patch entry`
            : `${group} must be a top-level YAML array of patch entries`,
        ),
      )
    }
    const entries = decoded.value.map((entry) => readRecord(entry))
    for (const entry of entries) {
      const checked = checkNoPlanExpression(entry, group)
      if (Result.isFailure(checked)) return Result.fail(checked.failure)
    }
    const recorded = options.groups?.[index]
    layers.push({
      label: group,
      patches: entries,
      generated: { position, label: recorded?.label, sites: recorded?.sites ?? [] },
    })
  }
  return Result.succeed(layers)
}

function bundleLayers(
  plan: ProfilePlan,
  profileDir: string,
  generatedLayers: readonly PreflightLayer[],
): Effect.Effect<PreflightLayer[], PreflightFailure, DshInstallationShape> {
  return Effect.gen(function* () {
    const dsh = yield* DshInstallation
    const layers: PreflightLayer[] = []
    let placed = false
    for (const item of plan.bundles) {
      if (item.kind === 'generated') {
        layers.push(...generatedLayers)
        placed = true
        continue
      }
      const patches = yield* dsh
        .resolveBundlePatches(item.name, profileDir)
        .pipe(
          Effect.catch((error) =>
            Effect.fail(
              fail(
                `cannot resolve profile bundle ${JSON.stringify(item.name)}: ${String(error.cause)}`,
              ),
            ),
          ),
        )
      layers.push({ label: `bundle:${item.name}`, patches: [...patches] })
    }
    if (!placed) layers.push(...generatedLayers)
    return layers
  })
}

/** The live preflight implementation; it needs the discovered DSH installation. */
export const preflightLayer: Layer.Layer<PreflightShape, never, DshInstallationShape> =
  Layer.effect(
    Preflight,
    Effect.gen(function* () {
      const dsh = yield* DshInstallation
      const check: PreflightShape['check'] = (input) =>
        Effect.gen(function* () {
          const groups = input.provenance?.profiles[input.plan.profile.name] ?? []
          const generatedLayers = yield* Effect.fromResult(
            parseGeneratedLayers(input.generated, { groups }),
          )
          const layers = yield* bundleLayers(input.plan, input.profileDir, generatedLayers).pipe(
            Effect.provideService(DshInstallation, dsh),
          )
          const composition = composePreflightLayers(layers)
          const raw = composition.warnings
          const messages =
            input.explain && raw.length > 0
              ? attributePreflightWarnings(
                  layers,
                  raw,
                  input.configDir === undefined ? {} : { configDir: input.configDir },
                ).map((warning) => `${warning.layer}: ${warning.message}`)
              : raw
          if (composition.duplicateInsertIds.length > 0) {
            return yield* Effect.fail(
              fail(
                `generated layers insert duplicate row ids: ${composition.duplicateInsertIds.join(', ')}`,
                messages,
              ),
            )
          }
          if (input.strict && messages.length > 0) {
            return yield* Effect.fail(fail('preflight warnings in strict mode', messages))
          }
          return { warnings: messages }
        })
      return { check }
    }),
  )