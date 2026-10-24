## Why

eedsh configs are TypeScript, but the runtime only accepts *erasable* TypeScript: Node 26 dropped `--experimental-transform-types`, so the loader the CLI relies on cannot run enums, namespaces, or decorators in a config. At the same time the shipped promise has no guaranteed type checking at all — a config is documented as typed, yet nothing in the toolchain establishes that it typechecks. Both limits belong to the same decision: stop pretending Node's type stripping is the TypeScript story, and adopt a real toolchain.

## What Changes

- **BREAKING** Require Node 26. Drop Node 24 from engines, CI, and docs; raise `@types/node` to the Node 26 line so the declared API surface matches the runtime.
- **BREAKING** Accept only TypeScript configs: `eedsh.config.ts` and `eedsh.config.mts`. `.js` and `.mjs` configs fail with a stable code and a migration hint instead of loading unchecked.
- **BREAKING** Evaluate configs with `tsx` instead of Node's type stripping. `@eedsh/cli` gains `tsx` as a runtime dependency and registers its ESM and CJS hooks in-process before the config import, so `node lib/bin.js` keeps working with no `--import` and no re-exec. Full TypeScript syntax (enums, namespaces, decorators) and tsx's tsconfig-aware resolution become available to configs.
- Stop typechecking at load time. eedsh loads, evaluates, and validates the plan; it makes no in-process compiler-API call and adds no `typescript` dependency to the CLI. Type correctness is established before `eedsh` sees the config.
- Add `eedsh check`: an explicit static typecheck that spells out `tsc`. It resolves the project's TypeScript from the config directory, runs `tsc --noEmit` against the config's nearest `tsconfig.json`, prints the exact command line and tsc's own output, passes through tsc's exit code, and accepts `-- <tsc args>` passthrough. Missing TypeScript or a missing tsconfig produces a stable failure with a fix, never a silent skip.
- Close the repository's own typechecking hole: root `test/`, `vitest.config.ts`, and `vitest.slow.config.ts` are currently excluded from every tsconfig. Add a root check project, typecheck the config fixtures and examples, add a `typecheck:watch` script, and gate CI on Node 26 only.
- Rewrite the documented contract: `eedsh` no longer claims erasable-only TypeScript, no longer claims a Node-loader guarantee, and states that configs must typecheck in their project (editor, `tsc --noEmit`, or `eedsh check`).

**Out of scope for this change:**

- Registering a loader in the spawned DSH process. `eedsh run` still boots a plain `node` child, so TypeScript DSH plugins remain unsupported.
- Pointing package exports at `.ts` sources, dropping the `tsc` build, or converting the repository's `.js` import specifiers.
- In-process typechecking, a compiler API wrapper, or eedsh-imposed compiler options. Strictness is the project's business, documented and demonstrated by eedsh's own examples.
- Type checking outside the config's own project, `eedsh init` scaffolding, and TypeScript 7 native tooling.

## Capabilities

### New Capabilities

- `typescript-toolchain`: the Node 26 baseline, TypeScript-only config discovery, tsx-based config evaluation with full TypeScript syntax, the resolution rules eedsh relies on, and the boundary that eedsh validates plans at runtime but never typechecks them.
- `static-typechecking`: the `eedsh check` command (spelling out `tsc`, its output and exit semantics, and its failure modes) plus the repository gates that keep eedsh's own sources, tests, and example configs typechecked.

### Modified Capabilities

- None. This repository has no archived specs; the in-flight `add-typed-profile-layer-api` change is not in `openspec/specs/` and is superseded in wording only, not requirement structure.

## Impact

- **`@eedsh/cli`**: `tsx` becomes a runtime dependency; config discovery, evaluation, and the module docstring change; `cli.ts` gains the `check` subcommand, its usage text, and its error kinds.
- **Unchanged**: `@eedsh/config` (plan API and schema), `@eedsh/runtime` (bundle and watcher), the materialization pipeline, preflight, HMR, and the published profile format. No new dependency reaches `@eedsh/config` or `@eedsh/runtime`.
- **Toolchain**: root `package.json` engines, scripts, and `@types/node`; a new root `tsconfig.check.json`; `.github/workflows/ci.yml` matrix; `README.md` development, Node, and config-authoring sections.
- **Tests**: a new check-command integration test; loader tests extended to full-syntax and CJS-project configs; fixtures added to a typecheck project; the architecture boundary test extended to tsx.
- **Dependencies**: one new runtime dependency (`tsx`, exact-pinned like every other dependency here) and its esbuild platform binary. `typescript` stays a development dependency of this workspace and a project dependency for users; `eedsh` resolves it from the config's project at check time.
