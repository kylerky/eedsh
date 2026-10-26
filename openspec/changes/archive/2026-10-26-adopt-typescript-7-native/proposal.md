## Why

The repository's own toolchain is pinned to TypeScript 5.9.3 while TypeScript 7 — the native Go compiler — is the current release line (7.0.2 stable, 7.1.0-beta). Staying on 5.x leaves the repo two majors behind, and every typecheck and declaration build still runs the legacy JavaScript compiler. The native compiler is now usable end to end, but not on 7.0.x: native declaration emit requires the 7.1 API that tsdown 0.23.2's dts plugin consumes, and the current `dts: { resolver: 'tsc' }` path cannot work on any 7.x because the classic TypeScript compiler API is gone. This change moves the whole repository onto the native compiler, including its published declarations.

A full probe in an isolated copy confirmed the target state: typecheck, package builds with native declaration emit, the 202-test suite, and `eedsh check` against a 7.1.0-beta installation all pass.

## What Changes

- Pin `typescript` to `7.1.0-beta` and `tsdown` to `0.23.2` (which brings `rolldown-plugin-dts@0.29.0-beta.2` and its TypeScript Go declaration generator).
- Remove `baseUrl` from `tsconfig.json`; TypeScript 6 already rejects it and TypeScript 7 removes it, while the existing `paths` mappings resolve from the tsconfig location without it. **BREAKING**
- Remove `resolver: 'tsc'` from `packages/config/tsdown.config.ts` so declaration emit uses the native generator instead of the removed classic API. **BREAKING**
- Regenerate `pnpm-lock.yaml` for the new compiler and bundler versions.
- Keep `@eedsh/cli`'s `tsx` evaluation and `eedsh check` behavior unchanged: a consumer project on TypeScript 7 is resolved and driven through its own `bin/tsc`, which remains a Node launcher for the native binary.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `static-typechecking`: the repository gate runs the TypeScript 7 native compiler, published declarations are emitted by it, and `eedsh check` is required to work against a config project that installs TypeScript 7.

## Impact

- `package.json` (devDependencies), `pnpm-lock.yaml`, `tsconfig.json`, `packages/config/tsdown.config.ts`.
- Repository gates: `pnpm typecheck`, `pnpm build:packages`, `pnpm test`, `pnpm verify`.
- Generated `packages/*/lib` declarations: semantically unchanged, but no longer byte-identical to the 5.9.3 output because the native emitter omits bundler `//#region` markers.
- Development prerequisite: the toolchain now requires the 7.1 beta compiler until 7.1 reaches stable; no runtime or consumer-facing dependency changes.
- Documentation may need to name the native compiler baseline where the authoring loop is described.
