## Context

The repository pins `typescript@5.9.3` and `tsdown@0.23.1`, declares `baseUrl` in `tsconfig.json`, and builds declarations for `@eedsh/config` with `dts: { resolver: 'tsc' }`. See proposal.md for why this must change.

Constraints established by a probe in an isolated copy of the repo:

- TypeScript 7's package has no classic compiler API. `import * as ts from "typescript"` returns only `version` and `versionMajorMinor`; the compiler API moved under `typescript/unstable/*`, and `bin/tsc` is a Node launcher that executes the native binary.
- `rolldown-plugin-dts@0.29.0-beta.2` loads a native declaration API from `typescript/async` and requires `Program.prototype.getDeclarationEmit`. TypeScript 7.0.2 exposes `typescript/unstable/async` only, so the native generator cannot load there; 7.1.0-beta exposes the expected path.
- The plugin's `tsc` resolver (and therefore `resolver: 'tsc'`) requires the classic API and rejects every 7.x package. Its Oxc fallback requires `isolatedDeclarations`, which produces 65 errors here, including four `TS9021` failures on Effect `TaggedError<...>()` extends-expressions that annotations cannot fix.
- With `typescript@7.1.0-beta` + `tsdown@0.23.2` + `baseUrl` removed + `resolver: 'tsc'` removed: typecheck passes, all three packages build with native declarations, 202 tests pass, and `eedsh check` reports `TypeScript 7.1.0-beta` and passes. The emitted `index.d.ts` differs from the 5.9.3 build only in 19 lines of bundler `//#region` comments.
- `tsdown@0.23.2` is the latest release and depends on `rolldown-plugin-dts ^0.29.0-beta.2`. `tsdown@0.23.1` pins `^0.28.7`, which refuses TypeScript 7 entirely.

## Goals / Non-Goals

**Goals:**

- Every repository gate (`typecheck`, package builds, tests) runs on the TypeScript 7 native compiler, including declaration emit.
- Keep the change to dependency pins plus two configuration deletions; no source refactor and no user-facing behavior change.
- Make the required compiler floor explicit so a 7.0.x pin fails loudly at build time instead of silently degrading.

**Non-Goals:**

- Refactoring exports for `isolatedDeclarations`/`oxc` compatibility, including the Effect `TaggedError` classes.
- Supporting TypeScript 5.x or a dual-compiler build after this change.
- Changing `eedsh`'s config discovery, evaluation, or check semantics for consumers.
- Replacing `tsx` runtime evaluation, which is independent of the installed TypeScript version.

## Decisions

**Pin `typescript@7.1.0-beta`, not 7.0.2.** Native declaration emit is only available through the `typescript/async` API that 7.1 provides. Alternatives: 7.0.2 paired with a second TypeScript 6 compiler for declarations (contradicts "whole repo native" and adds a shadow toolchain); 7.0.2 with the Oxc generator (blocked by the `TS9021` Effect error classes); waiting for 7.1 stable (defers the requested adoption indefinitely). The beta pin is the only path that is native end to end today.

**Bump `tsdown` to 0.23.2 and accept its beta dts plugin.** 0.23.2 is the current latest and the first release whose dts plugin supports the native generator. Forcing `rolldown-plugin-dts@0.29` onto 0.23.1 through an override would fight its declared dependency range; a custom declaration pipeline would be significantly more code than this change warrants. Both pins are exact, so nothing floats.

**Delete `baseUrl` instead of suppressing the deprecation.** TypeScript 6 rejects `baseUrl` unless `ignoreDeprecations: "6.0"` is set, and TypeScript 7 removes the option outright. The existing `paths` mappings already point at repository-relative files and resolve from the tsconfig location without `baseUrl`, which the probe confirmed on both 5.9.3 and 7.1.0-beta.

**Drop `resolver: 'tsc'` from the `@eedsh/config` dts build.** The resolver only selects how declarations resolve dependencies; the native generator supplies emission. Removing the option lets the plugin choose its native generator when the installed TypeScript exposes it, and keeps the build failing loudly when it does not. Keeping the resolver would require the classic API and cannot work on 7.x.

**Leave `eedsh check` unchanged.** TypeScript 7 still ships `bin/tsc` as a Node launcher, and `--noEmit`, `-p`, and `--listFilesOnly` all behave as before, so resolution, version printing, project-membership verification, and exit-code propagation continue to work. The probe exercised the real command against a 7.1.0-beta installation.

**No fallback to a second compiler.** If the pinned TypeScript stops exposing the native API, the build fails rather than silently emitting declarations through a non-native path. This keeps "native" a checkable property rather than a convention.

## Risks / Trade-offs

- **Beta compiler and beta dts plugin** → pin exact versions, keep the upgrade to 7.1 stable as a follow-up, and rely on the full gate (typecheck, build, tests) before merging. No ranges means no surprise upgrades.
- **Declaration output is not byte-identical** → the probe showed only `//#region` comment differences. Review the emitted `packages/*/lib/*.d.ts` diff during implementation and treat any public-type change as a failure.
- **`tsc --watch` was not exercised by the probe** → smoke-test the watch script before merging; if the native compiler rejects it, record that as a follow-up rather than removing the script.
- **Native compiler option coverage** → the probe typechecked with the repository's full strict option set, but any option the native compiler silently ignores would not surface. Keep the existing `pnpm verify` gate and CI on Node 26 unchanged.
- **Consumer projects remain independent** → their `eedsh check` runs their own TypeScript, so this change neither forces 7.x on them nor breaks their 5.x/6.x installs.

## Migration Plan

1. Update the pins, delete `baseUrl`, and remove the dts resolver in one commit with the regenerated lockfile.
2. Run `pnpm verify` (biome, typecheck, tests, builds) and inspect the declaration diff.
3. Rollback is a revert of the five files plus `pnpm install`; no published state, profile, or runtime artifact is affected.
