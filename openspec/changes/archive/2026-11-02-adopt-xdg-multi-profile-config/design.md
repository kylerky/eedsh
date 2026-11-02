## Context

See `proposal.md` for motivation. The current shape is spread across a few boundaries:

- `packages/cli/src/config.ts` owns discovery through `findConfigPath(cwd)`, supports `.ts` and `.mts`, and returns one validated `ProfilePlan`. `loadConfig` registers tsx once without a tsconfig, so tsx resolves its tsconfig from `process.cwd()`.
- `packages/cli/src/cli.ts` funnels `sync`, `run`, `check`, and `doctor` through one `resolveConfigPath` that searches the working directory. Each command assumes one plan.
- `@eedsh/config` exposes `defineProfile(input)`, which immediately validates one plan and returns `Result<ProfilePlan, Schema.SchemaError>`. The plan carries its own `dsh` pin.
- `@eedsh/cli` already resolves its own pinned DSH installation; the materializer writes `engines.dsh` from that installation's version, not from `plan.dsh`. A per-profile DSH pin is therefore not effective today.
- `packages/cli/src/check.ts` already knows how to find a nearest `tsconfig.json` and resolve the project's TypeScript installation. That logic is reusable for config evaluation.
- There is no config-project setup command. The working project, its `@eedsh/config` dependency, its `effect` peer, and its tsconfig are all the user's responsibility.

The implementation stays inside the existing Effect boundaries: expected failures are Result or Effect failures, file access is the core `FileSystem` service, package installation stays behind the existing `PackageManager` service, and the architecture test continues to reject new `throw`/`try` sites outside its allowlist.

## Goals / Non-Goals

**Goals:**

- One resolved config path and one config project, with no dependence on the caller's working directory.
- One `config.ts` that declares several named profiles with one shared DSH pin and an optional default.
- Per-profile validation and publication isolation, with deterministic one-profile selection and all-profile sync.
- A single `eedsh init` command that produces a project that can evaluate, typecheck, and sync without manual dependency work.
- A loader that resolves against the config project's tsconfig, not the caller's.

**Non-Goals:**

- Git initialization, dotfiles management, or any version-control behavior in `init`.
- Migrating or reading `eedsh.config.ts`/`.mts`/`.js`, or supporting the old single-plan export.
- Multiple DSH versions in one config, or booting several profiles with one `run`.
- Deleting published profiles when a profile is removed from `config.ts`.
- A config editor, secret storage, or a multi-user/system-wide config directory.
- Changing profile locks, publication atomicity, or the generation-record format.

## Decisions

### 1. Resolve the config path in one CLI module

Add a small path module in `packages/cli/src` with `configHome(env)`, `defaultConfigPath(env)`, and a single `CONFIG_FILENAME = "config.ts"`.

- Use `path.isAbsolute` for `XDG_CONFIG_HOME`; unset, empty, or relative falls back to `join(home, ".config")`, where `home` comes from `HOME`/`USERPROFILE` and finally `os.homedir()`.
- The default is `<configHome>/eedsh/config.ts`. There is no `XDG_CONFIG_DIRS` lookup and no cwd walk.
- `--config` remains: resolve it against the CLI's working directory, accept only an extension of `.ts`, and run the same loader. The explicit path is the escape hatch for development, alternate files, and a user who wants to try the old `eedsh.config.ts` path by hand.
- Replace the discovery helpers with this resolution and an existence check. The missing-config diagnostic names the resolved path, `eedsh init`, and `--config <path>`.

Alternatives considered: keeping cwd as a fallback (rejected: the same command would silently use different configs); platform-native directories on macOS/Windows (rejected: the requested contract is XDG, and `~/.config` is a predictable cross-platform fallback); accepting `.mts` (rejected: the generated project is ESM and `config.ts` is the single contract).

### 2. Model a config as a keyed profile record with one shared pin

The public authoring API becomes:

```ts
export default defineConfig({
  dsh: '0.2.1-rc.2',
  defaultProfile: 'work',
  profiles: {
    work: defineProfile({
      bundles: [bundle('@deepseek-ai/dsh-base'), bundle('@deepseek-ai/dsh-web-app'), generated()],
      layers: [layer('overrides', [/* ... */])],
    }),
    home: defineProfile({
      bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
    }),
  },
})
```

