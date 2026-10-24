## Why

The workspace is pinned to `effect@3.22.3` plus five `@effect/*` packages, while Effect 4.0.6 is the current release. Effect 4 consolidates those packages into `effect`, replaces `Either` with `Result`, deletes `ParseResult` and its `ArrayFormatter`, rewrites Schema transformations, and replaces the `@effect/cli` option API. Staying on 3.x keeps a locally invented copy of an Effect error type (`PlanIssue` aliasing `ParseResult.ArrayFormatterIssue`), a wrapper error (`PlanValidationError`) whose only job is to re-shape a native failure, and four dependencies that 4.0 no longer needs. Every package is private, so this is the cheapest moment to move and to stop maintaining a hand-rolled error contract.

## What Changes

- Migrate `effect` from `3.22.3` to `4.0.6` (exact pin) in `@eedsh/config` and `@eedsh/cli`, and `@effect/platform-node` from `0.108.3` to `4.0.6`.
- Remove `@effect/cli`, `@effect/platform`, `@effect/printer`, and `@effect/printer-ansi`; their v4 functionality lives in `effect` itself.
- **BREAKING** `@eedsh/config` validation returns Effect `Result` and fails with Effect's native `Schema.SchemaError`. `PlanIssue` and `PlanValidationError` are deleted; no local issue type, summary builder, or dedupe remains. `defineProfile` and `assertPlan` stay synchronous and throw the native `SchemaError`.
- **BREAKING** The authoring and output contracts are not preserved. Plan failures are reported with Effect's native formatted message (`SchemaError.message`), which is multi-line and path-stamped, replacing the current one-line-per-issue `path: message` output, the `plan` root label, and the five-issue truncation.
- Rewrite the plan schema for the v4 Schema API (`Schema.decodeTo` and `SchemaTransformation` in place of `transformOrFail`; `decodeUnknownResult` in place of `decodeUnknownEither`). The strict decode options `errors: 'all'` and `onExcessProperty: 'error'` are preserved, as is the detached-`structuredClone` success guarantee.
- Migrate the CLI command surface from `@effect/cli` 0.77 (`Command`, `Options`, `CliApp`) to `effect/cli` (`Command`, `Flag`, `Argument`).
- Replace the hand-written Node seams with Effect's own platform services: core `effect/FileSystem` in place of the `eedsh/FileSystem` shape (deleting `FileSystemShape`, `nodeFileSystem`, and `FileSystemFailure`), `@effect/platform-node`'s `NodeServices.layer` in place of three deep layer imports, and `ChildProcess`/`ChildProcessSpawner` in place of the manual `node:child_process` plumbing in the package installer. `writeFileAtomic` remains, rebuilt on the core file-system service.
- Replace `Context.GenericTag` with `Context.Service`, `effect/Predicate.isRecord` with a v4 predicate, and re-express the one `Layer.scoped` call under its v4 name.
- Keep `@eedsh/runtime` Effect-free and out of scope. It loads inside the DSH process, where DSH's own Effect 3 runtime lives, and has no effectful work.
- DSH stays at `@deepseek-ai/dsh@0.2.1-rc.2` and keeps its own Effect 3. The CLI spawns DSH as a child process and imports only the Effect-free `resolveProfileDir` and `composeEntries` helpers, so no version shared across the two processes is required.

## Capabilities

### New Capabilities

- `profile-plan-validation`: what an invalid plan produces: a native `Result` failure carrying `Schema.SchemaError`, the synchronous authoring entry point that throws it, the strict all-issues decode, the removal of any local issue or error type, and the formatted failure text the CLI reports.
- `effect-runtime-boundary`: the Effect dependency contract across the workspace: one exact Effect 4 version shared by `@eedsh/config` and `@eedsh/cli`, the v4 module topology the two packages may use, and the enforced absence of Effect from `@eedsh/runtime`.

### Modified Capabilities

None. The plan-shape requirements remain with the unarchived `typed-profile-layering` delta from `adopt-effect-plan-schema`; this change replaces only the validation result and error contract, which moves into the new `profile-plan-validation` capability.

## Impact

- **Code:** `packages/config/src/plan/validate.ts`, `packages/config/src/plan/schema.ts`, `packages/config/src/plan/types.ts`, `packages/config/src/api.ts`, `packages/cli/src/cli.ts`, `packages/cli/src/config.ts`, `packages/cli/src/internal/effect/services.ts`, `packages/cli/src/internal/effect/layer.ts`, `packages/cli/src/internal/effect/errors.ts`, `packages/cli/src/internal/{lock,lock-posix,lock-win32,atomic-write}.ts`, `packages/cli/src/materialize/*.ts`, `packages/cli/src/preflight.ts`, `packages/cli/src/check.ts`, and the `effect/Result`/`effect/Schema` imports throughout.
- **Dependencies:** `effect@4.0.6` and `@effect/platform-node@4.0.6` added; `@effect/cli`, `@effect/platform`, `@effect/printer`, and `@effect/printer-ansi` removed. `@effect/platform-node` also supplies the Node `FileSystem`, `Path`, `Terminal`, `Stdio`, and `ChildProcessSpawner` layers through one `NodeServices` layer. No dependency is added to `@eedsh/runtime`.
- **Tests:** `packages/config/test/plan/validate.test.ts`, `packages/config/test/plan/schema.test.ts`, `packages/config/test/plan/types.test.ts`, `packages/cli/test/cli.test.ts`, `packages/cli/test/internal/*`, and `test/architecture.test.ts` whitelist and version assertions.
- **Docs:** `README.md` Effect-boundaries and CLI-failure sections; `@eedsh/config` and `@eedsh/cli` JSDoc `@throws` and validation text.
- **Behavior:** exit codes, flags, profile layout, and generation format are unchanged. Plan failures now print Effect's native formatted message instead of `path: message` lines, the public validation API returns `Result<ProfilePlan, Schema.SchemaError>`, and file-operation failures surface as Effect `PlatformError` values instead of a project-defined `FileSystemFailure`.
- **Sequencing:** independent of DSH upgrades; can proceed now. The command-surface migration and the config/schema migration touch disjoint files and may be verified separately.
