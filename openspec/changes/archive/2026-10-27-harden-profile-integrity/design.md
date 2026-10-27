## Context

See `proposal.md` for motivation and the two spec deltas for the behavior contract. The current implementation is small and concentrated:

- `packages/cli/src/materialize/manifest.ts` owns reconciliation. `readPreviousGeneration` and `readGenerationId` both collapse an absent, malformed, foreign, or empty record into `undefined`/`null`.
- `packages/cli/src/materialize/program.ts` reads the profile manifest and generated package manifest, reconciles, decides `unchanged` from the generation id plus canonical manifest equality, then publishes.
- `packages/cli/src/materialize/publish.ts` writes patches and `.eedsh/plan.json`, snapshots the manifest and lockfile, writes the manifest, installs, preflights, then commits `.eedsh/generated/package.json` last. The plan write is outside the snapshot and the commit is outside the restore boundary.
- The CLI exposes `sync`, `run`, and `check`; `sync` already has `--strict` and `--explain` with distinct meanings. Diagnostics are a flat `warnings: string[]` from preflight.
- DSH reads `dsh.profile.bundles`; the profile is a pnpm project with `nodeLinker: hoisted` and a v9 `pnpm-lock.yaml`. Effect 4.0.6 ships `SemVer` and `SemVerRange`; `js-yaml` is already a CLI dependency.

The change is deliberately fail-closed and read-only where it inspects state. It does not add an npm dependency, does not bump the generation-record version, and does not add an ever-managed ownership ledger.

## Goals / Non-Goals

**Goals:**

- One strict, tagged generation-record reader shared by `sync` and `doctor`.
- Fail `sync` on an invalid record for an eedsh-managed profile, with an explicit adoption escape.
- Keep last-applied ownership and clean dependency sections outside `dependencies`.
- Make the committed plan content-addressable and the stable plan mirror transaction-consistent.
- Add a read-only `doctor` that verifies published state, including installed resolution, without locking or repairing.
- Deterministic diagnostics and exit statuses for both commands.

**Non-Goals:**

- Automatic recovery of ownership from the plan copy or any other artifact (owner decision).
- An ever-managed `owned` set, a release command, or historical adoption state.
- Installed-resolution enforcement during `sync`; it belongs to `doctor`.
- Doctor repair, config-drift reporting, DSH-version checks, JSON output, or network access.
- A generation-record schema version bump or a new plan field.

## Decisions

### D1. Tagged generation-record lookup with explicit adoption

Add a reader in `materialize/manifest.ts` (or a small `generation-record.ts` module it exports) that returns a tagged union:

```ts
type GenerationLookup =
  | { _tag: 'missing' }
  | { _tag: 'invalid'; path: string; reason: string; detail?: string; adoptable: boolean }
  | { _tag: 'valid'; record: GenerationRecord; previous: PreviousGeneration }
```

It validates the generated package `name`, `eedsh.format`, `eedsh.version === 1`, a non-empty `generationId`, a 64-hex `planHash`, non-empty string `bundles` that include `@eedsh/runtime` and `@eedsh/generated`, and non-empty string `packages`. A parse failure is `invalid` with `reason: 'unparseable'` so `doctor` can report it as a finding; the profile `package.json` reader keeps its existing hard parse error. An unsupported newer version is `invalid` with `adoptable: false` and a message to upgrade eedsh.

`materialize` decides absent versus invalid for a missing record: `missing` is a first run only when there is no eedsh artifact, meaning no runtime/generated bundle in `dsh.profile.bundles`, no `.eedsh/plan.json`, and no `.eedsh/generated` directory. A stray `.eedsh/sync.lock` does not count. Otherwise the missing record is an invalid one (`reason: 'missing'`) and blocks reconciliation.

Add `OwnershipRecordInvalid` to `internal/effect/errors.ts` with `path`, `reason`, `detail?`, and `adoptable`. `describeError` prints the path and reason, then either the upgrade instruction (not adoptable) or the `--adopt-ownership` recovery. The flag is `sync`-only and lives on `MaterializeOptions`; `run` users run `sync` once first. Adoption treats `previous` as undefined for the run, writes a fresh record, and emits a notice listing the adopted names.

Alternatives rejected: keeping `PreviousGeneration | undefined` and adding a separate existence check (two readers that drift); recovering from `.eedsh/plan.json` (rejected by the owner; the copy can be ahead of the committed record); silently preserving stale entries (the defect being fixed).

