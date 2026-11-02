## Why

Authoring a modified DSH agent preset currently requires cloning a frozen query row, converting DSH's parsed `!!js` shape into eedsh's plan expression node by hand, editing a raw nested child array, and replacing the whole preset registry config. The API exposes transport shapes and forces helper code into every config, while failures raised during config evaluation are wrapped as generic import failures. The plan format does not need to change to fix this; the authoring boundary does.

## What Changes

- Add `definePreset()` returning a mutable `PresetDefinition` with preset id, optional row id, name, description, order, and `.from(installedPreset)` to copy an installed preset's child list.
- Add a nested `.children((children) => { ... })` authoring scope. Children are edited one at a time through scoped handles; list operations accept one entry per call. No variadic child operations and no implicit child-to-parent chain.
- Add structured `PresetDefinitionError` failures for missing or ambiguous child lookups and anchors.
- Add `LayerBuilder.selectPreset(selected, { default })`, accepting preset references for both values, requiring the deployment default explicitly, and writing the full `agent-preset-registry` config.
- Normalize resolved bundle rows to plan expression nodes at the query boundary, so query results and cloned preset bodies are directly insertable without user-written conversion helpers.
- Preserve tagged authoring errors through config import. `ResolutionError` and `PresetDefinitionError` reach the CLI/REPL formatter with their codes instead of becoming `config.import_failed`.
- **BREAKING** Remove `source` from the bundle-selection authoring API and stop emitting it. Keep `NamedBundle.source` in the plan schema as accepted legacy data; no plan version bump.
- Keep bundle selection and package dependencies as separate concepts and explicit API calls.
- Warn when a generated layer contains no patches, using the existing preflight warning, attribution, and strict behavior.
- **BREAKING** Query handles now expose plan-shaped expression nodes instead of DSH's internal `__jsExpr` objects.

## Capabilities

### New Capabilities

- `preset-authoring`: authoring an agent preset definition from an installed preset, editing its child list through a nested scope, selecting it with an explicit deployment default, and reporting child lookup failures.

### Modified Capabilities

- `authoring-resolution`: query results are required to be directly plan-compatible, including expression normalization.
- `error-handling`: tagged authoring failures are preserved through config import and reported with their identities; the synchronous authoring exception boundary is documented.
- `preflight-diagnostics`: empty generated layers produce a preflight warning with the same raw, attributed, and strict behavior as other warnings.

## Impact

- `packages/config`: new `definePreset` / `PresetDefinition` / `PresetChildren` / `PresetChild` authoring objects; `PresetDefinitionError`; `LayerBuilder.selectPreset`; query expression normalization; removal of `BundleOptions.source`.
- `packages/cli`: preserve tagged authoring errors in config loading and format them in CLI/REPL output; warn on empty generated layers; bind `definePreset` in the REPL and extend completion.
- `packages/plan`: no schema or version change. `NamedBundle.source` remains accepted legacy data but is no longer produced.
- Tests, README, config examples, REPL help/completion, and fixtures gain preset authoring, expression round-trip, error-propagation, empty-layer, and source-removal coverage.
