## 1. Node 26 baseline and the typechecking gate

- [x] 1.1 Set `engines.node` to `>=26` in `package.json` and add the same field to `packages/config/package.json` and `packages/cli/package.json`; verify with `node -p "require('./package.json').engines.node"` and a successful `pnpm install --frozen-lockfile`
- [x] 1.2 Drop Node 24 from `.github/workflows/ci.yml` (matrix `[26]`) and from `README.md` (requirement line and CI line); verify no Node 24 reference remains with `grep -rn "24" .github/workflows/ci.yml README.md`
- [x] 1.3 Raise `@types/node` to the Node 26 line in the root devDependencies; verify `pnpm install` and `pnpm typecheck` pass
- [x] 1.4 Add root `tsconfig.check.json` extending `tsconfig.base.json` with `noEmit`, `paths` for both workspace package sources, and includes for `test`, `vitest.config.ts`, `vitest.slow.config.ts`, `packages/*/src`, and `packages/*/test`; verify `tsc -p tsconfig.check.json` passes and `tsc -p tsconfig.check.json --listFilesOnly | grep test/architecture` lists the root test
- [x] 1.5 Point the root `typecheck` script at the root check project and add `typecheck:watch`; verify a deliberately planted type error in `test/architecture.test.ts` fails `pnpm typecheck`, then remove it
- [x] 1.6 Immediately use git to commit the Node 26 baseline and typecheck gate, excluding `openspec/`

## 2. TypeScript-only config discovery

- [x] 2.1 Add failing tests in `packages/cli/test/cli.test.ts`: discovery selects `eedsh.config.ts` ahead of `eedsh.config.mts`, an explicit `.mts` path loads, and a `.js` or `.mjs` config exits non-zero with `config.unsupported_extension` naming both accepted filenames and publishing nothing; verify the new tests fail for the expected reason
- [x] 2.2 Restrict `CONFIG_FILENAMES` to the two TypeScript names, reject explicit JavaScript config paths before evaluation, and add the `config.unsupported_extension` error; verify the tests from 2.1 and the existing discovery test pass
- [x] 2.3 Add `eedsh.config.mts` and rejected `.mjs` fixtures under `packages/cli/test/fixtures/` and update the README config-discovery text; verify `pnpm test` passes
- [x] 2.4 Immediately use git to commit the TypeScript-only discovery change, excluding `openspec/`

## 3. Full TypeScript evaluation through tsx

- [x] 3.1 Add `tsx` (exact `4.23.15`) to `@eedsh/cli` dependencies and install; verify `node packages/cli/lib/bin.js --version` still runs after `pnpm -r build`
- [x] 3.2 Add failing tests and fixtures: a config using an `enum` evaluates and publishes, a config with a syntax error fails with `config.import_failed`, a CommonJS-project config (nearest `package.json` without `"type": "module"`) evaluates, and `sync --watch` applies an edited config; verify each fails before the loader is registered
- [x] 3.3 Register `tsx/esm/api` and `tsx/cjs/api` lazily and idempotently in `loadConfig` before the cache-busted native import, and update the module docstring plus the native-import comment; verify the tests from 3.2 pass
- [x] 3.4 Verify the built CLI integration test still syncs through `node lib/bin.js` with no loader flag, then run `pnpm verify`; if the CommonJS fixture cannot pass, stop and revise the `typescript-toolchain` spec with the user before continuing
- [x] 3.5 Immediately use git to commit the tsx evaluation change, excluding `openspec/`

## 4. The `eedsh check` command

- [x] 4.1 Add failing unit tests through the existing `CliDeps.spawn` seam: the command prints the TypeScript version, the selected tsconfig, and the command line, invokes `--noEmit -p <tsconfig>` through the resolved TypeScript, forwards `-- --pretty false`, returns the compiler's exit code, and materializes nothing
- [x] 4.2 Implement the `check` subcommand, its argument parsing (`--config`, `--` passthrough), and its usage text; verify the tests from 4.1 pass
- [x] 4.3 Implement project resolution (nearest `tsconfig.json`, TypeScript resolved from the config's directory via its manifest `bin.tsc`, `--listFilesOnly` membership preflight) and add failing tests for `check.tsconfig_missing`, `check.typescript_missing`, and `check.config_not_in_project`; implement the errors and verify all check tests pass
- [x] 4.4 Add a real integration test in a temporary project (config plus tsconfig) that runs the actual compiler: a clean project exits 0 and a type error exits 1 with the diagnostic text; verify with `pnpm test` and `pnpm test:slow` where applicable
- [x] 4.5 Document `eedsh check` in the README usage block and the config-authoring section, including `-- <tsc args>`; verify `eedsh check --help` lists `--config` and the passthrough
- [x] 4.6 Immediately use git to commit the check command, excluding `openspec/`

## 5. Boundaries and documentation

- [x] 5.1 Extend `test/architecture.test.ts` to assert `@eedsh/config` and `@eedsh/runtime` neither declare nor import `tsx` or `typescript`; verify the test fails if `tsx` is added to `packages/config/package.json` and passes once removed
- [x] 5.2 Rewrite the README sections on Node, config authoring, and development: configs must typecheck in their project, `eedsh check` is the executor, and no erasable-only or Node-loader claims remain; verify with `grep -rn "type stripping\|erasable" README.md packages/cli/src`
- [x] 5.3 Run `pnpm verify` on Node 26 and confirm `node packages/cli/lib/bin.js sync --config <fixture>` works with no loader flags; verify the published profile is unchanged
- [x] 5.4 Immediately use git to commit the documentation and boundary changes, excluding `openspec/`