### D2. Last-applied ownership stays the model

No production behavior beyond D1. `previous` is always the last published record's managed sets. A re-added name is user-owned because the record no longer contains it. `--adopt-ownership` is the only explicit reset, and it is for an unreadable record, not for re-adopting a published removal. The spec pins the boundary with the three adoption scenarios.

Alternative rejected: extending the record with an ever-managed `owned` set plus a release surface. It buys stickiness the owner does not want and forces a record version bump and a new plan or CLI surface.

### D3. Dependency sections are cleaned; overrides are reported

Reconciliation computes `ownedNames = managedPackages ∪ previous?.packages`. A new helper in `manifest.ts`:

1. Reads `devDependencies` and `optionalDependencies` as string records. If the value is absent or `{}`, nothing. If the value is not a plain object, or any value is not a string, leave it untouched and emit a warning that the section could not be reconciled.
2. Deletes every `ownedNames` key from those two sections. The package stays in `dependencies`, so install behavior is unchanged except that the duplicate is gone. Removals are emitted as notices.
3. Scans `peerDependencies`, top-level `pnpm.overrides`, top-level `overrides`, and top-level `resolutions` for exact keys in `ownedNames`. It emits warnings and never edits them. Pattern-valued override keys are not parsed; the `doctor` resolution check is the authority for actual version effects.

`buildManifest` writes the cleaned sections only when they existed; unrelated fields and key order are preserved. `readProfileDependencies` becomes a reader of all three install-relevant sections, and `profileDependenciesChanged` compares the canonical `{ dependencies, devDependencies, optionalDependencies }` object so a section-only cleanup still runs `pnpm install`.

Diagnostics are a small shared type, for example `{ severity: 'warning' | 'notice'; message: string }`. `reconcileManifest` returns `notices` alongside the manifest; `publishProfile` and `materialize` pass them through; the CLI prints `eedsh: warning:` or `eedsh: notice:`. Preflight `warnings` stay a separate array, so the existing `--explain` hint is only suggested for layer-attributed messages. Notices are sorted by section and package name for deterministic output.

### D4. The plan is committed with the record; the stable path is a mirror

The authoritative plan path is a deterministic function of the generation id:

```ts
authoritativePlanPath(generationId) === `plans/${generationId}.json`
```

`buildGeneratedBundle` adds that file to `files` immediately before `package.json`, with content exactly `canonicalJson(plan)` (no trailing newline), so `sha256(content) === planHash`. `writeGeneratedBundle({ includeManifest: false })` writes it with the patches. A failed attempt leaves an unreferenced plan file, exactly like the patch directory for that generation.

`.eedsh/plan.json` remains the documented stable path, but it is derived: it mirrors the committed plan with a trailing newline and is written after preflight, immediately before the commit. It is not referenced by the record.

Publication order becomes:

```
snapshot package.json, pnpm-lock.yaml, .eedsh/plan.json
write patches + plans/<generationId>.json
write package.json
install                                   <-- restore on failure
preflight                                 <-- restore on failure
write .eedsh/plan.json mirror             <-- restore on failure
commit .eedsh/generated/package.json      <-- restore on failure
```

The snapshot moves before any profile write and `ProfileSnapshot` gains the mirror path and bytes. `restoreProfileFiles` restores all three. The commit write joins the restore boundary; the atomic-write helper's documented guarantee (a failed write or rename leaves the target untouched) makes restoring correct. If the commit succeeds, no later fallible step exists.

The unchanged check in `program.ts` gains an artifact verification: the current generation's authoritative plan must exist and hash to the recorded `planHash`, and the mirror must match the committed plan. If the id and manifest match but either artifact is missing or different, materialization publishes with the same generation id (no install, preflight still runs) instead of returning `changed: false`. This is what repairs an older profile that predates the plan file and what lets `doctor` report a stale mirror.

The mirror comparison is semantic (canonical JSON), so hand formatting of `.eedsh/plan.json` is repaired rather than flagged. The authoritative comparison is byte-exact because the file is generated.

Alternative rejected: adding `planFile` to the record and bumping to version 2. Deriving the path from `generationId` is simpler, keeps the record at version 1, and still lets a reader locate and verify the plan.

### D5. Doctor is a read-only check pipeline

Add `packages/cli/src/doctor.ts` exporting an Effect program that takes the resolved profile directory and `FileSystem`. It does not use `PackageManager`, `SyncLock`, `DshInstallation`, or any write API. The CLI adds a `doctor` subcommand with `--profile`, `--config`, and `--strict`; `--profile` and `--config` are mutually exclusive usage errors.

