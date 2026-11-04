## Context

See `proposal.md` for the motivation. The current implementation conflates four concerns in one exact version:

- `@eedsh/cli` installs `@deepseek-ai/dsh@0.2.1-rc.2` and resolves its launcher from its own dependency tree.
- `@eedsh/cli` and `@eedsh/config` statically import `@deepseek-ai/dsh-app-boot`, and the CLI imports the patch-entry YAML schema from `@deepseek-ai/cordis-plugin-include`.
- `@eedsh/runtime` and the generated bundle declare exact `engines.dsh` values, so DSH skips both on any other version.
- `defineConfig().dsh()` is exact but is not used by materialization; the generated engine comes from the CLI's installed version.

This change removes the config-level DSH value and the plan's `dsh` field, removes `engines.dsh` from published bundles, discovers the user's DSH, and keeps only the exact discovered version in the generation record. DSH evaluates `engines.dsh` with prerelease-aware semver, but after this change there is no eedsh `engines.dsh` to evaluate; the CLI applies the supported range itself. The app-boot functions eedsh uses are present across the supported releases. Config evaluation happens in-process through tsx, so the CLI can install a synchronous bridge before importing a config module.

## Goals / Non-Goals

**Goals:**

- One user-installed DSH per invocation, used consistently for bundle resolution, preflight, generation provenance, and the launcher.
- A plan format with no DSH field, versioned at 2, with no version-1 reader.
- No `engines.dsh` on the generated bundle or the runtime bundle.
- The exact discovered DSH version remains recorded in every generation.
- A synchronous `dshVersion()` authoring API that returns the selected installation's exact version.
- RC.5 and alpha.2 work through the same path, with no alpha-specific branching.
- Missing, unsupported, and capability-incomplete installations fail before any profile is written or booted.

**Non-Goals:**

- No bundled DSH fallback. A separate installation is required.
- No per-profile or per-config DSH range or pin. The published artifact is not narrowed by config.
- No reader or migration for version-1 plans. They are rejected and profiles must be re-synced.
- No `engines.dsh` gate on eedsh bundles, including the runtime bundle.
- No support outside `^0.2.1-rc.2` in this change.
- No attempt to make eedsh authoring queries work in a plain script without the CLI bridge.
- No new package solely for DSH plumbing.

## Decisions

### 1. The plan is version 2 and has no DSH value

- Set `PLAN_VERSION = 2`.
- Remove `dsh` from `ProfilePlan`, `ProfilePlanSchema`, and the config envelope.
- Remove `.dsh()` from `ConfigBuilder`; `EedshConfig` contains only profiles and an optional default.
- `validateProfileDefinition(name, definition)` no longer receives a DSH value; each plan is built from the profile descriptor alone.
- Remove `DshPinSchema`, `DshRangeSchema`, and the plan package's semver dependency.
- Version-1 plans and version-2 plans carrying `dsh` fail validation. No legacy reader is added.
- A plain config that supplies `dsh` fails as an unknown field rather than having the value silently ignored.

The plan remains the artifact contract for profile name, ordered bundles, positional layers, and packages. It no longer describes the runtime it will run under.

Alternatives considered: keep `dsh` in the plan as an eedsh-written effective range (rejected by the requested removal); keep a version-1 reader (not needed); make the config value optional (still leaves a DSH field); remove only `.dsh()` but accept plain-config `dsh` (two ways to express a removed concept).

### 2. The supported range moves to the CLI

`SUPPORTED_DSH_RANGE = '^0.2.1-rc.2'` and the semver satisfaction check move to `@eedsh/cli`. The CLI validates the discovered installation before config evaluation for `sync`, `run`, and `repl`, and reports the range in unsupported-version failures. Neither the config, the plan, the generated bundle, nor the runtime package carries this string.

The plan package loses semver entirely. This keeps the plan contract pure and makes the compatibility policy belong to the tool that selects the installation.

Alternatives considered: keep the constant in `@eedsh/plan` (unused by the plan contract); use DSH's own `engines.dsh` check (the artifact no longer has one); hardcode the range in discovery (harder to test as policy).

### 3. Discovery is explicit and reports what it chose

Add a discovery module under the CLI with this precedence:

1. `--dsh <path>`
2. `EEDSH_DSH_ANCHOR`
3. a `dsh` launcher on `PATH`
4. `@deepseek-ai/dsh` resolvable from the working directory

A path may be the package directory or its `package.json`. Discovery reads the manifest, requires `name === '@deepseek-ai/dsh'`, and resolves `lib/bin.js` from the package root. PATH resolution follows the executable's real path, then walks to the owning package. The selected path and version are reported once and carried through the invocation.

An invalid explicit `--dsh` or anchor fails instead of falling through, so a typo never silently uses a different installation. One installation is selected per invocation; watch mode reuses it for every pass. `--dsh` is accepted by `sync`, `run`, `repl`, and `doctor`; `init` and `check` do not need it.

Alternatives considered: keep a bundled install and prefer it (reintroduces skew); discover per profile (profiles can disagree on bundle versions); resolve only from `node_modules` (breaks global installs).

### 4. The bridge is loaded from the selected DSH

