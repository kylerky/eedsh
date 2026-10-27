## Context

See `proposal.md` — Why. The constraints that shape the approach:

- Effect is pinned at `4.0.6`. `@eedsh/config` may import only `effect/Schema` and `effect/Result`; `@eedsh/cli` may use the full Effect runtime; `@eedsh/runtime` must remain Effect-free.
- `defineProfile` and `validatePlan` must stay synchronous: a config module is evaluated by importing it, so authoring cannot return an Effect.
- The CLI already parses its command surface with `effect/cli`, provides `NodeServices.layer`, and runs materialization as an Effect. The current shell is async/await around several Effect islands, and it catches around `Effect.runPromise` to keep defects from rejecting the process.
- The production source has 15 explicit `throw`s (all in the CLI), 20 JavaScript catch sites in CLI source (16 `try` blocks and 4 `.catch`), and 3 catches in the Effect-free runtime. Two of the CLI catches are the actual run boundaries; the rest are external adapters, memoization, or cleanup.
- `effect/cli` handlers return `Effect.Effect<void, E, R>`; the command functions currently return exit codes through a mutable local. The `runEedsh(argv, options): Promise<number>` seam is used by `bin.ts` and by the CLI tests, so its signature should survive.
- The DSH launcher spawn deliberately hands stdio and signals to DSH. The `SpawnLike` seam is not replaced by `ChildProcessSpawner`; `check`'s spawn seam is in the same position.
- `@eedsh/runtime` loads inside DSH's process, where DSH's own Effect 3 runtime is live. It has no Effect dependency and must not gain one.
- `defineProfile` currently returns a plan and `assertPlan` throws `Schema.SchemaError`. Configs use `export default defineProfile(...)`; the invalid-plan fixture exports a plain object. The loader already calls `validatePlan`.
- `typed-profile-layering` still contains an `Either`/throwing requirement, and `atomic-file-replacement` still names the removed `FileSystemFailure`; both conflict with the current code and with this change.

## Goals / Non-Goals

**Goals:**

- One failure model: expected failures are `Result` values or Effect failures; exceptions are adapted once at their source; defects are reported at the process edge.
- One process outcome: each CLI invocation builds one Effect program and observes it with one `Effect.runPromiseExit`.
- A `Result`-returning authoring API with no throwing authoring helper.
- Preserve externally observable CLI behavior: flags, profile layout, generation format, exit codes, and diagnostics, except the intended authoring export contract and the native reporting of authoring failures.
- Make the model enforceable so later changes cannot reintroduce expected-failure throws.

**Non-Goals:**

- Changing `@eedsh/runtime`; it stays plain Cordis and keeps its own catches.
- Removing the final rejection safety net in `bin.ts`, or test throws used as assertions.
- Replacing `SpawnLike` with `ChildProcessSpawner`, or changing DSH's stdio and signal ownership.
- Replacing chokidar, the Node file-system services, or the tsx loader with new libraries.
- Changing the atomic-write retry policy, profile locking semantics, preflight warning attribution, or the plan/generation formats.
- Fixing unrelated stale specifications beyond the two identified error contracts.

## Decisions

### D1. `defineProfile` returns a `Result`; `assertPlan` is removed

`defineProfile(input)` builds the candidate and returns `validatePlan(candidate)`, typed `Result<ProfilePlan, Schema.SchemaError>`. It stays synchronous. `assertPlan` is deleted because its only purpose was to turn the Result into a throw; a caller that genuinely wants an exception can write `Result.getOrThrow(validatePlan(value))` explicitly. `validatePlan` is unchanged.

*Alternatives.* (a) Keep `defineProfile` throwing and add `defineProfileResult` — rejected: the change is explicitly the Result-returning authoring API, and two entry points would keep the throw as the documented path. (b) Make `defineProfile` return an Effect — rejected: a config module must default-export data, and authoring UI and type inference should stay synchronous. (c) Keep `assertPlan` as an escape hatch — rejected: it would remain the sanctioned expected-failure throw and require an allowlist exception for a public API.

*Consequences.* Every fixture, test, and README example that consumes the returned plan must unwrap the Result. Configs do not need to unwrap: the loader handles the Result export (D2). `DefineProfileInput` is unchanged.

