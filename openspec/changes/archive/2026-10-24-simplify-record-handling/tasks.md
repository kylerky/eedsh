## 1. Characterization tests

- [x] 1.1 Add cases to `packages/cli/test/materialize/profile.test.ts` for an absent `dsh` section, `dsh` as null/array/scalar, `dsh.profile` as null/array/scalar, and preservation of unrelated `dsh` and `profile` fields; verify they pass against the current implementation with `pnpm exec vitest run packages/cli/test/materialize/profile.test.ts` (they pin the behavior the refactor must preserve).
- [x] 1.2 Add cases asserting that `reconcileManifest` does not mutate the input manifest and that reconciling the same input twice produces canonically equal output; verify with the same command.
- [x] 1.3 Immediately use git to commit the characterization tests excluding openspec artifacts.

## 2. Predicate sweep

- [x] 2.1 Replace the local `isObject` definitions in `packages/cli/src/materialize/manifest.ts` and `packages/cli/src/preflight.ts` with `isRecord` from `effect/Predicate`; verify with `pnpm typecheck` and `pnpm exec vitest run packages/cli/test/materialize/profile.test.ts packages/cli/test/materialize/preflight.test.ts`.
- [x] 2.2 Replace the inline loose checks in `packages/cli/src/materialize/program.ts`, `packages/cli/src/check.ts`, and `packages/cli/src/cli.ts` with `isRecord`, dropping any cast the guard makes unnecessary; verify with `pnpm typecheck` and `pnpm exec vitest run packages/cli/test/cli.test.ts`.
- [x] 2.3 Immediately use git to commit the predicate sweep excluding openspec artifacts.

## 3. Manifest write path

- [x] 3.1 Add the private `childRecord(parent, key)` accessor to `packages/cli/src/materialize/manifest.ts` and use it in `readProfileBundles`; verify with `pnpm exec vitest run packages/cli/test/materialize/profile.test.ts`.
- [x] 3.2 Rewrite `buildManifest` to return a single object literal built with `childRecord`, removing the leaf spreads and write-backs while keeping `structuredClone`; verify with `pnpm exec vitest run packages/cli/test/materialize/profile.test.ts` and confirm the input-not-mutated and canonical-idempotence cases pass.
- [x] 3.3 Immediately use git to commit the manifest write-path refactor excluding openspec artifacts.

## 4. Full verification

- [x] 4.1 Run `pnpm check` and confirm Biome and the TypeScript project are clean.
- [x] 4.2 Run `pnpm test` and confirm the full suite passes (the slow HMR test is excluded by the default config).
- [x] 4.3 Run `pnpm build:packages` and confirm both shipped packages build.
- [x] 4.4 Immediately use git to commit any verification fixes excluding openspec artifacts.
