/**
 * Human-readable diffs between two config evaluations. Canonical JSON removes
 * key-order noise; inserted rows are reported by id so a patch addition is
 * visible without printing the whole plan.
 * @module @eedsh/cli/repl/diff
 */
import { canonicalJson, type ProfilePlan } from '@eedsh/plan'

/** One profile name and its validated plan, or undefined when invalid/absent. */
export type PlanMap = ReadonlyMap<string, ProfilePlan | undefined>

function idOf(value: unknown): string | undefined {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).id === 'string'
    ? ((value as Record<string, unknown>).id as string)
    : undefined
}

interface PatchEntity {
  readonly kind: 'row' | 'patch'
  readonly id: string
  readonly value: unknown
}

function patchEntities(patches: readonly unknown[]): Map<string, PatchEntity> {
  const entities = new Map<string, PatchEntity>()
  patches.forEach((patch, patchIndex) => {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      entities.set(`patch:#${patchIndex}`, {
        kind: 'patch',
        id: `#${patchIndex}`,
        value: patch,
      })
      return
    }
    const record = patch as Record<string, unknown>
    if (Array.isArray(record.insert)) {
      record.insert.forEach((entry, entryIndex) => {
        const id = idOf(entry) ?? `#${entryIndex}`
        entities.set(`row:${id}`, { kind: 'row', id, value: entry })
      })
      return
    }
    const id = typeof record.id === 'string' ? record.id : `#${patchIndex}`
    entities.set(`patch:${id}`, { kind: 'patch', id, value: record })
  })
  return entities
}

function quote(value: string): string {
  return JSON.stringify(value)
}

function diffLayerPatches(
  profile: string,
  layerId: string,
  before: unknown[],
  after: unknown[],
): string[] {
  const prefix = `profile ${quote(profile)} layer ${quote(layerId)}`
  const previous = patchEntities(before)
  const next = patchEntities(after)
  const lines: string[] = []
  for (const [key, entity] of next) {
    const old = previous.get(key)
    if (old === undefined) lines.push(`+ ${entity.kind} ${quote(entity.id)} (${prefix})`)
    else if (canonicalJson(old.value) !== canonicalJson(entity.value)) {
      lines.push(`~ ${entity.kind} ${quote(entity.id)} (${prefix})`)
    }
  }
  for (const [key, entity] of previous) {
    if (!next.has(key)) lines.push(`- ${entity.kind} ${quote(entity.id)} (${prefix})`)
  }
  return lines
}

function layerKey(layer: { readonly id?: string | undefined }, index: number): string {
  return layer.id ?? `#${index}`
}

function diffPlan(profile: string, before: ProfilePlan, after: ProfilePlan): string[] {
  const lines: string[] = []
  if (before.dsh !== after.dsh)
    lines.push(`~ profile ${quote(profile)} dsh ${before.dsh} -> ${after.dsh}`)

  const beforeBundles = new Map(
    before.bundles.map((item) => [item.kind === 'generated' ? 'generated' : item.name, item]),
  )
  const afterBundles = new Map(
    after.bundles.map((item) => [item.kind === 'generated' ? 'generated' : item.name, item]),
  )
  for (const [key, item] of afterBundles) {
    const old = beforeBundles.get(key)
    const label = item.kind === 'generated' ? 'generated()' : quote(item.name)
    if (old === undefined) lines.push(`+ bundle ${label} (profile ${quote(profile)})`)
    else if (canonicalJson(old) !== canonicalJson(item)) {
      lines.push(`~ bundle ${label} (profile ${quote(profile)})`)
    }
  }
  for (const [key, item] of beforeBundles) {
    if (afterBundles.has(key)) continue
    lines.push(
      `- bundle ${item.kind === 'generated' ? 'generated()' : quote(item.name)} (profile ${quote(profile)})`,
    )
  }

  const beforePackages = before.packages
  const afterPackages = after.packages
  for (const name of Object.keys(afterPackages)) {
    const old = beforePackages[name]
    const value = afterPackages[name]
    if (old === undefined) lines.push(`+ package ${quote(name)} ${quote(value ?? '')}`)
    else if (old !== value)
      lines.push(`~ package ${quote(name)} ${quote(old)} -> ${quote(value ?? '')}`)
  }
  for (const name of Object.keys(beforePackages)) {
    if (!Object.hasOwn(afterPackages, name)) lines.push(`- package ${quote(name)}`)
  }

  const beforeLayers = new Map(before.layers.map((item, index) => [layerKey(item, index), item]))
  const afterLayers = new Map(after.layers.map((item, index) => [layerKey(item, index), item]))
  for (const [id, item] of afterLayers) {
    const old = beforeLayers.get(id)
    if (old === undefined) {
      lines.push(`+ layer ${quote(id)} (profile ${quote(profile)})`)
      lines.push(...diffLayerPatches(profile, id, [], item.patches as unknown[]))
      continue
    }
    if (canonicalJson(old.patches) === canonicalJson(item.patches)) continue
    lines.push(`~ layer ${quote(id)} (profile ${quote(profile)})`)
    lines.push(
      ...diffLayerPatches(profile, id, old.patches as unknown[], item.patches as unknown[]),
    )
  }
  for (const id of beforeLayers.keys()) {
    if (!afterLayers.has(id)) lines.push(`- layer ${quote(id)} (profile ${quote(profile)})`)
  }
  return lines
}

/**
 * Diff two evaluations by profile. Invalid or absent profiles are compared by
 * presence only; valid profiles get bundle, package, layer, patch, and row
 * changes.
 * @param before - the previous valid plan per profile.
 * @param after - the next valid plan per profile.
 * @returns one line per change, in profile order.
 */
export function diffPlans(before: PlanMap, after: PlanMap): string[] {
  const lines: string[] = []
  const names = new Set([...before.keys(), ...after.keys()])
  for (const name of names) {
    const old = before.get(name)
    const next = after.get(name)
    if (old === undefined && next === undefined) continue
    if (old === undefined) {
      lines.push(`+ profile ${quote(name)}`)
      continue
    }
    if (next === undefined) {
      lines.push(`- profile ${quote(name)}`)
      continue
    }
    lines.push(...diffPlan(name, old, next))
  }
  return lines
}
