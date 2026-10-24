## Context

See `proposal.md` for motivation and `specs/typed-profile-layering/spec.md` for the required behavior.

The current package has three plan definitions: hand-written interfaces in `plan/types.ts`, an exported TypeBox schema in `plan/schema.ts` that no runtime code consumes, and a 480-line hand-written validator in `plan/validate.ts` that owns the real contract. `effect@3.22.3` is already a dependency of `@eedsh/cli`, and the CLI imports the Effect index at startup, so adding `effect/Schema` to `@eedsh/config` adds no new runtime cost in the `eedsh sync`/`run` path. `@eedsh/config` is private today, so the dependency change has no external consumer yet.

A prototype against the real plan shape confirmed that an Effect schema can own the shape, the policy rules, and the JSON/expression checks, and that deriving the plan types from the schema works. It also confirmed two limitations that shape this design: the schema's filters are staged (a root refinement does not run when a nested refinement fails), and effect's decode defaults are lenient unless options are passed. Both are handled below rather than hidden.

The prior design treated Effect as a CLI island. This change supersedes that framing: Effect is the default in `@eedsh/config` and `@eedsh/cli`, with plain TypeScript only where the DSH/Cordis lifecycle or the synchronous config-module contract requires it.

## Goals / Non-Goals

**Goals:**

- One public Effect schema that is both the validator and the source of the plan type.
- An Effect-native validation API in `@eedsh/config`: `Either`, a `Data.TaggedError`, and native `ParseResult.ArrayFormatterIssue` values.
- Remove the TypeBox dependency and the hand-written structural validator.
- Replace the 20 `plan.*` codes with located, human-readable messages.
- Keep the plan format, canonical JSON, hashing, generation record, materialization, preflight, and HMR behavior unchanged for valid plans.
- Keep the authoring helpers plain data and keep their useful input types.
- Leave `@eedsh/runtime` plain because DSH/Cordis owns its lifecycle.
- Use Effect-native APIs on every surface this change touches in `@eedsh/cli`.

**Non-Goals:**

- A new package for the schema; the schema lives in `@eedsh/config`.
- Standard Schema or JSON Schema export; deferred.
- Exhaustive diagnostics across independent failure layers.
- Changes to the plan format/version, generation id, materializer, preflight, or HMR.
- Preserving `plan.*` codes, hand-written plan interfaces, or TypeBox-shaped exports.
- Effect services, Layers, or runtime in `@eedsh/config`.
- A full migration of the CLI's config discovery/evaluation, `check`, `watch`, and `run` surfaces to Effect programs; those remain Node/tsx/DSH boundaries and are a separate change.
- Effect in `@eedsh/runtime`.

## Decisions

### 1. Effect-native by default; plain only at explicit boundaries

`@eedsh/config` uses Effect `Schema`, `Either`, `Data.TaggedError`, and `ParseResult` for the plan. `@eedsh/cli` already uses Effect for materialization, and this change uses Effect-native types on the validation and diagnostic surfaces it touches. `@eedsh/runtime` remains a plain Cordis plugin because DSH's HMR service owns its lifecycle. `defineProfile` and `assertPlan` remain synchronous and throw the tagged error because a config module must default-export a plain plan before tsx and DSH can consume it.

*Alternatives considered:* keeping the CLI-only Effect island. Rejected because the validation surface is part of the package contract and the user requested Effect-native packages. Converting the CLI's remaining plain surfaces is a larger, separate change.

### 2. The schema lives in `@eedsh/config` and is the only plan definition

`plan/schema.ts` defines the format/version literals, profile and DSH identity, bundles, layers, patches, and packages, plus the policy and JSON/expression refinements. `ProfilePlan`, `PlanLayer`, `PlanBundle`, `PlanPatch`, and `ExpressionNode` are derived with `Schema.Schema.Type`. `plan/types.ts` keeps only the format/version constants, the authoring JSON primitives, and the Effect-native issue and error types. Format and version constants move to a small `plan/constants.ts` so the schema does not import the type module.

*Alternatives considered:* a separate `@eedsh/plan-schema` package. Rejected because the schema has one consumer and the extra package adds workspace, publishing, and import surface without changing the contract.

### 3. Derive the public plan types; keep authoring input types

The derived plan is readonly and patch payloads are opaque `unknown` values. This is the deliberate breaking change that makes the schema the single type source. The authoring helpers keep their useful input types: `JsonValue`, `JsonObject`, and `PlanEntry` remain for `override`, `insert`, `group`, and `raw`, so authors still get compile-time JSON checks where they can act on them. Helper return types use the derived plan types.

*Alternatives considered:* hand-written `ProfilePlan` plus a transform to make the schema's type match. That preserves mutable and JSON-typed plan properties but duplicates the shape and adds a cast. Rejected for simplicity.

