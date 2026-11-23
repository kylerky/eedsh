/**
 * The mutable authoring builders. `LayerBuilder` appends Loader patches to one
 * generated layer; `ConfigBuilder` and `ProfileBuilder` assemble the config.
 * Builders mutate because a config is assembled once, and `build(table)` is the
 * only place typed descriptors normalize to plain plan data.
 * @module @eedsh/config/builders
 */
import {
  configValue,
  decodeConfigEnvelope,
  type EedshConfig,
  type ExpressionNode,
  type JsonObject,
  type JsonValue,
  type PlanLayer,
  type PlanPatch,
  type PlanSource,
  type ProfilePlan,
  validateProfileDefinition,
} from '@eedsh/plan'
import * as Result from 'effect/Result'
import type * as Schema from 'effect/Schema'
import { authoringKind, isAuthoringObject, normalizeAuthoring } from './authoring'
import { type PresetDefinition, type PresetRef, presetRefId } from './preset'
import {
  type AuthoringSite,
  captureAuthoringSite,
  type PatchGroupProvenance,
  recordProfileProvenance,
} from './provenance'
import {
  authoringQueries,
  type Bundle,
  type BundleQueryDescriptor,
  bundleSelection,
  PatchDescriptor,
  type PatchTarget,
  type Preset,
  type PresetCollection,
  patchTargetQueries,
  patchTargetValue,
  queryDescriptorKey,
  type Row,
  type RowCollection,
} from './query'
import type { ConfigInput, ResolutionTable } from './resolution'
import {
  duplicatePackageDeclaration,
  normalizeSourceDeclaration,
  type SourceDeclaration,
} from './source'

/** One inserted Loader entry. */
export type PlanEntry = JsonObject

/** A value `LayerBuilder.insert()` accepts. */
export type LayerEntry =
  | PlanEntry
  | Row
  | Preset
  | RowCollection
  | PresetCollection
  | PresetDefinition

/** One stored layer patch: plain, or deferred until resolution. */
export type LayerPatch = PlanPatch | PatchDescriptor

/**
 * One mutable generated patch layer. Patch methods append in call order and
 * return the layer so calls can chain.
 */
export class LayerBuilder {
  /** The optional display label; never an identifier and never part of the plan. */
  readonly label: string | undefined
  /** The appended patches in application order; deferred ones expand at build. */
  readonly patches: LayerPatch[] = []
  /** The captured authoring site per patch, aligned with `patches`. */
  readonly sites: (AuthoringSite | undefined)[] = []
  private readonly targetQueries: BundleQueryDescriptor[] = []

  constructor(label?: string) {
    this.label = label
  }

  /** Append one patch and capture its authoring site, best effort. */
  private append(patch: LayerPatch): void {
    this.patches.push(patch)
    this.sites.push(captureAuthoringSite())
  }

  /**
   * The captured provenance for this group.
   * @param table - the invocation resolution, when deferred patches expand.
   * @returns one site per emitted patch.
   */
  provenance(table?: ResolutionTable): PatchGroupProvenance {
    const sites: (AuthoringSite | undefined)[] = []
    for (const [index, patch] of this.patches.entries()) {
      const site = this.sites[index]
      if (patch instanceof PatchDescriptor && table !== undefined) {
        for (let count = 0; count < patch.resolve(table).length; count += 1) sites.push(site)
      } else {
        sites.push(site)
      }
    }
    return { label: this.label, sites }
  }

  /**
   * Insert one or more Loader entries.
   * @param entries - an entry, a typed descriptor, or an array of them.
   * @returns this layer.
   */
  insert(entries: LayerEntry | readonly LayerEntry[]): this {
    const list: readonly LayerEntry[] = Array.isArray(entries) ? entries : [entries]
    this.append({ insert: [...list] })
    return this
  }

  /**
   * Disable an existing row.
   * @param target - a row id, a row or preset descriptor, or a collection.
   * @returns this layer.
   */
  disable(target: PatchTarget): this {
    this.recordTarget(target)
    this.append(patchTargetValue(target, { kind: 'disable' }))
    return this
  }

  /**
   * Enable an existing row.
   * @param target - a row id, a row or preset descriptor, or a collection.
   * @returns this layer.
   */
  enable(target: PatchTarget): this {
    this.recordTarget(target)
    this.append(patchTargetValue(target, { kind: 'enable' }))
    return this
  }

  /**
   * Replace an existing row's whole config, matching DSH's patch semantics.
   * @param target - a row id, a row or preset descriptor, or a collection.
   * @param config - the complete replacement config.
   * @returns this layer.
   */
  override(target: PatchTarget, config: JsonValue): this {
    this.recordTarget(target)
    this.append(patchTargetValue(target, { kind: 'override', config }))
    return this
  }

  /**
   * Select one preset and declare the deployment default explicitly. The
   * written config is complete and replaces the registry row's config; when
   * the row is absent, preflight reports the unmatched target.
   * @param selected - an installed or authored preset reference.
   * @param options - the required deployment-default preset reference.
   * @returns this layer.
   */
  selectPreset(selected: PresetRef, options: { readonly default: PresetRef }): this {
    const selectedDefault = presetRefId(selected, 'selected')
    const deploymentDefault = presetRefId(options.default, 'deployment-default')
    this.append({
      id: 'agent-preset-registry',
      config: { default: deploymentDefault, selectedDefault },
    })
    return this
  }

