## Why

eedsh currently ships its own exact `@deepseek-ai/dsh` installation, requires every config to declare a DSH pin, and stamps an exact `engines.dsh` into every published bundle. Every DSH release therefore requires a matching eedsh release, a profile published under one DSH version is skipped by the next, and the config-level pin duplicates a value eedsh already owns.

The chosen product direction is that eedsh requires the user's `dsh` to be installed and operates on that installation. The config should not declare a DSH version at all: the plan has no DSH field, and bundle compatibility is not encoded in `engines.dsh`.

## What Changes

- **BREAKING** `@eedsh/cli` no longer declares `@deepseek-ai/dsh` as a production dependency and no longer boots its own copy. Commands that need DSH discover the user's installation; `eedsh init` and `eedsh check` do not need one.
- Add discovery with explicit precedence: `--dsh <path>`, `EEDSH_DSH_ANCHOR`, a `dsh` launcher on `PATH`, then a project-local `@deepseek-ai/dsh`. Report the selected path and version.
- **BREAKING** Remove `defineConfig().dsh()` and the config-level DSH value. A config declares profiles only. Existing configs must delete the call.
- **BREAKING** Bump the profile plan to version 2 and remove the plan's `dsh` field. Version-1 plans are rejected; eedsh does not read them.
- **BREAKING** Remove `engines.dsh` from the generated bundle and the `@eedsh/runtime` package. DSH no longer decides whether to load eedsh bundles by DSH version; eedsh validates the discovered installation before publishing or booting.
- Keep eedsh's supported DSH range, `^0.2.1-rc.2`, as a CLI-level policy. The discovered version must satisfy it, but no artifact carries it.
- Add a synchronous authoring API, `dshVersion(): string`, that returns the exact version of the selected DSH installation so a config can branch or log on it. It cannot narrow or pin the published artifact.
- Keep the exact discovered version in the generation record's `dshVersion` for provenance and runtime drift reporting.
- **BREAKING** `@eedsh/config` and `@eedsh/cli` no longer bundle `@deepseek-ai/dsh-app-boot` or the patch-entry YAML schema. A capability bridge loads those from the discovered DSH before config evaluation and preflight.
- Extend `eedsh doctor` with optional discovered-DSH provenance and drift findings while keeping the command usable when no DSH is installed.
- Add tagged failures for missing, unsupported, or capability-incomplete DSH installations, and preserve them through config evaluation and the CLI reporter.
- Add a CI matrix that pins `0.2.1-rc.2`, `0.2.1-rc.5`, and `0.2.2-alpha.2` exactly and runs sync, preflight, runtime, and HMR integration against each.
- Document the migration: install `dsh` separately, delete `.dsh()`, re-sync to publish version-2 plans, and expect version-1 plans not to be read.

## Capabilities

### New Capabilities
- `external-dsh`: discovery, selection, supported-version enforcement, the capability bridge, command-level DSH requirements, removal of bundle version gates, and exact DSH provenance for a user-installed DSH.

### Modified Capabilities
- `multi-profile-config`: the config has no shared DSH value; only named profiles and selection remain.
- `typed-profile-layering`: the plan is version 2 and has no DSH field; authoring produces plans without a DSH value.
- `authoring-objects`: `.dsh()` is removed, unrooted queries use the active installation, and `dshVersion()` exposes the running version.
- `authoring-resolution`: queries read bundle rows through the active installation's bridge instead of a CLI-pinned anchor, and fail when no bridge is available.
- `config-repl`: provenance names the active installation and the session binds `dshVersion`.
- `generated-profile-materialization`: the generated manifest has no `engines.dsh`, the plan is version 2, and preflight composition uses the discovered DSH.
- `profile-doctor`: doctor has no generated-engine check, still works without DSH, and reports discovered provenance, supported-range, and record-drift findings.
- `generated-layer-hmr`: the runtime has no DSH engine gate, still probes required HMR capabilities, and reports generation/runtime version drift.
- `error-handling`: DSH discovery, supported-range, bridge, and capability failures join the tagged failure model.

## Impact

- **Plan format**: `PLAN_VERSION` becomes 2; `ProfilePlan` has no `dsh`; version-1 plans fail validation. Published profiles must be re-synced before doctor can read their authoritative plan.
- **Config API**: `.dsh()` and the `dsh` property are removed; `EedshConfig` contains profiles and an optional default. `dshVersion()` is the only DSH-version authoring API.
- **Artifacts**: generated and runtime bundles declare no `engines.dsh`. DSH loads them without a version gate; eedsh's CLI and doctor enforce the supported range and report record drift.
- **Packages**: `@eedsh/plan` no longer needs DSH range validation or semver; `@eedsh/cli` owns the supported-range check and adds semver; `@eedsh/config` drops its app-boot dependency and reads the bridge; `@eedsh/runtime` drops its DSH engine and probes HMR capabilities.
- **Public API**: removing `.dsh()`, the plan `dsh` field, and `engines.dsh`, plus the active-origin rename, are breaking.
- **Configuration and tests**: configs, fixtures, assertions, README examples, architecture checks, and integration tests move from a bundled/versioned DSH to a discovered one. Local tests use a dev-only DSH; CI installs each matrix version in isolation.
- **Operations**: users must install `dsh` (or pass `--dsh`) before `sync`, `run`, or `repl`; `init` and `check` remain usable without it. An upgrade requires `eedsh sync` to publish a version-2 plan.
