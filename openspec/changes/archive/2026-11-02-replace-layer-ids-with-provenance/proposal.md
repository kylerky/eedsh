## Why

The generated patch layer requires a hand-written identifier (`.layer('lsp', ...)`) that never reaches DSH: DSH flattens a bundle's patch files and reads only the patches, so the identifier contributes nothing to composition, and order comes from position in the array, not from the name. It exists so `--explain` has something to print, and it costs a third naming namespace beside the row id and the plugin package name, a filename-safety validation axis, and a new generation id whenever it is renamed. The information that would actually locate a bad patch — the line in `config.ts` that produced it — is already available from the TypeScript stack and is currently discarded.

## What Changes

- `.layer(build)` declares an anonymous patch group, and `.layer(label, build)` attaches optional display metadata. Existing `.layer('lsp', build)` call sites keep compiling: the string becomes a label, and `.layer('lsp', build)` and `.layer(build)` are both valid. A group's identity is its position; no identifier is authored or emitted, and a label is neither unique nor part of the plan.
- The plan's `layers[]` entries no longer carry a required `id`. `id` stays accepted as a deprecated, ignored optional field so previously published plans and mirrors keep decoding, matching the existing deprecated `NamedBundle.source` precedent. The plan version is not bumped.
- Generated patch files are named by position (`patches/<generationId>/0001.yml`) instead of by layer id; the generated package manifest lists them in plan order. The generation record's layer entries likewise stop carrying an identifier and keep `id` optional when reading, so an already-published record stays readable.
- New **patch provenance**: `@eedsh/config` records one authoring site (file, line, column) per builder call during config evaluation, plus an optional group label, and exposes the most recent evaluation's record to the CLI.
- New advisory sidecar `.eedsh/provenance.json`, keyed by generation id, carrying per-group labels and per-patch sites. It is written at the publication commit point and is never read by DSH.
- **`eedsh sync --explain`** attributes a warning to its exact patch, printed as `generated #<n>` plus the authoring site when known and the row ids the patch touches. The empty-group warning uses the same form.
- **REPL** prints group changes identified by patch content rather than by id, and annotates each composed row with the site that last touched it.
- **`eedsh doctor`** treats the sidecar as advisory: absent, unreadable, or stale provenance is never a finding and never affects exit status.

## Capabilities

### New Capabilities
- `patch-provenance`: per-patch authoring-site capture during config evaluation, and the published sidecar that carries it.

### Modified Capabilities
- `typed-profile-layering`: patch layers become anonymous ordered groups; the plan and schema lose the required layer identifier.
- `preflight-diagnostics`: attribution names a positional group, the authoring site, and the touched row ids instead of a layer id; empty groups are specified.
- `config-repl`: evaluation diffs identify groups by content, and the composition view reports row provenance by site.
- `generated-profile-materialization`: positional patch file names, the provenance sidecar in the publication set, and the generation record layer list without identifiers.
- `profile-doctor`: the provenance sidecar is explicitly outside the consistency check.

## Impact

- `@eedsh/config`: `ProfileBuilder.layer` signature, `LayerBuilder` site capture, a provenance registry module, public exports.
- `@eedsh/plan`: `PlanLayerSchema` (optional deprecated `id`), validation rules, derived types.
- `@eedsh/cli`: generated-bundle file naming and manifest, publication (sidecar write and restore), preflight attribution, REPL diff and composition sources, doctor exclusions, config evaluation plumbing.
- Tests: about 25 files assert on `layer(` or `generated:` labels, including fixtures under `packages/cli/test/fixtures/*/config.ts` and the plan-schema suites.
- Docs: root `README.md` (layer model, example configuration, migration table, CLI reference) and `packages/config/README.md`.
- Published profiles: a previously published generation still decodes (deprecated `id` keeps it valid), so `doctor` stays green until the next sync, which republishes with positional file names and a new generation id.
