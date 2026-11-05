## 1. Provenance-aware unchanged check

- [x] 1.1 Add failing cases in packages/cli/test/materialize/program.test.ts for a provenance-only republish after the DSH version changes and after the eedsh version changes, asserting the same generation identifier and a refreshed record; verify they fail.
- [x] 1.2 Compare the record's `dshVersion` and `eedshVersion` in the unchanged predicate; verify the new cases and the existing unchanged cases pass.
- [x] 1.3 Confirm publication, locking, preflight, plan mirror, provenance sidecar, and generation identifier behavior are unchanged by running the materialize tests and `pnpm typecheck`.
- [x] 1.4 Verify a real `eedsh sync` republishes the same generation with a changed DSH manifest version and writes no other artifact content change.
- [x] 1.5 Commit the CLI change and tests.

## 2. Documentation and OpenSpec

- [x] 2.1 Update README.md and packages/cli/README.md: after a DSH upgrade, `eedsh sync` refreshes the generation record even when the plan is unchanged; the runtime warning's recommended command now works.
- [x] 2.2 Run `pnpm verify` and `openspec validate refresh-sync-provenance --strict`; record environment-limited checks instead of claiming them.
- [x] 2.3 Archive the OpenSpec change and update the generated-profile-materialization spec.
- [x] 2.4 Commit the documentation and OpenSpec archive.
