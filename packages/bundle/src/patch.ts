/**
 * Build-time authoring for one DSH bundle's Loader patch layer. A bundle patch
 * is an ordered array of Loader patch entries; the published package ships the
 * emitted `cordis.patch.yml`. No DSH installation or profile is involved.
 * @module @eedsh/bundle/patch
 */

/** A JSON primitive. */
export type JsonPrimitive = string | number | boolean | null

/** A JSON value. */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

/** A `!!js` expression node; emission turns it into a DSH YAML scalar. */
export interface ExpressionNode {
  $eedsh: { expr: string }
}

/** One Loader patch entry. Plugin config stays opaque to this package. */
export interface PatchEntry {
  [key: string]: unknown
}

/** A bundle's ordered Loader patch list. */
export type BundlePatch = readonly PatchEntry[]

/** A target for `override`, `disable`, or `enable`. */
export type PatchTarget = string

/**
 * One mutable bundle patch. Methods append in call order and return the
 * builder so calls can chain.
 */
export class BundlePatchBuilder {
  private readonly entries: PatchEntry[] = []

  /**
   * Insert one or more Loader entries.
   * @param entries - an entry or an array of entries.
   * @returns this builder.
   */
  insert(entries: PatchEntry | readonly PatchEntry[]): this {
    const list: readonly PatchEntry[] = Array.isArray(entries)
      ? (entries as readonly PatchEntry[])
      : [entries as PatchEntry]
    this.entries.push({ insert: [...list] })
    return this
  }

  /**
   * Replace an existing row's whole config, matching DSH patch semantics.
   * @param target - the row id.
   * @param config - the complete replacement config.
   * @returns this builder.
   */
  override(target: PatchTarget, config: unknown): this {
    this.entries.push({ id: target, config })
    return this
  }

  /**
   * Disable an existing row.
   * @param target - the row id.
   * @returns this builder.
   */
  disable(target: PatchTarget): this {
    this.entries.push({ id: target, disabled: true })
    return this
  }

  /**
   * Enable an existing row.
   * @param target - the row id.
   * @returns this builder.
   */
  enable(target: PatchTarget): this {
    this.entries.push({ id: target, disabled: false })
    return this
  }

  /**
   * Preserve a raw Loader patch entry, including fields this API does not name.
   * @param entry - the patch entry.
   * @returns this builder.
   */
  raw(entry: PatchEntry): this {
    this.entries.push({ ...entry })
    return this
  }

  /** The patch as plain JSON-compatible data, in authored order. */
  toJSON(): BundlePatch {
    return [...this.entries]
  }
}

/**
 * Author one bundle patch.
 * @param build - receives a builder scoped to this patch.
 * @returns the plain ordered patch list.
 */
export function defineBundlePatch(build: (patch: BundlePatchBuilder) => void): BundlePatch {
  const builder = new BundlePatchBuilder()
  build(builder)
  return builder.toJSON()
}

/**
 * Build a group entry carrying an optional isolate map and ordered children.
 * Pass it to `insert()`.
 * @param id - the group row id.
 * @param fields - extra entry fields such as `name` or `isolate`.
 * @param children - ordered child entries.
 * @returns a group entry.
 */
export function group(id: string, fields: PatchEntry, children: readonly PatchEntry[]): PatchEntry {
  return {
    ...fields,
    id,
    group: true,
    config: children.map((child) => ({ ...child })),
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