### D2. A config module may export a plan or a Result; the loader validates both

`loadConfig` becomes `Effect<ProfilePlan, ConfigError | Schema.SchemaError>`:

- If the default export is a `Result`, a failure is surfaced as its native schema failure when it satisfies `Schema.isSchemaError`; otherwise it becomes a config failure. A success value is validated with the strict plan options before use, so a forged success cannot bypass the contract.
- If the default export is a plain value, it is validated with the strict options, as today.
- A missing default export remains `config.missing_default_export`.
- If the dynamic import rejects with a `SchemaError`, that schema failure is surfaced rather than wrapped as `config.import_failed`; other import rejections become `config.import_failed`.

*Alternatives.* (a) Require every config to export a Result — rejected: plain plan exports are useful, the invalid-plan fixture uses one, and validation has to run anyway. (b) Accept a Result without revalidating its success value — rejected: it trusts a runtime object that TypeScript cannot guarantee, and the loader is the plan contract's boundary. (c) Unwrap with a throwing helper inside the config — rejected: it reintroduces the authoring throw.

*Consequences.* `export default defineProfile(...)` keeps working; only the exported type changes. Authoring failures are reported with the native schema message instead of the current `config.import_failed` prefix. The extra validation of a success Result is one decode per load and is negligible.

### D3. One Effect program per CLI invocation and one `Exit`

`runEedsh` keeps its `Promise<number>` signature, but it builds the command program lazily with `Effect.suspend` and runs it once with `Effect.runPromiseExit`. The `Exit` is mapped once:

- success → the command's exit code;
- `CliError` → usage diagnostic and `EXIT_USAGE`;
- typed failure → one diagnostic and `EXIT_FAILURE`;
- defect → one diagnostic and `EXIT_FAILURE`;
- interrupts that are not an internal watch stop → failure, not a silent success.

Command functions (`runSyncCommand`, `runRunCommand`, `runCheckCommand`, and the one-shot sync) return Effects instead of Promises. `effect/cli` handlers still return `Effect<void>`; they yield the command Effect and store a successful command's exit code in the local `exitCode`, as today. `Effect.promise` wrappers around the command functions disappear.

*Alternatives.* (a) Keep the async shell and call `runPromiseExit` at each Effect entry — rejected: it leaves several mini-boundaries and duplicate report/print logic, which is the structure that produced the current throw/catch mix. (b) Make `runEedsh` return an Effect and move the run to `bin.ts` — rejected for now: it pushes the process boundary into the shebang entry point and makes the test seam less direct; the Promise signature is already the external seam. (c) Use `Effect.result` plus `runPromise` — rejected: defects still reject and need a JavaScript catch.

*Consequences.* The report/print path becomes one formatter. The watch loop still reports recoverable rerun failures and continues; those are `Effect.catch` handles inside the watch program, not process failures, so they are not reported twice.

### D4. The error taxonomy is tagged domain errors plus `PlatformError`

- `ConfigError` becomes `Data.TaggedError('ConfigError')<{ code: string; message: string }>`.
- New `CheckFailure` (code + message) for `check.*` and `config.not_found` infrastructure failures, and `SpawnFailure` (cause) for the launcher.
- Existing `PackageInstallFailure`, `PreflightFailure`, `SyncLocked`, and `DshResolveFailure` stay tagged.
- File-system failures remain `PlatformError.PlatformError`; no project-defined file-system error is introduced.
- `describeError`/`report` select diagnostics by `_tag`, `Schema.isSchemaError`, and the platform error shape, not by `instanceof` or message text.

*Alternatives.* (a) Keep `ConfigError` as a class and use `instanceof` — rejected: it is the only remaining class-shaped failure, does not compose with `catchTag`, and makes reporting inconsistent. (b) Collapse every failure into one `CliFailure` code type — rejected: it would erase the facts each tagged error carries (lock path, warning list, bundle name). (c) Wrap `PlatformError` in a project type — rejected: it re-labels a native error and was explicitly removed in the Effect 4 migration.

### D5. Sync leaves return `Result`; async leaves use the Effect error channel

