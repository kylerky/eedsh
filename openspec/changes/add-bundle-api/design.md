## Context

See `proposal.md` - Why. Three current facts constrain the design:

- DSH loads a plugin bundle's patch exclusively from package-relative YAML named by `dsh.bundle.patch`; `@deepseek-ai/dsh-app-boot` validates that declaration as a string or an ordered string list, resolves each path against the package directory, and parses the files with the Loader's `!!js` schema. A plugin therefore cannot generate its bundle layer at runtime and stay a normal DSH bundle.
- eedsh already has the authoring semantics and the `!!js` YAML emitter, but they live in private packages: `@eedsh/config` has the profile-oriented `LayerBuilder`, `group`, and `js`; `@eedsh/cli` owns `materialize/yaml.ts` and `materialize/yaml-schema.ts`; `@eedsh/plan` owns the Effect-based patch schema. None is currently publishable, and a public declaration that imports `@eedsh/plan` would be unusable outside this workspace.
- The first real adoption target is an external, private plugin repository (`dsh-superagent`) whose hand-written patch has 5 top-level rows, 5 groups with `isolate`, 8 `!!js` expressions, 2 agent presets, and 44 id nodes. It is already tested by parsing the YAML with DSH's own loader. Its package must remain installable and bootable by a plain DSH installation, without eedsh.

## Goals / Non-Goals

**Goals:**

- Put the build-time authoring and emission of one bundle patch layer behind a small, versioned npm package that an external plugin repository can install as a dev dependency.
- Keep the generated plugin a standard DSH bundle: unchanged `dsh.bundle.patch`, no eedsh manifest fields, no eedsh runtime dependency, no eedsh import from the plugin module.
- Make the emitted artifact deterministic and reviewable, and make staleness detectable in the plugin's own checks and before publication.
- Share one YAML dialect between eedsh profile generation and plugin bundle generation.

**Non-Goals:**

- Profile selection, bundle queries, package/source declarations, generated-layer markers, and preset selection. A bundle patch is only a Loader patch layer.
- A DSH installation, a profile, the eedsh capability bridge, network access, or Effect at authoring time.
- Semantic validation against a composed bundle stack; that remains DSH's or a profile's job.
- Generating the plugin's Cordis module, its `Config` schema, or typed plugin-config types.
- Changing DSH, the profile plan format, or how eedsh materializes profiles.

## Decisions

### 1. Publish a standalone package, not a subpath of `@eedsh/config`

`@eedsh/bundle` is a new package in this workspace. `@eedsh/config` remains the profile authoring package; publishing it is not sufficient because its public surface and declarations depend on private packages and Effect. A subpath such as `@eedsh/config/bundle` would still force external plugin repositories to install the profile authoring package and could leak private types into generated declarations.

Alternatives: publish `@eedsh/config` unchanged (couples plugin builds to profile authoring and Effect); vendor the API into each plugin repository (no shared contract, duplicated fixes); keep an internal workspace module (external repositories cannot resolve it). The standalone package is the only option that gives plugin repositories a small, versioned dependency without coupling them to the eedsh CLI or profile model.

### 2. Keep the public package self-contained

The package owns its public types (`JsonValue`, `BundlePatch`, `PatchEntry`, expression types) and its structural patch validation. It does not import `@eedsh/plan`, `@eedsh/config`, `@eedsh/cli`, or any DSH package at runtime or in its public declarations. Runtime dependencies are limited to `js-yaml`; no Effect.

Alternatives: reuse the plan schema (adds Effect and a private dependency to every plugin build, and leaks `@eedsh/plan` into published declarations); import plan types only (declarations still reference an unpublished package); duplicate the whole profile builder (too much surface). A small local validator plus the shared YAML emitter keeps the public contract stable and installable.

### 3. Expose only patch-layer authoring

The public API is `defineBundlePatch` plus `insert`, `override`, `disable`, `enable`, `raw`, `group`, `js`, and the emit/write/check functions. It deliberately does not expose `defineConfig`, `bundle()`, `.generated()`, `.package()`, `.source()`, `selectPreset`, or any query handle. Those are profile decisions; a bundle patch must not select bundles, declare dependencies, or inspect a composed profile.

Alternatives: re-export the existing `LayerBuilder` (couples the public package to profile concepts and query modules); expose a full profile config (a plugin would be able to rewrite deployment decisions). A narrow surface keeps generated plugins composable and safe for profile authors to override.

### 4. Reuse one deterministic YAML emitter

The package owns the vendored `tag:yaml.org,2002:js` schema and emits one top-level YAML array of patch entries. `js()` values become `!!js` scalars; `$eedsh` expression nodes never reach the file. Output is byte-stable: authored order, stable key order, no timestamps, no absolute paths, no generator version, one trailing newline, and a short header pointing at the TypeScript definition. The eedsh CLI imports this emitter instead of keeping a second copy.

Alternatives: let plugin authors call `js-yaml` directly (two dialects and missing `!!js` support); emit JSON (cannot represent `!!js`); embed generator/provenance versions in comments (creates churn on every package upgrade). One emitter is the compatibility guarantee.

### 5. Library-first build integration

The plugin repository imports its TypeScript definition from its own build script, calls `writeBundlePatch` or `checkBundlePatch`, and runs that script with the repository's existing TypeScript runner (`tsx` or an equivalent). The API package does not ship a CLI, does not depend on the eedsh CLI, and does not prescribe a build tool. An `eedsh bundle` convenience command can be added later without changing the package contract.

