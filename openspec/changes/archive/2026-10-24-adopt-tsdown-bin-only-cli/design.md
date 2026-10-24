## Context

See [proposal.md](proposal.md) for motivation. The constraints that shape the implementation:

- `@eedsh/runtime` is loaded by DSH's Cordis loader in a plain Node child; it cannot rely on `tsx` or Node's TypeScript stripping.
- `@eedsh/config` is loaded by `tsx` at config-evaluation time, but its public types are consumed by each user project's own `tsc`, and its JavaScript is also imported by the CLI and by fixture configs resolved through package exports.
- `node packages/cli/lib/bin.js` is the CLI entry in tests and documentation; `@eedsh/cli`'s `index.ts` library entry has no consumer in the repository.
- The repository typecheck is a separate no-emit project; the build currently doubles as a typecheck.
- tsdown 0.23.1 requires Node `^22.18.0 || ^24.11.0 || >=26.0.0`; the repository already requires Node 26.

## Goals / Non-Goals

**Goals:**

- Replace the per-file `tsc` emit with one bundled ESM artifact per package entry, preserving `lib/` paths and declarations.
- Remove the unused `@eedsh/cli` library surface and emit only `lib/bin.js`.
- Keep DSH, `tsx`, and plain Node consumption working without adding a loader anywhere.
- Make `tsc` a no-emit gate and remove package-level TypeScript config duplication.
- Use the move to adopt bundler-style extensionless relative imports.

**Non-Goals:**

- Source-only packages, a loader in the DSH child, or removing `lib`.
- Splitting `cli.ts` into args/report/commands modules or renaming `internal/effect`.
- tsdown workspace mode, publint/attw, or package publication.
- Any change to the plan schema, profile layout, generated bundle, CLI flags, or HMR behavior.

## Decisions

### D1: Bundle config and runtime; bundle the CLI bin only

`@eedsh/config` and `@eedsh/runtime` build one entry each (`src/index.ts`) to `lib/index.js`, `lib/index.d.ts`, and maps. `@eedsh/cli` builds only `src/bin.ts` to `lib/bin.js` with `dts: false`; `src/index.ts` is deleted and the package `exports` field is removed. The repository has no consumer of the CLI library entry, and tests import source modules directly.

*Alternatives considered:*

- Keep `lib/index.js` for the CLI: rejected—it is dead output and forces either a shared chunk or duplicate bundling of the CLI for two entries.
- Point package exports at `src`: rejected. Node 26 refuses TypeScript under a `node_modules` path, runtime profiles can be booted by DSH without eedsh, and raw `.ts` type exports impose `.ts` extension and compiler-option requirements on user projects.
- Run the CLI through `tsx` or Node's native type stripping: rejected—it makes the loader part of the startup contract, loads `tsx` for `--help`/`--version`, and only removes one package's build.

### D2: Per-package tsdown configs, not workspace mode

Each package gets a small `tsdown.config.ts`. `pnpm -r build` keeps pnpm's topological order, so `@eedsh/config`'s declarations exist before the CLI bundle is produced. tsdown workspace mode is still experimental and resolves package configs concurrently; it adds ordering risk for no benefit at this repository size.

The shared shape is:

```ts
defineConfig({
  entry: 'src/index.ts',
  outDir: 'lib',
  tsconfig: '../../tsconfig.base.json',
  fixedExtension: false, // package type module -> .js, not .mjs
  target: false,         // Node 26 input; no downleveling
  sourcemap: true,
  dts: { sourcemap: true },
})
```

`@eedsh/config` sets `dts: { sourcemap: true, resolver: 'tsc' }` because its declarations expose Effect Schema-derived types. The CLI config uses `entry: 'src/bin.ts'`, `dts: false`, and `deps: { neverBundle: [/^@eedsh\//] }`. All packages also externalize workspace packages explicitly; dependencies are external by default, but the regex documents the boundary.

`fixedExtension: false` is mandatory: tsdown defaults it to `true` for `platform: 'node'`, which would emit `.mjs`. `clean: true` (the default) removes the old per-file mirror before writing the bundle. The shebang in `src/bin.ts` is preserved and tsdown grants execute permission.

### D3: Build configuration and typecheck configuration are separate

`tsconfig.base.json` holds the compiler options used by tsdown and editors: `module: preserve`, `moduleResolution: bundler`, strictness, `verbatimModuleSyntax`, and `isolatedModules`. It contains **no `paths`** and **no `noEmit`**, so tsdown's resolver sees package names as package names and the declaration generator is not inhibited by a no-emit setting.

`tsconfig.json` extends the base and becomes the check project: `noEmit: true`, `baseUrl`, the `@eedsh/*` path mappings, and the full include set (package sources/tests, root tests, Vitest configs, and tsdown configs). `pnpm typecheck` runs `tsc -p tsconfig.json`; `tsconfig.check.json` and all package `tsconfig*.json` files are deleted. Package `typecheck` scripts are removed because the root project is authoritative.

Keeping `paths` out of the base is a correctness requirement, not tidiness: tsdown resolves tsconfig aliases and would inline `@eedsh/config` or `@eedsh/runtime` source into the CLI bundle if they were aliased in the build config. The explicit `neverBundle` regex is a second line of defense.

### D4: Extensionless imports are the new convention

With `module: preserve` / `moduleResolution: bundler`, relative imports drop the `.js` suffix in `packages/*/src` and `packages/*/test`. Vitest and `tsx` already resolve extensionless TypeScript; the bundled output has no internal relative imports, so Node never sees an extensionless specifier. `tsc` no longer validates NodeNext extension rules, which is acceptable because the bundler owns resolution. No source-scanning test is added to enforce the convention; it is documented and reviewed, and the build/typecheck still resolve both forms.

