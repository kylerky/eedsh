## Context

See `proposal.md` for the motivation and the spec deltas for the required behavior.

The current authoring boundary has three representations for the same data:

1. DSH's entry-list parser returns runtime expressions as `{ "__jsExpr": "<source>" }`.
2. Eedsh's plan requires `{ "$eedsh": { "expr": "<source>" } }`.
3. `@eedsh/config` query handles currently expose the first shape while claiming to expose the second.

That mismatch is why a config needs a user-written walk before inserting a cloned preset. The plan schema itself is deliberately opaque for plugin config, so it cannot catch the semantic mistake.

The other constraints:

- Query handles are synchronous and immutable; authoring builders are mutable and single-use.
- The plan is persisted, hashed, and compared. This change must not change its schema or version.
- The config project can hold a different copy of `@eedsh/config` from the CLI. Cross-copy discrimination must be structural, never `instanceof`.
- The architecture check allowlists authoring/query exceptions and requires a recorded reason for each site.
- DSH preset rows carry a Loader row id plus a preset id in `config.id`. The registry selects the preset id, not the row id.

## Goals / Non-Goals

**Goals:**

- Make resolved query rows directly plan-compatible, including nested runtime expressions.
- Provide a preset-definition object with a scoped child editor and explicit metadata.
- Preserve tagged authoring failures through config import and format them by identity.
- Keep preset selection explicit about the deployment default.
- Remove the inert bundle `source` authoring option without changing the plan version.
- Warn about empty generated layers in the existing preflight warning channel.

**Non-Goals:**

- No plan format or plan version change.
- No rename of the existing query `Preset` handle.
- No recursive child addressing through nested groups.
- No combined `bundlePackage` helper; bundle selection and package installation remain separate calls.
- No new publishing path, materializer change, or plan schema relaxation.
- No automatic registry-row insertion when `selectPreset` targets a profile without one.

## Decisions

### 1. Normalize expressions at resolution, not at build

The resolver SHALL convert DSH's exact `{ __jsExpr: string }` marker to the plan's `{ $eedsh: { expr: string } }` node immediately after composing a bundle's rows and before freezing them.

This makes `Row.data`, `Row.toJSON()`, `Preset.data`, and `Preset.toJSON()` satisfy the existing `authoring-resolution` contract. `PresetDefinition.from()` can then copy plain plan data without knowing about DSH's YAML parser.