Alternatives: ship a `tsx`-based CLI (adds a second command surface and a runtime runner dependency); a tsdown plugin (couples the contract to one build tool). The library keeps the integration choice with the plugin and remains usable by repositories with different build setups.

### 6. Commit the artifact and check it

The generated `cordis.patch.yml` is committed to the plugin repository, included in `files`, and verified by a check script in the plugin's normal checks. `prepack` runs the same check so a tarball cannot be published with a stale artifact. The header says the file is generated and points at the TypeScript source; arbitrary hand-written YAML comments are not preserved, so the TypeScript definition is the source of truth.

Alternatives: generate only during `prepack` (reviewers cannot see the artifact and a skipped lifecycle script can publish a missing file); generate during consumer installation (consumers would need eedsh and would mutate an installed package). Committing plus checking is reviewable and keeps the tarball self-contained.

### 7. Treat plain-DSH compatibility as a testable contract

The plugin package must keep `dsh.bundle.patch` as its only composition declaration, include the generated file, have no `@eedsh/*` runtime or peer dependency, no eedsh manifest field, and no `$eedsh`/eedsh-generated names in the YAML. A plain DSH profile that selects the plugin as a normal bundle is the acceptance test. The plugin's runtime module is unchanged as a normal Cordis plugin. A CI check also fails if a runtime `@eedsh/*` dependency appears.

Alternatives: allow an eedsh-only optional generator field (would let eedsh improve the plugin but breaks the promise that plain DSH sees the same artifact); evaluate the definition inside eedsh sync (rejected: the plugin would no longer be portable and the CLI would execute third-party code).

### 8. Release under the eedsh scope with an explicit release gate

The package is `@eedsh/bundle`, version `0.1.0`, MIT (the repository now has an MIT LICENSE), `type: module`, Node `>=22.19`, and `publishConfig.access: public`. The first release is manual from an authenticated account that owns the scope; the task stops before publishing if authentication or scope ownership is missing. CI may automate later, but the first release is a deliberate human gate. The package version is independent of the eedsh CLI version, and the generated YAML never embeds it.

Alternatives: publish immediately from CI without checking the scope (risks a failed or wrong-scope publication); reuse the CLI's version (couples unrelated release cadences); publish under another scope (loses the eedsh identity).

### 9. Dogfood in-repo and document the external migration

`@eedsh/runtime` is the first in-repo consumer: its single-row patch becomes a generated, committed artifact. A representative fixture covers the features the external plugin actually uses (rows, groups/isolate, presets, `!!js`). The external `dsh-superagent` migration is documented but not performed in this change because it lives in another repository and its publication path is independent. Its size and feature set are the design's acceptance yardstick.

Alternatives: require the external migration in this change (cross-repository coupling and an unrelated release); use only the trivial runtime row (does not exercise groups or presets). The in-repo dogfood plus the representative fixture gives coverage without crossing repository boundaries.

## Risks / Trade-offs

- [The npm scope or credentials are unavailable] → The release task verifies `npm whoami` and scope ownership before publishing; it stops and reports rather than publishing under another name. The implementation can still land and be consumed by a local link until the release gate is cleared.
- [The public API becomes a compatibility surface] → Keep the surface to the patch layer, release at `0.x`, and treat additive changes as minor and behavior/removal changes as major; the package contract is covered by specs and tests.
- [Patch validation drifts from the eedsh plan schema] → The CLI continues to validate profiles with `@eedsh/plan`; the public package owns only the structural patch subset, and tests pin the shared insertion/group/expression rules. The CLI uses the same emitter, so bytes cannot drift between profile and plugin layers.
- [Hand-written YAML comments are lost] → The TypeScript definition carries the rationale and the generated file has a short header pointing at it; if comment preservation becomes important, a later additive `comment()` API can emit comments without changing existing output.
- [A plugin edits the generated YAML by hand] → The header says it is generated, and the plugin's check fails on drift; the fix is to edit the definition and regenerate.
- [Static YAML has no hot-reload path of its own] → DSH re-reads bundle layers on the next recomposition; plugin development may restart or trigger a recomposition after rebuilding. This is the accepted cost of a portable, plain-DSH artifact; a dev watcher is a separate future concern.
- [The package supports a different Node/ESM range than a plugin] → Declare `engines.node >=22.19`, publish ESM plus declarations, build to an ES2022 target, and test a clean install/generation from a packed tarball.
- [The name `@eedsh/bundle` is confused with a runtime DSH bundle] → The package README's first paragraph says it is build-time authoring and not a runtime bundle, and the manifest declares no `dsh.bundle`.

## Migration Plan

1. Land and release `@eedsh/bundle`; keep the existing `@eedsh/runtime` hand-written patch until the package is installed and green.
2. Switch the CLI's patch emitter to the package's emitter and keep the generated profile output semantically unchanged; run the existing materialization tests.
3. Generate `packages/runtime/cordis.patch.yml` from a TypeScript definition commit the artifact and its check.
4. Publish `0.1.0` and verify a clean external install.
5. Migrate `dsh-superagent` in its own repository (documented here, not changed here): replace the hand-written patch with a definition, commit the generated file, and run its existing DSH-loader test plus the new drift check.

Rollback: keep the hand-written patch files in history; reverting the generation commit restores them. The package is a dev dependency only, so removing it never affects a published plugin's runtime.

## Open Questions

None that would change the specs or the package boundary. Whether to add a `comment()` emission API, a convenience CLI, or CI publishing is deferrable until the first release; all are additive to the contracted surface.
