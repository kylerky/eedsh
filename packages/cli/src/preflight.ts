/**
 * Preflight: compose the selected bundle layers with the generated layers
 * through DSH's own patch algorithm before the generation is committed, so a
 * plan that cannot compose never becomes the published profile.
 * @module @eedsh/cli/preflight
 */
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
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

/** One preflight composition layer. */
export interface PreflightLayer {
  /** Source label used in diagnostics (`bundle:<name>` or `generated:<id>`). */
  label: string
  patches: Record<string, unknown>[]
}

/** One preflight diagnostic attributed to its layer. */
export interface PreflightWarning {
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
   * followed by one empty-layer warning per empty generated layer.
   */
  warnings: string[]
  /** Generated layers that contributed no patches, in layer order. */
  emptyLayerLabels: string[]
  /** Row ids inserted twice by generated layers. */
  duplicateInsertIds: string[]
}

function emptyLayerWarning(label: string): string {
  const id = label.startsWith('generated:') ? label.slice('generated:'.length) : label
  return `generated layer ${JSON.stringify(id)} contains no patches`
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

/**
 * Every row id a patch list touches, including inserted rows, nested group
 * children, and id-targeted patches, in application order.
 * @param patches - the patches to scan.
 * @returns the touched row ids, with repeats in patch order.
 */
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
 * Compose preflight layers in application order. Bundle layers are composed
 * first; the generated layers sit at the plan's marker position. Warnings are
 * kept raw, and duplicate ids inserted by generated layers are reported.
 * @param layers - layers in application order.
 * @param options - labels of the generated layers.
 * @returns the composed entries, raw warnings, and duplicate ids.
 */
export function composePreflightLayers(
  layers: readonly PreflightLayer[],
  options: { generatedLayerLabels?: readonly string[] } = {},
): PreflightComposition {
  const warnings: string[] = []
  const entries = composeEntries(
    layers.map((layer) => layer.patches as PatchOptions[]),
    (message) => warnings.push(message),
  ) as unknown as Record<string, unknown>[]

  const generatedLabels = new Set(options.generatedLayerLabels ?? [])
  const emptyLayerLabels: string[] = []
  for (const layer of layers) {
    if (!generatedLabels.has(layer.label) || layer.patches.length > 0) continue
    emptyLayerLabels.push(layer.label)
    warnings.push(emptyLayerWarning(layer.label))
  }

  const seen = new Map<string, string>()
  const duplicates = new Set<string>()
  for (const layer of layers) {
    if (!generatedLabels.has(layer.label)) continue
    for (const id of insertedIds(layer.patches)) {
      if (seen.has(id)) duplicates.add(id)
      else seen.set(id, layer.label)
    }
  }

  return {
    entries,
    warnings,
    emptyLayerLabels,
    duplicateInsertIds: [...duplicates].sort(),
  }
}

/**
 * Attribute raw warnings to the layer whose patches produced them. Composition
 * warnings are attributed by recomposing prefixes; empty-layer warnings are
 * synthetic and map to their generated layer by position. Prefixes are
 * recomposed only when warnings exist, and the full stack is never recomposed:
 * the last layer receives any remaining composition warnings.
 * @param layers - layers in application order.
 * @param warnings - the raw warning list from one-pass composition.
 * @param options - the generated layers that emitted an empty-layer warning.
 * @returns warnings paired with their source layer, in raw order.
 */
export function attributePreflightWarnings(
  layers: readonly PreflightLayer[],
  warnings: readonly string[],
  options: { readonly emptyLayerLabels?: readonly string[] } = {},
): PreflightWarning[] {
  if (warnings.length === 0) return []
  const first = layers[0]
  if (first === undefined) return []
  const emptyLabels = options.emptyLayerLabels ?? []
  const syntheticCount = Math.min(emptyLabels.length, warnings.length)
  const composeWarnings =
    syntheticCount === 0 ? warnings : warnings.slice(0, warnings.length - syntheticCount)
  const synthetic = syntheticCount === 0 ? [] : warnings.slice(warnings.length - syntheticCount)

  const attributed: PreflightWarning[] = []
  if (composeWarnings.length > 0) {
    if (layers.length === 1) {
      for (const message of composeWarnings) attributed.push({ layer: first.label, message })
    } else {
      let placed = 0
      for (
        let index = 0;
        index < layers.length - 1 && placed < composeWarnings.length;
        index += 1
      ) {
        const prefixWarnings: string[] = []
        composeEntries(
          layers.slice(0, index + 1).map((layer) => layer.patches as PatchOptions[]),
          (message) => prefixWarnings.push(message),
        )
        const added = Math.min(prefixWarnings.length - placed, composeWarnings.length - placed)
        if (added <= 0) continue
        for (const message of composeWarnings.slice(placed, placed + added)) {
          attributed.push({ layer: layers[index]!.label, message })
        }
        placed += added
      }

      const last = layers[layers.length - 1]!
      for (const message of composeWarnings.slice(placed)) {
        attributed.push({ layer: last.label, message })
      }
    }
  }

  for (const [index, label] of emptyLabels.entries()) {
    const message = synthetic[index]
    if (message !== undefined) attributed.push({ layer: label, message })
  }
  return attributed
}

function fail(message: string, warnings: readonly string[] = []): PreflightFailure {
  return new PreflightFailure({ message, warnings: [...warnings] })
}

function checkNoPlanExpression(
  value: unknown,
  layerId: string,
): Result.Result<void, PreflightFailure> {
  if (Array.isArray(value)) {
    for (const item of value) {
      const checked = checkNoPlanExpression(item, layerId)
      if (Result.isFailure(checked)) return checked
    }
    return Result.succeed(undefined)
  }
  const record = readRecord(value)
  if ('$eedsh' in record) {
    return Result.fail(
      fail(`generated layer ${layerId} contains a plan expression node; emit !!js scalars instead`),
    )
  }
  for (const item of Object.values(record)) {
    const checked = checkNoPlanExpression(item, layerId)
    if (Result.isFailure(checked)) return checked
  }
  return Result.succeed(undefined)
}

/**
 * Parse the emitted generated layer files back into DSH patch lists.
 * @param generated - the generated bundle.
 * @returns one preflight layer per emitted file in application order, or a
 * preflight failure for malformed content.
 */
export function parseGeneratedLayers(
  generated: GeneratedBundle,
): Result.Result<PreflightLayer[], PreflightFailure> {
  const files = generated.files.filter((file) => file.path.endsWith('.yml'))
  const layers: PreflightLayer[] = []
  for (const [index, file] of files.entries()) {
    const id = generated.generation.layers[index]?.id ?? file.path
    const parsed = Result.try({
      try: () => yaml.load(file.content, { schema: entryListSchema }),
      catch: (cause) => fail(`cannot parse generated layer ${id}: ${String(cause)}`),
    })
    if (Result.isFailure(parsed)) return Result.fail(parsed.failure)
    const decoded = Schema.decodeUnknownOption(patchListSchema)(parsed.success)
    if (Option.isNone(decoded)) {
      return Result.fail(
        fail(
          Array.isArray(parsed.success)
            ? `generated layer ${id} contains a non-object patch entry`
            : `generated layer ${id} must be a top-level YAML array of patch entries`,
        ),
      )
    }
    const entries = decoded.value.map((entry) => readRecord(entry))
    for (const entry of entries) {
      const checked = checkNoPlanExpression(entry, id)
      if (Result.isFailure(checked)) return Result.fail(checked.failure)
    }
    layers.push({
      label: `generated:${id}`,
      patches: entries,
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

/** The live preflight implementation; it needs the pinned DSH installation. */
export const preflightLayer: Layer.Layer<PreflightShape, never, DshInstallationShape> =
  Layer.effect(
    Preflight,
    Effect.gen(function* () {
      const dsh = yield* DshInstallation
      const check: PreflightShape['check'] = (input) =>
        Effect.gen(function* () {
          const generatedLayers = yield* Effect.fromResult(parseGeneratedLayers(input.generated))
          const layers = yield* bundleLayers(input.plan, input.profileDir, generatedLayers).pipe(
            Effect.provideService(DshInstallation, dsh),
          )
          const composition = composePreflightLayers(layers, {
            generatedLayerLabels: generatedLayers.map((layer) => layer.label),
          })
          const raw = composition.warnings
          const messages =
            input.explain && raw.length > 0
              ? attributePreflightWarnings(layers, raw, {
                  emptyLayerLabels: composition.emptyLayerLabels,
                }).map((warning) => `${warning.layer}: ${warning.message}`)
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
