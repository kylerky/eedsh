## 1. Diagnostics and generation-record trust

- [x] 1.1 Add failing unit tests for the tagged generation-record lookup in `packages/cli/test/materialize/profile.test.ts` (or a new `generation.test.ts`): missing file, unparseable JSON, foreign name, wrong format, unsupported version, empty managed sets, and a valid record; verify they fail because the lookup API does not exist
- [x] 1.2 Implement the tagged lookup with format/version/name/generation-id/plan-hash/bundles/packages validation and the absent-versus-invalid heuristic; verify the lookup tests pass
- [x] 1.3 Add failing tests that reconciliation and materialization expose structured notices and that the CLI prints `eedsh: notice:` without adding the `--explain` hint, while preflight warnings still add it; verify they fail
- [x] 1.4 Add the shared notice type and thread notices through `reconcileManifest`, `publishProfile`, `materialize`, and the CLI printer; verify the diagnostics tests pass
- [x] 1.5 Add failing tests for invalid-record behavior: an eedsh-managed profile with a missing or corrupt record fails without writing, a fresh profile proceeds, `--adopt-ownership` preserves live entries and writes a record, and a newer record version refuses adoption; verify they fail
- [x] 1.6 Implement `OwnershipRecordInvalid`, the `adoptOwnership` materialize option, the adoption path, and the `sync --adopt-ownership` flag with help text; verify the behavior tests pass
- [x] 1.7 Add CLI tests for the invalid-record message, exit status 1, adoption exit status 0, and the new help text; verify `pnpm vitest run packages/cli/test/cli.test.ts` passes
- [x] 1.8 Immediately use git to commit the changes excluding openspec artifacts; verify `git log -1 --stat` lists only project files and no `openspec/changes/harden-profile-integrity/` paths

## 2. Last-applied ownership semantics

- [x] 2.1 Add characterization tests in `packages/cli/test/materialize/profile.test.ts` for last-applied ownership: a removed bundle and a removed dependency re-added after publication survive the next sync, and a re-addition before the removal is published is still removed; verify the tests pass against the current reconciliation and pin the behavior
- [x] 2.2 Update `README.md` so the reconciliation section states that ownership is last-applied, that a post-publication re-addition is user-owned, and that `--adopt-ownership` is only for an unreadable record; verify the section mentions both behaviors
- [x] 2.3 Immediately use git to commit the changes excluding openspec artifacts; verify `git log -1 --stat` lists the tests and README and no openspec change paths

## 3. Dependency-section exclusivity

- [x] 3.1 Add failing reconciliation tests for dependency sections: managed duplicates are removed from `devDependencies` and `optionalDependencies`, unrelated entries are preserved, malformed sections are untouched, previously managed names are cleaned up, peer and override conflicts are reported, and a section-only change triggers installation; verify they fail
- [x] 3.2 Implement the strict section reader, the owned-name scanner, the cleanup in `buildManifest`, and the all-section comparison used by `dependenciesChanged`; verify the reconciliation tests pass
- [x] 3.3 Add failing tests that removals produce notices and peer/override conflicts produce warnings in deterministic order; verify they fail
- [x] 3.4 Wire the section diagnostics through the notice channel added in group 1; verify the diagnostics tests pass
- [x] 3.5 Add a CLI test proving a section-only cleanup prints its notice and still reports an installation; verify the CLI test passes
- [x] 3.6 Immediately use git to commit the changes excluding openspec artifacts; verify `git log -1 --stat` contains only project files and no openspec change paths

## 4. Authoritative plan artifact

- [x] 4.1 Add failing `packages/cli/test/materialize/generated-bundle.test.ts` cases: the generated file list contains `plans/<generationId>.json` immediately before `package.json`, its bytes are exactly the canonical plan, and `sha256(bytes)` equals `planHash`; verify they fail
- [x] 4.2 Add the derived path helper and the authoritative plan file to `GeneratedBundle.files`, keeping the mirror fields distinct; verify the generated-bundle tests pass
- [x] 4.3 Add failing materialization tests that a current generation with a missing or mismatched authoritative plan is republished with the same generation id, does not install, and still preflights, while an intact plan stays unchanged; verify they fail
- [x] 4.4 Implement authoritative-plan verification in the unchanged check in `program.ts`; verify the materialization tests pass
- [x] 4.5 Immediately use git to commit the changes excluding openspec artifacts; verify `git log -1 --stat` contains only project files and no openspec change paths