  /**
   * Preserve a raw Loader patch entry, including fields this API does not name.
   * @param entry - the patch entry.
   * @returns this layer.
   */
  raw(entry: PlanPatch): this {
    this.append({ ...entry })
    return this
  }

  /** The distinct query descriptors this layer records. */
  queries(): readonly BundleQueryDescriptor[] {
    const descriptors = [...this.targetQueries]
    for (const patch of this.patches) descriptors.push(...authoringQueries(patch))
    return descriptors
  }

  /**
   * The layer as plain plan data; its identity is its position.
   * @param table - the invocation resolution.
   * @returns the plain patch list.
   */
  toJSON(table: ResolutionTable = { bundles: [] }): PlanLayer {
    const patches: PlanPatch[] = []
    for (const patch of this.patches) {
      if (patch instanceof PatchDescriptor) {
        patches.push(...patch.resolve(table))
        continue
      }
      patches.push(expandPatch(patch, table))
    }
    return { patches }
  }

  private recordTarget(target: PatchTarget): void {
    this.targetQueries.push(...patchTargetQueries(target))
  }
}

/**
 * Expand one plain patch, resolving inserted descriptors and collections.
 * @param patch - one authored patch.
 * @param table - the invocation resolution.
 * @returns the plain patch with every inserted entry resolved.
 */
function expandPatch(patch: PlanPatch, table: ResolutionTable): PlanPatch {
  if (!Array.isArray(patch.insert)) return patch
  const insert: JsonValue[] = []
  for (const item of patch.insert) insert.push(...expandEntry(item, table))
  return { ...patch, insert }
}

/** Expand one inserted value into the plain entries it contributes. */
function expandEntry(value: unknown, table: ResolutionTable): PlanEntry[] {
  if (isAuthoringObject(value)) {
    const kind = authoringKind(value)
    if (kind === 'rows' || kind === 'presets') {
      return [...(value.resolve(table) as readonly PlanEntry[])]
    }
    return [normalizeAuthoring(value, table) as PlanEntry]
  }
  return [normalizeAuthoring(value, table) as PlanEntry]
}

/**
 * Declare a group entry carrying an optional isolate map and ordered children.
 * Pass it to `layer.insert()` to add the group as a new row.
 * @param id - the group row id.
 * @param fields - extra entry fields such as `name`, `disabled`, or `isolate`.
 * @param children - ordered child entries.
 * @returns a group entry.
 */
export function group(id: string, fields: JsonObject, children: readonly PlanEntry[]): PlanEntry {
  return {
    ...fields,
    id,
    group: true,
    config: children.map((child) => ({ ...child })) as JsonValue[],
  }
}

/**
 * Build a runtime expression node with verbatim source text.
 * @param source - the JavaScript expression DSH evaluates at activation.
 * @returns the reserved expression node.
 */
export function js(source: string): ExpressionNode {
  return { $eedsh: { expr: source } }
}

/**
 * One mutable profile builder. Bundles, layers, and packages keep authored
 * order and are scoped to the profile.
 */
export class ProfileBuilder {
  /** The profile key, which is also the profile directory name. */
  readonly name: string
  private readonly bundles: unknown[] = []
  private readonly layers: LayerBuilder[] = []
  private readonly packageSpecs: Record<string, string> = {}
  private readonly sourceSpecs: Record<string, PlanSource> = {}

  constructor(name: string) {
    this.name = name
  }

  /**
   * Add an ordered bundle selection.
   * @param value - a bundle name or an unrooted `Bundle`.
   * @returns this profile.
   */
  bundle(value: string | Bundle): this {
    this.bundles.push(
      typeof value === 'string' ? { kind: 'bundle', name: value } : bundleSelection(value),
    )
    return this
  }

  /**
   * Add the positional generated-bundle marker.
   * @returns this profile.
   */
  generated(): this {
    this.bundles.push({ kind: 'generated' })
    return this
  }

  /**
   * Declare an ordered patch group scoped to its callback. The callback may be
   * passed alone for an anonymous group, or after an optional display label;
   * the label is not an identifier and is never part of the plan.
   * @param build - receives a layer builder scoped to this group.
   * @returns this profile.
   */
  layer(build: (layer: LayerBuilder) => void): this
  /**
   * Declare a labelled, ordered patch group scoped to its callback. The
   * callback stays optional so an empty labelled group can be declared.
   * @param label - an optional, non-unique display label.
   * @param build - receives a layer builder scoped to this group.
   * @returns this profile.
   */
  layer(label: string, build?: (layer: LayerBuilder) => void): this
  layer(
    labelOrBuild: string | ((layer: LayerBuilder) => void),
    build?: (layer: LayerBuilder) => void,
  ): this {
    const label = typeof labelOrBuild === 'string' ? labelOrBuild : undefined
    const buildLayer = typeof labelOrBuild === 'function' ? labelOrBuild : build
    const layer = new LayerBuilder(label)
    if (buildLayer !== undefined) buildLayer(layer)
    this.layers.push(layer)
    return this
  }

