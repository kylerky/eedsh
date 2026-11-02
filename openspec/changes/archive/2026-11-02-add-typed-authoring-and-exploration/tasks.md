## 1. Typed authoring foundations

- [x] 1.1 Add failing tests in `packages/config/test/authoring-objects.test.ts` for branded `.toJSON()` objects, rooted-query rejection as a plan selection, typed rows/presets, and structured query failures; run `pnpm vitest run packages/config/test/authoring-objects.test.ts` and verify the tests fail because the typed model does not exist yet.
- [x] 1.2 Implement the authoring brand, the `.toJSON()` protocol, and normalization helpers in `packages/config/src`; verify the normalization tests pass and `@eedsh/plan` still rejects a class instance in a plan position.
- [x] 1.3 Implement `Bundle` and `BundleQuery` with pinned, profile, and package-directory roots plus `.rows()`, `.presets()`, `.row()`, `.preset()`, `.version()`, `.packageDir()`, and `.origin()`; verify the bundle tests pass, including passing `selectedProfile` to `.fromProfile()` and rejecting a rooted handle as a plan selection.
- [x] 1.4 Implement immutable `Row` and `Preset` handles and the mutable `LayerBuilder` patch methods, with `js()` and `group()` kept as value constructors and `raw()` moved onto the layer; verify the row, preset, layer, and patch tests pass.
- [x] 1.5 Extend the documented author-time exception allowlist in `test/architecture.test.ts` for the new query module and update the `@eedsh/config` public-export assertions; verify `pnpm vitest run test/architecture.test.ts` passes.
- [x] 1.6 Immediately use git to commit the typed authoring foundations excluding openspec artifacts; verify the commit does not include `openspec/`.

## 2. Fluent config builder and validation contract

- [x] 2.1 Add failing tests in `packages/config/test/config.test.ts` for `defineConfig().dsh().defaultProfile().profile().build()`, callback-scoped profiles and layers, missing pin and missing profile failures, and the absence of the free helpers; verify the new tests fail.
- [x] 2.2 Implement `ConfigBuilder` and `ProfileBuilder` with mutable single-use chain methods and `.build()` returning `Result<EedshConfig, Schema.SchemaError>`; verify the builder and normalization tests pass.
- [x] 2.3 Remove `defineProfile` and the free query and patch helpers from `packages/config/src/api.ts`, `config.ts`, and `index.ts`; update the public-export and `test/smoke.test.ts` assertions and verify they pass.
- [x] 2.4 Update `packages/config/test/api.test.ts` and `packages/config/test/resolve.test.ts` to the typed API; verify `pnpm vitest run packages/config/test` passes.
- [x] 2.5 Immediately use git to commit the fluent builder excluding openspec artifacts; verify the commit does not include `openspec/`.

## 3. CLI config loading and project migration

- [x] 3.1 Add failing loader tests in `packages/cli/test/config.test.ts` for a fluently built Result config, a plain config value, and a rejected lone profile plan; verify the tests fail only where the loader contract needs updating.
- [x] 3.2 Update the CLI config boundary if needed and verify `pnpm vitest run packages/cli/test/config.test.ts` passes.
- [x] 3.3 Migrate `packages/cli/test/fixtures/*/config.ts` and the init fixture to the fluent API; verify `pnpm vitest run packages/cli/test/config.test.ts packages/cli/test/init.test.ts` passes.
- [x] 3.4 Update the `eedsh init` template in `packages/cli/src/init.ts` to emit a fluent config; verify `pnpm vitest run packages/cli/test/init.test.ts` and load the generated config in a test.
- [x] 3.5 Update the README TypeScript example blocks consumed by `test/support/readme.ts`; verify the README example test passes.
- [x] 3.6 Immediately use git to commit the CLI and fixture migration excluding openspec artifacts; verify the commit does not include `openspec/`.

## 4. REPL typed bindings and profile selection

