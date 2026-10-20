/**
 * Preflight: compose the selected bundle layers with the generated layers
 * through DSH's own patch algorithm before the generation is committed, so a
 * plan that cannot compose never becomes the published profile.
 * @module @eedsh/cli/preflight
 */
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import type { ProfilePlan } from '@eedsh/config'
import { Effect, Layer } from 'effect'
import * as yaml from 'js-yaml'
import { PreflightFailure } from './internal/effect/errors.js'
import {
  DshInstallation,
  type DshInstallationShape,
  Preflight,
  type PreflightShape,
} from './internal/effect/services.js'
import type { GeneratedBundle } from './materialize/generated-bundle.js'

/** One preflight composition layer. */
export interface PreflightLayer {
  /** Source label used in diagnostics (`bundle:<name>` or `generated:<id>`). */
  label: string
  patches: Record<string, unknown>[]
}

/** One unmatched-patch diagnostic attributed to its layer. */
export interface PreflightWarning {
  layer: string
  message: string
}

/** The result of composing a preflight layer stack. */
export interface PreflightComposition {
  entries: Record<string, unknown>[]
  warnings: PreflightWarning[]
  /** Row ids inserted twice by generated layers. */
  duplicateInsertIds: string[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Collect ids inserted by a layer, including nested group children. */
function insertedIds(patches: readonly Record<string, unknown>[]): string[] {
  const ids: string[] = []
  const visitEntry = (entry: unknown) => {
    if (!isObject(entry)) return
    if (typeof entry.id === 'string') ids.push(entry.id)
    if (entry.group === true && Array.isArray(entry.config)) entry.config.forEach(visitEntry)
  }
  for (const patch of patches) {
    if (Array.isArray(patch.insert)) patch.insert.forEach(visitEntry)
  }
  return ids
}

/**
 * Compose preflight layers in application order. Bundle layers are composed
 * first; the generated layers sit at the plan's marker position. Warnings are
 * attributed to the layer that introduced them, and duplicate ids inserted by
 * generated layers are reported.
 * @param layers - layers in application order.
 * @param options - labels of the generated layers.
 * @returns the composed entries, attributed warnings, and duplicate ids.
 */
export function composePreflightLayers(
  layers: readonly PreflightLayer[],
  options: { generatedLayerLabels?: readonly string[] } = {},
): PreflightComposition {
  const warnings: PreflightWarning[] = []
  let previousWarnings: string[] = []
  for (let index = 0; index < layers.length; index += 1) {
    const current: string[] = []
    const prefix = layers.slice(0, index + 1)
    composeEntries(
      prefix.map((layer) => layer.patches as PatchOptions[]),
      (message) => current.push(message),
    )
    const added = current.slice(previousWarnings.length)
    for (const message of added) warnings.push({ layer: layers[index]!.label, message })
    previousWarnings = current
  }

  const entries = composeEntries(
    layers.map((layer) => layer.patches as PatchOptions[]),
    () => {},
  ) as unknown as Record<string, unknown>[]

  const generatedLabels = new Set(options.generatedLayerLabels ?? [])
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
    duplicateInsertIds: [...duplicates].sort(),
  }
}

function fail(message: string, warnings: readonly string[] = []): PreflightFailure {
  return new PreflightFailure({ message, warnings: [...warnings] })
}

function assertNoPlanExpression(value: unknown, layerId: string): void {
  if (Array.isArray(value)) {
    value.forEach((item) => {
      assertNoPlanExpression(item, layerId)
    })
    return
  }
  if (!isObject(value)) return
  if ('$eedsh' in value) {
    throw fail(
      `generated layer ${layerId} contains a plan expression node; emit !!js scalars instead`,
    )
  }
  for (const item of Object.values(value)) assertNoPlanExpression(item, layerId)
}

/**
 * Parse the emitted generated layer files back into DSH patch lists.
 * @param generated - the generated bundle.
 * @returns one preflight layer per emitted file, in application order.
 * @throws {PreflightFailure} for malformed content.
 */
export function parseGeneratedLayers(generated: GeneratedBundle): PreflightLayer[] {
  const files = generated.files.filter((file) => file.path.endsWith('.yml'))
  return files.map((file, index) => {
    const id = generated.generation.layers[index]?.id ?? file.path
    let parsed: unknown
    try {
      parsed = yaml.load(file.content, { schema: entryListSchema })
    } catch (cause) {
      throw fail(`cannot parse generated layer ${id}: ${String(cause)}`)
    }
    if (!Array.isArray(parsed)) {
      throw fail(`generated layer ${id} must be a top-level YAML array of patch entries`)
    }
    for (const item of parsed) {
      if (!isObject(item)) {
        throw fail(`generated layer ${id} contains a non-object patch entry`)
      }
      assertNoPlanExpression(item, id)
    }
    return { label: `generated:${id}`, patches: parsed as Record<string, unknown>[] }
  })
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
          Effect.catchAll((error) =>
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
          const generatedLayers = yield* Effect.try({
            try: () => parseGeneratedLayers(input.generated),
            catch: (cause) => (cause instanceof PreflightFailure ? cause : fail(String(cause))),
          })
          const layers = yield* bundleLayers(input.plan, input.profileDir, generatedLayers).pipe(
            Effect.provideService(DshInstallation, dsh),
          )
          const composition = composePreflightLayers(layers, {
            generatedLayerLabels: generatedLayers.map((layer) => layer.label),
          })
          const messages = composition.warnings.map(
            (warning) => `${warning.layer}: ${warning.message}`,
          )
          if (composition.duplicateInsertIds.length > 0) {
            return yield* Effect.fail(
              fail(
                `generated layers insert duplicate row ids: ${composition.duplicateInsertIds.join(', ')}`,
                messages,
              ),
            )
          }
          if (input.strict && messages.length > 0) {
            return yield* Effect.fail(fail('unmatched patch targets in strict mode', messages))
          }
          return { warnings: messages }
        })
      return { check }
    }),
  )
