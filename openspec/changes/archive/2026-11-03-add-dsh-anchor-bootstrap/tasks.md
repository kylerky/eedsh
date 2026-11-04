## 1. Shared installation anchor format

- [x] 1.1 Add failing cases in packages/runtime/test/installation-anchor.test.ts for the anchor path under the DSH home, format version 1 encode/decode, required installAnchor, optional launcher/manager/provenance fields, and rejection of malformed or unsupported records; run "pnpm vitest run packages/runtime/test/installation-anchor.test.ts" and confirm the new cases fail.
- [x] 1.2 Implement packages/runtime/src/installation-anchor.ts with pure path and encode/decode/validate helpers, add the installation-anchor subpath export and build entry to packages/runtime/package.json and tsdown config, and verify the runtime helper tests and "pnpm typecheck" pass.
- [x] 1.3 Add failing CLI coverage in packages/cli/test/installation-anchor.test.ts that the shared helper resolves the cache under the CLI's resolveDshHome(env) and that the CLI rejects records with a missing anchor, wrong package name, or unsupported version; run the test and confirm it fails.
- [x] 1.4 Wire the CLI to the shared helper without duplicating the path or schema, verify the CLI helper test passes, and confirm no config-project file is read or written by the helper.
- [x] 1.5 Immediately use git to commit the anchor format and shared helper, excluding openspec/ artifacts, and verify git status shows only the intended runtime, CLI, test, and package-manifest changes.

## 2. Discovery anchor and launcher failure

- [x] 2.1 Add failing cases in packages/cli/test/dsh.test.ts for a valid anchor resolving an unmappable pnpm-style launcher, explicit --dsh and EEDSH_DSH_ANCHOR winning over the anchor, an anchor without a PATH launcher, malformed and stale anchors, a PATH launcher plus invalid anchor returning dsh.launcher_unresolved without project fallback, and project-local remaining the last fallback; run the discovery tests and confirm the new cases fail.
- [x] 2.2 Add dsh.launcher_unresolved to the DshFailure code union and implement anchor validation and the precedence step in packages/cli/src/dsh-discovery.ts, including a recorded discovery source and no project fallback when a PATH launcher is unresolved; verify the discovery tests pass.
- [x] 2.3 Add failing tests for the cache version guard: a matching "dsh --version" keeps the anchor, a mismatch or failed probe invalidates it, a timeout is bounded, and the probe runs only when a PATH launcher exists; verify the cases fail.
- [x] 2.4 Implement the bounded launcher version probe behind an injectable runner in the CLI, compare it with the recorded package version, and verify the new tests and the existing discovery tests pass without invoking pnpm or npm.
- [x] 2.5 Immediately use git to commit discovery, the new failure code, and the version guard, excluding openspec/ artifacts, and verify no package-manager query exists in the discovery module.

## 3. pnpm and npm bootstrap

- [x] 3.1 Add failing tests in packages/cli/test/dsh-bootstrap.test.ts with an injected command runner for pnpm global metadata exposing the package path and version, npm global root exposing the package, a launcher version mismatch, multiple matching candidates, no candidate, malformed JSON, a command timeout, and an unsupported manager; verify the tests fail.
- [x] 3.2 Implement packages/cli/src/dsh-bootstrap.ts with pnpm and npm adapters, the fixed-argument command runner, candidate validation through the existing anchor reader, supported-range validation, realpath deduplication, and deterministic manager inference; verify the bootstrap tests pass.
- [x] 3.3 Add failing tests that the bootstrap writes no cache and returns dsh.launcher_unresolved when no candidate matches, and that it never reads cmd-shim-target or another manager's metadata; verify they fail, then implement the boundaries and verify the tests pass.
- [x] 3.4 Immediately use git to commit the pnpm/npm bootstrap and its tests, excluding openspec/ artifacts, and verify the bootstrap module is imported only by setup paths.

## 4. Sync and run integration

- [x] 4.1 Add failing command tests in packages/cli/test/dsh-command.test.ts for a first sync with no valid anchor bootstrapping through pnpm/npm, a second sync with a valid anchor making no query, a missing or version-mismatched anchor re-bootstrapping, run's sync step bootstrapping, and bootstrap failure producing dsh.launcher_unresolved with no config import, publication, or boot; verify the tests fail.
- [x] 4.2 Implement the sync bootstrap orchestration: run normal discovery first, call the bootstrap only for an unresolved PATH launcher with no explicit selection or anchor, write the anchor atomically, and continue with the validated installation; reuse the same path for run's sync step; verify the command tests pass.
- [x] 4.3 Add failing boundary tests proving doctor, repl, and run --no-sync never query pnpm/npm and never write an anchor, while doctor remains usable without DSH and the others report the sync-once remedies; verify they fail, then implement the command-specific boundaries and verify the tests pass.
- [x] 4.4 Add a failing test for an anchor write failure: the current sync continues with the validated installation and a later sync without a valid anchor bootstraps again; implement the warning-and-continue behavior and verify the test passes.
- [x] 4.5 Immediately use git to commit sync/run integration and the command boundaries, excluding openspec/ artifacts, and verify a valid anchor prevents repeated package-manager queries.

