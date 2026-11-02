## Why

The config REPL can evaluate TypeScript but cannot guide exploration: it has no Tab completion, the `profile` binding is a bare string, and the authoring API is a flat set of free functions operating on detached data. Authors have to remember signatures and inspect `Result` internals to answer "which profiles, bundles, packages, and rows do I actually have?" A typed, fluent object model makes those relationships discoverable in both `config.ts` and the REPL, and gives completion a domain grammar instead of property-name guessing.

## What Changes

- **BREAKING** Replace the free-function authoring surface with typed objects and methods. `defineConfig()` returns a `ConfigBuilder` with `.dsh(...)`, `.defaultProfile(...)`, `.profile(name, build)`, and `.build()`. Profiles are built through `ProfileBuilder.bundle()`, `.generated()`, `.layer()`, and `.package()`; layers through `.insert()`, `.disable()`, `.enable()`, `.override()`, and `.raw()`; bundle queries through `.rows()`, `.presets()`, `.row()`, and `.preset()`.
- **BREAKING** Remove the free `rows`, `presets`, `row`, `defineProfile`, `insert`, `disable`, `enable`, `override`, and `layer` helpers in favor of methods. `bundle()` remains a factory but returns a typed `Bundle` that is both a plan selection and a query handle. `.fromProfile()` and `.fromPackageDir()` return a query-only `BundleQuery`; a rooted query is deliberately not a plan selection.
- **BREAKING** Normalize typed authoring objects to plain plan data only at the `defineConfig().build()` boundary, through an explicit `.toJSON()`/build protocol. The persisted plan format and the strict JSON plan schema are unchanged, and typed objects never reach a plan.
- **BREAKING** Rename the REPL `profile` binding to `selectedProfile` (a `ProfileView`), expose `config` as a `ConfigView`, and expose `plan` as a shortcut for `selectedProfile.plan()`. Add `.profile <name>` as the shell command that switches the selected profile. Remove the raw `profiles` map binding; `config.profiles()` returns typed profile views.
- Add chain-aware Tab completion over the object graph: valid methods at each chain step, plus profile names, bundle names, row ids, preset ids, package names, and command arguments such as `.sync on|off` and `.profile <name>`.
- Add read-only exploration views for profiles, bundles, layers, packages, composed rows/entries, and the published profile state (manifest, generation record, and doctor findings), so the prompt can answer "what is here?" without shelling out.
- Keep inspection read-only: completion, reload, resolution, and exploration never write profile files or publish. `.sync` and `--sync` remain the only publishers.
- Shell foundation is out of scope: this change keeps the existing prompt loop and does not add persistent history, multiline editing, or a `node:repl` shell swap.

## Capabilities

### New Capabilities

- `authoring-objects`: the typed authoring and query object model — `ConfigBuilder`, `ProfileBuilder`, `Bundle`, `BundleQuery`, `Layer`, `Row`, and `Preset` — including methods, resolution roots, patch authoring, normalization to plain plan data, and the boundary that keeps plans JSON-only.
- `repl-exploration`: the REPL's typed bindings (`config`, `selectedProfile`, `plan`), the `.profile` selection command, chain-aware completion, read-only views for profiles/bundles/packages/rows/published state, and the rule that exploration never writes or publishes.

### Modified Capabilities

- `profile-plan-validation`: replace the `defineProfile`-based synchronous Result contract with the fluent `defineConfig().build()` contract, while keeping native schema failures, strict validation, and the existing plan-or-Result export rules for config modules.

## Impact

- `packages/config`: new typed object model, normalization, query and patch methods; `api.ts`, `resolve.ts`, and `config.ts` are rewritten; public exports change.
- `packages/cli`: REPL bindings, command registry, completion engine, typed exploration views, banner/help; `session.ts`, `prompt.ts`, and their tests change.
- `packages/plan`: no plan-format change. Normalization lives outside the plan schema; the `defineProfile`/validation exports change per the validation delta.
- Docs and templates: README, the `eedsh init` template, fixtures, and examples move to the fluent API.
- Spec sequencing: this change supersedes the `add-config-repl` delta capabilities `authoring-resolution` and `config-repl`. `add-config-repl` was archived first (2026-10-28), so its preview, sync, watch, and `--eval` requirements are the main-spec baseline; this change now carries rebased `authoring-resolution` and `config-repl` deltas that replace the superseded free-function and string-binding requirements.
- **BREAKING** for existing configs: every config using the free helpers needs migration, and the REPL `profile` string binding disappears.