Add a bridge loader in the CLI:

- Resolve `@deepseek-ai/dsh-app-boot` with `createRequire(installation.anchor)`.
- Import it dynamically before config evaluation.
- Require `resolveProfileDir`, `resolveBundleDir`, `readProfileManifest`, `bundlePatchFiles`, `loadOverlayPatches`, and `composeEntries`.
- Store the validated bridge on `globalThis` under `Symbol.for('@eedsh/config.dsh-bridge')`.
- Carry the selected exact version on the bridge for `dshVersion()`.

`@eedsh/config` reads that global instead of importing app-boot. The global symbol is deliberate: the config project may load a different physical copy of `@eedsh/config` than the CLI, and `Symbol.for` crosses module instances. A missing bridge is a tagged `resolution.bridge_missing` failure; a missing function is `resolution.bridge_capability_missing`.

The CLI still sets `EEDSH_DSH_ANCHOR` before config import. That variable remains the explicit discovery override and a compatibility signal; it is no longer the source of truth for query-time resolution. The bridge is.

If app-boot cannot be resolved or imported, fail with `dsh.bridge_unavailable`. Do not fall back to a bundled implementation.

Alternatives considered: keep static app-boot imports (still couples eedsh to the DSH release that built it); use `dsh --dump-config` as the only oracle (too slow for REPL queries and unable to return row-level provenance); add a new shared package for the bridge (unnecessary; the CLI produces and the config package consumes a structural object).

### 5. The CLI owns DSH home/profile paths; the bridge owns bundle semantics

`doctor --profile` must work with no DSH installed, so it cannot depend on the bridge for the profile directory. Add a small local resolver in the CLI for `DSH_HOME` or `~/.dsh` and `profiles/<name>`. Use it for doctor and for path displays. The bridge supplies `resolveProfileDir` when a config query needs a profile root.

Bundle resolution, manifest reading, and patch composition stay in the bridge, so preflight and authoring queries share one code path.

The CLI also vendors the ten-line `!!js` YAML schema used to emit and parse generated patch lists. That removes the production dependency on `@deepseek-ai/cordis-plugin-include` and its loader peer. The schema is a stable Loader convention: a scalar tagged `tag:yaml.org,2002:js` becomes `{ __jsExpr: string }`.

Alternatives considered: keep the include package pinned (still a DSH package in production); call the DSH CLI to parse every generated file (slow and lossy); use a home-path package from DSH (an avoidable production coupling).

### 6. Command wiring

| Command | DSH required | Bridge required | Behavior |
|---|---|---|---|
| `init` | no | no | writes a config template with no DSH declaration |
| `check` | no | no | typechecks only |
| `doctor --profile` | no | no | reports DSH findings only when a DSH is discoverable |
| `doctor` | optional | only if the config executes queries | evaluates the config for the profile name |
| `sync` | yes | yes | discover, validate range, load bridge, evaluate config, preflight, publish |
| `run` | yes | yes (except `--no-sync` without preflight) | sync, then spawn the selected launcher |
| `repl` | yes | yes | discover, load bridge, evaluate config, start the session |

For `sync`, `run`, and `repl`, discovery and bridge loading happen before config import so a top-level query or `dshVersion()` can resolve. `doctor` attempts discovery but continues without it; a query-free config still works, and a config that calls a bridge API fails with the bridge-missing diagnostic. `run` syncs and boots the same installation, so the generation record and the running process cannot disagree by accident. `--no-sync` skips preflight and logs the same version-drift condition the runtime will report.

### 7. Published artifacts have no DSH engine

The generated package manifest declares no `engines.dsh` field; it keeps `dsh.bundle.patch` and the generation record. `@eedsh/runtime` declares no `engines.dsh`; it keeps `engines.node`. The generation record keeps `dshVersion = discovered version`.

DSH therefore does not skip eedsh bundles because of a version gate. The CLI refuses to publish or boot under an unsupported DSH, and doctor reports a supported-range error. A profile that is booted by a DSH outside the supported range without running the CLI is not prevented by DSH; the runtime's drift warning is the remaining signal.

The generated package's generation identifier is still derived from the plan and layer hashes. The plan no longer contains a DSH value, so a discovery-only version change rewrites the generation record's `dshVersion` and manifest without changing the plan identity.

Alternatives considered: keep generated `engines.dsh` (rejected by the requested removal); keep only the runtime `engines.dsh` (would still gate the watcher); remove the generation record's `dshVersion` (loses drift detection/provenance); rely only on DSH's gate (no gate remains).

### 8. Doctor remains read-only and optional

Doctor reads the generation record's `dshVersion`. When discovery succeeds, it reports the selected path and version, errors when the version is outside eedsh's supported range, and warns when the record version differs. It does not read a generated `engines.dsh` and does not read version-1 plans.

When discovery fails, doctor reports no DSH finding. `doctor --profile` never needs DSH. Doctor does not modify the profile and points drift findings at `eedsh sync`.

### 9. Error identities and public API changes

Add a tagged `DshFailure` with a stable code and facts:

