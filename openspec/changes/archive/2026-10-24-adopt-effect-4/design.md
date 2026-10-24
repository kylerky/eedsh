## Context

See `proposal.md` — Why. The constraints that shape the approach:

- Effect 4.0.6 is the current release; the workspace pins `effect@3.22.3` and five `@effect/*` packages in `@eedsh/config` and `@eedsh/cli` only.
- 48 source imports touch Effect across 31 files: 23 bare `effect`, 9 `effect/Either`, 5 `effect/Predicate`, 5 `effect/ParseResult`, 3 `effect/Schema`, and one each for `Option`, `Data`, `Console`, plus `@effect/cli` and three `@effect/platform-node` deep imports.
- `defineProfile` and `assertPlan` must stay synchronous: a config module default-exports plain data, so validation cannot return an Effect.
- `@eedsh/runtime` loads inside the DSH process, where DSH's Effect 3.22.3 is live. It must stay Effect-free.
- `eedsh run` spawns DSH as a child process (`process.execPath [binPath, '--profile', …]`) and imports only `resolveProfileDir` and `composeEntries` from `@deepseek-ai/dsh-app-boot`, a package with no Effect dependency and no Effect imports in its lib. The two processes therefore never share an Effect runtime.
- Verified v4 facts the design relies on: `effect/Either` does not exist (`effect/Result` replaces it); `effect/ParseResult` does not exist and has no `ArrayFormatter` successor; `Schema.SchemaError` is a `Data.TaggedError` with a positional `issue` constructor, an `issue` field, a `message` getter delegating to `SchemaIssue.defaultFormatter`, and a `toJSON` that emits only `{ _tag, message }`; `SchemaIssue.makeFormatterStandardSchemaV1()` returns `{ issues: [{ path, message }] }`; `Context.GenericTag` is gone and `Context.Service<Shape>(key)` replaces it; `Predicate.isRecord` is gone; `effect@4.0.6` declares no runtime dependencies; `@effect/platform-node@4.0.6` still ships `NodeFileSystem`, `NodePath`, and `NodeTerminal` deep entries that each export `layer`, and additionally exports `NodeServices.layer` typed `Layer<ChildProcessSpawner | Crypto | FileSystem | Path | Stdio | Terminal>`; core `FileSystem` exposes 31 methods and a test constructor `FileSystem.makeNoop(partial)`; `effect/process` exports `ChildProcess` and `ChildProcessSpawner`, whose handle exposes `exitCode` and stdout/stderr streams and whose spawner exposes `exitCode(command)`; core `FileSystem` has no atomic-write helper.

## Goals / Non-Goals

**Goals:**

- One Effect 4.0.6 installation providing every Effect capability the workspace uses, with no local re-implementation of an Effect type.
- Native failure values from validation through reporting: `Result`, `Schema.SchemaError`, `SchemaIssue`.
- The command surface parsed by `effect/cli` from the core package.
- Boundary rules updated in code and in the architecture test, not just in the README.

**Non-Goals:**

- Preserving the authoring API or the current stderr format. Both are explicitly replaced.
- Changing profile layout, generation format, exit-code meanings, flags, or materialization semantics.
- Touching DSH's version, its Effect 3 runtime, or `@eedsh/runtime`.
- Migrating the synchronous `node:fs` reads at the CLI boundary (config discovery, DSH resolution, `check`) or the DSH launcher spawn seam; both keep their current shapes.
- Introducing a compatibility shim, dual-version support, or a migration path for a 3.x consumer; every package is private.

## Decisions

### D1. Delete the local validation contract rather than port it

`PlanIssue` and `PlanValidationError` are deleted. `validatePlan` returns `Result.Result<ProfilePlan, Schema.SchemaError>`, `assertPlan` throws that error, and the public schema remains the single validator.

*Alternatives.* (a) Keep a flat `{_tag, path, message}` projection with the native tree attached as `cause` — rejected: it re-implements a formatter v4 already ships and perpetuates a type whose only purpose is to soften Effect's error. (b) Keep the flat shape only — rejected: same re-implementation with none of the native reach-through. The user direction is explicitly "do not keep the authoring or output contract; be as native and ergonomic as possible".

*Consequence.* The exported surface shrinks to `ProfilePlanSchema`, `validatePlan`, and `assertPlan`. `decodePlan` is dropped; `validatePlan` already returns the native `Result`, and the strict decode options live in one place.

### D2. `Schema.decodeUnknownResult` is the decode primitive

