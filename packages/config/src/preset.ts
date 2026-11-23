/**
 * Preset-definition authoring. A definition is mutable authoring sugar that
 * normalizes to an ordinary `@deepseek-ai/dsh-agent-preset` Loader row. Its
 * child list is edited through a callback-scoped editor: every operation names
 * one child or one anchor. A definition copied from an installed preset
 * resolves that preset's children from the invocation resolution at build time.
 * @module @eedsh/config/preset
 */
import type { JsonObject } from '@eedsh/plan'
import { AUTHORING_KIND, authoringKind } from './authoring'
import { defect } from './defect'
import type { BundleQueryDescriptor, Preset } from './query'
import type { ResolutionTable } from './resolution'

/** The Loader row name every preset definition normalizes to. */
export const PRESET_ROW_NAME = '@deepseek-ai/dsh-agent-preset'

/** Stable failure codes for preset authoring. */
export type PresetDefinitionErrorCode =
  | 'preset.invalid_id'
  | 'preset.child_not_found'
  | 'preset.child_ambiguous'
  | 'preset.invalid_selection'

/** A structured preset-authoring failure. */
export class PresetDefinitionError extends Error {
  readonly _tag = 'PresetDefinitionError'
  readonly code: PresetDefinitionErrorCode
  readonly presetId: string
  readonly rowId: string
  readonly childId?: string

  constructor(input: {
    readonly code: PresetDefinitionErrorCode
    readonly presetId: string
    readonly rowId: string
    readonly childId?: string
    readonly message: string
  }) {
    super(input.message)
    this.name = 'PresetDefinitionError'
    this.code = input.code
    this.presetId = input.presetId
    this.rowId = input.rowId
    if (input.childId !== undefined) this.childId = input.childId
  }
}

/** Options for a preset definition. */
export interface PresetDefinitionOptions {
  /** The Loader row id; defaults to `preset-` followed by the preset id. */
  readonly rowId?: string
}

type PresetOperation =
  | { readonly kind: 'check'; readonly id: string }
  | { readonly kind: 'append'; readonly entry: JsonObject }
  | { readonly kind: 'prepend'; readonly entry: JsonObject }
  | { readonly kind: 'insertBefore'; readonly anchor: string; readonly entry: JsonObject }
  | { readonly kind: 'insertAfter'; readonly anchor: string; readonly entry: JsonObject }
  | { readonly kind: 'remove'; readonly id: string }
  | { readonly kind: 'replace'; readonly id: string; readonly entry: JsonObject }
  | { readonly kind: 'setDisabled'; readonly id: string; readonly disabled: boolean }

interface PresetState {
  entries: JsonObject[]
  source?: Preset
  operations: PresetOperation[]
  name?: string
  description?: string
  order?: number
}

const STATES = new WeakMap<PresetDefinition, PresetState>()

function stateOf(definition: PresetDefinition): PresetState {
  const state = STATES.get(definition)
  if (state === undefined) defect(new Error('unreachable: preset definition has no state'))
  return state
}

