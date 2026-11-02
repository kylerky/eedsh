## Context

- DSH composition is a flat patch list: a bundle's patch files are `flatMap`ped before application, so file boundaries and any identifier inside them are invisible to composition. Only array position orders patches, and last write wins per row key (see the earlier layer-model analysis; the specs now state it).
- The current layer identifier is a file name, a diagnostic label, and a generation-id input. It is not a composition input, and it adds a filename-safety validation axis and a third naming namespace beside the row id and the package name.
- Configs are evaluated in-process by tsx with source maps enabled, so a V8 stack frame already carries the original `config.ts` line and column. Verified against a real config: the frame reads `<config dir>/config.ts:3:48`.
- The config project may resolve its own copy of `@eedsh/config`, distinct from the CLI's copy; the REPL explicitly imports the config project's copy. Module-level state in the authoring package therefore does not reliably reach the CLI, and the codebase already crosses that boundary with a `Symbol.for` global (`@eedsh/config.resolution-trace` in the REPL session).
- Plan and envelope decoding are strict (`onExcessProperty: 'error'`), and the authoritative plan is hashed with canonical JSON, so any provenance placed in the plan becomes contract and breaks hash portability.

## Goals / Non-Goals

**Goals:**
- Remove the authored identifier without losing the empty-group diagnostic or per-warning attribution.
- Attribute a warning to the exact patch and, when available, the line that wrote it.
- Publish provenance as an advisory artifact that never affects composition, hashing, or validity.
- Keep every previously published plan and generation record readable, with no plan or record version bump.

**Non-Goals:**
- Source instrumentation, AST rewriting, or a TypeScript transform.
- Making a row id the identity of a patch group.
- Emitting a single patch file (the per-group file is what makes an empty group observable).
- Changing DSH, its patch semantics, or its resolution rules.
- Provenance in the generated package or in anything DSH reads.

## Decisions

### D1 — Identity is position; the old identifier becomes an optional label
A patch group is identified by its index in `plan.layers`. `.layer(build)` declares an anonymous group; `.layer(label, build)` attaches a free-form, non-unique display label. The string argument keeps its position in the call, so existing `.layer('lsp', …)` configs compile and run unchanged and the value silently becomes a label.
The plan keeps `id` as a deprecated optional field and stops emitting it; the generation record does the same for its layer entries. Both are dropped from hashing only in the sense that new plans simply no longer contain them, so `PLAN_VERSION` and `GENERATION_VERSION` stay at 1 and an old profile still validates and can be read by `doctor` until its next sync.
*Alternatives:* a plan version bump (rejected: forces `doctor` to fail on every un-synced profile and needs a second schema); keeping the identifier required (rejected: the status quo this change exists to remove); using the row id as the group id (rejected: one patch can insert several rows, several patches target one row, and nested group children can repeat an id, so the identity would not be unique).

### D2 — One emitted file per group, named by position
Each group still emits its own YAML file, now `patches/<generationId>/0001.yml`. Collapsing to one file would make an empty group unobservable, which is the only diagnostic signal a group provides; positional names keep the artifact diffable without inventing an identifier. Nothing sorts these files, so the manifest list remains the ordering.

### D3 — Provenance crosses the module boundary through a process-global registry
`@eedsh/config` records sites while the config is evaluated and publishes the latest record on `globalThis[Symbol.for('@eedsh/config.provenance')]`. The CLI clears that slot before importing the config and reads it immediately after, next to the value it already unwraps, and `loadConfig` returns the record alongside the config.
This is the only channel that survives the config project resolving a different copy of the authoring package, and it mirrors the existing `resolution-trace` symbol. It keeps provenance out of the public config value and out of the strict envelope.
*Alternatives:* an optional field on the config envelope (rejected: adds a debug concern to the public `EedshConfig` contract, and a newer authoring package meeting an older CLI would trip `onExcessProperty: 'error'`); a module-level `Map` in the authoring package (rejected: two copies, two maps); a field in the plan (rejected: hashed, persisted, and machine-dependent).