- `dsh.not_found`
- `dsh.anchor_invalid`
- `dsh.unsupported_version`
- `dsh.bridge_unavailable`
- `dsh.bridge_load_failed`
- `dsh.capability_missing`

Add `resolution.bridge_missing` and `resolution.bridge_capability_missing` to the authoring resolution failures. The CLI reporter selects diagnostics by tag and prints once.

Remove `.dsh()`, the `dsh` property on `EedshConfig`, and the plan's `dsh` field. Rename the resolution origin value `'pinned'` to `'active'`. These are breaking public changes.

### 10. `dshVersion()` exposes the selected version

`@eedsh/config` exports `dshVersion(): string`. It reads `bridge.version` from the global bridge, returns the exact selected version, and never selects or installs DSH. Without a bridge it throws a tagged authoring failure with `resolution.bridge_missing`. It does not write the value into the plan or generated manifest; it is for branching and logging only.

The REPL binds it alongside `bundle`, `defineConfig`, `group`, and `js`.

Alternatives considered: return `undefined` (hides a configuration error); make it async (authoring is synchronous); expose a full `dshInfo()` object (more surface than requested); read an environment variable (does not prove which installation was selected); allow it to pin the artifact (contradicts removing the DSH field).

### 11. Testing and release verification

- Plan tests for version 2, rejection of version 1 and of a `dsh` field, and plan hash changes.
- Generated-manifest tests for the absence of `engines.dsh` and the exact `dshVersion`.
- Runtime-manifest tests for the absence of `engines.dsh` and presence of `engines.node`.
- Discovery tests with temporary package layouts and a fake `PATH`, covering precedence, invalid explicit selection, and Windows-style executable resolution.
- Bridge tests with a fake bridge module and with a real DSH, covering missing functions, synchronous config queries across duplicated module instances, and `dshVersion()`.
- Command tests for `sync`, `run`, and `repl` requiring DSH; `init`, `check`, and `doctor --profile` working without it; and no writes on discovery or version failure.
- Doctor tests for supported-range errors, record drift, and no finding when DSH is absent.
- Integration matrix, one isolated install per version: `0.2.1-rc.2`, `0.2.1-rc.5`, `0.2.2-alpha.2`. Each runs `eedsh sync`, `dsh --profile <name> --dump-config`, preflight, `dshVersion()`, the runtime drift check, and the slow HMR test.
- Architecture checks: no production `@deepseek-ai/dsh*` dependency in `@eedsh/cli` or `@eedsh/config`; no static DSH import in their sources; no `engines.dsh` in the generated or runtime manifests; no version-1 plan reader.
- A scheduled canary installs the current `latest` and `alpha` dist-tags and runs the smoke path.

## Risks / Trade-offs

- **[app-boot is not a documented public API]** → Capability-probe before use, test every supported release, and fail with `dsh.capability_missing` rather than guessing. Keep a future option to use `dsh --dump-config` as a preflight oracle.
- **[Prerelease ranges accept future alphas that may break]** → Keep `^0.2.1-rc.2` as CLI policy, run the canary, and narrow it when a release proves incompatible.
- **[The runtime no longer has an engine gate]** → The CLI refuses unsupported versions and doctor reports them; the runtime logs record drift. A direct `dsh` run outside eedsh is not gated, which is the requested trade-off.
- **[Version-1 plans are unreadable]** → Re-sync publishes a version-2 plan. Doctor reports the invalid plan; no legacy reader is planned.
- **[Removing per-config narrowing loses artifact pinning]** → The exact version remains in the record and `dshVersion()`; if exact artifact pinning is needed later, add an explicit mechanism rather than restoring `.dsh()`.
- **[Configs that call `dshVersion()` cannot be evaluated without DSH]** → Fail with the explicit bridge-missing error naming the remedies.
- **[Discovery picks the wrong installation]** → Explicit precedence, no fallback from an invalid explicit selection, and a reported path/version. `--dsh` is the deterministic override.
- **[Global bridge and duplicated config package]** → Use `Symbol.for` and test with two physical `@eedsh/config` copies. Clear the bridge per invocation/test.
- **[Removing the bundled DSH is a UX regression]** → The product decision accepts it. The error names the install command and `--dsh`; `init` and `check` still work immediately.
- **[Removing `engines.dsh` lets DSH load a bundle under an unsupported version]** → eedsh's CLI and doctor enforce the range; the runtime reports drift. This is the requested trade-off of not encoding DSH compatibility in the bundle.

## Migration Plan

1. Ship the breaking release with plan version 2 and no `engines.dsh`.
2. Users install DSH separately (`npm install -g @deepseek-ai/dsh`) or pass `--dsh`/set `EEDSH_DSH_ANCHOR`.
3. Users delete `.dsh(...)` and any plain-config `dsh` field.
4. Users run `eedsh sync` to publish a version-2 plan and a manifest without `engines.dsh`. Version-1 profiles are not readable; the first sync rewrites them.
5. Users run `eedsh doctor` to confirm the discovered version, supported range, and record drift.
6. Rollback: the previous eedsh reads version-1 plans, so it cannot read the version-2 plans. Rolling back requires restoring the old config with `.dsh(...)` and re-syncing with the older release.
