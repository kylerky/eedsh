## Why

Effect 4 gives the workspace `Result`, but expected failures still cross the codebase as thrown exceptions: config loading, generated-layer parsing, DSH resolution, and the synchronous authoring API throw, while the CLI shell catches around several Effect runs. Every throw has to be re-caught by each caller, diagnostics are produced in several places, and a defect that escapes one run can reject a promise instead of reaching the typed error channel. The authoring API is the last place where a normal invalid plan is an exception rather than a value.

This is the right moment to finish the transition: the packages are private, the Effect 4 migration is complete, and a single failure model keeps later features from reintroducing the pattern.

## What Changes

- **BREAKING** `@eedsh/config`: `defineProfile` returns `Result<ProfilePlan, Schema.SchemaError>` instead of returning a plan and throwing. `assertPlan` is removed; `validatePlan` remains the Result entry point. Authoring stays synchronous.
- **BREAKING** Config modules may default-export either a plan or a validation `Result`. The CLI validates a plain export and unwraps a `Result`; a `Result` failure is reported with Effect's native schema message instead of being wrapped as an import failure.
- The CLI runs each invocation as one Effect program and observes it with a single `Effect.runPromiseExit`; `Exit` is rendered once into diagnostics and an exit code. No JavaScript `try/catch` remains around an Effect run.
- Expected synchronous failures return `Result`; async and IO failures use the Effect error channel with tagged errors. `Result.try`, `Effect.try`, and `Effect.tryPromise` appear only at external API boundaries (dynamic import, Node file system and resolution, YAML parsing, native lock bindings, watcher startup, child processes).
- Convert config loading, preflight layer parsing, DSH installation and bundle resolution, the `check` command, lock acquisition and cleanup, and the profile reader to the new model. Defects stay defects and are reported at the process boundary, not remapped into domain failures.
- Change the injected config-loading seam to an Effect, update the CLI tests and fixtures, and add an architecture test that rejects expected-failure `throw`/`try` statements outside an explicit allowlist.
- Reconcile stale error requirements in the existing specs: `typed-profile-layering` still describes `Either` and a throwing authoring boundary, and `atomic-file-replacement` still names the removed `FileSystemFailure`.
- Keep `@eedsh/runtime` Effect-free; its exception handling is unchanged and out of scope.

## Capabilities

### New Capabilities

- `error-handling`: one failure model for eedsh: expected failures are values, external exceptions are adapted at their boundary, the CLI turns one `Exit` into diagnostics and an exit code, and defects are reported rather than recovered.

### Modified Capabilities

- `profile-plan-validation`: the authoring entry point returns a `Result` instead of throwing, `assertPlan` is removed, config modules may export a plan or a `Result`, and validation failures are reported natively for both forms.
- `typed-profile-layering`: the stale validation requirement that names `Either` and a throwing authoring boundary is removed as superseded by `profile-plan-validation`.
- `atomic-file-replacement`: replacement failures are the platform's file-system error, not the removed `FileSystemFailure`.

## Impact

- **Code:** `packages/config/src/api.ts`, `packages/config/src/plan/validate.ts`, `packages/cli/src/config.ts`, `check.ts`, `dsh.ts`, `cli.ts`, `preflight.ts`, `internal/effect/errors.ts`, `internal/lock-posix.ts`, `internal/lock-win32.ts`, `internal/atomic-write.ts`, `materialize/program.ts`, `materialize/publish.ts`, `materialize/yaml.ts`, and every test and fixture that calls `defineProfile`.
- **APIs:** `defineProfile` changes return type and `assertPlan` is removed; `CliRunOptions.loadConfig` becomes an Effect-returning seam. CLI flags, profile layout, generation format, and exit-code meanings are unchanged.
- **Dependencies:** none added or removed.
- **Docs:** README authoring, Effect-boundary, and failure sections; JSDoc `@throws` annotations; architecture test allowlist.
- **Behavior:** configs written with `export default defineProfile(...)` continue to work because the loader unwraps the `Result`. Invalid plans still print Effect's native schema message and exit 1.
