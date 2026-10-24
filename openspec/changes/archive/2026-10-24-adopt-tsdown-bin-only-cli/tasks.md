## 1. Config bundle spike and declaration baseline

- [x] 1.1 Run an ephemeral baseline artifact check: after `pnpm -r build`, use a one-off script or shell commands under gitignored `.tmp/` (not committed, and not added to `packages/cli/test/integration/built-cli.test.ts` or any other test file) to confirm `packages/config/lib/index.js` exists alongside the current per-file mirror such as `lib/plan/schema.js`; record the baseline output and remove or leave the scratch files only under `.tmp/`.
- [x] 1.2 Run an ephemeral consumer declaration check: create a temporary project under gitignored `.tmp/` with `module: nodenext`, `moduleResolution: nodenext`, and `skipLibCheck: false`, link the built `@eedsh/config` package and its `effect` peer, import `defineProfile` and `ProfilePlan`, add a `@ts-expect-error` assertion on an invalid plan field, and run `tsc --noEmit`; verify it passes against the current `tsc` declarations and do not add the project or a test wrapper to the repository.
- [x] 1.3 Add `tsdown@0.23.1` to the root devDependencies and add `packages/config/tsdown.config.ts` with `entry: 'src/index.ts'`, `outDir: 'lib'`, `tsconfig: '../../tsconfig.base.json'`, `fixedExtension: false`, `target: false`, `sourcemap: true`, and `dts: { sourcemap: true, resolver: 'tsc' }`; change the config package `build` script to `tsdown`; verify `pnpm --filter @eedsh/config build` emits only `lib/index.js`, `lib/index.d.ts`, and maps, with `effect` imports left external.
- [x] 1.4 Rerun the ephemeral artifact check and the ephemeral consumer declaration check from 1.1/1.2 against the tsdown output, run the existing config tests, and run `pnpm -r build` to confirm the CLI's `tsc` build still consumes the bundled config declarations; verify all pass and no `.mjs` files appear.
- [x] 1.5 Verify the tsdown install and binary path: run `pnpm install`, inspect the lockfile diff and `pnpm-workspace.yaml` `allowBuilds` entries, add only a specific entry if pnpm blocks a required native build, then run `pnpm --filter @eedsh/config build` and `pnpm install --frozen-lockfile`; if declaration generation fails despite `resolver: 'tsc'`, revert this group and stop with the failure.
- [x] 1.6 Confirm `git status` shows no new test files or committed build artifacts, then immediately use git to commit the config bundling spike, excluding `openspec/`.

## 2. Runtime bundle and build scripts

- [x] 2.1 Rerun the ephemeral artifact check for the runtime: after `pnpm --filter @eedsh/runtime build`, confirm `packages/runtime/lib/index.js` and `lib/index.d.ts` exist while `lib/watcher.js` does not; do not add these assertions to any persistent test.
- [x] 2.2 Add `packages/runtime/tsdown.config.ts` using the D2 shape, change the runtime package `build` script to `tsdown`, and remove the redundant `main` field from `packages/runtime/package.json`; verify `pnpm --filter @eedsh/runtime build`, the ephemeral runtime layout check, and the existing `pnpm test` pass.
- [x] 2.3 Update the root scripts to `build: pnpm typecheck && pnpm -r run build`, `build:packages: pnpm -r run build`, and `verify: pnpm check && pnpm test && pnpm build:packages`; verify a deliberately planted type error makes `pnpm build` fail, remove it, then run `pnpm verify`.
- [x] 2.4 Immediately use git to commit the runtime bundle and root build scripts, excluding `openspec/`.

## 3. Bin-only CLI

- [x] 3.1 Rerun the ephemeral artifact check for the CLI and manually verify the bin-only contract: `packages/cli/lib/bin.js` starts with the shebang and is executable, `packages/cli/lib/index.js` does not exist, and `node packages/cli/lib/bin.js --version` prints the package version; do not add these checks to the persistent test suite.
- [x] 3.2 Delete `packages/cli/src/index.ts`, remove the CLI package `exports` field, add `packages/cli/tsdown.config.ts` with `entry: 'src/bin.ts'`, `dts: false`, and `deps: { neverBundle: [/^@eedsh\//] }`, and change the CLI `build` script to `tsdown`; verify `pnpm -r build`, the existing built-CLI sync test, the ephemeral bin-only check, and `node packages/cli/lib/bin.js --version`.
- [x] 3.3 Run `pnpm typecheck` and `pnpm test` (they fail if the deleted `src/index.ts` is still imported), and inspect the CLI bundle to confirm `@eedsh/config` and `@eedsh/runtime` are not inlined.
- [x] 3.4 Immediately use git to commit the bin-only CLI, excluding `openspec/`.

