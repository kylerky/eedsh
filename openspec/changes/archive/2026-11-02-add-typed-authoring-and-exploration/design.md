## Context

See `proposal.md` - Why. The constraints that shape the approach:

- The plan is a storage and wire contract: it is written to `.eedsh/plan.json`, hashed into the generation record, compared across reloads, and read by the CLI. `@eedsh/plan` rejects class instances through its plain-object guard and rejects functions through its JSON walk ([`plain-object.ts`](../../../../packages/plan/src/plain-object.ts), [`json.ts`](../../../../packages/plan/src/json.ts)). Any method-bearing authoring object must stay outside that boundary.
- Authoring runs synchronously inside the config module. Queries use `readFileSync` and the DSH patch loaders; there is no build step and no daemon.
- The config project installs its own copy of `@eedsh/config`, and the CLI has a separate copy. Module identity is not shared, so `instanceof` is not a safe discriminator across the two.
- The REPL is a `node:readline` loop over a hidden `node:repl` evaluator started with `terminal: false`. The loop has no completer, history persistence, or multiline handling; the evaluator owns the bindings and has Node's default, AST-aware completer available through `REPLServer.complete`. Node 26 readline awaits an async completer, but renders hits as strings only.
- The unarchived `add-config-repl` change is the current baseline for preview resolution, save-driven reload, in-session sync, and `--eval`. Its `authoring-resolution` and `config-repl` deltas are not yet in `openspec/specs/`.
- Author-time resolution currently throws tagged `ResolutionError` values and is explicitly allowlisted by the architecture check for exception control flow. Plan validation returns Effect's native `Result` failures.

## Goals / Non-Goals

**Goals:**

- One typed object model shared by config authoring and REPL exploration, with methods replacing free functions.
- One explicit normalization seam that converts typed authoring objects into plain plan data before validation.
- A fully fluent config builder whose profile and layer steps are scoped callbacks.
- Chain-aware Tab completion that knows the typed API and the loaded domain data.
- Read-only exploration of profiles, bundles, layers, packages, composed rows, and published state.
- Preserve the existing preview, reload, sync, continuous-sync, `--eval`, and error-containment behavior.

**Non-Goals:**

- Changing the plan format, plan schema, generation format, materializer, or doctor semantics.
- A `node:repl` shell swap, persistent history, multiline editing, or Ctrl-C behavior changes.
- Deferred per-profile queries resolved during materialization.
- New publishing paths or automatic publication from exploration.
- A persistent query cache across sessions.
- Compatibility wrappers for the removed free helpers; the break is intentional.
- Changing preflight warning attribution, locking, or rollback behavior.

## Decisions

### 1. Two layers with one normalization seam

Typed authoring and query objects carry behavior; validated plan data stays plain JSON. Typed objects implement a branded `.toJSON()` (or equivalent build protocol), and `defineConfig().build()` recursively normalizes only branded objects before invoking the existing config/plan validation. A rooted `BundleQuery` is deliberately not branded for plan normalization, so it cannot be silently accepted as a plan selection. `@eedsh/plan` remains unchanged.

*Alternatives considered:* attach non-enumerable methods directly to the plain plan selection (it passes the current schema, but hides behavior from the data boundary and is fragile); relax the plan schema to accept class instances (the plan is persisted and cross-process, so it must remain JSON); make `toJSON()` the only discriminator (too permissive, arbitrary objects could inject data). A globally registered brand plus a kind discriminator keeps normalization explicit without coupling `@eedsh/plan` to `@eedsh/config`.

### 2. Config authoring is a callback-scoped fluent builder

`defineConfig()` returns a mutable, single-use `ConfigBuilder`. `.dsh(pin)`, `.defaultProfile(name)`, and `.profile(name, build)` return the same builder for chaining; `.build()` returns `Result<EedshConfig, Schema.SchemaError>`. `.profile(name, build)` creates a `ProfileBuilder`, passes it to the callback, then appends it; the callback return value is ignored. `.layer(id, build)` on a profile does the same for a `LayerBuilder`. This keeps the chain readable without requiring every callback to return a value.

