## 1. Adopt the multi-profile config model (still cwd-discovered)

- [x] 1.1 Add failing tests in `packages/config/test/api.test.ts` and a new `packages/config/test/plan/config.test.ts` for the keyed `defineConfig` envelope: shared DSH pin, key-as-name, dynamic records, default membership, per-profile Results, plain-config and Result validation, and rejection of a lone plan; run `pnpm vitest run packages/config/test` and confirm the new tests fail for the expected missing APIs.
- [x] 1.2 Implement `ProfileDefinition`, `DefineConfigInput`, `EedshConfig`, the config envelope schema, `defineProfile` as a synchronous descriptor, `defineConfig`, and `validateConfigValue`; export the new types and verify the tests from 1.1 pass with `pnpm vitest run packages/config/test`.
- [x] 1.3 Add failing CLI tests in `packages/cli/test/config.test.ts` and `packages/cli/test/cli.test.ts` for loading a config with a default profile and with a sole profile, and for a per-profile schema failure that does not fail the whole config; verify they fail.
- [x] 1.4 Change `packages/cli/src/config.ts` to return `EedshConfig`, add a default-or-sole selection helper, and update `sync`, `run`, `doctor`, and watch to operate on the selected plan; verify the tests from 1.3 pass.
- [x] 1.5 Mechanically convert every in-repo config fixture, inline test config source, README TypeScript block, and `test/support/readme.ts` itself plus its consumers to `defineConfig` with named profiles, including the hash-parity test; verify `pnpm test` passes with the existing one-profile command behavior.
- [x] 1.6 Update `test/smoke.test.ts` and public-export assertions for `defineConfig` and the descriptor `defineProfile`; run `pnpm test` and `pnpm typecheck` and confirm both pass.
- [x] 1.7 Immediately use git to commit the multi-profile config model and test migration, excluding `openspec/` artifacts.

## 2. Move to the XDG config path and all-profile sync

- [x] 2.1 Add failing tests in `packages/cli/test/config.test.ts` for XDG path resolution (set, unset, relative), no cwd discovery, `.ts`-only explicit paths, and the missing-config hint; add failing tests in a new loader test for config-project tsconfig resolution and caller-cwd path mappings being ignored; verify they fail.
- [x] 2.2 Implement the config-path module, remove `findConfigPath`/`findUnsupportedConfigPath` and `.mts` support, update the CLI's config resolution and missing-config diagnostic, and extract the shared nearest-tsconfig helper so `loadConfig` registers tsx against the config project; verify the tests from 2.1 pass.
- [x] 2.3 Add failing command tests for `--profile` on `sync`, `run`, and `doctor`, ambiguous and unknown selection (exit 2), `check --profile` rejection, bare sync publishing every profile, and invalid/locked/strict failures not stopping valid siblings; verify they fail.
- [x] 2.4 Implement the selection helper (explicit > default > sole), add the `--profile` flags, convert `sync` to the all-profile loop with profile-labelled diagnostics and per-profile exit aggregation, and update `run`/`doctor`/`check` accordingly; verify the tests from 2.3 pass.
- [x] 2.5 Update command-surface, integration fixture paths, and harness environments to use `XDG_CONFIG_HOME` or explicit `--config`; remove the obsolete discovery fixtures and update the `.mts`/`.js` rejection expectations; verify `pnpm test` and `pnpm typecheck` pass.
- [x] 2.6 Immediately use git to commit the XDG path, loader, selection, and sync-all changes, excluding `openspec/` artifacts.

## 3. Make watch mode multi-profile

- [x] 3.1 Add failing watch tests in `packages/cli/test/cli.test.ts` for bare watch publishing every profile, `--profile` narrowing, added and removed profiles, one invalid profile not stopping valid siblings, and one materialization failure not ending the session; verify they fail.
- [x] 3.2 Refactor `syncWatch` to reload the config, re-select the current profile set, run the all-or-one sync loop, keep the single service layer, and continue after selection or profile failures; verify the tests from 3.1 pass.
- [x] 3.3 Run `pnpm test` and `pnpm typecheck`, confirm the existing watch lifecycle and cleanup tests still pass, and verify the watcher ignores `node_modules/` in the XDG project.
- [x] 3.4 Immediately use git to commit the multi-profile watch changes, excluding `openspec/` artifacts.

## 4. Add `eedsh init`

- [x] 4.1 Add failing tests in `packages/cli/test/init.test.ts` for the three generated files, version and local-link specs, tsconfig inclusion, no overwrite, no git, `--no-install`, install failure, owner-only directory mode, and the `init --help` surface; verify they fail.
- [x] 4.2 Implement the init templates, dependency/version resolution including the single `TYPESCRIPT_SPEC` constant, config-directory resolution, atomic file writes, idempotent file creation, and the narrow init service seam; verify the tests from 4.1 pass.
- [x] 4.3 Validate the generated `config.ts` by loading it in a temporary project and verify `eedsh check` succeeds after a local install; if a registry install is unavailable in the environment, use the local link specs and record the result.
- [x] 4.4 Add the `init` command to the root command surface, help text, and `runEedsh` wiring; verify `eedsh init --no-install` writes to the injected `XDG_CONFIG_HOME`, prints the path/profiles/next commands, and exits 0.
- [x] 4.5 Run `pnpm test` and `pnpm typecheck`, confirm the command-surface and integration tests pass, and verify no init path requires DSH resolution.
- [x] 4.6 Immediately use git to commit `eedsh init`, excluding `openspec/` artifacts.

## 5. Update integration coverage, documentation, and the final gate

- [x] 5.1 Add built-CLI integration coverage for a temp `XDG_CONFIG_HOME`, `init --no-install`, multi-profile `sync`, `doctor`, and `run --profile`; run it against the current fixtures, fix any path or fixture gaps, and update the existing built-CLI, HMR, and check fixtures to `config.ts`; verify the new coverage passes.
- [x] 5.2 Update `README.md`, `packages/config/README.md`, and `packages/cli/README.md` for the XDG location, `eedsh init`, the keyed `defineConfig` API, profile selection, all-profile sync, and the breaking change; grep the repository for stale `eedsh.config.ts`, `.mts`, and single-plan authoring claims and fix them.
- [x] 5.3 Remove dead discovery, `.mts`, and old authoring code/tests that are no longer reachable; run `pnpm check`, `pnpm test`, and `pnpm build:packages` and confirm all pass.
- [x] 5.4 Run the slow Web HMR integration test with `pnpm test:slow` when the environment supports the pinned DSH, and run `pnpm verify` as the final gate; record any environment-limited skip rather than claiming it passed.
- [x] 5.5 Immediately use git to commit the integration, documentation, and cleanup work, excluding `openspec/` artifacts.