## 4. TypeScript project consolidation and extensionless imports

- [x] 4.1 Rewrite `tsconfig.base.json` to use `module: preserve` and `moduleResolution: bundler`, remove `declaration`, `declarationMap`, and `sourceMap`, and keep `paths` and `noEmit` out of it; create root `tsconfig.json` from the old `tsconfig.check.json` with `extends`, `noEmit`, `baseUrl`, the `@eedsh/*` paths, and includes for package sources/tests, root tests, both Vitest configs, and all `tsdown.config.ts` files; delete `tsconfig.check.json` and the six package `tsconfig*.json` files; change the root `typecheck` script to `tsc -p tsconfig.json` and remove package `typecheck` scripts; verify `pnpm typecheck` passes with the existing `.js` imports.
- [x] 4.2 Remove the `.js` suffix from every relative specifier in `packages/*/src` and `packages/*/test`; verify `pnpm typecheck`, `pnpm test`, and `pnpm -r build`.
- [x] 4.3 Confirm each tsdown config still reads `tsconfig.base.json` with no path aliases, run `pnpm -r build`, rerun the ephemeral bundle-layout and consumer-declaration checks, and inspect `packages/*/lib` to verify single-entry bundles, `.js` (not `.mjs`) output, and no per-file mirror; do not add the inspection or consumer check to the repository test suite.
- [x] 4.4 Immediately use git to commit the TypeScript consolidation and extensionless imports, excluding `openspec/`.

## 5. Mechanical cleanup

- [x] 5.1 Run the existing CLI and unit tests as the characterization baseline, then extract `ReadableLike`, `SpawnedProcessLike`, `SpawnOptionsLike`, `SpawnLike`, and `defaultSpawn` into `packages/cli/src/spawn.ts`; update `cli.ts`, `check.ts`, and the test imports; verify `pnpm typecheck` and `pnpm test`.
- [x] 5.2 Remove the unused `PlanInvalid` tagged failure, its `MaterializeError` union member, and its `describeError` switch case; verify `pnpm typecheck` and `pnpm test` pass and no reference remains.
- [x] 5.3 Move `packages/cli/src/internal/effect/program.ts` to `packages/cli/src/materialize/program.ts` and update `cli.ts` plus the three test imports; remove the redundant `EXIT_*` re-export from `cli.ts`, remove the `emitPatchesYaml` re-export from `generated-bundle.ts` and import it from `yaml.ts` in the test, and unexport `readProfileBundles`; verify `pnpm typecheck` and `pnpm test`.
- [x] 5.4 Update `packages/runtime/README.md` to describe the single bundled `lib/index.js` and update `packages/cli/README.md` to replace the stale Node-native-loader/type-stripping wording with tsx and to state that the package is bin-only; verify no stale `lib/watcher.js` or type-stripping claim remains.
- [x] 5.5 Immediately use git to commit the mechanical cleanup, excluding `openspec/`.

## 6. Documentation and full verification

- [x] 6.1 Update the root `README.md` development section for the tsdown build, `tsconfig.json` check project, `pnpm build`/`build:packages`/`verify` scripts, bundled `lib` layout, and extensionless imports; verify no reference to `tsconfig.check.json` or a `tsc` build remains.
- [x] 6.2 Run `pnpm install --frozen-lockfile`, `pnpm verify`, `pnpm test:slow`, `node packages/cli/lib/bin.js --version`, and a built `sync` against the built fixture; rerun the ephemeral artifact-layout and consumer-declaration checks one final time and confirm `git status` contains no transient test or build-artifact files; verify all pass, the CLI has only `lib/bin.js` (no `lib/index.js`), and config/runtime have only bundled entries.
- [x] 6.3 Immediately use git to commit the documentation and final verification, excluding `openspec/`.
