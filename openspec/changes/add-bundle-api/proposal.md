## Why

eedsh turns TypeScript into a normal DSH profile, but a plugin's own bundle layer is still a hand-written `cordis.patch.yml`: row ids, group/isolate trees, preset definitions, and `!!js` expressions are opaque JSON, duplicated with the plugin's TypeScript constants, and checked only when DSH boots. Plugin authors need the same typed, code-first authoring for their bundle layer, while the published plugin must stay a standard DSH bundle that works under DSH instances that eedsh did not start.

A published build-time package is the delivery vehicle: a plugin repository adds one dev dependency, generates the YAML in its build, commits it, and ships it in the plugin tarball. Consumers need no eedsh package, profile, or runtime, and eedsh's own bundles can dogfood the same API.

## What Changes

- Add a new publishable package `@eedsh/bundle` with a synchronous build-time API for one bundle's Loader patch layer: `defineBundlePatch`, a patch builder (`insert`, `override`, `disable`, `enable`, `raw`), `group`, `js`, and `emitBundlePatch`/`writeBundlePatch`/`checkBundlePatch`.
- Emit DSH-native YAML: a top-level patch array, group/isolate entries, and `!!js` expressions through the vendored Loader schema. Output SHALL be deterministic, self-describing, free of `$eedsh` nodes and generator versions, and safe to commit.
- Publish the package to npm as ESM with TypeScript declarations: runtime dependency on `js-yaml` only; no DSH, `@eedsh/*` private package, Effect, or Node-26-only API; Node >=22.19; MIT.
- Reuse the package's emitter from the eedsh CLI so profile generation and plugin bundles share one YAML dialect.
- Define and test the compatibility contract: the generated plugin keeps a standard `dsh.bundle.patch` field, ships the committed YAML in `files`, adds no eedsh manifest fields or runtime dependency, and loads under plain DSH without eedsh.
- Dogfood the package in `@eedsh/runtime` and add a representative fixture covering rows, groups/isolate, presets, and `!!js`. Document the external `dsh-superagent` migration; do not modify that repository here.
- Add a release path: `private: false`, `publishConfig.access: public`, a first `0.1.0` publication, and a clean-install check from the registry.

Out of scope:

- Generating plugin Cordis `Config` schemas or typed plugin-config types.
- Evaluating plugin definitions inside `eedsh sync` or exposing profile-context queries at build time.
- Changing DSH, the profile plan format, or the generated profile layout.
- Migrating the external `dsh-superagent` repository or publishing on its behalf.
- Any UI, profile behavior, or CLI command surface beyond the emitter reuse.

## Capabilities

### New Capabilities

- `bundle-patch-authoring`: typed build-time authoring of one plugin bundle's Loader patch and DSH-compatible YAML emission.
- `bundle-api-package`: the standalone published package: exports, declarations, dependency isolation, Node range, versioning, and release.
- `plugin-bundle-compatibility`: the generated plugin stays a standard DSH bundle with no eedsh runtime dependency, and its committed artifact is checked.

### Modified Capabilities

None.

## Impact

- New package `packages/bundle` and its build, tests, README, and package metadata.
- `packages/cli`: the patch YAML emitter moves to (or delegates to) the new package; generated profile output and existing tests must not change semantically.
- `packages/runtime`: its `cordis.patch.yml` becomes a generated, committed artifact.
- Root README, architecture documentation, and CI/release workflow; npm `@eedsh` scope and publication credentials are release prerequisites.
- No DSH change, no profile plan change, and no runtime dependency for plugin consumers.