| Leaf | New shape |
|---|---|
| config path validation | `Result<void, ConfigError>` (replaces `assertSupportedConfigPath` throwing) |
| generated layer parsing | `Result<PreflightLayer[], PreflightFailure>`; `yaml.load` adapted with `Result.try` |
| DSH installation and bundle resolution | `Result<..., DshResolveFailure>`; lifted with `Effect.fromResult` |
| config loading | `Effect` carrying `ConfigError` or `Schema.SchemaError` |
| check helpers | `Result.try` for require/read/realpath; `runCheck` is `Effect<number, CheckFailure>` |
| profile JSON reading | `Effect.try` (still mapped to `PlatformError`) |
| safe error stringification and version read | `Result.try` with an explicit fallback |
| lock cleanup and native calls | `Effect.tryPromise`/`Effect.try` + `Effect.ignore`; keep one adapter per native API |
| watcher closure | `Effect.tryPromise` with the existing warning path |

The malformed-expression check in `materialize/yaml.ts` stays a defect: validation makes it unreachable, and turning it into a `Result` would force `buildGeneratedBundle` and every caller to carry a failure that cannot happen. It is allowlisted in the architecture check.

*Alternatives.* (a) Convert every helper to `Effect` — rejected: a `Result` keeps synchronous leaves testable without a runtime. (b) Convert `buildGeneratedBundle` to `Result` for the impossible state — rejected as type noise. (c) Keep the `assertSupportedConfigPath` throw and catch it — rejected: path validation is an expected failure and has two call sites.

### D6. `loadConfig` is an Effect; tsx registration is a memoized attempt

`loadConfig` uses `Effect.gen` with `Effect.try` for the modification-time stat, `Effect.tryPromise` for the dynamic import, and `Effect.fromResult` for plan validation. The tsx loader registration remains a module-level memo because it must run once per process and a failed registration must be retryable in watch mode. The memo stores a `Promise<Result<void, unknown>>` (fulfilled and rejected mapped with `then`), clears itself on failure, and is lifted with `Effect.promise`; this removes the JavaScript catch without inventing a service or a runtime-owned cache.

*Alternatives.* (a) `Effect.cached` — rejected: the cached Effect must be created and retained inside a runtime or service to be process-global, which adds a layer for no behavioral gain. (b) Register the loader in the service layer — rejected: it would make `--help`/lazy loading depend on a layer, and the current lazy registration is deliberate. (c) Keep the `.catch` memo — rejected: it is a small catch, but the goal is to eliminate the pattern and the Result memo is simpler.

### D7. `check` returns compiler codes as successes and infrastructure problems as failures

`runCheck` becomes `Effect<number, CheckFailure>`. Missing tsconfig, missing TypeScript, a config outside the project's file set, and a spawn failure fail with a `check.*` code. A compiler nonzero exit code, including a failed file listing, is a successful command outcome and is returned unchanged; `check` must forward tsc's code. `capture` and `runInherited` keep their Promise/event shape but are adapted with `Effect.tryPromise`; the child `error` event becomes a `CheckFailure` instead of a rejected Promise that escapes to the runner.

*Alternatives.* (a) Keep `runCheck` async and only use `Result` internally — rejected: the command would still need a Promise rejection boundary in the one-runner design, and `capture` currently rejects. (b) Treat every nonzero compiler exit as a failure — rejected: it would change the documented exit-code forwarding. (c) Move check onto `ChildProcessSpawner` — rejected: `check` injects a spawn seam and the change is about errors, not process services.

### D8. Seam policy: convert our own async APIs, adapt external ones once

`CliRunOptions.loadConfig` becomes `(path) => Effect<ProfilePlan, ConfigError | Schema.SchemaError>`. The watcher factory, `SpawnLike`, and the service-layer factory keep their current shapes: they wrap external libraries or the DSH launcher, and each is adapted once with `Effect.tryPromise`/`Effect.try`. The service-layer factory is called inside the Effect so a throw becomes a defect captured by `Exit`.

*Alternatives.* (a) Convert every seam to Effect — rejected: the watcher and spawn seams exist to model third-party callback APIs, and converting them would churn tests without improving the failure model. (b) Keep `loadConfig` a Promise seam and adapt it — rejected: config loading is our own API and is central to the authoring-failure behavior.

### D9. Preserve reporting details through the single renderer