- `DefineProfileInput` drops `name` and `dsh`; `defineProfile` becomes a synchronous typed descriptor that copies its arrays/records and does not validate or throw.
- `DefineConfigInput<P>` is generic over the profile record, so `defaultProfile?: keyof P & string` keeps a literal default checked by the editor. A dynamically built record widens to `string`; the runtime envelope check remains the gate.
- `defineConfig` validates the envelope (exact DSH pin, non-empty safe profile keys, default membership) and then builds and validates each profile plan with the existing `validatePlan`, injecting the key as `profile.name` and the shared pin as `dsh`. It returns `Result<EedshConfig, Schema.SchemaError>`; envelope defects fail the outer Result, while a bad profile is stored as that profile's failure.
- The loaded shape is:

```ts
interface EedshConfig {
  readonly dsh: string
  readonly defaultProfile?: string
  readonly profiles: Readonly<Record<string, Result.Result<ProfilePlan, Schema.SchemaError>>>
}
```

- A plain config export is normalized by the same envelope and per-profile validation. A Result export is unwrapped and revalidated; a profile Result is revalidated so a forged success cannot bypass `validatePlan`. A plain profile plan or profile Result is rejected as a config.
- Hoisting `dsh` is deliberate: the CLI boots its own pinned install and the materializer records that install's version. Repeating a pin per profile would suggest a behavior eedsh does not have. If per-profile runtime experimentation is needed later, a profile-level override can be added then.

Alternatives considered: an array of `defineProfile({ name, ... })` values (explicit names and order, but duplicate names, a runtime-only default, and no key/name linkage); keeping per-profile `dsh` (decorative today); one all-or-nothing schema for the whole config (simpler, but a broken sibling would block every profile).

### 3. Isolate profile validation from config validation

Config loading returns a config even when one or more profiles fail. Envelope failures are terminal; profile failures are data.

- `defineConfig` and the plain-config normalizer both produce `EedshConfig` with per-profile Results.
- `loadConfig` reports only config-level failures (bad envelope, import failure, missing default export, failed outer Result). It does not collapse profile failures into a config failure.
- Commands decide what to do with a profile Result:
  - explicit selection of an invalid profile reports its native schema failure and exits 1;
  - all-profile sync reports the invalid profile, continues with valid profiles, and exits 1;
  - `doctor` only needs the name, so an invalid plan does not block inspecting the published profile;
  - `run` fails if its selected profile is invalid.
- A profile failure that is not a `Schema.SchemaError` inside a forged Result is treated as a config-level invalid export; only native schema failures are per-profile data.

This preserves the single native error style while avoiding the "one typo blocks every environment" failure mode. The cost is a nested Result shape, which is contained in the config package and the CLI's selection helper.

### 4. Select profiles deterministically, and sync all by default

- `sync` without `--profile` selects every key in the config record.
- `sync --profile <name>` selects exactly that key; it never falls back to the default.
- `run` and `doctor` without `--profile` use `--profile`, then `defaultProfile`, then the sole profile.
- Unknown names and ambiguous one-profile selection are usage errors (exit 2) listing `Object.keys(config.profiles)`; they happen before publication, boot, or inspection.
- `check` does not accept `--profile`; unknown flags already produce the CLI's usage error.
- Selection is a CLI helper over the loaded config, not a config-package concern. It returns a small tagged error (`UnknownProfile`, `AmbiguousProfile`) that the command maps to a usage diagnostic.

For sync-all, `runSyncCommand` becomes a loop over selected profile entries:

- invalid profile: print `eedsh: profile "<name>":` and its native message; mark failure; continue;
- valid profile: call the existing one-plan materializer unchanged, with its own lock and publication transaction;
- materialization error: print a profile-labelled diagnostic; mark failure; continue;
- success/unchanged: print the existing result line (which already includes the profile name).

The loop exits 1 if any selected profile failed or was invalid; otherwise 0. `--strict`, `--explain`, and `--adopt-ownership` are passed through per profile, so a strict failure is isolated. `sync --profile` is the same loop with one entry. `run` keeps the one-profile path and only syncs the selected profile.

Diagnostics: when more than one profile is selected, print a per-profile header before warnings/results so raw DSH warnings stay raw and still have a profile context. Errors use the profile-labelled reporter. A single-profile run keeps today's output.

Alternatives considered: default-only sync with an `--all` flag (more ceremony for the common "apply my config" action); fail-fast on the first profile (leaves valid profiles unpublished); parallel profile syncs (unnecessary complexity and interleaved diagnostics).

### 5. Bind tsx to the config project's tsconfig

Extract the nearest-tsconfig lookup from `check.ts` into a shared module. `loadConfig` uses it to compute the tsconfig for the config path and registers tsx with `register({ tsconfig: tsconfigPath })` (ESM and CJS), or `tsconfig: false` when the config project has none.