The `nativeImport` `new Function` in `config.ts` stays: it still needs to prevent the bundler from rewriting the user-config specifier.

### D5: Scripts preserve the typecheck gate

- Root `build`: `pnpm typecheck && pnpm -r run build`.
- Root `build:packages`: `pnpm -r run build`.
- Root `verify`: `pnpm check && pnpm test && pnpm build:packages` (avoids a second typecheck).
- Package `build`: `tsdown`.

The built-CLI integration test continues to run `pnpm -r build`; the slow HMR test continues to build only `@eedsh/runtime`. `cli.test.ts` keeps its conditional config build because fixture configs resolve `@eedsh/config` through package exports.

### D6: Cleanup stays mechanical

While imports move, apply only the low-risk cleanup: extract spawn types into `spawn.ts` to break the `cli.ts` ↔ `check.ts` type cycle; remove the unused `PlanInvalid` failure and its CLI switch case; import `EXIT_*` directly from `exit.ts`; move `internal/effect/program.ts` to `materialize/program.ts`; remove the `emitPatchesYaml` re-export; unexport `readProfileBundles`; update the package READMEs. Leave the larger `cli.ts` split and `internal/effect` rename to a separate change.

### D7: Generated declarations are verified during implementation, not guarded persistently

The source tests resolve `@eedsh/*` through Vitest aliases, so they do not exercise `lib/index.d.ts`. During this change, run a one-off consumer project under gitignored `.tmp/`: `module: nodenext` / `moduleResolution: nodenext`, `skipLibCheck: false`, link the built `@eedsh/config` package and its `effect` peer, import `defineProfile` and `ProfilePlan`, and run `tsc --noEmit`. Use a `@ts-expect-error` assertion on an invalid plan field so a declaration that collapses to `any` does not pass silently.

This check and the build-layout checks are ephemeral: they are not added to `built-cli.test.ts`, `test/architecture.test.ts`, or any other persistent test. The existing built-CLI integration test is left unchanged; it still builds and executes the bin but does not gain shebang, version, or layout assertions. No persistent test scans package manifests or source for absent `exports` fields, missing tsconfig files, or import suffixes; those properties are verified by the build/typecheck and reviewed from the diff. The accepted consequence is that generated declarations, bundle layout, and the bin-only manifest shape have no permanent regression guard after this change; a future packaging test can be added deliberately if that risk becomes unacceptable.

## Risks / Trade-offs

- **Effect-derived declarations fail to bundle** → First implementation task is a config-only spike; use `dts.resolver: 'tsc'`; if declarations still fail, stop and keep `tsc` for config rather than shipping broken types.
- **tsdown inlines workspace packages through tsconfig paths** → No `paths` in `tsconfig.base.json`; explicit `deps.neverBundle` regex; inspect the CLI bundle for an inlined `PlanValidationError`/config module.
- **Clean build ordering** → Keep `pnpm -r build`; do not build the CLI alone on a clean tree; document that `@eedsh/config` must build first.
- **Bin-only CLI breaks an external embedder** → The package is private and no repository consumer exists; call it out as breaking and keep `runCli` available from source for tests.
- **`lib/bin.js` path, shebang, or version lookup regresses** → Verify the shebang, executable bit, and `--version` output once during implementation; the existing built-CLI test still executes the bin for sync, but no new persistent assertion is added.
- **pnpm does not expose the root `tsdown` binary to package scripts** → Verify `pnpm --filter @eedsh/runtime build`; if it fails, add `tsdown` to that package's devDependencies rather than changing the build model.
- **pnpm 12 blocks a native transitive build script** → Review the install output and add only the specific `allowBuilds` entry required by Rolldown/Oxc.
- **Generated d.ts, bundle layout, and bin-only manifest have no persistent regression guard** → D7 runs one-off consumer declaration and layout checks during this change; residual risk is accepted because no artifact or source-scanning tests are added to the repository suite. A dedicated packaging test can be added in a later change if the residual risk becomes unacceptable.
- **The extensionless-import convention can regress without a guard** → The convention is documented in the README and reviewed in changes; no source-scanning test is added, per the agreed test scope.
- **Lockfile and dependency-tree growth** → Pin `tsdown@0.23.1` exactly and review the lockfile diff; no runtime dependency is added to config or runtime.

## Migration Plan

1. Spike `@eedsh/config` with tsdown: install, build, inspect `lib/index.js`/`lib/index.d.ts`, run the one-off consumer typecheck and the existing config tests. Stop on declaration failure.
2. Migrate `@eedsh/runtime` and `@eedsh/config` builds; verify `pnpm -r build`, runtime tests, the slow HMR path, and rerun the one-off bundle-layout check.
3. Make the CLI bin-only, remove `index.ts`/`exports`, and verify the built CLI.
4. Promote the check config to `tsconfig.json`, point tsdown at the base, delete package configs, switch to bundler resolution, and drop `.js` specifiers.
5. Apply the mechanical cleanup and leave the existing architecture tests unchanged.
6. Update the READMEs and run `pnpm verify`.

Each step is a separate commit. Rollback is a revert: no on-disk profile or plan format changes are involved, and `lib` is regenerated by the previous `tsc` configuration.

## Open Questions

None. The declaration-generation risk is a scheduled spike with a clear stop condition, not an unresolved design choice.
