## 1. Service graph and the process boundary (T0a)

- [x] 1.1 Add failing tests for `main(argv): Effect<number, never, CliServices>` and the new `Output` and `Environment` tags; verify they fail because the entry point still takes `CliRunOptions` and the tags do not exist
- [x] 1.2 Implement `Output` and `Environment` with live layers plus a shared `TestLive` base layer; verify the new tests pass and `pnpm test packages/cli/test/cli.test.ts` stays green
- [x] 1.3 Add `DshDiscovery`, `ConfigLoader`, `BundleResolver`, and `Watcher` tags whose live layers delegate to today's functions unchanged; verify `pnpm test packages/cli/test/integration` passes without edits to the integration tests
- [x] 1.4 Make every adapter return its exit code and report its own typed failure through `Output`; delete `setFailureContext`; verify the exit-code assertions in `packages/cli/test/cli.test.ts` still pass
- [x] 1.5 Derive the process result in `bin.ts` from the single `Exit` and remove the mutable `exitCode` capture; verify `node packages/cli/lib/bin.js --help`, an unknown subcommand, and a failing command exit as before
- [x] 1.6 Delete `CliRunOptions` and `CommandRuntime` and migrate every test to provide a layer; verify `pnpm typecheck && pnpm test`
- [x] 1.7 Immediately use git to commit the phase-1 changes excluding openspec artifacts

## 2. One failure vocabulary (T1)

- [x] 2.1 Add reporter tests that assert the exact `eedsh: ` lines for one representative failure per tag; confirm they pass against today's reporter and keep them as the regression baseline
- [x] 2.2 Publish one closed failure union per package and an `EedshError` union in the CLI; verify the reporter tests fail to typecheck until every arm is covered
- [x] 2.3 Replace the `_tag` switch in `packages/cli/src/command/report.ts` with an exhaustive match, porting each arm verbatim; verify the baseline lines from 2.1 are unchanged
- [x] 2.4 Narrow the reporter to `EedshError`, delete `asRecord`-based inspection and the `unknown` parameter, and remove any now-unused message helper; verify `pnpm typecheck` reports no `unknown` at the reporter and `pnpm lint` passes
- [x] 2.5 Audit every `Result` that reaches the CLI edge and either keep it as pure computation or move it to the error channel; verify each remaining seam is a documented `Effect.fromResult` call and list the kept seams in a module comment
- [x] 2.6 Immediately use git to commit the phase-2 changes excluding openspec artifacts

## 3. Child process and filesystem services (T0b, part 1)

- [x] 3.1 Add failing tests for a `ChildProcess`-backed bounded command runner and for `FileSystem`-backed readers, using a fake spawner and a fake filesystem
- [x] 3.2 Replace `spawnSync` in `command-runner.ts`, the DSH bootstrap, source provisioning, `check`, and the version probe with the child-process service; verify `packages/cli/test/command-runner.test.ts`, `dsh-bootstrap.test.ts`, `provision/git.test.ts`, and `init.test.ts` pass
- [x] 3.3 Replace synchronous `node:fs` reads in `dsh-discovery.ts`, `doctor.ts`, `check.ts`, `installation-anchor.ts`, and `internal/tsconfig.ts` with the filesystem service; verify `dsh-discovery`, `doctor`, `check`, and `installation-anchor` suites pass
- [x] 3.4 Remove the remaining filesystem and child-process imports from `packages/cli/src`; verify `pnpm grep`-style inspection shows no `node:fs`, `node:fs/promises`, or `node:child_process` import outside the layer adapters that provide the services
- [x] 3.5 Immediately use git to commit the phase-3 changes excluding openspec artifacts

## 4. Watching and the REPL (T0b, part 2)

- [x] 4.1 Add failing tests for `Watcher.watch(dir)` returning a stream of events, using a fake watcher that emits changes on demand
- [x] 4.2 Implement the chokidar-backed watcher layer with `Effect.acquireRelease` around the subscription; verify the watcher tests pass and closing the stream disposes the subscription
- [x] 4.3 Rewrite watch mode as `Stream.debounce` plus `Stream.runForEach`, delete `stopSignal` and the `AbortSignal` seam, and let interruption release the layer; verify `packages/cli/test/watch.test.ts` and a shutdown-on-interrupt test pass
- [x] 4.4 Replace the REPL's nested `Effect.runPromiseExit` with a direct call inside the invocation program; verify `packages/cli/test/repl` passes with behavior unchanged
- [x] 4.5 Move REPL input to the `Terminal` service over a line stream and session state to a `Ref`; verify all `packages/cli/test/repl` suites pass and no `node:readline` or `node:repl` import remains in `packages/cli/src`
- [x] 4.6 Immediately use git to commit the phase-4 changes excluding openspec artifacts

## 5. Authoring receives resolved inputs (T2)

- [x] 5.1 Add failing tests: a module exporting `(input) => defineConfig()` evaluates, `input.dshVersion` is the selected version, and a non-function default export fails with `config.invalid_default_export`
- [x] 5.2 Implement `ConfigInput`, invoke the exported factory once, and report `config.invalid_default_export`; verify the 5.1 tests and the existing `config.missing_default_export` test pass
- [x] 5.3 Make query handles record `{ bundle, root, row | preset }` descriptors and expose `ConfigBuilder.queries()`; verify with a filesystem spy that evaluating a config that roots and queries bundles reads no file
- [x] 5.4 Move resolution into `@eedsh/cli` as the `BundleResolver` service, keeping the handle and descriptor types in `@eedsh/config`; verify the `authoring-resolution` integration tests pass
- [x] 5.5 Add the resolution phase that deduplicates `(bundle, root)`, resolves in one pass, and calls `build(table)`; verify a failing resolution stops before build and no generation is committed
- [x] 5.6 Remove `installDshBridge`, `clearDshBridge`, `dshVersion()`, and the global resolution-trace store; verify `@eedsh/config` imports no IO or module-loading Node builtin and two consecutive evaluations observe no shared state
- [x] 5.7 Update every config fixture, the canonical example config, and the README migration section to the factory form; verify `pnpm verify`
- [x] 5.8 Immediately use git to commit the phase-5 changes excluding openspec artifacts

## 6. Enforcement and documentation

- [x] 6.1 Add the architecture checks for forbidden Node IO imports, runtime starts outside `bin.ts`, exception control flow, and callable capability seams; verify they fail and list every current violation
- [x] 6.2 Convert or remove each reported violation until the new checks pass; verify `pnpm test test/architecture.test.ts`
- [x] 6.3 Delete the exception allowlist from `test/architecture.test.ts` and keep the single entry safety net assertion; verify the file still asserts the Effect module allowlist for `plan` and `config`
- [x] 6.4 Rewrite the README "Architecture" and "Effect boundaries" sections and the package role table to describe the package-line boundary; verify no claim about `CliRunOptions`, the bridge, or `dshVersion()` remains
- [x] 6.5 Run `pnpm verify` and confirm the full suite passes on the current platform
- [x] 6.6 Immediately use git to commit the phase-6 changes excluding openspec artifacts
