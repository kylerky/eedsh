## Context

The CLI currently evaluates a config with a native dynamic import and relies on Node's type stripping for `.ts` ([config.ts](../../../packages/cli/src/config.ts)). That contract is narrower than it looks:

- Node 26 removed `--experimental-transform-types`, so enums, namespaces, and decorators cannot run in a config at all. Node ships only strip-only mode, and TypeScript 5.9 ships no `lib.es2025`, so the Node 26 upgrade does not widen what a config can contain.
- Nothing in the repository typechecks the root `test` directory, the Vitest configs, or the CLI's own config fixtures. `pnpm typecheck` only runs the three package check projects.
- The shipped bin contract is `node packages/cli/lib/bin.js`, and `@eedsh/runtime` is imported by DSH inside a plain Node child process that eedsh spawns. Neither may depend on a TypeScript loader.

See proposal.md for motivation and the two capability specs for required behavior. This design covers how the toolchain is arranged to satisfy them.

## Goals / Non-Goals

**Goals:**

- Evaluate full TypeScript configs in-process, with no build step, no temporary files, and no re-exec of the CLI.
- Make static typechecking the only typechecking, owned by the config's project, with `eedsh check` as the explicit executor.
- Keep the runtime dependency surface to exactly one loader, confined to `@eedsh/cli`.
- Keep the shipped artifact contract: `node lib/bin.js` starts with plain Node, and no loader is required by DSH or by `@eedsh/runtime`.
- Make the repository's own quality gate cover every TypeScript file it contains.

**Non-Goals:**

- Registering a loader in the spawned DSH process or supporting TypeScript DSH plugins.
- Removing the `tsc` build, pointing package exports at `.ts` sources, or converting the repository's `.js` import specifiers.
- Implementing a compiler-API checker, eedsh-imposed compiler options, or tsconfig resolution of eedsh's own.
- TypeScript 7 native tooling, `eedsh init`, or profiles written by another tool.

## Decisions

### D1: tsx registered in-process, not used as a runner

`loadConfig` registers `tsx`'s ESM and CJS hooks lazily, once per process, before the first import, then performs the existing cache-busted native import. `node lib/bin.js` remains the entry point; nothing is re-executed and no `--import` flag is required.

*Alternatives considered:*

- `node --import tsx lib/bin.js` or re-exec with `NODE_OPTIONS`: doubles startup, complicates signal/exit handling, and moves the loader into the bin's contract.
- Making `tsx` the package bin: users would run a wrapper rather than the shipped artifact, and the built `lib` would need a second entry path.
- A custom `module.registerHooks` loader built on `ts.transpileModule`: would collapse to one dependency, but re-implements specifier resolution, ESM/CJS interop, and source mapping — precisely the surface tsx already maintains. Revisit only if a compiler-API need ever returns.

Both `tsx/esm/api` and `tsx/cjs/api` registration are required: a `.ts` config in a project without `"type": "module"` is classified as CommonJS by Node, and the dynamic import reaches the CJS loader rather than the ESM hooks. If the spike shows CJS configs cannot be supported this way, the fallback is to require ESM configs explicitly — which is a spec change, so the spike comes first.

The existing `new Function`-wrapped dynamic import stays. Its purpose is unchanged (stop transformer-level rewriting of the specifier so the process loader handles the config); only its comment changes, because the process loader is now tsx rather than Node's stripping.

### D2: TypeScript-only config discovery

Discovery looks for `eedsh.config.ts` then `eedsh.config.mts`. When neither exists but a `.js` or `.mjs` config does, the CLI reports `config.unsupported_extension` rather than "config not found", so the migration hint is the first thing a user sees. An explicit `--config` with a JavaScript extension fails the same way before evaluation.

*Alternatives considered:* accepting `.mjs` as an unchecked escape hatch (rejected — it recreates the gap the change exists to close); accepting JavaScript with `checkJs` (rejected — the strictness contract is TypeScript's, and JSDoc-shaped configs are not the target).

### D3: Static checking in the project, executed by `eedsh check`

`eedsh check` resolves the config by D2's rules, walks upward for the nearest `tsconfig.json`, resolves the TypeScript package from the config's directory, prints the version, tsconfig, and full command line, then spawns `process.execPath <typescript>/bin/tsc --noEmit -p <tsconfig>` with `stdio: inherit` and forwards passthrough arguments. It never evaluates the config, never publishes, and exits with tsc's code.

A project check can pass vacuously when the config file is not in the tsconfig's file set, so the command first runs `tsc -p <tsconfig> --listFilesOnly` and confirms the config appears. When it does not, the command fails with `check.config_not_in_project` naming the tsconfig and the fix instead of reporting a check that never looked at the config. The preflight lists files without typechecking, so it is cheap relative to the check it guards.

Resolving TypeScript from the config's directory (via `createRequire` anchored there, then reading the package manifest's `bin.tsc`) rather than from the CLI's own dependencies is what makes the check *the project's* check: its tsconfig, its `paths`, its version.

