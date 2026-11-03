/**
 * The mutable authoring builders. `LayerBuilder` appends Loader patches to one
 * generated layer; `ConfigBuilder` and `ProfileBuilder` assemble the config.
 * Builders mutate because a config is assembled once, and `.build()` is the
 * only place typed handles normalize to plain plan data.
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
import { normalizeAuthoring } from './authoring'
import { type PresetDefinition, type PresetRef, presetRefId } from './preset'
import {
  type AuthoringSite,
  captureAuthoringSite,
  type PatchGroupProvenance,
  recordProfileProvenance,
} from './provenance'
import {
  type Bundle,
  bundleSelection,
  type PatchTarget,
  type Preset,
  patchTargetId,
  type Row,
} from './query'
import {
  duplicatePackageDeclaration,
  normalizeSourceDeclaration,
  type SourceDeclaration,
} from './source'

/** One inserted Loader entry. */
export type PlanEntry = JsonObject

/** A value `LayerBuilder.insert()` accepts. */
export type LayerEntry = PlanEntry | Row | Preset | PresetDefinition

/**
 * One mutable generated patch layer. Patch methods append in call order and
 * return the layer so calls can chain.
 */
export class LayerBuilder {
  /** The optional display label; never an identifier and never part of the plan. */
  readonly label: string | undefined
  /** The appended Loader patches in application order. */
  readonly patches: PlanPatch[] = []
  /** The captured authoring site per patch, aligned with `patches`. */
  readonly sites: (AuthoringSite | undefined)[] = []

  constructor(label?: string) {
    this.label = label
  }

  /** Append one patch and capture its authoring site, best effort. */
  private append(patch: PlanPatch): void {
    this.patches.push(patch)
    this.sites.push(captureAuthoringSite())
  }

  /** The captured provenance for this group. */
  provenance(): PatchGroupProvenance {
    return { label: this.label, sites: [...this.sites] }
  }

  /**
   * Insert one or more Loader entries.
   * @param entries - an entry, a typed handle, or an array of them.
   * @returns this layer.
   */
  insert(entries: LayerEntry | readonly LayerEntry[]): this {
    const list: readonly LayerEntry[] = Array.isArray(entries) ? entries : [entries]
    this.append({ insert: [...list] })
    return this
  }

  /**
   * Disable an existing row.
   * @param target - a row id, a `Row`, or a `Preset`.
   * @returns this layer.
   */
  disable(target: PatchTarget): this {
    this.append({ id: patchTargetId(target), disabled: true })
    return this
  }

  /**
   * Enable an existing row.
   * @param target - a row id, a `Row`, or a `Preset`.
   * @returns this layer.
   */
  enable(target: PatchTarget): this {
    this.append({ id: patchTargetId(target), disabled: false })
    return this
  }

  /**
   * Replace an existing row's whole config, matching DSH's patch semantics.
   * @param target - a row id, a `Row`, or a `Preset`.
   * @param config - the complete replacement config.
   * @returns this layer.
   */
  override(target: PatchTarget, config: JsonValue): this {
    this.append({ id: patchTargetId(target), config })
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

  /** The layer as plain plan data; its identity is its position. */
  toJSON(): PlanLayer {
    return { patches: [...this.patches] }
  }
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

  /** The captured authoring provenance for this profile's patch groups. */
  provenance(): readonly PatchGroupProvenance[] {
    return this.layers.map((layer) => layer.provenance())
  }

  /** The profile as authored data; typed handles are normalized at build. */
  toJSON(): {
    readonly bundles: readonly unknown[]
    readonly layers: PlanLayer[]
    readonly packages: Record<string, string>
    readonly sources?: Record<string, PlanSource>
  } {
    const sources = { ...this.sourceSpecs }
    return {
      bundles: [...this.bundles],
      layers: this.layers.map((layer) => layer.toJSON()),
      packages: { ...this.packageSpecs },
      ...(Object.keys(sources).length === 0 ? {} : { sources }),
    }
  }
}

/**
 * The mutable, single-use config builder. `defineConfig()` returns it; every
 * chain method returns it and `.build()` validates once.
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

  /**
   * Normalize typed objects, validate the envelope and every profile, and
   * return the config or Effect's native schema error. Never throws.
   * @returns the validated config or a native schema failure.
   */
  build(): Result.Result<EedshConfig, Schema.SchemaError> {
    for (const profile of this.profiles) {
      recordProfileProvenance(profile.name, profile.provenance())
    }
    const authored: Record<string, unknown> = {
      profiles: Object.fromEntries(
        this.profiles.map((profile) => [profile.name, profile.toJSON()]),
      ),
    }
    if (this.defaultName !== undefined) authored.defaultProfile = this.defaultName
    const decoded = decodeConfigEnvelope(normalizeAuthoring(authored))
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
 * Author a multi-profile config through a fluent, synchronous builder.
 * @returns a new config builder.
 */
export function defineConfig(): ConfigBuilder {
  return new ConfigBuilder()
}