### 4. Policy lives in schema refinements; JSON and expressions use root refinements

Duplicate layer ids/names, the generated-marker count, reserved names, profile/layer/DSH-pin formats, and patch rules are `Schema.filter` refinements on the relevant arrays, strings, and patch objects. A cycle-safe walk in `plan/json.ts` checks functions, symbols, BigInt, undefined, non-finite numbers, circular references, class instances, and expression-node shape; it is invoked by root refinements on the plan schema. Each refinement returns the filter issues for its own rule.

*Alternatives considered:* keep the policy pass and JSON walk outside the schema. That would leave the public schema partial and keep the duplication this change removes. Rejected.

### 5. Decode through a wrapper with strict options

`decodePlan = Schema.decodeUnknownEither(ProfilePlanSchema, { errors: "all", onExcessProperty: "error" })` is the supported decode entry point and returns `Either<ProfilePlan, ParseError>`. The raw schema remains exported for consumers that need it, but the docs state that decoding it directly requires the same options or unknown keys are stripped. A successful decode is passed through `structuredClone` so `defineProfile` keeps returning a detached plan.

*Alternatives considered:* relying on the schema's defaults. They are fail-fast and silently strip unknown fields, which is the wrong contract for a validator. Rejected.

### 6. Use an Effect-native validation result and error

`PlanIssue` is `ParseResult.ArrayFormatterIssue`: it carries Effect's issue tag, a path array, and a message. `PlanValidationError` extends `Data.TaggedError('PlanValidationError')<{ issues: readonly PlanIssue[]; message: string }>`, so it is a real `Error` with a `_tag` and a readable summary. `validatePlan(value)` returns `Either<ProfilePlan, PlanValidationError>`; it maps the left side of `decodePlan` through `ParseResult.ArrayFormatter`, deduplicates identical issues, and clones a successful plan. `assertPlan` throws the tagged error; `defineProfile` keeps its synchronous plain-data contract. The CLI formats the path arrays for humans, so the config package exposes native issue paths rather than a string-path DTO.

Removed: the hand-rolled `PlanValidation` union, a custom `PlanIssue` interface, the hand-written `PlanValidationError` class, string paths in the config API, and all `plan.*` semantic codes.

*Alternatives considered:* keeping the 20 codes and a code adapter (rejected by the user request; it was the largest piece of non-schema machinery); using the raw `ParseError` as the public issue type (rejected because it exposes the full tree instead of the flat located issues); keeping string paths (rejected because native Effect paths are simpler and the CLI already owns presentation).

### 7. Accept non-exhaustive diagnostics

When a plan has several independent failures, the schema may report only the failures from the first failing refinement layer; the root JSON/expression refinements are skipped once a nested refinement fails. The plan is still rejected, and every reported issue has a location and message. Exhaustiveness is not a requirement. A pre-pass that runs the JSON walk before decoding would restore exhaustive reporting, but it would split validation across two paths and make the schema no longer the validator.

*Alternatives considered:* a `validatePlan` pre-pass over the raw value. Rejected for simplicity; revisit only if users report the staged behavior as a problem.

### 8. Effect is a peer dependency of `@eedsh/config`

`effect` is added as a peer dependency plus a dev dependency at the same exact version as `@eedsh/cli`. The workspace resolves it through the CLI; future external consumers install their own copy. This avoids two Effect copies and incompatible `Schema` type identities when the package is published. `@sinclair/typebox` is removed. The architecture test allows `@eedsh/config` to import `effect/Schema`, `effect/Either`, `effect/ParseResult`, and `effect/Data`, keeps `@eedsh/runtime` Effect-free, and asserts the config and CLI Effect versions match.

*Alternatives considered:* a regular dependency. Simpler while private, but wrong once the public schema is published, because type identity depends on a single Effect instance. The private-package period is not long enough to justify a later migration.

### 9. Public API changes are explicit

Removed: `ProfilePlanSchemaType`, TypeBox-shaped schema exports, `PlanIssue.code`, the `PlanValidation` union, the hand-written `PlanValidationError` class, and the unused `isJsonObject` helper. Changed: `ProfilePlan`, `PlanLayer`, `PlanBundle`, and `PlanPatch` are derived and readonly; `validatePlan` returns `Either<ProfilePlan, PlanValidationError>`; `PlanValidationError` is a tagged error; `PlanIssue` is the Effect issue type. Added: `decodePlan`. Kept: `defineProfile`, the patch helpers, `validatePlan`, `assertPlan`, `PlanValidationError`, `RESERVED_NAMES`, `PLAN_FORMAT`, `PLAN_VERSION`, `canonicalJson`, and `hashPlan`.