`validatePlan` decodes with `Schema.decodeUnknownResult(ProfilePlanSchema, { errors: 'all', onExcessProperty: 'error' })` and `assertPlan` reuses `validatePlan` and throws the failure.

*Alternatives.* `SchemaParser.decodeUnknownResult` fails with a bare `SchemaIssue.Issue`, which would require the config package to construct `new Schema.SchemaError(issue)` itself. Rejected: it hand-builds what the schema API already returns, and it would make the sync and result paths produce different error construction code. The raw tree stays reachable through `error.issue`.

### D3. Report failures by printing the native message

`describeError` gains a `Schema.isSchemaError` branch that returns `error.message.split('\n')`; `formatIssuePath`, the `PlanValidationError` branch, and the config-side `describePath`/`summarize`/`dedupe` helpers are deleted. `report` keeps prefixing each line with `eedsh: `, so a located failure prints as its message line followed by its `at [path]` line.

*Alternatives.* Rebuild the old `path: message` layout with `makeFormatterStandardSchemaV1()` — rejected by user direction and because it would keep a presentation contract that exists only in the README. Deduplication and five-issue truncation are dropped with it; v4 reports each issue once per decoder pass and the duplicate suppression was compensating for `ArrayFormatter`, not for the plan.

### D4. Rewrite the schema in place, keeping its rules

The plan schema keeps its struct, filter, and JSON-guard structure. `Schema.transformOrFail` becomes `Schema.decodeTo` with a `SchemaTransformation`; `Schema.decodeUnknownEither` becomes `decodeUnknownResult`; `Schema.FilterIssue` and `Schema.FilterOutput` remain the filter failure and output types. Every existing rule — duplicate layers, generated-marker count, reserved names, JSON compatibility, expression-node shape — is preserved as a filter, because the rules are the plan contract and are not part of the dropped authoring/output contract.

### D5. `effect/cli` replaces `@effect/cli` at the same flag surface

`CliApp.run` becomes `Command.run` (or `Command.runWith(command, { version })` when tests need injected argv); `Options.*` becomes `Flag.*`; `Command.make` and `Command.withSubcommands` keep their names. Flag names, aliases, defaults, and descriptions stay identical so `sync`, `check`, and `run` accept the same invocation. Command construction stays in one place so the `runCli` test seam survives.

### D6. `Context.Service` replaces `Context.GenericTag` one-for-one

Each remaining `eedsh/*` tag becomes `Context.Service<Shape>('eedsh/…')` with its key unchanged (the file-system tag is deleted rather than converted — see D11), so layers, tests, and `Effect.provide` call sites keep their names. `Layer.succeed`, `mergeAll`, `provide`, and `effect` remain; the single `Layer.scoped` call is re-expressed with the v4 scoped constructor.

### D7. Replace `isRecord` with the v4 predicate at each site

`Predicate.isObject` is used where the check is "an object, not an array", which is every current `isRecord` caller. A local guard is added only if a caller needs plain-record semantics that `isObject` does not provide; no shared "compat" module is introduced.

### D8. Consolidate dependencies behind the core package

`packages/cli/package.json` declares `effect@4.0.6` and `@effect/platform-node@4.0.6` and drops `@effect/cli`, `@effect/platform`, `@effect/printer`, and `@effect/printer-ansi`. `packages/config/package.json` keeps `effect@4.0.6` as peer and dev dependency. Pins stay exact, matching the existing style and keeping the "same Effect version" assertion meaningful.

### D9. Enforce the new boundary in the architecture test

`CONFIG_EFFECT_MODULES` becomes `['effect/Schema', 'effect/Result']`. The version-agreement assertion is unchanged. A dependency assertion is added that the CLI declares no `@effect/cli`, `@effect/platform`, or `@effect/printer*` package, and that no source file imports one.

### D10. Keep the detached clone on success

`validatePlan` still returns `structuredClone` of the decoded plan. Decoding already produces fresh objects, but the clone guarantees that a caller mutating the result cannot reach the input, which keeps the published plan stable for hashing and comparison. This is a two-line guarantee, not a contract being preserved.

### D11. Effect's platform services replace the hand-written Node seams

The CLI stops wrapping Node APIs in its own shells and takes the platform-provided services instead:

