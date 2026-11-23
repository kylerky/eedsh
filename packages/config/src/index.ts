import type { PlanFailure } from '@eedsh/plan'
import type { PresetDefinitionError } from './preset'
import type { ResolutionError } from './resolve'
import type { SourceDeclarationError } from './source'

export type {
  EedshConfig,
  ExpressionNode,
  GeneratedBundle,
  InvalidConfigValue,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  NamedBundle,
  PlanBundle,
  PlanLayer,
  PlanPatch,
  PlanSource,
  ProfilePlan,
} from '@eedsh/plan'
export * from './authoring'
export * from './bridge'
export * from './builders'
export * from './preset'
export {
  type AuthoringSite,
  type ConfigProvenance,
  clearProvenance,
  configProvenance,
  type PatchGroupProvenance,
} from './provenance'
export * from './query'
export {
  CONFIG_DIR_ENV,
  clearResolutionTrace,
  DSH_ANCHOR_ENV,
  PROFILE_ROOT_OVERRIDE_ENV,
  type QueryRoot,
  ResolutionError,
  type ResolutionErrorCode,
  type ResolutionOrigin,
  type ResolutionTrace,
  type ResolvedBundle,
  resolutionTrace,
  takeResolutionTrace,
} from './resolve'
export * from './source'

/**
 * Every failure the authoring package reports: its own tagged authoring
 * failures plus the native plan failure its terminal build can return.
 */
export type ConfigFailure =
  | ResolutionError
  | PresetDefinitionError
  | SourceDeclarationError
  | PlanFailure