function cloneJson<T>(value: T): T {
  return structuredClone(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function childIdOf(entry: JsonObject): string | undefined {
  return typeof entry.id === 'string' ? entry.id : undefined
}

/** Look up one top-level child, rejecting a missing or ambiguous id. */
function childIndex(
  entries: readonly JsonObject[],
  definition: PresetDefinition,
  id: string,
): number {
  const matches: number[] = []
  entries.forEach((entry, index) => {
    if (childIdOf(entry) === id) matches.push(index)
  })
  if (matches.length === 0) {
    defect(
      new PresetDefinitionError({
        code: 'preset.child_not_found',
        presetId: definition.id,
        rowId: definition.rowId,
        childId: id,
        message: `preset ${JSON.stringify(definition.id)} (row ${JSON.stringify(definition.rowId)}) declares no child ${JSON.stringify(id)}`,
      }),
    )
  }
  if (matches.length > 1) {
    defect(
      new PresetDefinitionError({
        code: 'preset.child_ambiguous',
        presetId: definition.id,
        rowId: definition.rowId,
        childId: id,
        message: `preset ${JSON.stringify(definition.id)} (row ${JSON.stringify(definition.rowId)}) declares ${matches.length} children with id ${JSON.stringify(id)}; the edit is ambiguous`,
      }),
    )
  }
  return matches[0] as number
}

/** Apply one recorded child operation to a materialized child list. */
function applyOperation(
  definition: PresetDefinition,
  entries: JsonObject[],
  operation: PresetOperation,
): void {
  switch (operation.kind) {
    case 'check': {
      childIndex(entries, definition, operation.id)
      return
    }
    case 'append':
      entries.push(cloneJson(operation.entry))
      return
    case 'prepend':
      entries.unshift(cloneJson(operation.entry))
      return
    case 'insertBefore': {
      const index = childIndex(entries, definition, operation.anchor)
      entries.splice(index, 0, cloneJson(operation.entry))
      return
    }
    case 'insertAfter': {
      const index = childIndex(entries, definition, operation.anchor)
      entries.splice(index + 1, 0, cloneJson(operation.entry))
      return
    }
    case 'remove': {
      const index = childIndex(entries, definition, operation.id)
      entries.splice(index, 1)
      return
    }
    case 'replace': {
      const index = childIndex(entries, definition, operation.id)
      entries[index] = cloneJson(operation.entry)
      return
    }
    case 'setDisabled': {
      const index = childIndex(entries, definition, operation.id)
      entries[index] = { ...(entries[index] as JsonObject), disabled: operation.disabled }
    }
  }
}

/**
 * One transient child handle. With no copied source, operations are validated
 * against the authored child list before mutating it. A copied source is
 * resolved at build time, so its operations are recorded and replayed then.
 */
export class PresetChild {
  constructor(
    private readonly definition: PresetDefinition,
    private readonly childId: string,
  ) {}

  /** Disable this child. */
  disable(): void {
    this.setDisabled(true)
  }

  /** Enable this child. */
  enable(): void {
    this.setDisabled(false)
  }

  /** Remove this child from the list. */
  remove(): void {
    const state = stateOf(this.definition)
    if (state.source === undefined) childIndex(state.entries, this.definition, this.childId)
    this.record({ kind: 'remove', id: this.childId })
  }

  /**
   * Replace this child in place.
   * @param entry - the one replacement entry.
   */
  replaceWith(entry: JsonObject): void {
    const state = stateOf(this.definition)
    if (state.source === undefined) childIndex(state.entries, this.definition, this.childId)
    this.record({ kind: 'replace', id: this.childId, entry })
  }

  private setDisabled(disabled: boolean): void {
    const state = stateOf(this.definition)
    if (state.source === undefined) childIndex(state.entries, this.definition, this.childId)
    this.record({ kind: 'setDisabled', id: this.childId, disabled })
  }

  private record(operation: PresetOperation): void {
    const state = stateOf(this.definition)
    if (state.source === undefined) applyOperation(this.definition, state.entries, operation)
    else state.operations.push(operation)
  }
}

/**
 * The callback-scoped child editor. Operations are single-target and accept at
 * most one entry; only top-level children are addressable.
 */
export class PresetChildren {
  constructor(private readonly definition: PresetDefinition) {}

  /**
   * Address one child by id.
   * @param id - the child Loader row id.
   * @returns a transient child handle.
   */
  child(id: string): PresetChild {
    const state = stateOf(this.definition)
    if (state.source === undefined) childIndex(state.entries, this.definition, id)
    else state.operations.push({ kind: 'check', id })
    return new PresetChild(this.definition, id)
  }

  /**
   * Append one entry after the current children.
   * @param entry - the entry to append.
   */
  append(entry: JsonObject): void {
    this.record({ kind: 'append', entry })
  }

  /**
   * Prepend one entry before the current children.
   * @param entry - the entry to prepend.
   */
  prepend(entry: JsonObject): void {
    this.record({ kind: 'prepend', entry })
  }

  /**
   * Insert one entry before one named anchor.
   * @param anchor - the child Loader row id to insert before.
   * @param entry - the entry to insert.
   */
  insertBefore(anchor: string, entry: JsonObject): void {
    this.record({ kind: 'insertBefore', anchor, entry })
  }

  /**
   * Insert one entry after one named anchor.
   * @param anchor - the child Loader row id to insert after.
   * @param entry - the entry to insert.
   */
  insertAfter(anchor: string, entry: JsonObject): void {
    this.record({ kind: 'insertAfter', anchor, entry })
  }

  private record(operation: PresetOperation): void {
    const state = stateOf(this.definition)
    if (state.source === undefined) applyOperation(this.definition, state.entries, operation)
    else state.operations.push(operation)
  }
}

/**
 * A mutable agent-preset definition. It normalizes to an ordinary inserted
 * Loader row with the preset package name, so the plan gains no new concept.
 */
export class PresetDefinition {
  /** The preset id the registry selects. */
  readonly id: string
  /** The Loader row id patches and insertions use. */
  readonly rowId: string
  readonly [AUTHORING_KIND] = 'preset-definition' as const

  constructor(id: string, options: PresetDefinitionOptions = {}) {
    if (typeof id !== 'string' || id.trim() === '') {
      defect(
        new PresetDefinitionError({
          code: 'preset.invalid_id',
          presetId: typeof id === 'string' ? id : '',
          rowId: options.rowId ?? '',
          message: 'a preset definition needs a non-empty preset id',
        }),
      )
    }
    this.id = id
    this.rowId = options.rowId ?? `preset-${id}`
    STATES.set(this, { entries: [], operations: [] })
  }

  /**
   * Copy one installed preset's child list. Identity and metadata stay with
   * this definition; the source descriptor is resolved during build, and the
   * source handle is never mutated or aliased.
   * @param source - the queried preset to adapt.
   * @returns this definition.
   */
  from(source: Preset): this {
    const state = stateOf(this)
    state.source = source
    state.entries = []
    state.operations = []
    return this
  }

  /**
   * Set the preset display name.
   * @param name - the display name.
   * @returns this definition.
   */
  name(name: string): this {
    stateOf(this).name = name
    return this
  }

  /**
   * Set the preset description.
   * @param description - the description text.
   * @returns this definition.
   */
  description(description: string): this {
    stateOf(this).description = description
    return this
  }

  /**
   * Set the preset order.
   * @param order - the numeric order.
   * @returns this definition.
   */
  order(order: number): this {
    stateOf(this).order = order
    return this
  }

  /**
   * Edit the child list inside one callback scope. The callback return value
   * is ignored and the scope returns this definition.
   * @param build - receives the scoped child editor.
   * @returns this definition.
   */
  children(build: (children: PresetChildren) => unknown): this {
    build(new PresetChildren(this))
    return this
  }

  /**
   * The preset definition as an ordinary inserted Loader row.
   * @param table - the invocation resolution, required for a copied source.
   * @returns the plain Loader row.
   */
  toJSON(table: ResolutionTable = { bundles: [] }): JsonObject {
    const state = stateOf(this)
    const entries = this.materializedEntries(table)
    const config: JsonObject = {
      id: this.id,
      plugins: cloneJson(entries) as JsonObject[],
    }
    if (state.name !== undefined) config.name = state.name
    if (state.description !== undefined) config.description = state.description
    if (state.order !== undefined) config.order = state.order
    return { id: this.rowId, name: PRESET_ROW_NAME, config }
  }

  /** The row as plain plan data, resolved by the invocation. */
  resolve(table: ResolutionTable): JsonObject {
    return this.toJSON(table)
  }

  /** The source preset query this definition needs, when it copies one. */
  queries(): readonly BundleQueryDescriptor[] {
    return stateOf(this).source?.queries() ?? []
  }

  private materializedEntries(table: ResolutionTable): JsonObject[] {
    const state = stateOf(this)
    if (state.source === undefined) return state.entries
    const source = state.source.resolve(table)
    const config = isRecord(source.config) ? source.config : {}
    const plugins = Array.isArray(config.plugins) ? (config.plugins as JsonObject[]) : []
    const entries = cloneJson(plugins)
    for (const operation of state.operations) applyOperation(this, entries, operation)
    return entries
  }
}

/** A reference the preset registry can select: an installed or authored preset. */
export type PresetRef = Preset | PresetDefinition

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'object') {
    const name = (value as { constructor?: { name?: string } }).constructor?.name
    return name === undefined || name === '' ? 'an object' : `a ${name}`
  }
  return typeof value
}

