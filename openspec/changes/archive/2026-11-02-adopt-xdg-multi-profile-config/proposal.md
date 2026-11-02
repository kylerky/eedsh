## Why

eedsh currently discovers `eedsh.config.ts` from the current working directory. Every command therefore depends on where it is run, and the global CLI still expects a per-project install of `@eedsh/config` and `typescript`. Pointing eedsh at `$XDG_CONFIG_HOME/eedsh` today produces a bare config file that cannot resolve its own imports; the directory is not a working TypeScript project. At the same time, one config file can describe only one profile, so switching between a web profile and a minimal profile means editing or replacing the file.

This change makes the config a single XDG-based project, lets one `config.ts` define several named profiles, and adds an `eedsh init` command that creates the project and its dependencies in one step.

## What Changes

- **BREAKING** Read the config only from `$XDG_CONFIG_HOME/eedsh/config.ts`, falling back to `~/.config/eedsh/config.ts` when `XDG_CONFIG_HOME` is unset or not absolute. Remove working-directory discovery, `eedsh.config.ts`, `eedsh.config.mts`, and JavaScript config discovery. Keep `--config <path>` as an explicit `.ts` override for development and alternate files.
- Add `eedsh init`: create the config directory and a working TypeScript project (`config.ts`, `package.json`, `tsconfig.json`), install `@eedsh/config`, the matching `effect` version, and `typescript` with pnpm, and print the next commands. It never overwrites an existing `config.ts`, is safe to re-run for a partially created project, performs no git initialization, and supports `--no-install`.
- **BREAKING** Replace the single-plan default export with a config-level authoring API: `defineConfig({ dsh, defaultProfile?, profiles })`, where `profiles` is a keyed record of `defineProfile(...)` descriptors. Profile keys are the profile names; the shared `dsh` pin is injected into every per-profile plan. `defineProfile` becomes a synchronous typed descriptor instead of a validating plan builder.
- Validate each profile plan independently. A config-level defect (invalid `dsh`, unknown `defaultProfile`, empty or unsafe profile set) fails the whole config; an invalid profile in one key does not prevent other profiles from being selected, published, or run.
- Add profile selection: `--profile <name>` on `sync`, `run`, and `doctor`; the selected profile is `--profile`, then `defaultProfile`, then the sole profile. Multiple profiles without a default make commands that need one fail as a usage error listing the available names. `check` takes no profile.
- **BREAKING** Change bare `eedsh sync` to publish every profile in the config, sequentially, each under its own profile lock. `--profile` narrows the run to one profile. Unchanged profiles remain no-ops; a failure for one profile does not stop the others; the command exits 1 if any profile failed or was invalid. `sync --watch` re-evaluates the same selection on each change. Removing a profile from the config does not delete its published DSH profile.
- Evaluate config imports against the config project's own tsconfig rather than the caller's working directory, so a global config cannot inherit path mappings from an unrelated project.
- Update the CLI help, README, package READMEs, fixtures, integration tests, and the plan/authoring tests for the new layout.

## Capabilities

### New Capabilities

- `config-project`: The XDG config location, `eedsh init` scaffolding and dependency installation, the working-project contract, and the actionable failure when no config project exists.
- `multi-profile-config`: The keyed multi-profile authoring contract, config-level versus per-profile validation, profile selection rules, all-profile sync behavior, and per-profile failure isolation in sync and watch.

### Modified Capabilities

- `typescript-toolchain`: Config discovery moves from the working directory to the XDG `config.ts` path, only `.ts` is accepted, and loader resolution is bound to the config project's tsconfig rather than the caller's.
- `typed-profile-layering`: The authoring surface now produces a multi-profile config with one shared DSH pin, and each named profile still produces a versioned plan.
- `profile-plan-validation`: `defineConfig` and the descriptor form of `defineProfile` replace the single-plan authoring contract; config exports and per-profile native failure reporting change.
- `profile-doctor`: Doctor selects a profile from the multi-profile config, applies the default-or-sole rule, and reports an actionable usage error when the choice is ambiguous.
- `watch-mode-lifecycle`: Watch mode applies the same all-or-one profile selection on every rerun and isolates profile failures without stopping the session.

## Impact

- **`@eedsh/config`**: new `defineConfig`, config envelope types, keyed profile descriptors, shared `dsh` injection, per-profile validation results, and updated exports/tests. The per-profile `ProfilePlan` schema and hashing stay intact.
- **`@eedsh/cli`**: XDG config-path resolution, `--config` validation, config loading, profile selection, multi-profile sync/watch/run/doctor orchestration, new `init` command, help text, and diagnostics. Init reuses the existing pnpm/child-process and file-system services; no new runtime dependency is required.
- **Profile state**: existing published profiles are untouched; a profile removed from `config.ts` remains on disk until the user removes it. Each profile keeps its own lock, generation, and publication transaction.
- **Tests and fixtures**: config discovery and command-surface tests, new multi-profile and init tests, README-derived tests, and built-CLI integration tests move to the XDG project model.
- **Documentation**: root README, `packages/config/README.md`, and `packages/cli/README.md` describe the XDG location, `eedsh init`, multi-profile selection, and the breaking config shape.
- **Compatibility**: this is a breaking change with no migration tooling. Existing config files and single-profile default exports are not read.