- This removes the caller's cwd from resolution and makes the config's own `paths` usable. It also matches `check`, which already uses the config's tsconfig.
- The current loader is memoized once per process. The new registration is keyed by the tsconfig selection. The normal CLI process loads one config path, so one registration is the common case. Tests and embedders that load different config projects in one process need a re-register path; tsx's `register` returns an unregister function, so the loader helper unregisters the previous selection before switching. If that proves unreliable on a Node line, the fallback is one registration per process with the first config's tsconfig, and the tests that need another project run in a separate process.
- Do not set `TSX_TSCONFIG_PATH`: it is process-global and would leak into the DSH child process spawned by `run`.

Alternatives considered: keep cwd resolution (rejected: a global config would inherit an unrelated project's mappings); disable tsconfig resolution entirely (loses documented `paths` support); use an environment variable (global side effects).

### 6. Implement `init` as a standalone Effect program

Add `packages/cli/src/init.ts` with pure template builders and a `runInit` program; add a small `init` command in `cli.ts`.

- `init` uses the resolved `defaultConfigPath(env)`; it has no target flag, no config load, and no DSH requirement.
- It uses the core `FileSystem` service and the existing `PackageManager` service (pnpm install in a directory), but not `defaultServices()`: that layer constructs DSH resolution and preflight, which init does not need. Add a narrow `initServices` seam to `CliRunOptions` for tests, defaulting to `NodeServices.layer` plus `pnpmPackageManagerLayer`.
- File writes go through `writeFileAtomic` for each new file. The directory is created with `recursive: true` and mode `0o700` when it does not exist; an existing directory is left as-is.
- Existing files are never overwritten. `config.ts` is checked first; if present, it is reported as kept. Missing `package.json`/`tsconfig.json` are written. This makes a failed install repairable by re-running.
- No `.gitignore`, no git command, no legacy-file handling.
- `--no-install` skips the `PackageManager` call and prints `cd <dir> && pnpm install`.

Templates:

- `package.json`: `{ name: "eedsh-config", private: true, type: "module", devDependencies }`.
- `config.ts`: imports `bundle`, `defineConfig`, `defineProfile`, and `generated`; one profile key `default` with `dsh-base`, `dsh-web-app`, and `generated()`; no `defaultProfile` for a single profile. The DSH pin comes from the CLI's resolved `@deepseek-ai/dsh` package.
- `tsconfig.json`: `target: "es2024"`, `module: "preserve"`, `moduleResolution: "bundler"`, `strict: true`, `noEmit: true`, `skipLibCheck: true`, `verbatimModuleSyntax: true`, `include: ["**/*.ts"]`. This matches the repository's bundler-style resolution, lets tsx and `tsc -p` agree, and needs no `@types/node` for the scaffold.

Dependency specs:

- Resolve `@eedsh/config` and `effect` package manifests from the CLI's own installation with `createRequire(import.meta.url)`. Use exact versions in a published CLI.
- In an unpublished workspace (config package version `0.0.0`), write `link:<resolved package dir>` for `@eedsh/config` and `effect` so local development and tests do not depend on a registry release. A published CLI always writes versions.
- `typescript` uses one `TYPESCRIPT_SPEC` constant. Keep it aligned with the compiler the check integration test exercises; changing it is a one-line change plus a check run.
- Concrete spec resolution is injected into `runInit` so tests can assert the emitted manifest without depending on the checkout's current versions.

Output: `eedsh: initialized <configDir>`, the profile key(s), and next commands `eedsh check`, `eedsh sync`, `eedsh run`. Install failure reports the config directory and leaves the files.

Alternatives considered: shelling out to a scaffold script (new dependency and platform surface); writing files without an Effect service (breaks the package's boundary and test seams); making init install with npm/yarn (eedsh already requires pnpm for sync); auto-initializing git (out of scope and potentially destructive inside a dotfiles tree).

### 7. Keep the existing materializer, doctor, and check contracts

- `materialize` still receives one `ProfilePlan` and one profile directory. No change to plan hashing, generation records, locking, or ownership.
- `doctor` keeps `--profile` as the no-config inspection path. Without it, it evaluates the config only to choose a name; it does not require the plan to be valid.
- `check` keeps its own compiler/project checks. It now resolves `config.ts` from XDG by default; its missing-config message points to `eedsh init`.
- Config removal does not trigger cleanup: published profiles are ordinary DSH state, and deleting them would exceed the command's contract.

### 8. Update the tests around the new seams

- Config-package tests cover envelope errors, keyed plans, dynamic records, default membership, per-profile Results, plain config/Result exports, and rejection of a lone plan.
- CLI tests replace cwd fixtures with `XDG_CONFIG_HOME` temp directories and explicit `--config` fixtures. New command-surface tests cover `init`, `--profile` on sync/run/doctor, all-profile sync, ambiguity/unknown usage errors, and `check` rejecting `--profile`.
- Init tests use the in-memory `FileSystem` and fake `PackageManager` where possible, plus a temp-directory command test for modes and `--no-install`. Template output is evaluated as a module (the existing README helper approach) and typechecked in the built-CLI integration test.
- The README test helper returns a config plus a selected plan instead of one plan. Hash parity selects the README example profile explicitly.
- The built-CLI integration test uses a temp XDG directory and a temp `config.ts` with `--config` for publication; init integration uses `--no-install` to stay network-independent, and a local-workspace install test can link the packages when pnpm is available.

## Risks / Trade-offs

- **Breaking change with no migration tooling** → Publish this as a breaking release, document the one-time move to `defineConfig`, and keep `--config` as the manual escape hatch. Do not add implicit fallback.
- **Existing `eedsh.config.ts` is silently ignored** → The missing-config diagnostic names `eedsh init`; docs state the old names are not read. `eedsh init` explicitly does not touch the legacy file.
- **XDG semantics on Windows/macOS** → Use `XDG_CONFIG_HOME` when absolute and `~/.config` otherwise on every platform; test path construction with Windows-style absolute paths, and keep the missing-config diagnostic path-explicit.
- **A global config inherits an unrelated project's tsconfig** → Bind tsx to the config project's nearest tsconfig and add a test where the caller cwd has conflicting `paths`.
- **tsx loader state across multiple configs in one process** → Cache by tsconfig selection and unregister before switching; if the loader cannot switch reliably, isolate multi-project tests in separate processes. Never use the process-global `TSX_TSCONFIG_PATH`.
- **Local-link manifests are machine-specific** → Only emit `link:` specs for an unpublished `0.0.0` workspace; published CLIs write versions. Re-running init after moving a checkout does not rewrite an existing manifest, so document that local development can reinstall with `pnpm install`.
- **Existing `package.json`/`tsconfig.json` is preserved even if incomplete** → Init reports kept files, and `eedsh check`/evaluation fail with actionable errors. This is safer than merging or rewriting a user's project file.
- **Installation requires network and pnpm** → `--no-install` writes a complete project and prints the command; install failure leaves a repairable project.
- **Multi-profile sync can partially succeed** → Exit 1 if any selected profile failed, and label every profile diagnostic. Scripts must check the exit code. No cross-profile rollback is attempted.
- **Profile removal leaves published state behind** → Document that removal is not deletion; `doctor --profile` can inspect the orphan and the user can remove it manually. Automatic deletion would be a separate, destructive feature.
- **Per-profile Results are a nested shape** → Keep the nesting behind `EedshConfig` and selection helpers; revalidate plain and forged exports so the public contract remains data-first.
- **A dynamically built profile record loses the literal `keyof` check** → Runtime envelope validation remains authoritative; add a test for an unknown `defaultProfile` built through `Object.fromEntries`.
- **Profile iteration order is object-key order** → Normal string keys preserve authored order; integer-like keys sort. Profiles are independent, so only reporting order is affected. Sort explicitly if stable ordering becomes a requirement.
- **A config with a bad profile blocks nothing, but a bad envelope blocks everything** → Intended boundary: shared `dsh`/default/keys are prerequisites; composition errors are local.
- **Init's TypeScript range can drift from the tested toolchain** → One constant, covered by the check integration test. Update the constant and the test together.
- **Removing cwd discovery changes scripts that relied on it** → Breaking release notes; `--config` supports explicit paths; no hidden fallback.

## Migration Plan

1. Land the config-package API and schema first, with unit tests, then the CLI path/loader/selection/sync changes, then `init`, then docs and integration tests. Each step is independently testable; the workspace gate (`pnpm verify`) stays green.
2. Release as a breaking version. Release notes: “Create `$XDG_CONFIG_HOME/eedsh/config.ts` with `eedsh init`, move profile definitions into `defineConfig({ ... })`, and remove the old config file. `eedsh.config.ts`, `.mts`, and single-plan exports are no longer read.”
3. Rollback: reinstall the previous CLI and restore the old config file. Published profiles, locks, and generation records are unchanged by this change; no profile data migration is required.
4. Cleanup after a user removes a profile is manual. `eedsh` does not delete published profiles, so rollback remains safe.

## Open Questions

None that change the specs or the approach. The exact TypeScript range in the scaffold and the final wording of the init next-step output can be settled during implementation and covered by the integration test.