Profile selection in `cli.ts`:

- `--profile <name>`: validate the name with the profile-name rules (no separators, not `.`, `..`, or `node_modules`) and resolve with `resolveProfileDir(name, env.DSH_HOME)`.
- Otherwise: resolve and load the config, use `plan.profile.name`, and ignore the plan content. This is only a name lookup; config drift is out of scope.
- Both: print a usage error and exit 2.

Check pipeline, in order, with independent checks continuing after a warning and dependent checks skipped after an error:

| Check | Source | Severity |
|---|---|---|
| Record present and valid | `.eedsh/generated/package.json` | error |
| Authoritative plan present, hashes, decodes | `plans/<generationId>.json` | error; missing is warning |
| Record, plan, and mirror agree | record, plan, `.eedsh/plan.json` | record/plan inconsistency is error; mirror is warning |
| Managed bundles and dependencies | `package.json` | error |
| Dependency-section conflicts | `package.json` | warning |
| Scaffolding present | `cordis.yml`, `cordis.patch.yml`, `pnpm-workspace.yaml` | warning |
| Lockfile entries and ranges | `pnpm-lock.yaml` | error |
| Installed packages and versions | profile module layout | error |
| Snapshot unchanged | record before and after | error |

Implementation details:

- Record: reuse D1's reader. Missing, invalid, or unsupported version stops the pipeline; there is no adoption in doctor.
- Authoritative plan: hash the bytes against `record.planHash`, then decode with `ProfilePlanSchema`. Missing is a warning (the next sync republishes); wrong hash or invalid content is an error. If the plan is unusable, skip the record/plan consistency checks but continue with record-based manifest and installation checks.
- Record/plan consistency: `record.bundles` must equal `managedBundleOrder(plan)`; every `plan.packages` entry must have the same spec in `record.packages`; `record.packages` must contain exactly those names plus `@eedsh/runtime` and `@eedsh/generated`. The runtime and generated specs are record facts, not plan facts.
- Mirror: compare the canonical parsed mirror with the authoritative plan. Missing or different is a warning.
- Manifest: read `package.json` (hard parse error is a finding). Managed bundles must be a prefix in recorded order. Managed packages must match the recorded spec in `dependencies`. Managed names in `devDependencies`, `optionalDependencies`, `peerDependencies`, `pnpm.overrides`, `overrides`, or `resolutions` are warnings. Reuse D3's scanner so sync and doctor cannot drift.
- Lockfile: parse with `js-yaml` inside `Effect.try`. Accept lockfile version 9.x. Use `importers['.']` or, when there is exactly one importer, that importer; otherwise report an error. Every managed package needs an entry. Compare the entry specifier with the record spec; a difference is a warning because pnpm may normalize. For a semver-range spec, parse the resolved version (strip a trailing pnpm peer suffix such as `(peer@1.0.0)`) and use `SemVerRange.matches`. A parse failure of the spec means it is non-semver: check presence only. A missing entry or an out-of-range resolved version is an error.
- Installed packages: read `node_modules/<name>/package.json`, following links. Missing is an error. For semver specs, compare the installed version with the lockfile version and check the range. For `link:`, `file:`, and `workspace:`, report the installed version without a range check. This assumes the eedsh profile workspace uses `nodeLinker: hoisted`; a profile whose workspace was changed may produce a "not resolvable" error, which is a useful diagnostic rather than a silent pass.
- Scaffolding: presence only; missing is a warning because DSH and sync can recreate or repair the files.
- Snapshot: re-read the record at the end. A changed or now-invalid record produces an error asking the user to rerun; a clean summary is never printed for a torn read.

Findings are `{ severity: 'error' | 'warning'; check: string; message: string; path?: string }`. Output is plain text, errors before warnings, then check and message for determinism, followed by `N errors, M warnings`. Exit 0 when there are no errors and either no warnings or no `--strict`; exit 1 otherwise; usage errors exit 2. Doctor never repairs; messages point to `eedsh sync` or `eedsh sync --adopt-ownership`.

No lock is acquired. The generation-id double read is the consistency mechanism; a same-id republish during the run is harmless because the record and plan content are unchanged.

### D6. CLI and error plumbing

