## 1. Plan version 2 and config API removal

- [x] 1.1 Add failing cases to `packages/plan/test/schema.test.ts`, `packages/plan/test/envelope.test.ts`, and `packages/plan/test/validate.test.ts` for version 2 acceptance, version 1 rejection, a `dsh` field rejection, an absent config `dsh`, and absence of `dsh` from the plan type; run `pnpm vitest run packages/plan/test` and confirm the new cases fail.
- [x] 1.2 Set `PLAN_VERSION = 2`, remove `dsh` from `ProfilePlan` and `ProfilePlanSchema`, remove `DshPinSchema`/`DshRangeSchema`, and remove semver from `packages/plan/package.json`; verify the new plan tests pass.
- [x] 1.3 Add failing cases in `packages/config/test/api.test.ts`, `packages/config/test/config.test.ts`, and `test/smoke.test.ts` for the removed `.dsh()`, the absent `EedshConfig.dsh`, and rejection of a plain-config `dsh` field; verify they fail.
- [x] 1.4 Remove `.dsh()` from `ConfigBuilder`, remove `dsh` from `EedshConfig` and the config envelope, and remove the DSH argument from `validateProfileDefinition`; verify the config and smoke tests pass.
- [x] 1.5 Update plan/config fixtures, `test/support/plan.ts`, `test/smoke.test.ts`, and `packages/cli/test/materialize/hash-parity.test.ts` for version 2 and no `dsh`; verify `pnpm vitest run packages/plan/test packages/config/test` and `pnpm typecheck` pass.
- [x] 1.6 Immediately use git to commit the plan and config removal, excluding `openspec/` artifacts, and verify `git status` shows only the intended source, test, and lockfile changes.

## 2. CLI supported-range policy

- [x] 2.1 Add failing tests in `packages/cli/test/dsh.test.ts` for the CLI-level supported range `^0.2.1-rc.2`, prerelease satisfaction, and rejection outside the range; verify they fail.
- [x] 2.2 Add `semver` to `packages/cli/package.json`, define the supported-range policy in the CLI, and implement the satisfaction helper used by discovery and doctor; verify the new CLI tests pass.
- [x] 2.3 Remove any remaining plan-exported DSH schema or range helper imports, replace the pinned DSH package-version assertion in `test/smoke.test.ts` with a supported-range check, and verify `pnpm typecheck` passes with no DSH range concept in `@eedsh/plan`.
- [x] 2.4 Immediately use git to commit the CLI policy, excluding `openspec/` artifacts, and verify the plan package has no semver dependency.

## 3. Remove generated and runtime DSH engines

- [x] 3.1 Add failing cases to `packages/cli/test/materialize/generated-bundle.test.ts` proving the generated manifest has no `engines.dsh`, still lists patch files, and keeps the exact `dshVersion` in the record; verify they fail.
- [x] 3.2 Remove `engines` from `GeneratedManifest` and `buildGeneratedBundle`, update fixtures, and verify the generated-bundle tests pass.
- [x] 3.3 Add a failing runtime-manifest assertion that `packages/runtime/package.json` has no `engines.dsh` and still has `engines.node`; remove the DSH engine and verify the assertion passes.
- [x] 3.4 Add failing runtime tests in `packages/runtime/test/watcher.test.ts` for missing `watchConfig`/`reconcileProfile` capabilities and for a `dshVersion` drift warning read from the generation record and `profileContext.installAnchor`; verify they fail.
- [x] 3.5 Implement the runtime capability guard and drift warning without adding semver or Effect; verify `pnpm vitest run packages/runtime/test` passes and the profile still boots when a capability is absent.
- [x] 3.6 Immediately use git to commit the artifact and runtime changes, excluding `openspec/` artifacts, and verify neither generated nor runtime manifests contain `engines.dsh`.

## 4. Remove the bundled YAML and path dependencies