Authoring builders are mutable because a config is assembled once; query handles are immutable because they may be reused and must not change a previous result. Validated values are frozen.

*Alternatives considered:* an immutable builder for every step (safer reuse, but callbacks must return every nested builder and every config edit allocates a new tree); registration-style `.profile(name)` returning a `ProfileBuilder` that needs `.done()` or a parent back-reference (natural to type, easy to misuse); keeping the object envelope and only making leaves typed (does not deliver the requested fluent top level).

`defineConfig()` remains the factory name. A `config()` factory would collide with the loaded `config` binding at the prompt; keeping `defineConfig()` preserves `config` as the most useful exploration object.

### 3. `bundle()` is dual-use; rooted handles are query-only

`bundle(name)` returns an immutable `Bundle` that is both a plan selection (`.toJSON()` -> `{ kind: 'bundle', name, source? }`) and a query handle. With no root, queries resolve from the pinned installation. `.fromProfile()` and `.fromPackageDir()` return a `BundleQuery`, which has the read methods, reports its origin, and has no plan-normalization brand. Passing a `BundleQuery` to `ProfileBuilder.bundle()` is a type error and a runtime normalization failure.

`.fromProfile()` accepts a profile name or a structural handle carrying `name`, so the REPL's `selectedProfile` can be passed directly without reaching into a string field. The JSON query root `{ profile: string }` remains string-only.

*Alternatives considered:* a separate `query.bundle()` entry point (cleaner types, but abandons the requested single-factory chain); encoding the root in `bundle(name, { root })` (the rooted value would still look like a plan selection and could be silently normalized); non-enumerable methods on plain selection data (works, but the plan boundary becomes implicit).

### 4. Query handles are immutable; rows, presets, and patches are typed

`Bundle`, `BundleQuery`, `Row`, and `Preset` are immutable handles over a resolution snapshot. `.rows()`, `.presets()`, `.row(id)`, and `.preset(id)` return typed values with `.toJSON()` plain data. A missing row or preset reports a tagged failure. `.disable()`, `.enable()`, and `.override(config)` on a resolved row or preset return plain patch data; deleting or replacing a resolved row is a patch operation, not a mutation of the handle.

`LayerBuilder.insert()` accepts typed rows/presets or plain Loader entries and normalizes them. `.disable()`, `.enable()`, `.override()`, and `.raw()` append patches to the layer and return the layer. `js()` and `group()` remain small value constructors because they build plan values rather than operate on object state; `raw` moves onto the layer. The old free query, profile, and patch helpers are removed.

*Alternatives considered:* keep free helpers as deprecated wrappers (two public surfaces and two completion grammars, defeating the object model); make `.row(id)` return plain data and put patch methods only on layers (less fluent and less discoverable); return a typed `Patch` object (the patch is terminal data, and a class adds no chain value).

### 5. The REPL binds typed views, not the raw plan map

The session binds `config` as a `ConfigView`, `selectedProfile` as a `ProfileView`, and `plan` as the selected profile's validated `ProfilePlan`. The old `profile` string binding and the raw `profiles` map of `Result<ProfilePlan>` are removed. `config.profiles()` returns typed profile views; `config.profile(name)` returns one. `.profile <name>` switches selection from the already loaded config without re-importing it, and updates `selectedProfile` and `plan`. An unknown or invalid profile is reported and the current selection stays.

The session's `bind()` stops using an undifferentiated `Object.assign`. It uses an explicit binding table containing only the curated authoring factories and the typed views, and asserts that no binding name already exists in the authoring module. This turns a future export silently shadowing a prompt binding into a failing test.

Views are built by the CLI session from the validated config; the config project's authoring objects are not retained after `.build()`. Cross-copy checks use structural or branded data, never `instanceof`.

