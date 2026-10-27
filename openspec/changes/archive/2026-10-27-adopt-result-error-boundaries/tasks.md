## 1. Result authoring and config export support

- [x] 1.1 Add failing config tests that assert `defineProfile` returns a success Result for conforming input, a failure Result for invalid input, and that `assertPlan` is not exported; run `pnpm vitest run packages/config/test` and confirm the new expectations fail.
- [x] 1.2 Add failing CLI tests for configs that export a success Result, a plain plan, a failure Result, a forged success Result, and an authoring failure raised during module evaluation; run the targeted `packages/cli/test` cases and confirm they fail for the expected reasons.
- [x] 1.3 Implement `defineProfile` as a synchronous `Result` return, remove `assertPlan`, and update the config package JSDoc; run `pnpm vitest run packages/config/test` and confirm the config suite passes.
- [x] 1.4 Implement loader support for plain and Result exports, revalidate a successful Result, surface a `SchemaError` failure natively, and stop wrapping an authoring `SchemaError` as `config.import_failed`; run the targeted CLI config-export tests and confirm they pass.
- [x] 1.5 Update every direct `defineProfile` consumer in tests, fixtures, the CJS fixture, and `test/smoke.test.ts` to unwrap the Result; verify with `pnpm typecheck` and `pnpm test`.
- [x] 1.6 Update the README authoring example and invalid-plan prose to say `defineProfile` returns a Result and the loader accepts a plan or a Result; verify the README example test passes.
- [x] 1.7 Immediately use git to commit the config, CLI loader, test, fixture, and README changes, excluding `openspec/changes/adopt-result-error-boundaries`.

## 2. Error taxonomy and synchronous leaves

- [x] 2.1 Add failing tests for a tagged `ConfigError`, config-path validation as a `Result`, generated-layer parsing as a `Result`, and DSH installation/bundle resolution as a `Result`; run the relevant config, preflight, and dsh tests and confirm they fail.
- [x] 2.2 Add failing `check` tests that distinguish infrastructure failures (`check.tsconfig_missing`, `check.typescript_missing`, `check.config_not_in_project`) from a compiler nonzero exit code; verify the expected failures.
- [x] 2.3 Convert `ConfigError` to a tagged error, add `CheckFailure` and `SpawnFailure`, and update the reporter to match by tag, native schema error, and platform error shape; run the diagnostic tests and confirm they pass.
- [x] 2.4 Implement `validateConfigPath` as a `Result`, `parseGeneratedLayers` as a `Result`, and DSH resolution as a `Result`, lifting them with `Effect.fromResult` where needed; update all call sites and run `pnpm vitest run packages/cli/test/materialize packages/cli/test/cli.test.ts`.
- [x] 2.5 Convert the synchronous `check` resolution, manifest read, and realpath fallback helpers to `Result.try` while preserving the existing `check.*` codes; run the `eedsh check` tests and confirm they pass.
- [x] 2.6 Immediately use git to commit the taxonomy, config-path, preflight, DSH, and check-helper changes, excluding `openspec/changes/adopt-result-error-boundaries`.

## 3. One CLI runner

- [x] 3.1 Add failing CLI tests for a `loadConfig` Effect seam, exactly one diagnostic per typed failure, a defect thrown by service-layer construction, `check` returning exit 2, `run` returning exit 7, and a normal watch stop returning 0; verify the new tests fail.
- [x] 3.2 Convert `loadConfig` to `Effect<ProfilePlan, ConfigError | Schema.SchemaError>`, including `Effect.try` for the stat, `Effect.tryPromise` for the import, and `Effect.fromResult` for validation; remove the JavaScript catch from the tsx loader memo by storing a `Promise<Result>`; run the config-loading tests and confirm they pass.
- [x] 3.3 Convert the sync, run, check, and watch command functions to Effects and make `runEedsh` execute the program through one `Effect.runPromiseExit`; remove the run-boundary catches and the `Effect.promise` command wrappers; verify the command tests.
- [x] 3.4 Convert `runCheck` to `Effect<number, CheckFailure>` with `capture` and `runInherited` adapted through `Effect.tryPromise`, preserving compiler exit-code forwarding; verify the `eedsh check` suite.
- [x] 3.5 Convert `runBoot` and the watch loop to Effects, keep the `SpawnLike` and watcher seams as adapted Promise/event APIs, and preserve the `--explain` preflight hint through the single renderer; run `pnpm vitest run packages/cli/test/cli.test.ts` and confirm it passes.
- [x] 3.6 Run `pnpm typecheck` and the full test suite, then immediately use git to commit the runner, seam, check, boot, and watch changes, excluding `openspec/changes/adopt-result-error-boundaries`.

## 4. Remaining adapters and utilities

- [x] 4.1 Add or adjust failing tests for POSIX lock retry/cleanup, Windows native-load failure cleanup, atomic-write cleanup, profile JSON parse failure, and watcher close failure; run the internal and materialize suites and confirm the expectations.
- [x] 4.2 Replace the remaining POSIX stat/close catches with `Effect.tryPromise`/`Effect.ignore` or a `Result`-memoized adapter, convert the Windows ignore helpers to `Effect.try(...).pipe(Effect.ignore)`, and convert the profile JSON read to `Effect.try`; verify the lock, atomic-write, and materialize tests.
- [x] 4.3 Convert the safe error stringification, version read, and runtime link resolution to `Result.try` or `Effect.try` with explicit fallbacks; run the CLI failure-reporting tests.
- [x] 4.4 Immediately use git to commit the adapter and utility changes, excluding `openspec/changes/adopt-result-error-boundaries`.

## 5. Enforcement, documentation, and verification

- [x] 5.1 Add a failing architecture test that scans `packages/config/src` and `packages/cli/src` for JavaScript `throw`, `try`, and `.catch(` and fails on any new occurrence; include a scanner test that proves a synthetic throw is rejected and that the allowlist permits `materialize/yaml.ts` and remaining native adapters.
- [x] 5.2 Update the README Effect-boundaries and failure sections with the single-Exit model, the `Result` authoring contract, the loader export forms, and the allowlist; update `@throws` JSDoc and verify `pnpm check` plus the README example test.
- [x] 5.3 Run `pnpm verify` and confirm typecheck, lint, tests, and all package builds pass.
- [x] 5.4 Run `pnpm test:slow` and confirm the built-CLI, integration, and HMR checks pass.
- [x] 5.5 Run `openspec validate adopt-result-error-boundaries --strict` and confirm the change is valid.
- [x] 5.6 Immediately use git to commit the architecture test, documentation, and final fixes, excluding `openspec/changes/adopt-result-error-boundaries`.