/**
 * The preset id one reference resolves to for the registry.
 * @param reference - an installed `Preset` or an authored `PresetDefinition`.
 * @param role - the reference's role, used in the failure message.
 * @returns the preset id the registry selects.
 */
export function presetRefId(reference: PresetRef, role: string): string {
  const kind = authoringKind(reference)
  const record =
    reference !== null && typeof reference === 'object'
      ? (reference as unknown as Record<string, unknown>)
      : undefined
  const presetId = typeof record?.id === 'string' ? record.id : ''
  const rowId = typeof record?.rowId === 'string' ? record.rowId : ''
  if (kind !== 'preset' && kind !== 'preset-definition') {
    defect(
      new PresetDefinitionError({
        code: 'preset.invalid_selection',
        presetId,
        rowId,
        message: `the ${role} preset must be an installed preset or an authored preset definition; received ${describeValue(reference)}`,
      }),
    )
  }
  if (presetId === '') {
    defect(
      new PresetDefinitionError({
        code: 'preset.invalid_selection',
        presetId,
        rowId,
        message: `the ${role} preset has no preset id to select`,
      }),
    )
  }
  return presetId
}

/**
 * Author a mutable agent-preset definition.
 * @param id - the non-empty preset id the registry selects.
 * @param options - optional explicit Loader row id.
 * @returns a new preset definition.
 */
export function definePreset(id: string, options: PresetDefinitionOptions = {}): PresetDefinition {
  return new PresetDefinition(id, options)
}
