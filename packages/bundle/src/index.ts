/**
 * `@eedsh/bundle`: build-time TypeScript authoring and DSH-compatible YAML
 * emission for one plugin bundle's Cordis Loader patch. The generated
 * `cordis.patch.yml` is a normal DSH bundle artifact; this package is a
 * development dependency and is never loaded by a profile.
 * @module @eedsh/bundle
 */

export type { BundlePatchCheck } from './artifacts'
export { checkBundlePatch, writeBundlePatch } from './artifacts'
export {
  type BundlePatch,
  BundlePatchBuilder,
  defineBundlePatch,
  type ExpressionNode,
  group,
  type JsonPrimitive,
  type JsonValue,
  js,
  type PatchEntry,
  type PatchTarget,
} from './patch'
export {
  BundlePatchError,
  type BundlePatchIssue,
  type ValidatedBundlePatch,
  validateBundlePatch,
} from './validate'
export {
  BUNDLE_PATCH_HEADER,
  emitBundlePatch,
  emitPatchesYaml,
  loadPatchesYaml,
} from './yaml'