  /**
   * Declare a profile-local package dependency.
   * @param name - the package name.
   * @param spec - the dependency specification.
   * @returns this profile.
   */
  package(name: string, spec: string): this {
    if (Object.hasOwn(this.sourceSpecs, name)) throw duplicatePackageDeclaration(name)
    this.packageSpecs[name] = spec
    return this
  }

  /**
   * Declare a profile package dependency whose contents eedsh provisions from
   * a git repository or a local checkout. The defaults for `prepare` are
   * resolved here so the plan records exactly what will run.
   * @param name - the package name.
   * @param declaration - the acquisition location, optional ref, and steps.
   * @returns this profile.
   */
  source(name: string, declaration: SourceDeclaration): this {
    if (Object.hasOwn(this.packageSpecs, name)) throw duplicatePackageDeclaration(name)
    this.sourceSpecs[name] = normalizeSourceDeclaration(name, declaration)
    return this
  }

  /**
   * The captured authoring provenance for this profile's patch groups.
   * @param table - the invocation resolution, when deferred patches expand.
   * @returns one provenance record per group.
   */
  provenance(table?: ResolutionTable): readonly PatchGroupProvenance[] {
    return this.layers.map((layer) => layer.provenance(table))
  }

  /** The distinct query descriptors this profile records. */
  queries(): readonly BundleQueryDescriptor[] {
    return this.layers.flatMap((layer) => layer.queries())
  }

  /**
   * The profile as authored data with every descriptor resolved.
   * @param table - the invocation resolution.
   * @returns the plain profile data.
   */
  toJSON(table: ResolutionTable = { bundles: [] }): {
    readonly bundles: readonly unknown[]
    readonly layers: PlanLayer[]
    readonly packages: Record<string, string>
    readonly sources?: Record<string, PlanSource>
  } {
    const sources = { ...this.sourceSpecs }
    return {
      bundles: [...this.bundles],
      layers: this.layers.map((layer) => layer.toJSON(table)),
      packages: { ...this.packageSpecs },
      ...(Object.keys(sources).length === 0 ? {} : { sources }),
    }
  }
}

/**
 * The mutable, single-use config builder. `defineConfig()` returns it; every
 * chain method returns it and `build(table)` validates once.
 */
export class ConfigBuilder {
  private defaultName: string | undefined
  private readonly profiles: ProfileBuilder[] = []

  /**
   * Name the profile a command selects when none is named.
   * @param name - a declared profile key.
   * @returns this config.
   */
  defaultProfile(name: string): this {
    this.defaultName = name
    return this
  }

  /**
   * Declare a profile; the callback receives a builder scoped to that profile.
   * @param name - the profile key.
   * @param build - receives the profile builder.
   * @returns this config.
   */
  profile(name: string, build: (profile: ProfileBuilder) => void): this {
    const profile = new ProfileBuilder(name)
    build(profile)
    this.profiles.push(profile)
    return this
  }

  /** The distinct query descriptors the invocation must resolve. */
  queries(): readonly BundleQueryDescriptor[] {
    const distinct = new Map<string, BundleQueryDescriptor>()
    for (const profile of this.profiles) {
      for (const descriptor of profile.queries()) {
        const key = queryDescriptorKey(descriptor)
        if (!distinct.has(key)) distinct.set(key, descriptor)
      }
    }
    return [...distinct.values()]
  }

  /**
   * Normalize typed objects and descriptors using the invocation resolution,
   * validate the envelope and every profile, and return the config or Effect's
   * native schema error.
   * @param table - the resolved bundles for every descriptor `queries()` reports.
   * @returns the validated config or a native schema failure.
   */
  build(table: ResolutionTable = { bundles: [] }): Result.Result<EedshConfig, Schema.SchemaError> {
    for (const profile of this.profiles) {
      recordProfileProvenance(profile.name, profile.provenance(table))
    }
    const authored: Record<string, unknown> = {
      profiles: Object.fromEntries(
        this.profiles.map((profile) => [profile.name, profile.toJSON(table)]),
      ),
    }
    if (this.defaultName !== undefined) authored.defaultProfile = this.defaultName
    const decoded = decodeConfigEnvelope(normalizeAuthoring(authored, table))
    if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
    const envelope = decoded.success
    const profiles: Record<string, Result.Result<ProfilePlan, Schema.SchemaError>> = {}
    for (const [name, definition] of Object.entries(envelope.profiles)) {
      profiles[name] = validateProfileDefinition(name, definition)
    }
    return Result.succeed(configValue(envelope, profiles))
  }
}

/**
 * The synchronous factory a config module default-exports. The invocation calls
 * it once with the selected version and the config directory.
 */
export type ConfigFactory = (input: ConfigInput) => ConfigBuilder

/**
 * Author a multi-profile config through a fluent, synchronous builder.
 * @returns a new config builder.
 */
export function defineConfig(): ConfigBuilder {
  return new ConfigBuilder()
}