*Alternatives considered:* keep `profile` as a string and add `selectedProfile` alongside (two names for the selected profile, and the old binding's dot completion remains useless); bind `profile` as the view and rename the shell command to `.use` (terse, but `.profile` and `profile` would then mean different things); continue binding the whole authoring module (large, collision-prone surface).

### 6. Exploration views are read-only snapshots

`ConfigView` exposes `dsh`, `defaultProfile`, `profiles()`, and `profile(name)`. `ProfileView` exposes `name`, `plan()`, `bundles()`, `layers()`, `packages()`, `entries()`, and `published()`. `BundleView` keeps the plan selection data and queries with the selected profile as its default root. `PackageView` combines declared plan packages, managed runtime/generated packages, and installed manifest versions. `PublishedProfileView` exposes the profile manifest, generation record, authoritative plan location, and doctor findings; a missing profile is a view with `exists: false`, not an exception.

`entries()` returns composed rows with provenance: the last layer or bundle that touched each row id. The session already composes the bundle and generated layers for the summary; the composition seam is extended to return the composed entries and an id-to-source map (last-touch wins). A failed composition is a view with an error and warnings, not a thrown session failure.

Views are snapshots for the current evaluation. They are rebuilt on load, reload, profile switch, preview change, and successful sync. Building them is read-only and reuses the existing generation-record, manifest, and doctor readers.

*Alternatives considered:* a dot-command navigation language (`.bundles`, `.rows`, `.show`) instead of typed views (adds a second API and conflicts with the existing rule that domain queries are ordinary expressions); plain data plus helper functions (the pre-change model, and the reason exploration is hard); eager per-row provenance at materialization (changes persisted state for a read-only concern).

### 7. Completion is a pure engine with a hybrid fallback

The completion engine is a pure function over `(line, cursor)` and returns the token start plus hits. It is shell-agnostic and directly testable. It recognizes three contexts:

1. **Shell commands** from the command registry: command names, `.sync on|off`, `.profile <name>`, `.resolve <name>@<version>`.
2. **Domain chains**: `bundle('...').<TAB>` offers only valid next methods; `.fromProfile('<TAB>` offers profile names; `.row('<TAB>` and `.preset('<TAB>` resolve the selected bundle under the current root and offer ids; `plan.packages['<TAB>` offers package names; rooted handles do not offer a second root.
3. **Generic expressions**: member expressions outside the domain grammar fall back to the hidden evaluator's `REPLServer.complete`, filtered for obvious prototype noise. This keeps ordinary JavaScript inspection working without pretending the domain grammar covers it.

Catalogs are per-evaluation and in-memory. Profile names come from the validated config. Bundle names combine authored plan bundles, profile manifest bundles, pinned DSH packages that declare `dsh.bundle`, and the active preview. Row and preset ids are resolved on demand through the config project's authoring module, so the prompt uses the same code as `config.ts`. Catalogs are invalidated on reload, profile switch, preview change, and successful sync. Completion snapshots and drains the resolution trace so Tab never emits provenance lines, swallows resolution failures, and never writes or publishes.

Readline's completer is asynchronous in Node 26, so catalog work does not require a synchronous blocking path. Hits are strings; completion descriptions are not promised because the readline renderer does not support them. A later shell swap can reuse the same engine.

*Alternatives considered:* rely only on Node's default completer (no domain argument completion, noisy prototype hits, no chain-state filtering); rely only on a hand-written JavaScript parser (reinvents Node's AST-aware completion); complete only dot commands (leaves the object graph undiscoverable); perform completion by evaluating arbitrary prefixes (side effects, traces, and slow installs).

### 8. Failure style stays split: Result at build, tagged errors at query

`defineConfig().build()` returns Effect's native schema `Result` and never throws on invalid input. Query methods keep throwing tagged `ResolutionError` values, matching the current author-time resolution contract; the session and the REPL catch and format them. The architecture test's documented allowlist for author-time resolution is extended to the new query module(s) with the same rationale. Completion swallows query failures.