- [x] 4.1 Add failing tests for the vendored `!!js` YAML schema round-trip and for local `DSH_HOME`/profile path resolution, including unset and absolute `DSH_HOME`; verify they fail.
- [x] 4.2 Vendor the `tag:yaml.org,2002:js` schema and expression predicate into the CLI, switch `materialize/yaml.ts` and `preflight.ts` to it, and remove the production `@deepseek-ai/cordis-plugin-include` and loader dependencies; verify the YAML and preflight tests pass.
- [x] 4.3 Add the local DSH home/profile resolver and replace direct `resolveProfileDir` imports in the CLI with it, keeping `doctor --profile` independent of an installed DSH; verify the new resolver tests and existing doctor/path tests pass.
- [x] 4.4 Remove the now-unused include/loader declarations from `packages/cli/package.json` and refresh the lockfile; verify `pnpm install` and `pnpm typecheck` succeed.
- [x] 4.5 Immediately use git to commit the dependency removal and vendored schema, excluding `openspec/` artifacts, and verify no production source still imports the removed packages.

## 5. DSH discovery

- [x] 5.1 Add failing cases to `packages/cli/test/dsh.test.ts` for precedence (`--dsh`, `EEDSH_DSH_ANCHOR`, `PATH`, project-local), package-directory and package.json inputs, invalid explicit selections, no installation found, and reported version/bin path; verify they fail.
- [x] 5.2 Implement the discovery module and the `DshFailure` codes for missing, invalid, unsupported, bridge, and capability failures; verify the discovery tests pass.
- [x] 5.3 Add cross-platform executable resolution coverage for a `PATH` launcher, including a Windows-style extension, and verify the discovery tests pass on the current platform.
- [x] 5.4 Verify discovery returns one installation object carrying anchor, launcher, version, and source, and that an invalid explicit selection never falls through to `PATH`.
- [x] 5.5 Immediately use git to commit discovery, excluding `openspec/` artifacts, and verify `git status` shows only the discovery module, tests, and related error types.

## 6. Capability bridge and dshVersion

- [x] 6.1 Add failing tests for loading `@deepseek-ai/dsh-app-boot` from a selected installation, validating the six required capabilities, installing and clearing the global bridge, and preserving it across two physical `@eedsh/config` module instances; verify they fail.
- [x] 6.2 Implement the bridge loader with `createRequire(installation.anchor)`, dynamic import, capability validation, the selected version, and the `Symbol.for('@eedsh/config.dsh-bridge')` registry; verify the bridge tests pass.
- [x] 6.3 Replace the static app-boot imports in `@eedsh/config` resolution with the global bridge and add structured `resolution.bridge_missing` and `resolution.bridge_capability_missing` failures; verify the resolution and config query tests pass.
- [x] 6.4 Replace the CLI's app-boot bundle resolution and preflight composition with the bridge, and remove app-boot from production dependencies while keeping a dev-only copy for tests; verify `pnpm vitest run packages/config/test packages/cli/test/materialize` passes.
- [x] 6.5 Add failing tests in `packages/config/test/api.test.ts` and `packages/config/test/authoring-objects.test.ts` for `dshVersion()` returning the selected exact version, ignoring plan data, failing without a bridge, and staying synchronous; verify they fail.
- [x] 6.6 Implement `dshVersion()` from the bridge and update `test/smoke.test.ts` to assert the export; verify the new tests pass.
- [x] 6.7 Immediately use git to commit the bridge and `dshVersion()`, excluding `openspec/` artifacts, and verify neither `@eedsh/config` nor `@eedsh/cli` has a production DSH/app-boot dependency.

## 7. Command wiring and migration behavior

- [x] 7.1 Add failing command tests for `sync`, `run`, and `repl` requiring a discovered DSH, `init` and `check` working without one, `doctor --profile` working without one, `--dsh` and `EEDSH_DSH_ANCHOR` overrides, and no writes on discovery or version failure; verify they fail.
- [x] 7.2 Wire discovery and bridge installation into the command flows before config evaluation, spawn the discovered launcher for `run`, and enforce the supported range before publishing; verify the command tests pass.
- [x] 7.3 Change `eedsh init` to write a config template with no `.dsh()` call and to resolve no DSH pin; verify init succeeds with no DSH installed and the generated config builds.
- [x] 7.4 Add coverage for `run --no-sync`, watch mode reusing one installation across passes, and a config calling `dshVersion()` during evaluation; verify the relevant CLI and watch tests pass.
- [x] 7.5 Immediately use git to commit command wiring, excluding `openspec/` artifacts, and verify the generated config template and CLI help contain no DSH pin.

