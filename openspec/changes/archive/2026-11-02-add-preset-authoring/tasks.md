## 1. Normalize resolved expressions

- [x] 1.1 Add a failing query-resolution test using a bundle fixture with nested `!!js` expressions in a preset child's `disabled` and `config` values; assert the returned row contains plan expression nodes, not `__jsExpr`; run `pnpm vitest run packages/config/test/resolve.test.ts packages/config/test/authoring-objects.test.ts` and observe the failure.
- [x] 1.2 Implement the shape-exact `__jsExpr` to `$eedsh` conversion in `packages/config/src/resolve.ts` before the rows are frozen; rerun the targeted tests and observe them pass.
- [x] 1.3 Add an integration test that inserts a resolved preset containing `!!js` into a generated plan and verifies the emitted profile or configuration dump preserves the expression; run `pnpm vitest run packages/cli/test/integration/authoring-resolution.test.ts packages/cli/test/materialize/generated-bundle.test.ts` and observe it pass.
- [x] 1.4 Immediately use git to commit the resolution normalization excluding `openspec/` artifacts; verify with `git status --short` and `git log -1`.

## 2. Add preset definitions and child scopes

- [x] 2.1 Add failing tests in `packages/config/test/preset-definition.test.ts` for `definePreset` identity, default and explicit row ids, metadata, `from()` copying only children, source immutability, and normalization to an ordinary `@deepseek-ai/dsh-agent-preset` row; run `pnpm vitest run packages/config/test/preset-definition.test.ts` and observe the failures.
- [x] 2.2 Implement `PresetDefinition`, its authoring brand, exports, and `LayerBuilder.insert` acceptance while keeping the query `Preset` handle distinct; rerun the targeted tests and observe them pass.
- [x] 2.3 Add failing tests for the nested `.children((children) => ...)` scope covering disable, enable, remove, replace, append, prepend, insert-before, insert-after, single-target operations, ignored callback return, and top-level-only addressing; run `pnpm vitest run packages/config/test/preset-definition.test.ts` and observe the failures.
- [x] 2.4 Implement `PresetChildren` and `PresetChild` with the scoped editor API; rerun the targeted tests and observe them pass.
- [x] 2.5 Add failing tests for missing and ambiguous child/anchor lookups, error fields, and no partial mutation; run `pnpm vitest run packages/config/test/preset-definition.test.ts` and observe the failures.
- [x] 2.6 Implement `PresetDefinitionError` and its validation paths, add the preset module to the architecture allowlist with its rationale, and rerun the targeted tests plus `pnpm vitest run test/architecture.test.ts`.
- [x] 2.7 Immediately use git to commit the preset authoring objects excluding `openspec/` artifacts; verify with `git status --short` and `git log -1`.

## 3. Add explicit preset selection

- [x] 3.1 Add failing tests for `LayerBuilder.selectPreset(selected, { default })` with installed and authored preset references, differing and identical defaults, full registry config output, required default options, and no merge or inference; run `pnpm vitest run packages/config/test/config.test.ts packages/config/test/preset-definition.test.ts` and observe the failures.
- [x] 3.2 Implement `PresetRef` and `LayerBuilder.selectPreset`; rerun the targeted tests and observe them pass.
- [x] 3.3 Add an integration test showing the selected preset and registry patch compose together, and that a missing registry row remains a preflight warning; run `pnpm vitest run packages/config/test/preset-definition.test.ts packages/cli/test/materialize/preflight.test.ts`.
- [x] 3.4 Immediately use git to commit preset selection excluding `openspec/` artifacts; verify with `git status --short` and `git log -1`.

## 4. Preserve authoring errors through config import

- [x] 4.1 Add failing CLI and REPL tests in `packages/cli/test/config.test.ts` and `packages/cli/test/repl/session.test.ts` for a missing preset and a missing preset child, asserting the preserved code and message rather than `config.import_failed`; include an untagged import failure that still becomes a config import failure; run the targeted tests and observe the failures.
- [x] 4.2 Add a structural `isAuthoringError` guard covering `ResolutionError` and `PresetDefinitionError`; update `loadConfig` to preserve tagged authoring errors and adjust its Effect error union; rerun the targeted tests.
- [x] 4.3 Add CLI and REPL formatter cases for `PresetDefinitionError`, including preset id, row id, and child id; rerun the targeted tests.
- [x] 4.4 Run `pnpm vitest run test/architecture.test.ts packages/cli/test/config.test.ts packages/cli/test/repl/session.test.ts` and observe all pass.
- [x] 4.5 Immediately use git to commit authoring error propagation excluding `openspec/` artifacts; verify with `git status --short` and `git log -1`.

## 5. Remove bundle source authoring

- [x] 5.1 Add or update failing tests proving `.bundle()` emits no `source`, that `.package()` remains the only dependency input, and that legacy plan data with `NamedBundle.source` still validates without a plan version change; run `pnpm vitest run packages/config/test/config.test.ts packages/plan/test` and observe the expected failures.
- [x] 5.2 Remove `BundleOptions.source`, `Bundle.source`, source emission, and the `ProfileBuilder.bundle` source option while keeping the plan schema's legacy field and read-only views; run `pnpm typecheck` and the targeted tests.
- [x] 5.3 Mark the plan `source` field and related docs as deprecated legacy data; update config tests and README examples to use explicit `.bundle()` and `.package()`; run `pnpm check`.
- [x] 5.4 Immediately use git to commit bundle-source removal excluding `openspec/` artifacts; verify with `git status --short` and `git log -1`.

## 6. Warn about empty generated layers

- [x] 6.1 Add failing preflight tests in `packages/cli/test/materialize/preflight.test.ts` for an empty generated layer warning in raw mode, attributed mode with `--explain`, strict failure without committing a generation, and unchanged plan/layer output; run the targeted tests and observe the failures.
- [x] 6.2 Implement the empty-layer warning in `composePreflightLayers()` for generated layers only, naming the layer; rerun the targeted tests and observe them pass.
- [x] 6.3 Update the `--strict` command help from unmatched patch targets to preflight warnings, update command-surface expectations, and run `pnpm vitest run packages/cli/test/command-surface.test.ts packages/cli/test/materialize/preflight.test.ts`.
- [x] 6.4 Immediately use git to commit empty-layer warnings excluding `openspec/` artifacts; verify with `git status --short` and `git log -1`.

## 7. Wire the REPL and documentation, then verify the workspace

- [x] 7.1 Add failing REPL tests for the `definePreset` binding, binding-collision protection, and completion of the new preset-definition methods; run `pnpm vitest run packages/cli/test/repl/session.test.ts packages/cli/test/repl/completion.test.ts` and observe the failures.
- [x] 7.2 Add `definePreset` to the curated bindings and extend the completion method map; rerun the targeted tests and observe them pass.
- [x] 7.3 Update README, `packages/config/README.md`, and config examples with the nested preset authoring, `selectPreset`, expression normalization, and explicit bundle/package migration; run `pnpm format:check` and `pnpm lint`.
- [x] 7.4 Run `pnpm check && pnpm test && pnpm build:packages` and observe the full verification pass.
- [x] 7.5 Immediately use git to commit the REPL, docs, and verification updates excluding `openspec/` artifacts; verify with `git status --short` and `git log -1`.