This split is deliberate: threading `Result` through every chain step would make `bundle('x').rows()` unsuitable for direct composition in a config, while `build()` is the validation boundary where a `Result` is expected.

*Alternatives considered:* make every query return `Result` (ergonomic loss for config composition, and a much larger breaking change); catch query failures inside the builder and convert them to schema failures (loses the tagged code and bundle facts); unify on exceptions (contradicts the project's validation contract).

### 9. The change supersedes the archived REPL change, deliberately

`add-config-repl` was complete and is now archived first (2026-10-28), so its `authoring-resolution` and `config-repl` requirements are part of the main specs. This change replaces its free-function query surface and its string-binding surface, while preserving the preview, reload, sync, continuous-sync, and `--eval` behavior. The archive order is recorded: the old change's baseline landed first, and this change carries rebased `authoring-resolution` and `config-repl` deltas that modify or remove the superseded requirements. Archiving this change after it completes therefore leaves no stale free-function or string-binding requirement behind.

## Risks / Trade-offs

- **Typed objects leak into the persisted plan** -> keep `@eedsh/plan` unchanged, brand normalization, and test both the builder path and the direct-value rejection path.
- **Migration blast radius is large** -> no compatibility wrappers; migrate fixtures, README, init template, and tests in the same change; provide a migration section in the README.
- **Rooted query is accidentally used as a plan selection** -> no plan-normalization brand on `BundleQuery`, a type-level distinction, and a runtime rejection test.
- **Binding collision is silent again** -> explicit binding table plus an assertion test against the authoring module's exports.
- **Completion is slow or stale** -> per-evaluation in-memory catalogs, lazy row resolution, invalidation on reload/profile/preview/sync, and a small latency budget; a failure returns no hits.
- **Completion triggers side effects or provenance output** -> read-only resolution, trace snapshot/drain around completion, no publishing path, and tests that snapshot profile files.
- **The two `@eedsh/config` copies diverge** -> no `instanceof`; resolve catalogs through the config project's bound module; views are built by the CLI from validated plain data.
- **Query exceptions conflict with the error-handling ideal** -> keep the documented author-time exception and record the follow-up; do not silently swallow query failures.
- **Composition provenance is expensive or wrong for groups** -> compute a last-touch id-to-layer map once per evaluation, cover nested groups in tests, and treat composition failure as a view error.
- **Readline cannot render completion descriptions** -> do not promise them; keep hits plain and put explanations in `.help` and object methods.
- **Builder reuse footgun** -> document authoring builders as single-use and keep query handles immutable; tests may assert repeated `.build()` behavior.
- **Shell limitations remain** -> explicitly out of scope; history, multiline, and Ctrl-C behavior are a follow-up.

## Migration Plan

1. Introduce the typed authoring/query classes, branding, and `.build()` normalization behind the existing exports; add plan-boundary tests.
2. Replace the free-function implementation of the config surface with the fluent builder; update the config package tests and remove `defineProfile`/`assertPlan` exports.
3. Update the CLI loader tests for Result, plain config, and lone-plan rejection; keep the existing materializer and preflight untouched.
4. Update the REPL session to build and bind `ConfigView`, `selectedProfile`, and `plan`; add `.profile`, help/banner text, and the binding-collision guard; migrate session tests.
5. Implement the pure completion engine, the command/argument catalogs, and the readline completer wiring; add engine tests and session adapter tests.
6. Add the exploration snapshots: profile/bundle/layer/package views, composed entries with provenance, and the published view; add read-only filesystem tests.
7. Migrate README examples, the `eedsh init` template, fixtures, and the CLI reference; document the breaking migration.
8. Reconcile `add-config-repl` before archiving: remove or rebase its superseded deltas, then archive this change. Rollback before release is a revert; the plan format did not change, so published profiles are not stranded. After release, users migrate their configs with the documented mapping.

## Open Questions

None that change the specs or task breakdown. The archive sequencing is a required reconciliation step, not an open design choice.