- `cli.ts` adds `doctorCommand` to the root subcommands and `--adopt-ownership` to `sync`. `--explain` remains sync-only; `doctor` rejects it as a usage error.
- `printResult` prints preflight `warnings` with `eedsh: warning:` and reconciliation `notices` with their severity. The `EXPLAIN_HINT` condition remains tied to preflight warnings.
- `MaterializeResult` gains `notices`; `PublishProfileResult` gains `notices`; `ReconcileManifestResult` gains `notices`.
- `OwnershipRecordInvalid` joins `MaterializeError`; the CLI reports it through the normal failure path and exits 1. The adoption run emits an adoption notice and exits 0.
- No new dependencies. Effect's `SemVer` and `SemVerRange` are used only by doctor and isolated in a small helper so a future replacement is local.

### D7. Test strategy

- Unit: generation lookup matrix (missing, unreadable, unparseable, wrong name/format/version, empty sets, valid); absent-versus-invalid heuristics; adoption; last-applied re-adoption.
- Reconciliation: dev/optional cleanup, unrelated entries, malformed sections, peer/override warnings, previous-name cleanup, section-only install trigger.
- Publication: authoritative plan file order/content/hash; same-id republish for a missing plan or mirror; failure restoration for install, preflight, mirror, and commit; leftover artifacts unreferenced.
- Doctor: one test per finding, clean profile, all exit-code combinations, no writes, profile/config selection, mutual exclusion, snapshot change, semver ranges, linked packages, missing lockfile, installed-version mismatch.
- CLI: help text and flag acceptance, notices versus `--explain` hint, doctor usage and output.
- Integration: publish a temp profile, run doctor clean, then corrupt the record, plan, manifest, lockfile, and installed package in turn and assert the findings and exit status.

## Risks / Trade-offs

- **Fail-closed blocks sync on a corrupt record** -> The diagnostic names the path and reason and offers `--adopt-ownership`; adoption is documented as permanent. This is the owner's chosen trade.
- **Adoption can silently freeze stale managed entries as user-owned** -> The adoption notice lists them; the README states the consequence. No automatic recovery exists by design.
- **Doctor false positives from pnpm layout or normalization** -> Prefer the installed version for range checks, strip pnpm peer suffixes, compare lockfile specifiers as warnings, and name the expected path in errors. Effect SemVer is marked unstable; it is pinned with the existing exact Effect version and isolated behind one helper.
- **Lockfile version drift (future pnpm)** -> Doctor reports an unsupported lockfile version as "installed state cannot be verified" instead of guessing. A future format is a separate change.
- **Pattern-valued overrides are not parsed** -> D3/D5 report exact-name conflicts only; the resolved-version check is the authoritative consequence test, so a patterned override that changes a managed version still fails doctor.
- **The mirror can be stale after an abrupt crash** -> The record and `plans/<generationId>.json` remain authoritative; doctor warns about the mirror and the next sync rewrites it. The same-id republish path repairs a missing authoritative plan.
- **The commit restore assumes the atomic-write contract** -> The helper's documented behavior is that a failed write/rename leaves the target untouched; the restore wraps only effects that fail under that contract.
- **No record version bump** -> A future format change must add version 2 and update the reader; today unknown versions fail closed with an upgrade message.
- **Doctor without a lock can see a mid-publish state** -> The generation-id double read catches a generation change; same-id republishes keep content stable. Doctor is documented as a point-in-time snapshot.

## Migration Plan

1. Deploy the CLI. No record or plan schema migration is needed.
2. The first `sync` after upgrade on an existing profile republishes the same generation to add `plans/<generationId>.json` and refresh the mirror. It does not install dependencies and the generation id is unchanged.
3. A profile with an unreadable record now fails `sync`; run `eedsh sync --adopt-ownership` once and review the reported adopted names.
4. `doctor` on an existing profile reports a warning for the missing authoritative plan until step 2 runs; no error.
5. Rollback: the old CLI ignores the new plan file and the `--adopt-ownership` flag; the record remains version 1. Dependency-section cleanup is not automatically reversed, so re-add removed `devDependencies` or `optionalDependencies` entries manually if needed. The fail-closed behavior reverts to silent preservation.

## Open Questions

- Should `doctor` gain a machine-readable `--json` output? Deferred; the human-readable contract is enough for this change.
- Should `doctor` detect unpublished config changes by comparing the current plan hash? Deferred and explicitly out of scope; `sync` owns publication.
- Should `run` accept `--adopt-ownership` directly? Deferred; running `sync --adopt-ownership` once is sufficient.