*Alternatives considered:* normalize inside `normalizeAuthoring()` at build time (leaves query handles wrong and keeps the helper trap), export a public converter (still makes the author call it), change the plan schema to accept `__jsExpr` (leaks DSH's transport shape into the persisted contract).

The conversion is shape-exact: only a record whose sole key is `__jsExpr` with a string value is converted. All other opaque config remains untouched.

### 2. `definePreset` is authoring sugar over an ordinary row

`definePreset(id, options?)` returns a mutable `PresetDefinition` branded with a new `preset-definition` authoring kind. Its normalized value is:

```ts
{
  id: rowId,                    // default: "preset-" + presetId
  name: '@deepseek-ai/dsh-agent-preset',
  config: {
    id: presetId,
    name,
    description,
    order,
    plugins: [...children],
  },
}
```

The builder validates a non-empty preset id and derives a default row id. Supplying an explicit row id overrides the derivation. `from(installed)` copies only `installed.config.plugins`; identity and metadata remain explicit to the new definition.

The `preset-definition` brand is distinct from the query `Preset` brand, so a newly authored definition is not accepted as a patch target for an existing row. `LayerBuilder.insert()` accepts it; layer `disable` / `override` still accept only row ids or resolved query handles.

*Alternatives considered:* reuse the query `Preset` class for authoring (mixes immutable lookup with mutable editing), call the builder `Preset` and rename the query handle (larger breaking surface with little gain), make the definition an immutable value (consistent but every child edit would allocate a new tree).

### 3. Child editing is a callback scope, not a chain

```ts
const adapted = definePreset('ptc-fresh')
  .from(web.preset('ptc'))
  .name('Adapted PTC')
  .description('PTC for personal use')
  .order(2)
  .children((children) => {
    children.child('tool-todo').disable()
    children.child('tool-web').disable()
    children.append({ name: '@deepseek-ai/dsh-tool-lsp' })
  })
```

`PresetChildren` is a scoped editor:

- `child(id)` returns a `PresetChild`.
- `PresetChild` supports `disable`, `enable`, `remove`, and `replaceWith`.
- The scope supports `append`, `prepend`, `insertBefore`, and `insertAfter`.
- Every operation is single-target and accepts at most one entry.
- Child operations return `void`; the callback is the scope boundary, and `.children()` returns the `PresetDefinition`.
- Child handles are intended to be short-lived and are not a parent-returning chain.

Only top-level children are addressable. Group children remain raw `group()` entries in the child list and can be appended or replaced as a whole.

*Alternatives considered:* `disableChild('a', 'b')` (variadic and collapses all child operations into parent methods), child methods returning the parent (implicit transition the user rejected), a child builder requiring `.done()` (explicit but noisy and inconsistent with `.profile` / `.layer` callbacks).

### 4. Child failures are a tagged authoring error

`PresetDefinitionError` carries:

- `_tag: 'PresetDefinitionError'`
- `code: 'preset.invalid_id' | 'preset.child_not_found' | 'preset.child_ambiguous' | 'preset.invalid_selection'`
- `presetId`, `rowId`, and `childId` where applicable.

Lookup happens before mutation, so a failed child operation leaves the definition untouched. Duplicate child ids are ambiguous rather than first-wins.

The public query/authoring boundary continues to throw tagged errors instead of returning `Result`, because the fluent config API is synchronous and direct composition is the reason for the API. This is a documented exception in `error-handling`; the architecture allowlist adds the preset module with that rationale.

### 5. Config import preserves tagged authoring failures

`loadConfig()` currently catches every non-schema import exception and wraps it in `ConfigError('config.import_failed')`. That destroys `ResolutionError` identity and would destroy `PresetDefinitionError` identity.

The import adapter will:

1. Preserve `Schema.SchemaError`.
2. Preserve a structurally recognized tagged authoring error.
3. Wrap everything else in the existing config import failure.

A shared `AuthoringError` type or structural guard covers `ResolutionError` and `PresetDefinitionError`. The CLI and REPL formatters add the preset error case; existing resolution formatting remains. `Effect` error unions and tests are updated so a missing preset or child is reported as its own code, not as `config.import_failed`.

*Alternatives considered:* defer child failures to `.build()` (turns immediate authoring mistakes into late validation errors and complicates the child scope), return `Result` from every lookup (breaks the fluent call shape), keep wrapping but include the code in the message (loses the tag-based diagnostic contract).

### 6. `selectPreset` takes preset references and a required default

```ts
.selectPreset(adapted, { default: standard })
```

`PresetRef` is the union of a resolved `Preset` and an authored `PresetDefinition`; both expose the preset id used by the registry. The selected reference becomes `selectedDefault`; the required `default` reference becomes `default`.

The helper writes the full registry config. It does not read the existing registry row, merge it, or infer the deployment default. If the registry row is absent, the existing preflight unmatched-target warning is the feedback. Passing the selected preset as `default` is valid and makes it the deployment default too.

*Alternatives considered:* a string default (loses reference checking and reads worse), inferring the default from the pinned registry (silently snapshots another layer and can go stale), a generic `mergeConfig` helper (hides whole-config replacement and has the same stale-snapshot risk).

### 7. Remove bundle `source` authoring without a plan bump

`BundleOptions.source`, `Bundle.source`, and source emission are removed. `.bundle()` writes only the bundle name, and package installation stays on `.package()`. This reflects the distinct concepts:

- a bundle is an ordered patch layer;
- a package is a profile dependency;
- a local bundle commonly needs both calls because it is both.

`NamedBundle.source` remains in the plan schema as accepted legacy data, so no plan version bump is required. New authoring paths never produce it; the field is marked deprecated in documentation and type comments. The materializer continues to ignore it.

*Alternatives considered:* remove the plan field and bump the version (rejected: no version bump), make `source` install a dependency (conflates two concepts and duplicates `packages`), add `bundlePackage()` (rejected in favor of explicit `.bundle()` / `.package()`).

### 8. Empty layers warn in preflight

`composePreflightLayers()` already receives generated-layer labels. It will add one warning for each generated layer whose patch list is empty. The warning names the layer and does not alter the plan or generated files.

The warning joins the existing raw warning list, so:

- raw mode prints it without a layer prefix;
- `--explain` attributes it to `generated:<id>`;
- `--strict` fails on it because strict already fails on preflight warnings.

The `--strict` help text changes from "unmatched patch targets" to "preflight warnings" to match existing behavior.

*Alternatives considered:* warn at build time (no output channel, and `check` does not evaluate the config), drop empty layers (changes the plan and generated layer set), make it an error (the user asked for warnings).

## Risks / Trade-offs

- **Expression conversion misses a new DSH marker** -> convert only the exact `__jsExpr` shape today; add a fixture with nested disabled/config expressions; if DSH adds another transport marker, resolution fails the round-trip test rather than silently emitting it.
- **Preset child scopes escape their callback** -> keep handles transient, document the scope, and avoid storing them in the definition. A runtime closed-scope guard can be added if misuse appears; it is not needed for the specified behavior.
- **Cross-copy error detection fails** -> use structural `_tag` checks and test with the config project's installed package where practical.
- **Authoring exception expansion weakens the error model** -> confine it to the documented synchronous authoring boundary, extend the architecture allowlist explicitly, and preserve tags through import.
- **Legacy `source` remains in the plan type** -> stop producing it, mark it deprecated, and add a test proving `.bundle()` writes no source. The plan stays version 1.
- **Hard-coded registry semantics** -> `selectPreset` is DSH-specific domain sugar; it writes one known row and leaves missing-row handling to preflight rather than inserting a registry.
- **Empty-layer warning noise** -> warn only for generated layers, once per empty layer; bundle layers are not inspected.
- **REPL completion drift** -> add `definePreset` to curated bindings and extend the method map; a binding-collision test catches accidental shadowing.

## Migration Plan

1. Add the resolution normalization and its expression round-trip tests; existing query consumers see plan-shaped expressions instead of `__jsExpr`.
2. Add `PresetDefinition`, `PresetChildren`, `PresetChild`, and `PresetDefinitionError`; keep the query `Preset` API.
3. Add `selectPreset` and registry tests.
4. Preserve tagged authoring errors through config loading; update CLI/REPL formatting and architecture allowlist.
5. Remove `source` from authoring, keep the legacy plan field, and migrate tests/docs to explicit `.bundle()` plus `.package()`.
6. Add the empty-layer preflight warning and strict/explain tests.
7. Update REPL bindings/completion, README examples, and the init/config examples.

Configs using `bundle(name, { source })` migrate to `.bundle(name).package(name, spec)`. Configs that inspected `__jsExpr` switch to the plan expression node or built-in `js()` helper. Rollback is a revert; no plan version or persisted generation format changes.