The runner records the active command's reporting context (notably `--explain` for `sync`) when it dispatches the command and passes it to the formatter, so the preflight hint and warning attribution stay identical. `reportSyncError` becomes a pure formatter; there is exactly one stderr write per failure. Watch rerun failures remain recoverable and are reported by the watch program's `Effect.catch`.

### D10. Enforce the model with an architecture check

Extend `test/architecture.test.ts` with a source scan of `packages/config/src` and `packages/cli/src` for JavaScript `throw`, `try`, and `.catch(` call sites. The allowlist records `materialize/yaml.ts` (impossible state) and any remaining native adapter that cannot be expressed through `Effect.try`. `packages/runtime/src` is exempt. The check message names the file and construct.

*Alternatives.* (a) Rely on review — rejected: the change's acceptance criterion is the absence of the pattern. (b) Add a lint plugin — rejected: the repository already has a source-scanning architecture test and does not need a new toolchain dependency.

### D11. Reconcile the stale specifications in this change

Remove the `Either`/throwing requirement from `typed-profile-layering` as superseded by `profile-plan-validation`, and change `atomic-file-replacement`'s failure requirement from the deleted `FileSystemFailure` to `PlatformError`. Leaving either in place would make the archive contradict the code this change produces.

*Alternatives.* (a) Separate documentation change — rejected: the contradictions are directly about the failure contract this change is rewriting.

## Risks / Trade-offs

- **`defineProfile`'s return type ripples through every test and fixture** → Do the config package and its tests first, add a local unwrap helper in test code, and let the loader accept both exports so runtime configs need no edits.
- **Authoring failures now print differently** → This is intended: a `SchemaError` from config evaluation is surfaced natively instead of as `config.import_failed`. Add an integration test that asserts the exact native message and the absence of the prefix.
- **One runner can double-report or lose the preflight hint** → Make the formatter pure and test exactly one stderr occurrence for typed failures, defects, and watch reruns; test `--explain` attribution separately.
- **A defect thrown during program construction escapes before `runPromiseExit`** → Build the program inside `Effect.suspend` and keep the existing "service layer unavailable" test as a defect-capture test.
- **`effect/cli` handlers must return `Effect<void>`, which complicates returning check/run exit codes** → Keep the local `exitCode` as today, and add tests for `check` exit 2 and `run` exit 7 after the refactor.
- **A Promise memoizer or native adapter remains a catch** → Keep those adapters minimal and allowlisted, and document why they are boundaries rather than expected-failure control flow.
- **`check` conflates compiler failure with infrastructure failure** → Explicitly model only infrastructure failures as `CheckFailure`; keep compiler/list exit codes as successful outcomes and test both.
- **The DSH launcher's stdio and signal behavior changes** → Keep `SpawnLike` and the existing event handling; do not move the launcher to `ChildProcessSpawner` in this change.
- **The Effect-free runtime gains a dependency through the new convention** → Keep the runtime out of the architecture scan and apply the new model only to config and CLI; its catches remain.
- **Spec archive drops detail from MODIFIED requirements** → Use REMOVED+ADDED for the authoring requirement and keep the existing scenario name in the modified reporting requirement; run `openspec validate --strict` before finishing.

## Migration Plan

1. Config package: change `defineProfile` to return `Result`, remove `assertPlan`, update config tests and fixtures, and add loader support for plain and Result exports. Verify with config tests and the CLI invalid-plan test.
2. Error taxonomy and sync leaves: add `CheckFailure`/`SpawnFailure`, convert `ConfigError` to tagged, convert config-path/preflight/DSH/check helpers to `Result`, and update their tests.
3. One CLI runner: convert command functions, config loading, check, run boot, and watch to Effects; remove the run-boundary catches; add exact diagnostic/exit-code tests.
4. Lock and utility cleanup: replace remaining JS catches with `Effect.tryPromise`/`Effect.ignore` or keep them as allowlisted adapters; verify lock and atomic-write tests.
5. Enforcement and docs: extend `test/architecture.test.ts`, update README/JSDoc, and run `openspec validate --strict`.

Rollback is a revert: every package is private, there is no persisted data format change, and the profile layout and generation format are untouched.

## Open Questions

None.
