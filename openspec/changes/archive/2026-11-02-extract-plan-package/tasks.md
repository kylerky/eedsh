## 1. Plan package scaffold

- [x] 1.1 Create `packages/plan/package.json` (name `@eedsh/plan`, `type: module`, exports pointing at `lib`, `engines.node >= 26`, effect peer and dev dependency at the shared exact version), `tsdown.config.ts`, and `tsconfig.json`; verify the files exist and `pnpm --filter @eedsh/plan build` succeeds.
- [x] 1.2 Add the workspace entry to the lockfile with `pnpm install` and verify `pnpm --filter @eedsh/plan build` and `pnpm typecheck` pass for the empty package.
- [x] 1.3 Immediately use git to commit the package scaffold, excluding openspec artifacts.

## 2. Move the plan contract

- [x] 2.1 Move `packages/config/src/plan/{constants,types,schema,validate,json,plain-object}.ts` and their tests into `packages/plan`, update `src/index.ts`, and verify the moved tests pass with `pnpm vitest run packages/plan`.
- [x] 2.2 Move envelope decoding, `EedshConfigSchema`, `configValue`, `InvalidConfigValue`, and `validateConfigValue` into `packages/plan`, keeping the forged-Result rejection tests; verify the validator tests pass.
- [x] 2.3 Move `hashPlan` into the CLI materialization code and update the generation-record imports; verify the generated-bundle and record tests pass and `packages/plan/src` imports no `node:` module.
- [x] 2.4 Immediately use git to commit the moved contract, excluding openspec artifacts.

## 3. Slim the authoring package

- [x] 3.1 Add failing boundary tests that assert `@eedsh/config` exports no runtime plan validators and that `@eedsh/plan` is imported by `@eedsh/cli`; verify they fail before the rewiring.
- [x] 3.2 Rewire `@eedsh/config` to import from `@eedsh/plan`, keep `defineConfig`/`defineProfile` and the patch helpers, and add type-only plan re-exports; verify the authoring API tests pass.
- [x] 3.3 Update the CLI's import sites (`config.ts`, `selection.ts`, `cli.ts`, `doctor.ts`, `preflight.ts`, `materialize/*`, `internal/effect/services.ts`) to `@eedsh/plan`; verify `pnpm typecheck` and the CLI test suite pass.
- [x] 3.4 Split CLI test imports by symbol and move any plan-only fixtures with the moved code; verify the full `pnpm test` run passes.
- [x] 3.5 Immediately use git to commit the rewiring, excluding openspec artifacts.

## 4. Enforce the new topology

- [x] 4.1 Extend `test/architecture.test.ts` with the plan package, the one-shared-Effect-version check across plan, config, and CLI, and the authoring rule (schema/result only, no Effect runtime, Effect-free DSH helpers only); verify the test passes and a deliberately introduced violation is caught.
- [x] 4.2 Update README and package descriptions for the three internal packages; verify the README's dependency statements match the manifests.
- [x] 4.3 Run `pnpm verify` and `openspec validate extract-plan-package --strict`; verify both pass, then immediately use git to commit the boundary and docs work, excluding openspec artifacts.