### D4 — Capture one site per builder call from the V8 stack
Each builder method captures `new Error().stack` and selects the first frame whose file is outside the authoring package root, derived from `import.meta.url` and resolved for both the built `lib/` and the source-mapped `src/` layout. Capture is best-effort: a missing or unparseable frame yields no site and never fails evaluation. Frames are stored absolute in memory and relativized against the config directory when the sidecar is written, so no host path is ever persisted.
*Alternatives:* `Error.prepareStackTrace` (rejected: process-global and affects user code); a tsx transform hook (rejected: not applicable, this is our own call stack).

### D5 — Attribution is per patch, not per group
Both the site and the touched row ids address a single patch entry, so attribution recomposes prefixes over the **flat** patch list rather than over layers, and the first prefix whose warning count grows identifies the patch; the patch index maps back to its group and offset. This runs only under `--explain` when warnings exist, and is O(P²) compositions, which is acceptable at observed patch counts and is measured by a task.
*Alternatives:* per-group capture (rejected: mixes a group-level site with a patch-level message); matching the offending id in the warning text against patch contents (rejected: a heuristic that can be confidently wrong).

### D6 — The sidecar is advisory, generation-tagged, and outside the commit contract
`.eedsh/provenance.json` sits next to the plan mirror, is keyed by the generation id it describes, and is written after the mirror and before the generated package manifest, which remains the commit point. The precondition snapshots it with the manifest, lockfile, and mirror, and restores it on any later failure. It is excluded from the unchanged check: an unchanged materialization does not write one, and a missing sidecar is repaired by the next publication rather than by a no-op run.

### D7 — The REPL diff matches groups by content
With no identifier, `diffPlans` matches groups on the canonical JSON of their patches, consuming matches in order so repeated identical groups pair deterministically. Inserting or removing a group then reports exactly that group instead of reporting every later group as changed.

### D8 — Doctor ignores the sidecar
The sidecar is not part of record/plan/mirror consistency. An absent, malformed, or generation-mismatched sidecar produces no finding and changes no exit status, including under `--strict`, so provenance can be deleted at any time without turning a healthy profile red.

### D9 — One attribution format, degraded by what is known
Attribution renders `<group>: <message>`, where the group is `generated #<n>` followed by the label, the site, and the touched row ids as each becomes available. A warning from a bundle keeps its `bundle:<name>` label. The empty-group warning uses the same prefix, so `generated #2 (config.ts:9:5) contains no patches` replaces `generated layer "lsp" contains no patches`.

## Risks / Trade-offs

- **A loader other than tsx produces unusable frames** → capture is best-effort and evaluation never fails; a test evaluates a fixture through the real loader and asserts the site, so a regression is caught at the source rather than at the user.
- **A helper module receives the credit** → accepted and documented: the site is where the builder was called, which is still the author's code, and the group label covers the cross-file case.
- **Global registry goes stale between evaluations** → the CLI clears it immediately before each import and reads it immediately after; the record carries no cross-evaluation identity.
- **Attribution cost grows with patch count** → only under `--explain` with warnings present, prefix recomposition over a flat list; a task measures a representative config and records the number.
- **Sidecar drifts from the sources after edits that do not change the plan** → it is generation-tagged and advisory; the next real publication rewrites it, and consumers must treat a mismatched generation as unavailable.
- **Old code reading new artifacts** → the reverse direction is safe (old plans and records decode because the fields became optional), but an older eedsh cannot read a plan without `id`. Rolling back after syncing requires re-syncing with the older version from the config, which regenerates a plan carrying ids.
- **Test churn** → about 25 files assert on `layer(` or `generated:` labels; the label format change touches fixtures and expectations together, and the plan-schema suites gain legacy-id cases.

## Migration Plan

1. Authoring keeps compiling: `.layer('lsp', fn)` now attaches a label, so no config edit is required, and `.layer(fn)` becomes available for anonymous groups.
2. Previously published profiles stay valid: old plans and records decode with the deprecated optional `id`, so `doctor` is green before the first sync.
3. The first `eedsh sync` after the upgrade produces a different plan (no identifiers), hence a new generation id and positional patch files; publication is atomic, so the old generation remains bootable until the commit point.
4. Provenance appears on that first publication. Until then, attribution falls back to group position and touched row ids.
5. Rollback: revert the release and re-sync from the config, which republishes a plan with identifiers; a profile that has never been re-synced keeps a plan the older version can read.

## Open Questions

- Whether `doctor --profile` should later *display* recorded sites (the sidecar makes it possible) is a separate, additive change; nothing in this design depends on it.