`defineProfile` and `assertPlan` remain synchronous and throw `PlanValidationError`; this is the config-module/DSH boundary. `validatePlan` and `decodePlan` are the Effect-native entry points for frontends and the CLI.

### 10. Tests target the schema as the contract

Config tests decode through `decodePlan` and assert rejection, issue tags, path arrays, and messages. `validatePlan` tests assert the `Either` shape, the tagged error, deduplication, and detached output. `defineProfile` tests assert the synchronous throw. The published README example remains a valid plan. A fixture plan is compared before and after for canonical JSON and hash equality to prove valid plans do not change. Type-level tests assert the derived readonly/opaque plan shape. CLI tests assert the formatted `path: message` output and the absence of `plan.*` codes. The architecture test asserts the new boundary. There is no differential test for codes because codes no longer exist.

### 11. Documentation describes the new boundary

Root README, `packages/config/README.md`, and `packages/cli/README.md` are updated: Effect is the default in config and the CLI, the public plan schema is Effect-based, the validation API is `Either`/tagged-error native, the authoring entry point remains synchronous at the DSH/config-module boundary, and `@eedsh/runtime` stays a plain Cordis plugin. The completed `add-typed-profile-layer-api` design is superseded by this change; do not rewrite its completed task records.

## Risks / Trade-offs

- **Effect-native public API requires consumers to have Effect** -> the package already exposes an Effect Schema, so the dependency is part of the public contract; `effect` is a peer dependency.
- **Synchronous authoring exception** -> `defineProfile`/`assertPlan` throw instead of returning `Either`; documented as the config-module/DSH loading boundary. `validatePlan` is the Effect-native entry point.
- **Non-exhaustive diagnostics** -> documented behavior; the plan is still rejected; users fix reported issues and rerun. Revisit with a pre-pass only if this proves painful.
- **Generic structural messages** -> native issue paths and messages identify the location; tests assert paths and message substrings, not exact prose. Some messages may be less specific than the old hand-written ones.
- **Direct schema decode defaults strip unknown fields** -> `decodePlan` is the documented entry point and passes strict options; tests cover both the wrapper and the raw-schema caveat.
- **Derived readonly/opaque plan types** -> breaking change; CLI and tests compile against the derived types; docs show the new shape. `raw`, `override`, `insert`, `group`, and `layer` keep authoring input checks.
- **Array issue paths are arrays at the config boundary** -> the CLI formats them for people; consumers get native Effect paths and can format them however they need.
- **Patch rules and the JSON walk remain hand-written refinements** -> keep them in small helpers, test paths, and avoid duplicating logic; the schema is still the validator.
- **Effect peer version drift** -> exact peer and dev versions; architecture test asserts config and CLI agree; workspace dedupes.
- **Full CLI Effect migration is deferred** -> the CLI's config discovery/evaluation, `check`, `watch`, and `run` remain Node/tsx/DSH boundaries in this change; a separate change can migrate them.
- **Archive ordering** -> `add-typed-profile-layer-api` must be archived first so `typed-profile-layering` exists; the proposal and migration plan state this.
- **Plan output drift** -> `structuredClone` and strict decoding preserve the validated plan; a canonical JSON/hash test guards valid fixtures. Invalid plans are rejected earlier or with different messages, which is intended.

## Migration Plan

1. Archive `add-typed-profile-layer-api` (and the completed `adopt-tsx-and-check-command` change if the archive order requires it) so `openspec/specs/typed-profile-layering/spec.md` exists. Verify with `openspec show typed-profile-layering --type spec`.
2. Add `effect` to `@eedsh/config`, remove TypeBox, and rewrite `plan/schema.ts`, `plan/json.ts`, `plan/validate.ts`, `plan/types.ts`, and the helper types in `plan/api.ts` around `Either`, the tagged error, and native issue paths.
3. Update `loadConfig` in the CLI to consume the `Either` result, update `describeError` to format issue paths and the tagged error, and fix the type-only ripple. Keep the CLI's Node/tsx/DSH boundaries unchanged.
4. Update config/CLI tests, the architecture test, the READMEs, and the lockfile.
5. Run `pnpm verify`; compare a fixture plan's canonical JSON and hash before/after; run `eedsh sync` against a temporary profile to confirm the CLI output and publication path.
6. Archive this change after the implementation change is complete.

Rollback is a revert: restore the TypeBox dependency and the previous validator. Published profiles are unaffected because the plan format, canonical JSON, and generation record do not change for valid plans.

## Open Questions

- Whether to add a Standard Schema wrapper or a generated JSON Schema later. Deferred; it would be additive and does not change the schema or validation contract.
- Whether to migrate the CLI's remaining plain surfaces to Effect in a separate change. Deferred by design; out of scope for this change.
