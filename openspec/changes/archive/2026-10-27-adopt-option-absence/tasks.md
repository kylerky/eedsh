## 1. Baseline and Schema leaf readers

- [x] 1.1 Review the current working tree with `git status --short` and `git diff --stat`, then run `pnpm test`; verify the suite exits 0 and record the baseline.
- [x] 1.2 Update `packages/cli/test/internal/schema-readers.test.ts` to expect `Option.none()` and `Option.some(...)` for `readOptionalString`, `readVersion`, and both `readLockfileEntry` fields, covering missing, wrong, empty, and partial values. Run `pnpm vitest run packages/cli/test/internal/schema-readers.test.ts`; verify it fails because the readers still return plain values.
- [x] 1.3 Convert `packages/cli/src/internal/schema-readers.ts` to return `Option`: `readOptionalString` decodes `Schema.String` directly, `readVersion` drops its fallback parameter, and `readLockfileEntry` exposes required Option fields. Update the lockfile checks in `packages/cli/src/doctor.ts` to `Option.isSome`, and the version fallbacks in `check.ts`, `dsh.ts`, and `cli.ts` to `Option.getOrElse`. Run the schema-reader, doctor, CLI, and DSH suites; verify all pass.
- [x] 1.4 Run `pnpm typecheck` and the focused suites again, then commit only the schema-reader and version-call-site changes with path-scoped git commands; verify `git show --stat` lists no `openspec/` paths and no unrelated files.

## 2. Optional files and manifest domain types

- [x] 2.1 Add `packages/cli/test/internal/read-optional.test.ts` asserting `Option.some` for an existing file and `Option.none` for a missing file. Update the `reconcileManifest` helper in `packages/cli/test/materialize/profile.test.ts` to pass `Option.none()`/`Option.some(...)` for `manifest` and `previous`. Run the read-optional and profile suites; verify they fail against the current plain-value contracts.
- [x] 2.2 Convert `packages/cli/src/internal/read-optional.ts` to `Effect<Option<string>, PlatformError>`. Adapt `ProfileSnapshot` and `restoreFile` in `packages/cli/src/materialize/publish.ts`, and the `readOptional` branches in `packages/cli/src/doctor.ts`, to `Option` without changing behavior. Run the publish and doctor suites; verify they pass.
- [x] 2.3 Convert `readJsonFile` in `packages/cli/src/materialize/program.ts` to `Effect<Option<Record<string, unknown>>, PlatformError>`, and convert `ReconcileManifestInput.manifest`/`.previous`, `readProfileBundles`, `readProfileDependencies`, `declaredDependencyNames`, `hasManagedBundles`, `scanDependencyConflicts`, and `CleanedDependencySections` in `manifest.ts` to required Option values. Update every `reconcileManifest` call site, including the publication test fixture. Run the profile and program suites; verify they pass.
- [x] 2.4 Convert `PublishProfileInput.previousManifest` and its publication checks in `packages/cli/src/materialize/publish.ts` to required `Option`, and update `publish.test.ts` accordingly. Run the publish suite; verify it passes.
- [x] 2.5 Run `pnpm typecheck` and the profile, program, publish, and doctor suites, then commit only these file and JSON-domain changes with path-scoped git commands; verify `git show --stat` lists no `openspec/` paths.

## 3. Config, check, and CLI command inputs

- [x] 3.1 Add tests for `findConfigPath` and `findUnsupportedConfigPath` in `packages/cli/test/config.test.ts`, and for `findTsconfigPath` and `resolveTypeScript` in a new or existing check test. Assert `Option.some` when a supported path or installation exists and `Option.none` when it does not. Run `pnpm vitest run packages/cli/test/config.test.ts <check-test>`; verify the new cases fail against the current return types.
- [x] 3.2 Convert `findConfigPath`, `findUnsupportedConfigPath`, `findTsconfigPath`, `resolveTypeScript`, and `readPackageBin` to `Option`, and convert `resolveConfigPath` plus the CLI command input fields (`configPath`, `profile`) to `Option` so `effect/cli` flags flow through without early `Option.getOrUndefined`. Convert the DSH bundle lookup to `Option.fromUndefinedOr`. Run the config, CLI, command-surface, check, and DSH suites; verify they pass.
- [x] 3.3 Run `pnpm typecheck` and the focused suites again, then commit only the config/check/CLI changes with path-scoped git commands; verify `git show --stat` lists no `openspec/` paths.

## 4. Doctor findings and lockfile domain

- [x] 4.1 Update `packages/cli/test/doctor.test.ts` so finding paths and lockfile-entry expectations use `Option.some`/`Option.none`, and add a no-path finding assertion. Run `pnpm vitest run packages/cli/test/doctor.test.ts`; verify it fails against the current optional-property shape.
- [x] 4.2 Convert `DoctorFinding.path`, `errorFinding`, `warningFinding`, finding comparison/formatting, doctor's generation/plan/lockfile returns, `resolvedVersion`, and the remaining lockfile version checks in `packages/cli/src/doctor.ts` to `Option`. Preserve the same findings, messages, ordering, and exit codes. Run the doctor and integration-doctor suites; verify they pass.
- [x] 4.3 Run `pnpm typecheck` and the doctor suites, then commit only the doctor changes with path-scoped git commands; verify `git show --stat` lists no `openspec/` paths.

## 5. Boundary audit, documentation, and final verification

- [x] 5.1 Run `grep -RInE '\| undefined|\?:|return undefined|=== undefined|!== undefined' packages/cli/src` and confirm every remaining match is an allowed JS/JSON/environment/third-party edge, internal mutable state, or a multi-state ADT. Replace any missed domain absence with `Option` and run `pnpm typecheck`; verify it exits 0.
- [x] 5.2 Update the Effect-boundaries note in `README.md` to state that CLI domain absence uses `Option`, while `undefined` remains at JS/JSON/environment/third-party edges and the config walker and Effect-free runtime remain exceptions. Verify the text names the convention and the allowed `undefined` edges.
- [x] 5.3 Run `openspec validate adopt-option-absence --strict`, `pnpm check`, and `pnpm test`; verify all three exit 0 and the change reports specs skipped.
- [x] 5.4 Commit the README and any remaining non-openspec changes with path-scoped git commands; verify `git show --stat` lists no `openspec/` paths and the working tree has no unrelated tracked changes.
