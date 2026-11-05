## Context

`buildGeneratedBundle` derives the generation identifier from the canonical plan and the emitted patch-file hashes. The generation record separately records the exact `eedshVersion` and `dshVersion`. `materialize` treated a profile as unchanged when the identifier, the reconciled manifest, the authoritative plan, and the plan mirror all matched. Environment provenance was not compared, so a DSH upgrade could never refresh it through a normal sync.

The runtime warns when the record's `dshVersion` differs from the running installation and recommends `eedsh sync`. That warning was accurate but unrepairable without changing the plan.

## Goals / Non-Goals

**Goals:**

- A manual `eedsh sync` after a DSH upgrade refreshes the generation record's `dshVersion` and re-runs preflight against the new installation.
- The generation identifier stays the same when the plan and layers are unchanged.
- An eedsh version change refreshes the record with the same identifier.
- No runtime or artifact-format change.

**Non-Goals:**

- Automatic syncing from the runtime. Syncing stays explicit.
- Adding the DSH or eedsh version to the plan or the generation identifier.
- Changing the generation-record schema, the profile layout, or DSH boot behavior.
- Treating a *config* edit as a provenance refresh; only a published comparison triggers this path.

## Decisions

### 1. Extend the unchanged check with recorded versions

`lookup.record.dshVersion` and `lookup.record.eedshVersion` join the unchanged predicate. When either differs from `dsh.version` or `options.eedshVersion`, materialization continues into the normal publication path. It rebuilds the same `generated` bundle, writes the artifacts, preflights against the discovered installation, and commits the generated package manifest. The generation identifier does not change because the plan and layers do not; the record and manifest gain the new versions.

The alternative — including a version in the generation identifier — would make every DSH upgrade a new generation and cause the runtime watcher to reconcile an unchanged composition. Rewriting the record outside publication would skip preflight and atomic restore.

### 2. Preflight still runs on every provenance refresh

The repair is also the compatibility check. When the new DSH release no longer provides a row the plan targets, preflight reports it (or fails under `--strict`) and the previous generation stays committed. Reporting a version refresh as a plain metadata write would hide that incompatibility.

### 3. The runtime warning stays as-is

The runtime already names both versions and `eedsh sync`. With this change that recommendation succeeds. An automatic sync would require recording a config path and CLI entry and spawning the CLI from the runtime; the chosen product direction is to keep the sync manual and the runtime listener-free.

## Risks / Trade-offs

- A sync now republishes (and re-runs preflight) after an eedsh upgrade even when nothing else changed. The work is one preflight plus the same artifact writes, and it does not reinstall when dependencies are unchanged.
- A profile published by an older eedsh still refreshes correctly: sync compares its record with the current invocation and republishes.
- The runtime warning persists until the user runs the manual sync; that is the intended requirement.
