## Why

The profile plan is defined three times: hand-written types in `types.ts`, an unused TypeBox schema in `schema.ts`, and a 480-line validator in `validate.ts`. The exported schema is weaker than the validator, so another frontend validating with it accepts plans that `eedsh` rejects. Effect is already the CLI's runtime; the packages should be Effect-native by default, with plain TypeScript only at the DSH/Cordis and synchronous config-module boundaries. Using Effect Schema as the single public schema, validator, and plan type source removes the duplication and the dead TypeBox dependency, and brings the validation surface in line with that default.

## What Changes

- Replace TypeBox with Effect Schema in `@eedsh/config`; remove `@sinclair/typebox` and add `effect` as a peer dependency plus a dev dependency.
- Make `ProfilePlanSchema` the validator: it enforces the plan shape, identity and naming rules, duplicate ids and names, marker count, reserved names, patch rules, JSON compatibility (functions, symbols, BigInt, undefined, non-finite numbers, circular references, class instances), and expression-node shape.
- Derive `ProfilePlan`, `PlanLayer`, `PlanBundle`, and `PlanPatch` from the schema. **BREAKING** plan types become readonly and patch payloads become opaque `unknown` values.
- Adopt Effect-native validation APIs. `validatePlan` returns `Either<ProfilePlan, PlanValidationError>`; `PlanValidationError` is a `Data.TaggedError`; issues are `ParseResult.ArrayFormatterIssue` values carrying the Effect issue tag, a path array, and a message. `decodePlan` returns `Either<ProfilePlan, ParseError>`.
- **BREAKING** Drop the 20 `plan.*` error codes and any semantic error code from an issue. `PlanValidationError.issues` and `validatePlan` expose located issues, and the CLI prints `path: message` instead of `code at path: message`.
- Keep the authoring entry points synchronous: `defineProfile` and `assertPlan` return a plain plan or throw the tagged `PlanValidationError`. A config module must default-export plain data, so this is the deliberate DSH/config-module boundary in an otherwise Effect-native package.
- **BREAKING** Validation may report only the first failing refinement layer when a plan has several independent problems; the plan is still rejected.
- Make Effect the default boundary: `@eedsh/config` and `@eedsh/cli` use Effect-native APIs, `@eedsh/runtime` stays a plain Cordis plugin because DSH HMR owns its lifecycle, and a full migration of the CLI's config discovery, evaluation, `check`, `watch`, and `run` surfaces is out of scope for this change.
- Update the architecture boundary so `@eedsh/config` may use `effect/Schema`, `effect/Either`, `effect/ParseResult`, and `effect/Data`, while `@eedsh/runtime` remains Effect-free.
- Update the README, package READMEs, and the architecture test, and supersede the prior design's TypeBox and Effect-island claims in this change's design.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `typed-profile-layering`: plan validation is implemented by a public Effect schema and an Effect-native validation API (`Either` plus a tagged error); the plan types are derived from the schema; validation reports located issues instead of stable `plan.*` codes.

## Impact

- **`packages/config`**: `plan/schema.ts` becomes the Effect schema and rules, `plan/validate.ts` returns `Either` and a tagged error, `plan/types.ts` keeps only constants, authoring JSON primitives, and the Effect-native issue/error types, and `plan/api.ts` and `package.json` follow the derived types and the Effect dependency.
- **`packages/cli`**: plan type usages follow the derived readonly types; `describeError` formats the native issue paths and handles the tagged validation error; `loadConfig` consumes the `Either` result. Materialization, preflight, publication, and HMR are unchanged, and the remaining plain CLI surfaces are not migrated in this change.
- **Tests**: config validation and API suites are rewritten around the schema, `Either`, and the tagged error; CLI error assertions and architecture tests are updated; remaining CLI fixtures and tests take type-only changes.
- **Docs**: root `README.md`, `packages/config/README.md`, and `packages/cli/README.md` are updated; the prior OpenSpec design/proposal claims about TypeBox and the Effect island are superseded by this change.
- **Dependencies**: `@sinclair/typebox` leaves the workspace; `effect` is added as a peer and dev dependency of `@eedsh/config`, and the lockfile is updated.
- **Unchanged**: plan format and version, canonical JSON and hashing, generation record, materializer, preflight, HMR, CLI commands, and the plain `@eedsh/runtime` plugin.
- **Sequencing**: `add-typed-profile-layer-api` must be archived first so the `typed-profile-layering` main spec exists before this change is archived.
