> **Archive prerequisite:** before archiving this change, archive `add-typed-profile-layer-api` so `openspec/specs/typed-profile-layering/spec.md` exists. Verify with `openspec show typed-profile-layering --type spec`. Implementation can proceed before the archive; only this change's archive depends on it.

> **Archive status:** checked after implementation on 2026-10-20. `openspec show typed-profile-layering --type spec` fails (`Spec 'typed-profile-layering' not found`): `add-typed-profile-layer-api` is complete but not archived, so this change cannot be archived yet.

## 1. Baseline and package

- [x] 1.1 Record the current canonical JSON and hash for the plan produced by `packages/cli/test/fixtures/readme/eedsh.config.ts`, add `packages/config/test/plan/hash-parity.test.ts` asserting the recorded digest, and verify the test passes with the current validator.
- [x] 1.2 Add failing tests in `packages/config/test/plan/schema.test.ts` for a valid plan decoding, wrong field types, unknown plan fields, and missing required fields; verify the tests fail before implementation.
- [x] 1.3 Add `effect` to `packages/config/package.json` as peer and dev dependencies at 3.22.3, remove `@sinclair/typebox`, run `pnpm install`, and verify `pnpm-lock.yaml` no longer records a TypeBox importer and does record the config Effect dependency.
- [x] 1.4 Create `packages/config/src/plan/constants.ts` for `PLAN_FORMAT` and `PLAN_VERSION`, update `types.ts`, `schema.ts`, and imports to use it, and verify `pnpm --filter @eedsh/config typecheck` passes.
- [x] 1.5 Replace the TypeBox schema in `packages/config/src/plan/schema.ts` with the Effect structural schema (format/version literals, profile, DSH pin, bundles, layers, patches, packages) and derive `ProfilePlan`, `PlanLayer`, `PlanBundle`, `PlanPatch`, and `ExpressionNode`; verify the structural tests from 1.2 pass.
- [x] 1.6 Immediately use git to commit the dependency, constants, and structural schema changes excluding openspec artifacts; verify `git status --short` shows no uncommitted implementation files.

## 2. Policy and JSON refinements

- [x] 2.1 Add failing tests in `packages/config/test/plan/schema.test.ts` for safe and unsafe profile names, exact DSH pins, empty, unsafe, and duplicate layer ids, duplicate bundle names, multiple generated markers, reserved bundle and package names, and patch rules including insert entries and group/name/disabled fields; verify the tests fail.
- [x] 2.2 Implement the policy refinements in `plan/schema.ts` for identity, naming, duplicates, marker count, reserved names, and patch rules; verify the 2.1 tests pass and each failure path points at the offending id, name, marker, or patch.
- [x] 2.3 Add failing tests for function, symbol, BigInt, undefined, non-finite number, circular reference, class instance, and malformed expression-node values; verify the tests fail.
- [x] 2.4 Add `packages/config/src/plan/json.ts` with the cycle-safe JSON and expression walk and attach it as root refinements on the plan schema; verify the 2.3 tests pass with the expected paths such as `layers[0].patches[0].config.fn`.
- [x] 2.5 Immediately use git to commit the policy and JSON refinements excluding openspec artifacts; verify `git status --short` shows no uncommitted implementation files.

## 3. Derived types, public API, and Effect-native validation