## 5. Plan mirror and publication restoration

- [x] 5.1 Add failing publication tests: the mirror is written after preflight and before the generated-manifest commit, and a failure at install, preflight, mirror write, or commit restores the profile manifest, lockfile, and mirror to their previous bytes; verify they fail
- [x] 5.2 Move the mirror write to the pre-commit position, snapshot the mirror before writes, restore it on failure, and include the commit write in the restore boundary; verify the publication tests pass
- [x] 5.3 Add failing tests that a missing or differing mirror on an otherwise current generation triggers a same-id publish and is rewritten, while an intact mirror is a no-op; verify they fail
- [x] 5.4 Verify the mirror in the unchanged check alongside the authoritative plan; verify the tests pass
- [x] 5.5 Immediately use git to commit the changes excluding openspec artifacts; verify `git log -1 --stat` contains only project files and no openspec change paths

## 6. Doctor core

- [x] 6.1 Add failing `packages/cli/test/doctor.test.ts` cases for a read-only inspection: record, authoritative plan, record/plan/mirror consistency, managed manifest entries, dependency-section conflicts, scaffolding, findings, no writes, and a generation change during diagnosis; verify they fail
- [x] 6.2 Implement the `doctor.ts` pipeline and plain-text finding report with the specified severities; verify the doctor unit tests pass
- [x] 6.3 Add failing CLI tests for `doctor --profile`, `doctor --config`, mutual exclusion, missing profile, exit statuses 0/1/2, and no config evaluation when `--profile` is used; verify they fail
- [x] 6.4 Add the `doctor` subcommand, flags, profile selection, and exit-code mapping; verify the CLI tests pass
- [x] 6.5 Immediately use git to commit the changes excluding openspec artifacts; verify `git log -1 --stat` contains only project files and no openspec change paths

## 7. Doctor installed-resolution checks

- [x] 7.1 Add failing tests for the semver helper and lockfile checks: v9 root importer, missing lockfile, missing entry, specifier difference as a warning, and an out-of-range version as an error; verify they fail
- [x] 7.2 Implement the lockfile reader and the Effect `SemVer`/`SemVerRange` helper; verify the lockfile tests pass
- [x] 7.3 Add failing tests for installed packages: missing installation, installed version differing from the lockfile, a satisfying semver version, and a `link:` specification reported without a range error; verify they fail
- [x] 7.4 Implement installed-package resolution and version comparison; verify the installed tests pass
- [x] 7.5 Add a failing test that a sync publishing during doctor produces a "profile changed" error instead of a clean result, then implement the generation-id double read; verify the test passes
- [x] 7.6 Immediately use git to commit the changes excluding openspec artifacts; verify `git log -1 --stat` contains only project files and no openspec change paths

## 8. Documentation and full verification

- [x] 8.1 Update `README.md` for the new CLI surface (`doctor`, `--adopt-ownership`, doctor flags), the profile layout (`plans/<generationId>.json` authority and the mirror), and the publication guarantees; verify the README mentions each new command, flag, path, and exit-status rule
- [x] 8.2 Add an integration test that publishes a temporary profile, runs doctor clean, then corrupts the record, plan, manifest, lockfile, and installed package in turn and asserts the findings and exit status; verify the integration test passes
- [x] 8.3 Run `pnpm check` and fix formatting, lint, and type errors; verify it exits 0
- [x] 8.4 Run `pnpm test` and fix failures, including any existing materialization tests affected by the new fail-closed behavior; verify it exits 0
- [x] 8.5 Immediately use git to commit the changes excluding openspec artifacts; verify `git log -1 --stat` contains only project files and no openspec change paths
