import type { PlanFailure } from '@eedsh/plan'
import type { AuthoringDefect, ResolutionError } from './errors'
import type { PresetDefinitionError } from './preset'
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
export * from './errors'
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
  type ConfigInput,
  DSH_ANCHOR_ENV,
  findResolved,
  PROFILE_ROOT_OVERRIDE_ENV,
  type QueryRoot,
  queryKey,
  queryRootKey,
  type ResolutionOrigin,
  type ResolutionTable,
  type ResolutionTrace,
  type ResolvedBundle,
} from './resolution'
export * from './source'

/**
 * Every expected failure the authoring package can report: its tagged
 * authoring failures and the native plan failure its terminal build can return.
 * Resolution failures are produced by the CLI but keep their identity here.
 */
export type ConfigFailure =
  | ResolutionError
  | PresetDefinitionError
  | SourceDeclarationError
  | PlanFailure

/** The defect authoring misuse reports, distinct from every expected failure. */
export type ConfigDefect = AuthoringDefect
