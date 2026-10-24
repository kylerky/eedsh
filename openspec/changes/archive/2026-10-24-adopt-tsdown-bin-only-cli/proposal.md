## Why

Every package currently emits a 1:1 `tsc` mirror of `src` into `lib`—120 files for a ~3.5k-line repository—and `@eedsh/cli` publishes a library entry that nothing imports. The per-file build also forces 89 relative `.js` specifiers through `moduleResolution: nodenext` and duplicates six package-level TypeScript configs. The emitted JavaScript itself is still required: DSH loads `@eedsh/runtime` in a plain Node child, user configs load `@eedsh/config` by package name, and `node packages/cli/lib/bin.js` is the CLI entry. What can change is the shape of the build, not its existence.

## What Changes

- Add `tsdown` (exact `0.23.1`) as a workspace-root development dependency and use per-package `tsdown.config.ts` files to build `@eedsh/config` and `@eedsh/runtime` as single bundled ESM entries with bundled declarations and source maps, still under `lib/`.
- Make `@eedsh/cli` bin-only: remove `src/index.ts` and the package `exports` library entry, build only `src/bin.ts` to `lib/bin.js`, and delete the now-unused `lib/index.js`/`index.d.ts`. **BREAKING** for anyone importing `@eedsh/cli` as a library; the package is private and nothing in the repository does so.
- Keep `tsc` as the no-emit typecheck gate. Remove emit settings from the compiler configuration, delete the six per-package `tsconfig.json`/`tsconfig.check.json` files, and split configuration into a build/editor `tsconfig.base.json` (no `paths`, no `noEmit`) plus a root `tsconfig.json` check project (`noEmit`, `paths`, full include set).
- Switch the repository to bundler-style resolution (`module: preserve`, `moduleResolution: bundler`) and drop the 89 relative `.js` specifiers from package sources and tests.
- Externalize dependencies and workspace packages from the bundles, and explicitly keep the `tsdown` build from inlining `@eedsh/config` or `@eedsh/runtime` via tsconfig path aliases.
- Apply low-risk cleanup while the import graph is already changing: extract the spawn types out of `cli.ts` to break the `cli.ts` ↔ `check.ts` cycle, remove the unused `PlanInvalid` failure, import exit codes directly from `exit.ts`, move the materialization program under `materialize/`, remove redundant re-exports, and correct the stale package READMEs.
- Keep the `lib/bin.js` path, the runtime `dsh.bundle.patch` contract, the config plan format, and all CLI behavior unchanged.

**Out of scope:**

- Splitting `cli.ts` into separate args/report/command modules, or renaming the `internal/effect` folder.
- Running the CLI or runtime from TypeScript source, registering `tsx` in the spawned DSH process, or removing emitted `lib` JavaScript.
- Publishing packages, publlint/attw validation, or changing the generated profile format.
- Adding persistent build-artifact, declaration, or source-scanning tests (for example, asserting absent `exports` fields or tsconfig files); those checks are one-off verification during implementation only.
- tsdown workspace mode; `pnpm -r build` remains the ordered build entry point.

## Capabilities

None. This is a tooling and internal-refactor change with no spec-level behavior change, so `.openspec.yaml` sets `skip_specs: true`. The runtime, plan, profile, and CLI contracts remain as they are, except for the removal of the unused `@eedsh/cli` library entry point.

### New Capabilities

None.

### Modified Capabilities

None.

## Impact

- **Root toolchain**: `package.json` (tsdown devDependency, build/verify scripts), `pnpm-lock.yaml`, `tsconfig.base.json`, and new root `tsconfig.json`. Build-artifact and generated-declaration checks are one-off verification during implementation, not new repository tests.
- **Packages**: new per-package `tsdown.config.ts`; `@eedsh/cli` loses `src/index.ts`, `exports`, and `lib/index.*`; `@eedsh/runtime` loses the redundant `main` field; all six package tsconfig files are deleted.
- **Source**: extensionless relative imports across `packages/*/src` and `packages/*/test`; `cli.ts`, `check.ts`, `internal/effect/errors.ts`, `index.ts`, `internal/effect/program.ts`, and `materialize/generated-bundle.ts` receive the cleanup moves.
- **Tests and docs**: no new persistent build-artifact, declaration, or source-scanning guard tests are added; artifact-layout and generated-declaration checks are one-off verification during implementation and are left uncommitted. The existing test suite is unchanged, including the built-CLI integration test that executes the built bin. The root and package READMEs are updated.
- **Unchanged**: the plan schema, generated bundle format, DSH profile layout, CLI flags and exit codes, HMR behavior, and `@eedsh/runtime`'s runtime dependency surface.