*Alternatives considered:*

- In-process compiler API: rejected earlier in exploration — a second runtime dependency, a duplicated option set, and a checker that disagrees with the project's tsconfig on `paths`, `verbatimModuleSyntax`, and module classification.
- Spawning tsc on every `sync`: rejected — puts a whole-project compile on the hot path and makes "TypeScript missing" a sync failure.
- Running the user's package-manager script: rejected — unknowable script names and hidden behavior; `eedsh check` stays a plain `tsc`.

### D4: One root check project is the repository gate

A root `tsconfig.check.json` extends `tsconfig.base.json` with `noEmit`, `paths` for the two workspace packages, and includes package sources and tests, the root `test` directory, both Vitest configs, and the CLI fixtures. The root `typecheck` script runs that project; `typecheck:watch` runs it with `--watch --preserveWatchOutput`. Package-level check configs stay for developers working inside one package, but the root project is authoritative because it is the only one that sees everything.

`pnpm verify` therefore fails on a type error anywhere, including the root tests, Vitest configuration, and example configs. CI drops to the Node 26 matrix entry.

*Alternative considered:* per-package watch scripts stitched together with `pnpm -r --parallel` (rejected — three scripts plus a root script to cover files that belong to no package).

### D5: Node 26 baseline, types aligned to it

Engine fields become `>=26` on the root and all three packages, CI runs Node 26 only, and `@types/node` moves to the 26 line. `target`/`lib` stay `es2024` because TypeScript 5.9 has no `lib.es2025`; Node 26's newer globals come from the Node type definitions instead.

### D6: Documentation states the contract, examples prove it

The README's Node requirement, config-authoring section, and development commands are rewritten: typechecking is the project's responsibility before eedsh runs; `eedsh check` is the explicit executor; eedsh validates plans at runtime and performs no load-time checking. The completed `add-typed-profile-layer-api` change's design notes about Node type stripping and erasable-only configs are superseded by this decision, not edited in place.

## Risks / Trade-offs

- **Process-global loader hooks** → registration happens once, lazily, in `loadConfig`; tests that assert resolution behavior run in their own files, and the loader is never registered for `--help`/`--version`.
- **tsx transform caching versus the mtime cache-buster** → the watch path is covered by an explicit test that edits a config and asserts the new plan is used; the spike verifies behavior before tasks are written.
- **CJS-project configs may not reach the tsx hooks** → spike before implementation; fallback is ESM-only configs, which requires a spec change and a user-facing error rather than a silent failure.
- **`eedsh check` depends on the user's project declaring TypeScript** → stable `check.typescript_missing` error naming the install command; documented as a project prerequisite, not a recommendation.
- **Vacuous check success when the config is outside the tsconfig's file set** → guarded by the `--listFilesOnly` preflight and `check.config_not_in_project`; the alternative (silent success) would make `eedsh check` untrustworthy.
- **Whole-project tsc runtime on large projects** → it is explicit and off the sync path; passthrough arguments let users narrow behavior, and the tool prints the invocation for reproduction.
- **Breaking changes: Node 24 support and `.js`/`.mjs` configs** → engine warning from the package manager and a dedicated error code with a migration hint; both are called out in the proposal and release notes.
- **No enforced check means an unchecked config can still publish** → accepted trade-off; the meaning of "type checking is the requirement" is a project contract enforced by its CI and demonstrated by eedsh's own typechecked examples.
- **New runtime dependency for every CLI install** → one exact-pinned package (plus its platform esbuild binary); no new dependency reaches `@eedsh/config` or `@eedsh/runtime`.

## Migration Plan

1. Land the Node 26 baseline and the typechecking gate first; they are independent of the loader and make later changes safe.
2. Switch config discovery and evaluation in one commit so no released state accepts a config it cannot load.
3. Add `eedsh check` and document it; users who rename `.mjs` → `.ts` get a working config immediately, and users adding checking run it in CI.
4. No on-disk format changes: plans, generated bundles, and published profiles are untouched. Rollback is a revert; profiles written by the previous version remain valid.

## Open Questions

None. The CJS-loader question is a spike that can invalidate the ESM/CJS requirement, so it is scheduled before implementation rather than left open.