## 5. Init explicit anchor and cache reporting

- [x] 5.1 Add failing tests in packages/cli/test/init.test.ts for init --dsh validating and recording an anchor, init without --dsh reporting an existing anchor and querying nothing, init succeeding with no DSH or anchor while printing the first-sync hint, an invalid --dsh writing no project files, re-running init keeping the three project files and refreshing the anchor, a failed anchor write keeping a usable project, and init --help listing --dsh; verify the tests fail.
- [x] 5.2 Add the optional --dsh input to the init command and InitInput, validate it before writing project files, read and report an existing anchor through the shared helper and Effect FileSystem, write the anchor atomically outside the config project, and preserve the existing non-destructive init behavior; verify the init tests pass.
- [x] 5.3 Verify init performs no pnpm/npm metadata query and writes no DSH dependency or config field; run "pnpm vitest run packages/cli/test/init.test.ts" and confirm the config-project tests still pass.
- [x] 5.4 Immediately use git to commit init --dsh and the anchor reporting, excluding openspec/ artifacts, and verify the config project still contains only config.ts, package.json, and tsconfig.json.

## 6. Runtime installation anchor recorder

- [x] 6.1 Add failing tests in packages/runtime/test for a profile boot with profile context and HMR writing the anchor, a boot without HMR still writing it, a missing profile context writing nothing, an invalid installAnchor warning without a write, a write failure warning without failing the profile, and an upgrade replacing the recorded anchor; verify the tests fail.
- [x] 6.2 Implement the recorder in packages/runtime/src/index.ts (or a small startup helper) using profileContext.home and profileContext.installAnchor, the shared anchor helper, an atomic Node fs write, and best-effort warning handling independent of the HMR watcher; verify the runtime tests pass.
- [x] 6.3 Confirm the existing watcher registration and HMR requirements are unchanged, run the full runtime test suite, and verify the runtime package still has no Effect or DSH production dependency.
- [x] 6.4 Immediately use git to commit the runtime recorder and tests, excluding openspec/ artifacts, and verify an HMR-disabled profile still records the anchor.

## 7. Integration, cross-platform, and architecture checks

- [x] 7.1 Add an integration test that puts a pnpm-generated dsh shim and matching pnpm metadata on PATH and verifies the first sync bootstraps and publishes without --dsh; use a real temp pnpm global install where the environment supports it and a recorded fixture otherwise, run it against the implemented sync path, and record whether it is a regression pass or an environment-limited skip.
- [x] 7.2 Add failing Windows-oriented tests for the bootstrap command runner and the "dsh --version" guard using .cmd launchers and paths containing spaces; verify they fail on the current platform or the Windows CI job.
- [x] 7.3 Implement or adjust the test fixtures and the shell-aware runner needed by 7.1 and 7.2; verify the integration and Windows-oriented tests pass.
- [x] 7.4 Add failing architecture checks that discovery, doctor, repl, and run --no-sync contain no package-manager query or shim parser, the runtime contains no Effect or DSH production dependency, the CLI declares no production DSH dependency, and the anchor path is outside the config project; verify the checks fail.
- [x] 7.5 Update the architecture checks and any inspected manifests, verify "pnpm vitest run test/architecture.test.ts" passes, and confirm there is no cmd-shim-target parser anywhere.
- [x] 7.6 Immediately use git to commit the integration, cross-platform, and architecture work, excluding openspec/ artifacts, and verify the intended files are the only changes.

## 8. Documentation and release verification

- [x] 8.1 Add command-surface and documentation assertions for the final init --dsh help, the dsh.launcher_unresolved wording containing pnpm/npm-only, --dsh, EEDSH_DSH_ANCHOR, and the boot-once remedy, and the upgrade/archive notes; run them and confirm the missing documentation or wording fails.
- [x] 8.2 Update README.md, packages/cli/README.md, and packages/runtime/README.md for the first-sync bootstrap, the recorded anchor, init --dsh, the pnpm/npm-only boundary, upgrade recovery, and the archive prerequisite; verify the command-surface assertions and help output pass.
- [x] 8.3 Run "pnpm verify" and "openspec validate add-dsh-anchor-bootstrap --strict"; run "pnpm test:slow" where the environment supports it and record any environment-limited skip rather than claiming it passed.
- [x] 8.4 Verify the migration notes state that adopt-external-dsh must be archived before this change, that no config or plan migration is required, and that the previous eedsh release ignores the new anchor file.
- [x] 8.5 Immediately use git to commit the documentation and any verification fixes, excluding openspec/ artifacts, and verify the final git status contains only intended code, test, package, and documentation changes.