## 8. Doctor without engine gates

- [x] 8.1 Add failing cases to `packages/cli/test/doctor.test.ts` for a discovered supported DSH, an unsupported discovered version, record-version drift, `--strict` behavior, and no finding when DSH is absent; verify they fail.
- [x] 8.2 Implement optional discovery and the provenance, supported-range, and drift findings in `doctor`, with no `engines.dsh` read; verify the doctor tests pass.
- [x] 8.3 Verify doctor remains read-only, does not acquire the sync lock, and reports an unreadable version-1 plan rather than trying to read it; run `pnpm vitest run packages/cli/test/doctor.test.ts packages/cli/test/integration/doctor.test.ts`.
- [x] 8.4 Immediately use git to commit doctor findings, excluding `openspec/` artifacts, and verify the doctor output identifies `eedsh sync` as the repair command.

## 9. Error reporting, active-origin rename, and REPL binding

- [x] 9.1 Add failing tests for reporter output for `dsh.not_found`, `dsh.unsupported_version`, `dsh.capability_missing`, and a preserved `resolution.bridge_missing` config-import failure; verify they fail.
- [x] 9.2 Implement the reporter mappings and ensure each failure is reported once with exit 1 rather than becoming a generic defect or `config.import_failed`.
- [x] 9.3 Rename the resolution origin from `pinned` to `active` across `@eedsh/config`, the REPL views, and the tests; remove `config.dsh`/`ConfigView.dsh`, `plan.dsh` from diffing, and `dshPin` from preview plans; key previews by the selected installation version instead; verify `pnpm vitest run packages/config/test packages/cli/test/repl` passes.
- [x] 9.4 Bind `dshVersion` in the REPL alongside the curated authoring factories and add a prompt test; verify the REPL binding tests pass.
- [x] 9.5 Immediately use git to commit the error, origin, and REPL changes, excluding `openspec/` artifacts, and verify no production code still returns `pinned` or reads `config.dsh`.

## 10. Architecture, documentation, and migration notes

- [x] 10.1 Add failing architecture checks that production `@eedsh/cli` and `@eedsh/config` manifests declare no `@deepseek-ai/dsh*` dependency and their sources contain no static DSH import, that no generated/runtime manifest contains `engines.dsh`, and that no version-1 plan reader exists; verify the checks fail before the updates.
- [x] 10.2 Update the architecture checks and any package manifests they inspect; verify `pnpm vitest run test/architecture.test.ts` passes.
- [x] 10.3 Update `README.md` and CLI help for installing `dsh`, discovery precedence, `--dsh`, the removed `.dsh()`, plan version 2, the absence of `engines.dsh`, `dshVersion()`, doctor findings, and the required re-sync after an upgrade.
- [x] 10.4 Update the `eedsh init` documentation and examples to show a config with no DSH declaration, and document the version-1 plan migration and rollback limits.
- [x] 10.5 Immediately use git to commit the architecture and documentation updates, excluding `openspec/` artifacts, and verify `pnpm lint` and `pnpm typecheck` pass.

## 11. Compatibility matrix and release verification

- [x] 11.1 Add a matrix test harness that installs or selects isolated `0.2.1-rc.2`, `0.2.1-rc.5`, and `0.2.2-alpha.2` installations and runs `eedsh sync` through `--dsh`; verify the harness runs locally for at least the current and target versions.
- [x] 11.2 Add the CI matrix and scheduled `latest`/`alpha` canary workflow; verify the workflow YAML is valid and the matrix names the three pinned versions.
- [x] 11.3 Run the matrix smoke test, `dsh --profile <name> --dump-config`, preflight, `dshVersion()`, runtime drift check, and the slow HMR test against the supported versions; record any environment-limited skip rather than claiming it passed.
- [x] 11.4 Run `pnpm verify`, `pnpm test:slow` where the environment supports it, and `openspec validate adopt-external-dsh --strict`; verify all pass.
- [x] 11.5 Immediately use git to commit the matrix harness and CI workflow, excluding `openspec/` artifacts, and verify the final `git status` contains only intended code, test, workflow, and documentation changes.
