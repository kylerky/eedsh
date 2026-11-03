/**
 * The patch-entry YAML dialect used by generated layers. It is a vendored
 * version of DSH's `!!js` Loader convention: a scalar tagged
 * `tag:yaml.org,2002:js` becomes `{ __jsExpr: string }`.
 * @module @eedsh/cli/materialize/yaml-schema
 */
import * as yaml from 'js-yaml'

/** One Loader patch entry, opaque to the CLI. */
export interface PatchOptions {
  id?: string
  insert?: Record<string, unknown>[]
  name?: string
  config?: unknown
  group?: boolean | null
  disabled?: boolean | null
  [key: string]: unknown
}

/** Whether a value is a serialized Loader JavaScript expression. */
export function isJsExpr(value: unknown): value is { __jsExpr: string } {
  return value instanceof Object && '__jsExpr' in value
}

const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data as string }),
  predicate: (data) => isJsExpr(data),
  represent: (data) => (data as { __jsExpr: string }).__jsExpr,
})

/** The entry-list YAML dialect: JSON values plus `!!js` expression scalars. */
export const entryListSchema: yaml.Schema = yaml.JSON_SCHEMA.extend(JsExpr)
