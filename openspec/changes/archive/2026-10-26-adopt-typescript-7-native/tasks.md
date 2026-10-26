## 1. Pin the native compiler (test first)

- [x] 1.1 Capture the current declaration baseline: copy `packages/config/lib/index.d.ts` and `packages/runtime/lib/index.d.ts` to `/tmp/eedsh-dts-baseline/`; verify the copies exist and are non-empty.
- [x] 1.2 Strengthen the existing compiler test in `packages/cli/test/integration/built-cli.test.ts` so it reads the repository root `package.json` and asserts that `eedsh check` prints that exact `typescript` version; run the test against the current 5.9.3 pin and verify it fails for the expected version mismatch.
- [x] 1.3 Pin `typescript@7.1.0-beta` and `tsdown@0.23.2` in the root `package.json`, run `pnpm install`, and verify `./node_modules/.bin/tsc --version` reports `7.1.0-beta` and `pnpm-lock.yaml` records the new versions.
- [x] 1.4 Delete `baseUrl` from `tsconfig.json`, run `pnpm typecheck`, and verify it passes with the native compiler and still resolves the `@eedsh/*` path mappings.
- [x] 1.5 Remove `resolver: 'tsc'` from `packages/config/tsdown.config.ts`, run `pnpm build:packages`, and verify all three packages build and `packages/config/lib/index.d.ts` plus `packages/runtime/lib/index.d.ts` are regenerated.
- [x] 1.6 Run `pnpm test` and verify the full suite passes, including the strengthened compiler-version assertion from 1.2.
- [x] 1.7 Immediately use git to commit the toolchain pin, config deletions, lockfile, and test update, excluding openspec artifacts.

## 2. Verify the native gate end to end

- [x] 2.1 Diff each regenerated declaration file against its `/tmp/eedsh-dts-baseline/` copy; verify the only differences are bundler `//#region` comments and that no exported type changed.
- [x] 2.2 Build the CLI and run `node packages/cli/lib/bin.js check --config packages/cli/test/fixtures/basic/eedsh.config.ts`; verify it prints TypeScript `7.1.0-beta`, the selected tsconfig, the exact command line, and `eedsh: check passed`.
- [x] 2.3 Start `pnpm typecheck:watch`, confirm it completes an initial check under the native compiler, then stop it and verify no crash or unsupported-option error was reported.
- [x] 2.4 Temporarily pin `typescript@7.0.2` (without committing), run `pnpm build:packages`, and verify it fails with the message that the classic TypeScript API is unavailable rather than emitting declarations; restore `7.1.0-beta` and verify the build passes again.
- [x] 2.5 Add the TypeScript 7.1-native development prerequisite where the README lists toolchain requirements, and verify the stated version matches the root `package.json` pin.
- [x] 2.6 Run `pnpm verify` and verify biome, typecheck, tests, and package builds all pass on Node 26.
- [x] 2.7 Immediately use git to commit the README update and any declaration-output adjustments, excluding openspec artifacts.
