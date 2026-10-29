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
  ProfilePlan,
} from '@eedsh/plan'
export * from './authoring'
export * from './builders'
export * from './preset'
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