- `eedsh/FileSystem` and its six-method `FileSystemShape` are deleted. The materialization pipeline, the sync lock, and the atomic writer take the core `effect/FileSystem.FileSystem` service, and the live layer comes from `@effect/platform-node`'s `NodeServices.layer` instead of three separate deep-imported layers.
- `FileSystemFailure` is deleted. File operations already fail with `PlatformError`, which carries the operation, path, and reason, so the local error only re-labelled it. Its `describeError` branch goes with it.
- `writeFileAtomic` stays as a CLI-level helper, re-implemented over `FileSystem.writeFileString`, `rename`, and `remove`, because v4 ships no atomic-write primitive.
- The package installer's `pnpmInstall` promise plumbing is replaced by `ChildProcess.make('pnpm', ['install'], { cwd })` driven through `ChildProcessSpawner`, keeping the single-method `PackageManager` service as the test seam.
- Test fakes stop implementing a bespoke shape: they provide `FileSystem.makeNoop({ … })`, so a test declares only the operations it exercises.

*Alternatives.* (a) Keep the thin shapes as a stable seam — rejected: 94 lines across 17 files exist to re-express services Effect already provides, and the wrapper's only unique behaviour is `writeFileAtomic`. (b) Keep `FileSystemFailure` and map `PlatformError` into it — rejected: it would be the same re-labelling this change removes elsewhere. (c) Migrate the launcher spawn and the synchronous boundary reads too — rejected as scope creep: the launcher deliberately hands `stdio` and signals to DSH, and the synchronous reads sit outside the effectful pipeline.

*Consequence.* File-operation failures read as platform errors rather than `cannot <op> <path>` lines, which is consistent with this change dropping the output contract. `SyncLocked`, `DshResolveFailure`, `PreflightFailure`, and `PackageInstallFailure` remain because they carry domain facts no platform error carries.

## Risks / Trade-offs

- **Schema rewrite changes the plan's decoded shape or hash** → Keep the existing hash test vectors and plan fixtures; run them before and after the schema rewrite; treat any hash change as a failure to investigate, not an expected diff.
- **`effect/cli` runner needs services the current bootstrap does not build** (`Stdio`, terminal, and v4's environment service) → Spike the runner in isolation first; the CLI's `main` already provides a Node platform layer, so the fix is layer wiring rather than architecture.
- **v4 `Schema` filter messages differ from v3** (`message`/`messageMissingKey`/`messageUnexpectedKey` annotations) → These become better or worse text, not different outcomes; assert on paths and pass/fail, not on wording.
- **Dropping dedupe/truncation makes pathological configs noisy** → Accepted; exit codes and the first line remain useful, and nothing machine-readable depended on the old shape.
- **Platform errors read differently and carry a different shape than `FileSystemFailure`** → Accepted as part of dropping the output contract; assert on failure presence and exit code, not on wording, and keep the domain errors that carry facts the platform error lacks.
- **Test fakes change shape** (`FileSystemShape` fakes become `FileSystem.makeNoop` providers) → Do this in the same group as the service deletion so the suite never straddles two injection styles.
- **Two Effect copies install because DSH needs 3.x** → The CLI must not import DSH's Effect-using packages or boot DSH in-process; the architecture test asserts the import boundary, and the spawn seam keeps the versions in separate processes.
- **`Context.Service` tags keyed by string keep working but lose the class-style ergonomics** → Chosen deliberately: one-for-one migration keeps layer wiring and tests readable, and converting to class-style services is a separate refactor with no v4 dependency.

## Migration Plan

1. Spike (throwaway, no committed code): confirm the `effect/cli` runner and its service requirements, the `decodeTo`/transformation replacement for `transformOrFail`, the filter message API, and `Context.Service` usage in a layer.
2. Dependencies and config: bump pins, drop the four packages, rewrite the schema and validation, migrate config imports to `Result`, and update config tests. The config package compiles and its tests pass against Effect 4 alone.
3. CLI core: `Context.Service`, `Result`, predicate replacements, and layer/error-type migrations across the internal modules; delete the `eedsh/FileSystem` seam in favour of core `FileSystem`, move the package installer onto `ChildProcess`, and switch the bootstrap to `NodeServices.layer`. No command-surface changes yet.
4. CLI surface: move command parsing to `effect/cli` and re-point the bootstrap; keep the `runCli` test seam.
5. Boundaries and docs: architecture test, README Effect-boundary and CLI-failure sections, JSDoc `@throws` updates.

Steps 2 and 4 touch disjoint files and can be verified independently. Rollback is a revert: every package is private and there is no persisted data or external contract to migrate back.

## Open Questions

- Whether the v4 runner requires a narrower layer set than the current bootstrap provides — resolved by the spike in step 1, without changing the specs or step order.
- Whether any `Schema.filter` site relied on v3's exact `FilterIssue` message construction — resolved during step 2 by the existing schema tests.