- [x] 4.1 Add failing tests in `packages/cli/test/repl/session.test.ts` for `config`, `selectedProfile`, and `plan`; the absence of the `profile` string and raw `profiles` map; `.profile` switching, unknown-profile handling, no re-import, help/banner text, and the binding-collision guard; verify the new tests fail.
- [x] 4.2 Implement `ConfigView` and `ProfileView` construction and bind them from `packages/cli/src/repl/session.ts`, updating `bind()`, `loadAndSelect()`, and `reload()`; verify the binding tests pass.
- [x] 4.3 Implement `.profile <name>` in the command registry, select from the already loaded config, and update `selectedProfile` and `plan` without re-importing; verify switch, unknown-profile, and no-re-import tests pass.
- [x] 4.4 Replace the undifferentiated `Object.assign` with an explicit binding table and a collision assertion; verify a test with an injected colliding export fails loudly and the normal session passes.
- [x] 4.5 Update `packages/cli/test/repl/command.test.ts`, `integration.test.ts`, and other REPL assertions for the new bindings and fluent queries; verify `pnpm vitest run packages/cli/test/repl` passes.
- [x] 4.6 Immediately use git to commit the REPL bindings excluding openspec artifacts; verify the commit does not include `openspec/`.

## 5. Chain-aware completion

- [x] 5.1 Add failing pure completion tests in `packages/cli/test/repl/completion.test.ts` for command names, `.sync on|off`, `.profile` arguments, chain methods, profile/bundle/row/preset/package arguments, rooted-state filtering, and error containment; verify the new tests fail.
- [x] 5.2 Implement the pure completion engine in `packages/cli/src/repl/completion.ts` with the command, chain, and argument grammar; verify the pure completion tests pass.
- [x] 5.3 Implement per-evaluation catalogs using the config project's authoring module, with trace snapshot/drain and invalidation on reload, profile switch, preview change, and sync; verify catalog freshness and staleness tests pass.
- [x] 5.4 Wire the async `readline` completer in `packages/cli/src/repl/prompt.ts` and the Node default-completion fallback, filtering prototype noise; verify the session adapter tests pass and the non-TTY no-prompt test still passes.
- [x] 5.5 Add read-only completion tests that snapshot profile files before and after catalog completion calls; verify no profile file is written and no generation is published.
- [x] 5.6 Immediately use git to commit the completion engine excluding openspec artifacts; verify the commit does not include `openspec/`.

## 6. Exploration views

- [x] 6.1 Add failing tests for profile, bundle, layer, package, composed-entry, and published-state views, including missing profiles and snapshot invalidation; verify the new tests fail.
- [x] 6.2 Implement `PackageView` from declared plan packages, managed runtime and generated packages, and installed manifest versions; verify the package tests pass.
- [x] 6.3 Implement `PublishedProfileView` from the profile manifest, generation record, authoritative plan, and doctor findings, including the missing-profile case; verify the published-state tests pass.
- [x] 6.4 Extend the composition seam to return composed entries plus the last-touch source map and implement `ProfileView.entries()`; verify provenance tests pass, including nested groups.
- [x] 6.5 Rebuild the exploration snapshots on load, reload, profile switch, preview change, and successful sync; verify the invalidation tests pass.
- [x] 6.6 Add read-only exploration tests that walk every view; verify no file under the DSH profile directory is written and `.sync` remains the only publisher.
- [x] 6.7 Immediately use git to commit the exploration views excluding openspec artifacts; verify the commit does not include `openspec/`.

## 7. Documentation, verification, and change reconciliation

- [x] 7.1 Update the README authoring reference, REPL section, CLI reference, and a migration guide for the breaking API; verify the README examples and `pnpm test` pass.
- [x] 7.2 Update package-level documentation that mentions the old free helpers or `profile` binding; verify documentation links and examples resolve.
- [x] 7.3 Run `pnpm verify` (Biome check, typecheck, tests, package builds) and fix every failure; verify the command exits 0.
- [x] 7.4 Reconcile `add-config-repl`: archive it first or fold its deltas, then rebase this change's superseded deltas so the archive order is recorded; verify `openspec validate "add-typed-authoring-and-exploration" --strict` passes.
- [x] 7.5 Immediately use git to commit the documentation and final fixes excluding openspec artifacts; verify the commit does not include `openspec/`.
