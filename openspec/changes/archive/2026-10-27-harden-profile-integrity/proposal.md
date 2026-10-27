## Why

The reconciler trusts the generation record to know which manifest entries eedsh owns. When that record is missing or malformed, `sync` silently reclassifies eedsh-managed entries as user-owned, so stale bundles and dependencies survive indefinitely. The stable plan copy can also disagree with the record after a failed publish, and dependency declarations outside `dependencies` can bypass managed specifications without a diagnostic. Operators have no read-only way to verify that a published profile still matches what eedsh committed.

## What Changes

- **BREAKING** `eedsh sync` fails with a tagged diagnostic when an eedsh-managed profile's generation record is missing or invalid, instead of silently preserving stale entries. `--adopt-ownership` re-baselines ownership from the current manifest.
- Keep last-applied ownership semantics: a bundle or dependency removed by a published generation and later re-added by hand is user-owned. This is documented and pinned by a spec scenario.
- Reconcile managed and previously managed package names out of `devDependencies` and `optionalDependencies`; preserve unrelated entries and malformed sections. Warn on conflicts in `peerDependencies`, `pnpm.overrides`, `overrides`, and `resolutions`. The install decision covers every dependency section the reconciler can change.
- Write the authoritative plan as `plans/<generationId>.json` inside the generated package, before the package manifest, and verify it in the unchanged check. Keep `.eedsh/plan.json` as a mirror written at the commit point, snapshotted and restored with the manifest and lockfile.
- Add `eedsh doctor`, a read-only command that verifies the published generation record, plan provenance, manifest reconciliation, dependency sections, lockfile, and installed package resolution. It reports findings, exits 1 on errors (and on warnings with `--strict`), and never repairs.
- Separate reconciliation notices from preflight warnings so `--explain` is suggested only for layer-attributed preflight diagnostics.

## Capabilities

### New Capabilities
- `profile-doctor`: the read-only `eedsh doctor` command: profile selection, published-state integrity checks, installed-resolution verification, diagnostics, and exit status.

### Modified Capabilities
- `generated-profile-materialization`: generation-record validity and ownership re-baselining, last-applied adoption semantics, dependency-section exclusivity, authoritative plan provenance and mirror publication, and reconciliation diagnostics.

## Impact

- **CLI surface**: new `eedsh doctor` command with `--profile`, `--config`, and `--strict`; new `sync --adopt-ownership` flag.
- **CLI internals**: `cli.ts`, `materialize/manifest.ts`, `materialize/program.ts`, `materialize/publish.ts`, `materialize/generated-bundle.ts`, materialization errors, and a new doctor module.
- **Profile layout**: new `.eedsh/generated/plans/<generationId>.json` authoritative artifact; `.eedsh/plan.json` remains as a derived mirror.
- **Dependencies**: no new package. Doctor resolution checks use `effect/SemVer` and `effect/SemVerRange`; lockfile inspection uses the existing `js-yaml`.
- **Compatibility**: the generation record stays format `eedsh/generation`, version 1; no plan schema change. Profiles published by older versions gain the authoritative plan on the next successful sync. A missing or unreadable record now blocks `sync` until `--adopt-ownership` is used.
- **Tests**: manifest reconciliation, publication failure/restore, no-op plan verification, dependency-section cleanup and install triggering, doctor findings and exit codes, CLI usage, and a temp-profile integration check.
