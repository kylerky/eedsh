## 1. Workspace, Packages, Toolchain, and Checks

- [x] 1.1 Create the root private `@eedsh/workspace` pnpm workspace (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`) and skeleton packages `packages/config` (`@eedsh/config`), `packages/cli` (`@eedsh/cli`, bin `eedsh`), and `packages/runtime` (`@eedsh/runtime`); add `@sinclair/typebox` to `@eedsh/config`, pinned `effect`, `@eedsh/config`, `@eedsh/runtime`, `@deepseek-ai/dsh`, `@deepseek-ai/dsh-app-boot`, `chokidar`, and `js-yaml` to `@eedsh/cli`, the exact DSH engine to `@eedsh/runtime`, and Biome, TypeScript, and Vitest at the workspace root; verify `pnpm install` succeeds and `pnpm -r build` exits 0
- [x] 1.2 Add `.editorconfig`, `biome.json` (excluding generated and planning directories), and the Biome format scripts; verify `pnpm format` then `pnpm format:check` exit 0
- [x] 1.3 Add the Biome lint and import-organization scripts; verify `pnpm lint`, `pnpm lint:fix`, and `biome check` exit 0
- [x] 1.4 Add the strict build/check tsconfigs and typecheck scripts; verify `pnpm typecheck` exits 0
- [x] 1.5 Add the shared Vitest configuration and a workspace smoke test that imports `@eedsh/config` and `@eedsh/runtime` public entries and resolves the pinned DSH package; verify `pnpm test` passes
- [x] 1.6 Add the `pnpm check`/`pnpm verify` aggregate scripts and `.github/workflows/ci.yml`; verify `pnpm check` exits 0, the workflow YAML parses, and the workflow runs `pnpm verify` on Node 24 and 26
- [x] 1.7 Add an architecture test that reads the three package manifests and source trees and asserts `@eedsh/config` and `@eedsh/runtime` declare no `effect` dependency and import no `effect` module, `@eedsh/config` declares no DSH runtime dependency, and `@eedsh/cli` declares and uses Effect; verify `pnpm test` passes
- [x] 1.8 Run `pnpm verify`, then immediately use git to commit the workspace, package split, and toolchain changes excluding `openspec/`; verify `git status --short` shows no implementation changes and only openspec artifacts remain untracked

## 2. Plan Schema and Typed API in @eedsh/config

- [x] 2.1 Add failing tests in `packages/config/test/plan/schema.test.ts` for the `typed-profile-layering` plan contract: minimal plan, JSON round-trip, unsupported function/circular values, missing name, duplicate/empty/unsafe layer ids, invalid expression node, duplicate generated markers, and preserved bundle order; verify the new tests fail
- [x] 2.2 Implement the plan types, TypeBox schema, recursive JSON/expression validation, and canonical JSON hash in `packages/config/src/plan/`; verify the plan schema tests pass
- [x] 2.3 Add failing tests in `packages/config/test/api.test.ts` for `defineProfile` and the helpers (`bundle`, `generated`, `layer`, `insert`, `override`, `disable`, `enable`, `group`, `js`, `raw`), including positional marker behavior, whole-config replacement, reserved bundle names, and the expression node shape; verify the new tests fail
- [x] 2.4 Implement the typed API and export it from `packages/config/src/index.ts`; verify the API tests pass and the module imports no Effect module
- [x] 2.5 Run `pnpm check` and `pnpm test`, then immediately use git to commit the `@eedsh/config` plan and API changes excluding `openspec/`; verify `git status --short` shows no implementation changes

## 3. Generated Bundle and YAML Emission in @eedsh/cli

- [x] 3.1 Add failing tests in `packages/cli/test/materialize/generated-bundle.test.ts` for versioned generation patch files, layer ordering, the generated package manifest with `dsh.bundle.patch` and `eedsh` metadata, the emitted plan JSON, and generation-id changes on content changes; verify the new tests fail
- [x] 3.2 Implement the structured YAML emitter with a custom `!!js` type, patch-file naming, generation hashing, and the generated bundle writer in `packages/cli/src/materialize/`; verify the generated-bundle tests pass
- [x] 3.3 Add a failing round-trip test that emits a layer containing an expression and parses/composes it through DSH's patch loader, asserting the expression survives as a `!!js` value and the patch targets resolve; verify the test fails until the emitter output is compatible
- [x] 3.4 Correct the emitter/serialization until the DSH round-trip test passes; verify the full generated-bundle test file passes
- [x] 3.5 Run `pnpm check` and `pnpm test`, then immediately use git to commit the generated bundle and YAML changes excluding `openspec/`; verify `git status --short` shows no implementation changes

## 4. Effect Island, Profile Reconciliation, and Atomic Publication

- [x] 4.1 Add failing tests in `packages/cli/test/materialize/profile.test.ts` for the `generated-profile-materialization` manifest contract: runtime immediately before generated, positional marker and omitted-marker order, preserved user-added bundles, removal of previously managed bundles, duplicate elimination, preserved user dependencies, removed managed dependencies, managed-spec precedence, untouched profile patch, and created-empty profile patch; verify the new tests fail
- [x] 4.2 Implement profile manifest and dependency reconciliation in `packages/cli/src/materialize/manifest.ts` and `profile.ts`, using the previous generation's managed sets; verify the profile tests pass
- [x] 4.3 Add failing tests in `packages/cli/test/internal/effect.test.ts` for the Effect island: tagged materialization failures, injectable file/package/DSH services, lock acquisition and release, resource cleanup on failure, unchanged-plan no-op, and restoration of manifest and lockfile snapshots after a package or preflight failure; verify the tests run through `Effect.runPromise` with test layers and fail
- [x] 4.4 Implement the tagged error model, service tags, layers, Effect materialization program, atomic-write helper, sync lock, generation-id calculation, package-manager adapter, and publication ordering in `packages/cli/src/internal/effect/`, `packages/cli/src/materialize/publish.ts`, and `packages/cli/src/dsh.ts`; keep Node `fs`/`spawn` inside service implementations and verify the Effect tests pass
- [x] 4.5 Verify the Effect island remains confined to `@eedsh/cli` by running the architecture test from task 1.7 and `pnpm typecheck`; confirm `@eedsh/config` and `@eedsh/runtime` still have no Effect dependency
- [x] 4.6 Run `pnpm check` and `pnpm test`, then immediately use git to commit the Effect island, profile reconciliation, and publication changes excluding `openspec/`; verify `git status --short` shows no implementation changes

## 5. Preflight and Bootable-Profile Integration

- [x] 5.1 Add failing tests in `packages/cli/test/materialize/preflight.test.ts` for the `generated-profile-materialization` preflight contract: unmatched patch warning, strict-mode failure and skipped commit, duplicate inserted id rejection, malformed patch/expression rejection, target bundle resolution failure, tagged preflight failures, and composition with the generated layer at the marker; verify the new tests fail
- [x] 5.2 Implement preflight as an Effect program in `packages/cli/src/preflight.ts` by resolving target bundle directories and patch files and composing them with the generated layers through DSH's own patch composition functions; verify the preflight tests pass
- [x] 5.3 Add an integration test that materializes a temp profile and runs the pinned `dsh --profile <name> --dump-config` with a temporary `DSH_HOME`, asserting generated rows appear in order and an existing profile-patch override still wins; verify the test passes
- [x] 5.4 Run `pnpm check` and `pnpm test`, then immediately use git to commit the preflight and bootable-profile integration changes excluding `openspec/`; verify `git status --short` shows no implementation changes

## 6. Runtime Bundle and HMR Watcher in @eedsh/runtime

- [x] 6.1 Add failing tests in `packages/runtime/test/watcher.test.ts` for the `generated-layer-hmr` contract using a fake HMR service and temp generated-package files: registration only with profile context and HMR, generation-id dedupe, malformed-record containment, restart-required reporting, and recovery on a later valid generation; verify the new tests fail
- [x] 6.2 Implement the `@eedsh/runtime` bundle patch, plugin entry, and factored watcher function in `packages/runtime/` without any Effect import; verify the watcher tests pass and the architecture test still passes
- [x] 6.3 Add a slow Web-profile integration test that materializes an eedsh profile, boots `dsh --profile <name> --no-open --port <free>`, publishes a new generation disabling a harmless row, and asserts the watcher reports an applied generation or a restart-required diagnostic; verify the test passes
- [x] 6.4 Fix any runtime or test-harness issues found by the Web HMR integration test; verify the slow HMR test and the watcher unit tests pass
- [x] 6.5 Run `pnpm check` and `pnpm test`, then immediately use git to commit the runtime bundle and HMR changes excluding `openspec/`; verify `git status --short` shows no implementation changes

## 7. CLI in @eedsh/cli: Sync, Watch, and Run

- [x] 7.1 Add failing tests in `packages/cli/test/cli.test.ts` for the `eedsh sync`, `eedsh sync --watch`, and `eedsh run` contracts: a fixture config importing `@eedsh/config`, native TypeScript config loading, validation/sync exit codes, strict-mode propagation, tagged Effect failures mapped to diagnostics, watch rerun and last-generation retention on compile failure, `ManagedRuntime` service reuse across watch runs, and `run` argument forwarding through an injected spawn; verify the new tests fail
- [x] 7.2 Implement config discovery/evaluation, the CLI parser, sync/watch orchestration (using `Effect.runPromise` for one-shot sync and `ManagedRuntime` for watch), and the pinned-DSH spawn path in `packages/cli/src/cli.ts`, `config.ts`, `watch.ts`, and `dsh.ts`; verify the CLI tests pass
- [x] 7.3 Add a built-CLI integration test that runs the compiled `eedsh sync --config <fixture>` against a temp profile whose config imports `@eedsh/config`, then verifies the result with `dsh --profile <name> --dump-config`; verify the test passes
- [x] 7.4 Run `pnpm check` and `pnpm test`, then immediately use git to commit the CLI changes excluding `openspec/`; verify `git status --short` shows no implementation changes

## 8. Documentation and Final Verification

- [x] 8.1 Write the root README and package READMEs for `@eedsh/config`, `@eedsh/cli`, and `@eedsh/runtime` covering the three-package split, the Effect island and its boundary, the layer model, positional `generated()` marker, config example, coexist contract, CLI commands, Biome/TypeScript quality gate commands, HMR behavior, restart-required limitations, and the deferred upper-layer API; verify every documented command and example matches the implemented flags and paths
- [x] 8.2 Run `pnpm verify` (Biome check, typecheck, Vitest, build), the slow Web HMR integration test explicitly, and a manual temp-`DSH_HOME` `eedsh sync` followed by `dsh --profile <name> --dump-config`; verify all commands exit 0
- [x] 8.3 Run `pnpm verify`, then immediately use git to commit the documentation and final verification changes excluding `openspec/`; verify `git status --short` shows no implementation changes