- [x] 3.1 Add failing tests in `packages/config/test/plan/` for `validatePlan` returning `Either`, the left side being a tagged `PlanValidationError` with `ParseResult.ArrayFormatterIssue` values (issue tag, path array, message), no `code` field, deduplicated issues, a detached right-side plan, an empty path array for a root failure, and `defineProfile` throwing the tagged error synchronously; verify the tests fail.
- [x] 3.2 Update `packages/config/src/plan/types.ts` to define `PlanIssue` as `ParseResult.ArrayFormatterIssue`, define `PlanValidationError` with `Data.TaggedError`, remove `PlanValidation`, `ProfilePlanSchemaType`, and `isJsonObject`, and add a type-level test under `packages/config/test/plan/types.test.ts` proving the plan is readonly and patch payloads are opaque; verify `pnpm typecheck` reports the expected `@ts-expect-error` assertions.
- [x] 3.3 Implement `decodePlan` with `{ errors: "all", onExcessProperty: "error" }` returning `Either<ProfilePlan, ParseError>`, and `validatePlan` mapping the left side through `ParseResult.ArrayFormatter` into a `PlanValidationError` with deduplicated issues and a message summary, plus `structuredClone` on the right side in `plan/validate.ts`; make `assertPlan` throw the tagged error while `defineProfile` stays synchronous; verify the 3.1 tests pass.
- [x] 3.4 Update `packages/config/src/plan/api.ts` so helpers return the derived types while `override`, `insert`, `group`, and `raw` keep their JSON authoring inputs, and update `packages/config/src/index.ts` to export `decodePlan`, `PlanIssue`, `PlanValidationError`, and the derived types while removing the TypeBox-shaped exports; verify `packages/config/test/api.test.ts` and `test/smoke.test.ts` pass.
- [x] 3.5 Run `pnpm --filter @eedsh/config typecheck` and `pnpm --filter @eedsh/config test`; verify both pass, `validatePlan` returns `Either`, and no test asserts a `plan.*` code.
- [x] 3.6 Immediately use git to commit the derived types, Effect-native validation, and public API changes excluding openspec artifacts; verify `git status --short` shows no uncommitted implementation files.

## 4. CLI diagnostics and type ripple

- [x] 4.1 Update the CLI tests in `packages/cli/test/cli.test.ts` to assert `path: message` output, no `plan.*` code, a root-level `plan: message` case, and the tagged validation error path; verify the tests fail against the current renderer.
- [x] 4.2 Update `loadConfig` in `packages/cli/src/config.ts` to consume the `Either` result and throw the tagged error, update `describeError` in `packages/cli/src/cli.ts` to format `ParseResult.ArrayFormatterIssue` path arrays and handle the tagged error, update the `PlanInvalid` branch and `packages/cli/test/internal/effect.test.ts` for the new issue shape; verify the 4.1 tests pass.
- [x] 4.3 Fix type-only ripples in `packages/cli/src`, `packages/cli/test`, and fixtures caused by readonly plan properties and opaque patch payloads; verify `pnpm typecheck` and `pnpm --filter @eedsh/cli test` pass.
- [x] 4.4 Immediately use git to commit the CLI diagnostics, validation-result handling, and type changes excluding openspec artifacts; verify `git status --short` shows no uncommitted implementation files.

## 5. Boundary, docs, and final verification

- [x] 5.1 Update `test/architecture.test.ts` so `@eedsh/config` may import `effect/Schema`, `effect/Either`, `effect/ParseResult`, and `effect/Data`, `@eedsh/runtime` remains Effect-free, `@eedsh/cli` keeps its Effect dependency, and the config and CLI Effect versions match; verify `pnpm test test/architecture.test.ts` passes, including the runtime no-Effect assertion.
- [x] 5.2 Update `README.md`, `packages/config/README.md`, and `packages/cli/README.md` for the public Effect schema, the `Either`/tagged-error validation API, native issue paths, the synchronous `defineProfile` boundary, readonly plan types, no `plan.*` codes, and the Effect-native default; verify each documented import and command matches the implementation, no README claims config has no Effect dependency, and no README describes Effect as a CLI-only island.
- [x] 5.3 Run `pnpm verify`; verify Biome, typecheck, tests, and build all pass, and the 1.1 hash-parity test still passes.
- [x] 5.4 Run an end-to-end `eedsh sync` against a temporary profile using `packages/cli/test/fixtures/basic/eedsh.config.ts`; verify the command exits 0, publishes the expected generated files, and prints no `plan.*` code on the invalid fixture.
- [x] 5.5 Confirm the archive prerequisite from the note above: `openspec show typed-profile-layering --type spec` succeeds after `add-typed-profile-layer-api` is archived; if it does not, record that this change cannot be archived yet.
- [x] 5.6 Immediately use git to commit the boundary, documentation, and parity changes excluding openspec artifacts; verify `git status --short` shows no uncommitted implementation files.