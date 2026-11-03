# @eedsh/cli

The `eedsh` command. It creates the XDG config project, evaluates `config.ts`
with `tsx`, selects one or every named profile, preflights each composition through
DSH's own patch algorithm, publishes normal DSH profiles atomically, and can boot
the discovered launcher.

The package is bin-only: `lib/bin.js` (the `eedsh` binary) is the only build output,
and there is no library export. For installation, Quick start, and config authoring,
see the [root README](../README.md).

Effect is the default here: tagged failures, `Context.Tag` services for file access,
package installation, DSH resolution, preflight, and sync locking, plus one scoped
service layer per watch session. `effect/cli` parses the command surface; its generated
help and usage errors are rendered through an injected Console with ANSI escapes stripped, and the
CLI binds only the narrow Node file-system, path, and terminal layers. Node `fs` and
`spawn` live only in the live service layer. `@eedsh/plan` owns the plan schema and
validation, `@eedsh/config` composes it for synchronous authoring, while
`@eedsh/runtime` stays a plain Cordis plugin; `defineConfig().build()` remains
synchronous at the config boundary and returns the native validation Result.

## Commands

```sh
eedsh init   [--no-install] [--dsh <path>]
eedsh sync   [--profile <name>] [--config <path>] [--dsh <path>] [--strict] [--watch] [--explain] [--adopt-ownership] [--rebuild] [--no-build]
eedsh doctor [--profile <name> | --config <path>] [--dsh <path>] [--strict]
eedsh check  [--config <path>] [-- <tsc args>]
eedsh run    [--profile <name>] [--config <path>] [--dsh <path>] [--no-sync] [-- <dsh args>]
eedsh repl   [--profile <name>] [--config <path>] [--dsh <path>] [--sync] [--eval <expression>]
eedsh --help | --version
```

- `init` creates `$XDG_CONFIG_HOME/eedsh` (`~/.config/eedsh` when unset or not
  absolute) with `config.ts`, `package.json`, and `tsconfig.json`. It links the
  CLI's own `@eedsh/config` and `effect` in an unpublished workspace, declares the
  single `TYPESCRIPT_SPEC` TypeScript version, never overwrites an existing file,
  and creates no repository. It installs with pnpm unless `--no-install` is given.
  `--dsh <path>` validates an explicit installation and records the machine-local
  anchor; without it, init reports an existing anchor, queries no package manager,
  and still succeeds when neither DSH nor an anchor exists.
- `sync`, `run`, and `repl` must discover one `@deepseek-ai/dsh` installation
  before evaluating a config: `--dsh <path>`, then `EEDSH_DSH_ANCHOR`, then a
  `dsh` launcher on `PATH`, then the recorded anchor, then a project-local
  package. The path may be the package directory or its `package.json`. An
  invalid explicit selection fails instead of falling through, and the discovered
  version must satisfy `^0.2.1-rc.2`. Only `sync` and the sync step of `run`
  bootstrap an unresolved `PATH` launcher through pnpm or npm global metadata;
  `doctor`, `repl`, and `run --no-sync` never query a package manager.
  `init`, `check`, and `doctor --profile` need no installation; `doctor` uses
  one only when it is discoverable.
- `--config` accepts an absolute or working-directory-relative `.ts` path. Without
  it, the CLI resolves `$XDG_CONFIG_HOME/eedsh/config.ts` and never searches the
  working directory. `.mts`, `.js`, and `.mjs` fail with
  `config.unsupported_extension` before import.
- Bare `sync` publishes every profile in record order; `--profile` publishes only
  that profile and never falls back to the default. Each profile has its own lock and
  publication transaction. An invalid, locked, or failed profile is reported with its
  name and does not stop its valid siblings; the command exits `1` if any selected
  profile failed or was invalid.
- Preflight warnings are raw DSH messages by default, without a group prefix.
  In a multi-profile run each profile gets a header before its warnings and results.
  Raw warnings are followed by a one-line hint pointing at `--explain`.
- `--explain` attributes each preflight warning as `<group>: <message>`. The
  group is `generated #<n>` with the optional label, the authoring site, and the
  touched row ids when they are known; a bundle warning keeps `bundle:<name>`.
  Empty generated groups use the same positional prefix. It is sync-only; `run`,
  `check`, and `doctor` reject it as a usage error.
- `--strict` makes unmatched id-targeted patches a failure for the affected profile;
  strict failures stay raw unless `--explain` is also supplied, and that profile's
  generation record is not updated.
- `--watch` re-evaluates the config and the same all-or-one selection on every
  change (debounced). The watcher is ready before the initial sync; changes during a
  run coalesce into at most one follow-up, and one service layer serves the whole
  session. A config, selection, validation, or profile failure is reported and the
  session stays active; the previously published generation stays in place. Added
  profiles are picked up and removed profiles are no longer synced, but their
  published profiles remain. A stop signal interrupts an in-flight sync and releases
  its profile lock before the command exits 0. Layer or watcher construction failure
  exits 1 before any sync; a watcher-close failure is reported as a warning without
  changing the exit status.
- `run` selects `--profile`, then the declared default, then the sole profile. An
  unknown or ambiguous one-profile selection is a usage error (exit 2) listing the
  names, before publication or boot.
- `--adopt-ownership` re-baselines ownership from the current manifest when the
  generation record cannot be read. Sync fails closed without it, and it is not a way
  to re-adopt a removal already published.
- `--rebuild` runs every declared source preparation step even when the resolved
  commit and recorded steps are unchanged. `--no-build` fails with
  `provision.no_build`, naming the source and the commands it would run, instead of
  preparing; a source that needs no preparation still syncs. The two flags are
  mutually exclusive and a usage error together. See
  [Source provisioning](#source-provisioning).
- `check` typechecks the config's project with its own `tsc --noEmit -p <tsconfig>`,
  forwards arguments after `--`, never evaluates the config or publishes a profile,
  takes no `--profile` (it is a usage error), and exits with the compiler's exit code.
- `run` syncs the selected profile first unless `--no-sync`, then spawns
  `node <discovered dsh>/lib/bin.js --profile <name> <your args>` with inherited
  stdio and the invoking environment. Preflight, the generation record, and the
  spawned process all come from that one installation.
- `doctor` inspects a published profile without changing it. When a DSH is
  discoverable it prints its path and version, errors on an unsupported version,
  and warns about generation drift; see [Doctor](#doctor).
- `repl` opens a TypeScript session over the loaded config. Bindings persist:
  `config` is the config view, `selectedProfile` is the selected profile view,
  `plan` is `selectedProfile.plan()`, and the curated authoring factories
  `bundle`, `defineConfig`, `definePreset`, `dshVersion`, `group`, and `js` are
  bound. The legacy `profile`
  string and raw `profiles` map are not. Tab completes commands, chain methods,
  and profile, bundle, row, preset, and package names; a second Tab lists
  ambiguous matches. Saves are debounced and
  re-evaluated; the session prints a plan diff and composition summary, and keeps
  the previous evaluation after a bad save. Dot commands are `.help`,
  `.profile <name>`, `.reload`, `.resolve`, `.sync`, `.clear`, and `.exit`.
  Inspection, `.profile`, completion, and `.reload` write no profile files.
  `.sync` publishes now;
  `--sync` or `.sync on` publishes after each valid changed save, and
  `.sync off` returns to inspection. `.resolve name@exact-version` prepares a
  hash-keyed preview under `$XDG_CACHE_HOME/eedsh/repl` and prints the
  profile-root override; a successful preview-baked publication is re-evaluated
  against the real profile, deleting the preview when the plans match. `--eval`
  evaluates one expression without starting the prompt and exits non-zero on
  failure.
- Exit codes: `0` success; `1` config, validation, materialization, preflight, or
  launch failure; `2` usage error. Validation failures print Effect's native
  formatted schema message, including its location annotations. Locations are not
  rewritten into a `path` prefix, and there are no stable `plan.*` codes. `check`
  forwards the compiler's exit code and `run` forwards DSH's exit code as the
  command outcome.

## Config project

The default config is `$XDG_CONFIG_HOME/eedsh/config.ts`, or
`~/.config/eedsh/config.ts` when `XDG_CONFIG_HOME` is unset, empty, or not
absolute. There is no working-directory discovery and `XDG_CONFIG_DIRS` is not
consulted; `--config <path>` is the explicit `.ts` override. When the default path
does not exist, the command exits `1` and names both `eedsh init` and
`--config <path>`. Legacy `eedsh.config.ts`, `eedsh.config.mts`, and JavaScript
configs are never read, renamed, or adopted.

`eedsh init` creates the directory owner-only (where supported) and writes:

```
config.ts        defineConfig with one "default" profile (dsh-base + dsh-web-app + generated); no DSH declaration
package.json     private ESM manifest; links @eedsh/config and effect locally in a 0.0.0 workspace
tsconfig.json    es2024 / preserve / bundler, strict, noEmit; include ["**/*.ts"]
```

Existing files are kept byte-for-byte and reported, so a partially created project
is repaired by re-running init. Install failure leaves the files in place and exits
`1`; `--no-install` writes the project and prints
`cd <config dir> && pnpm install`. Init performs no git initialization, writes no
DSH declaration, and resolves no DSH pin or installation. `init --dsh` records
the validated installation in `$DSH_HOME/.local/state/installation.json` after
the project files; a failed anchor write is reported and keeps the usable project.
Without `--dsh`, init reads and reports an existing valid anchor and prints how
the first sync bootstraps one when none exists.

## Installation anchor

The machine-local anchor is `$DSH_HOME/.local/state/installation.json`. It
records `format: 1`, the absolute `installAnchor` package.json, the exact
version, and the recording source, plus the launcher and package manager when
known. It lives outside the config project, so it is never committed and the
project manifest gains no DSH dependency or version. Writes are atomic and
owner-only.

The state directory moved from `$DSH_HOME/.eedsh/` to `$DSH_HOME/.local/`; the
anchor is the only file that moves. After a successful anchor write, eedsh
removes the retired `$DSH_HOME/.eedsh/installation.json` and then the retired
directory when it holds nothing else, leaving a directory with other content
alone. A missing anchor re-bootstraps on the next sync, so no manual migration is
needed.

`eedsh sync` and the sync step of `eedsh run` bootstrap only when a `PATH`
launcher exists but its package cannot be located. The bootstrap asks pnpm
(`pnpm list -g --depth=0 --json`) and npm (`npm root -g`) for global metadata,
requires one candidate whose version equals `dsh --version`, and records the
anchor. When pnpm and npm both match, the launcher path selects the manager;
otherwise the command fails with `dsh.launcher_unresolved` instead of guessing.
A malformed, missing, or version-mismatched anchor is ignored and the next sync
bootstraps again.

`doctor`, `repl`, and `run --no-sync` never query pnpm or npm and never write
the anchor. They select `--dsh`, `EEDSH_DSH_ANCHOR`, direct `PATH` resolution,
or the anchor, and otherwise report `dsh.launcher_unresolved` or
`dsh.not_found` with the remedies. Other package managers and custom wrappers
are not introspected; use `--dsh`, `EEDSH_DSH_ANCHOR`, or boot an eedsh-managed
profile once so the runtime records the anchor.

Config evaluation registers tsx against the nearest `tsconfig.json` at or above
`config.ts` (or no tsconfig when there is none), never against the caller's working
directory. This makes the config's own `paths` mappings usable and keeps an
unrelated project's mappings out. Registration is keyed by that tsconfig and the
previous hooks are unregistered when a different config project is loaded in the
same process; `TSX_TSCONFIG_PATH` is never set.

## Source provisioning

`.source(name, { from, ref?, prepare? })` declares a profile package dependency
whose contents eedsh acquires from a git repository or a local checkout, prepares,
and links into the published profile. It is a dependency, not a bundle selection,
so a package that contributes a patch layer still needs `.bundle(name)`.

The acquisition kind comes from `from` alone. A `git`, `http`, `https`, `ssh`,
or `file` scheme, or an scp-like `user@host:path` form, is a git source; any
other value is a local checkout path. `file://` is the explicit way to name a
local directory that holds a git repository (it is cloned); a plain path is
linked in place. Both kinds name a directory, so no `.git` suffix is implied. A
relative path resolves against the config directory and `~/` expands to the user
home.

`ref` applies to git sources only and is a config error on a local checkout.
`prepare` is an ordered list of fixed argv arrays run without a shell in the
checkout. The git default is `[['pnpm', 'install'], ['pnpm', 'run', 'build']]`;
the local default is no steps. The resolved list is recorded in the plan.
Declaring one package through both `.package()` and `.source()` is a tagged
`SourceDeclarationError` that config loading preserves.

Every sync provisions declared sources before reconciliation, under
`$DSH_HOME/.local/`:

```
state/installation.json        installation anchor
state/sources/<key>.json       resolved commit, preparation steps, timestamp
sources/<key>/                 provisioned git working tree
locks/<key>.lock               per-source kernel lock
```

The key derives from the authored location and ref, so one repository and ref
pair maps to one checkout and distinct refs get distinct checkouts. A git
checkout is resolved against the remote and prepared only when new, when the
commit moved, or when the declared steps changed; an unchanged source is neither
fetched nor built. A local checkout is read in place and written only when its
declaration asks for preparation. The per-source lock serializes acquisition and
preparation.

The profile manifest receives a derived `link:<absolute checkout>` dependency,
reconciled as managed: a moved location rewrites it and installs, and removing
the declaration removes it while the checkout stays on disk. The plan records the
declaration without the path, so plans stay machine-independent. After
preparation, verification requires the manifest to name the declared package and
its main (or `.`) and client entries to exist; a missing entry fails the sync
before a generation is published.

When the remote cannot be reached, a sync with a checkout and record warns and
keeps the recorded commit; with no usable checkout it fails naming the source.
`--rebuild` forces preparation and `--no-build` refuses it, naming the source
and the commands; the flags are mutually exclusive. `eedsh doctor` reports a
missing checkout, a specification mismatch, and an unbuilt package as errors and
a working tree at a different commit than the record as a warning, without
provisioning.

## Doctor

`eedsh doctor` inspects one published profile and reports findings without taking a
lock, writing files, or repairing anything.

- It reports the discovered DSH path and version, an unsupported version as an
  error, and a record/runtime version difference as a `--strict`-sensitive
  warning that recommends `eedsh sync`. It reads no `engines.dsh` and reports a
  version-1 plan as unreadable. Doctor never queries pnpm or npm and never writes
  the installation anchor; it remains usable without DSH.
- It verifies the generation record, the authoritative
  `plans/<generationId>.json`, the `.eedsh/plan.json` mirror, managed bundles and
  dependencies, dependency-section conflicts, profile scaffolding, the lockfile, and
  installed package resolution. It also reads the published plan's source
  declarations: a missing provisioned location, a manifest specification that
  does not name that location, and an unbuilt entry point are errors, and a
  working tree at a commit other than the recorded one is a warning. Doctor never
  provisions, prepares, fetches, or repairs a source.
- `--profile <name>` selects a profile under `DSH_HOME` without evaluating a
  config; without it, doctor evaluates the config only to take the declared default
  or the sole profile, and a config with several profiles and no default is a usage
  error listing the names. `--config <path>` supplies the config path explicitly,
  and supplying both `--profile` and `--config` is a usage error. An invalid plan
  does not prevent doctor from inspecting the published profile by name.
- Findings print errors first and end with `N errors, M warnings`. `doctor` exits
  `0` when there are no errors (warnings are fine unless `--strict` is set), `1` with
  an error or with `--strict` and a warning, and `2` on a usage error.
- Findings point at `eedsh sync` or `eedsh sync --adopt-ownership`. When the
  generation record cannot be read, sync fails closed; `--adopt-ownership`
  re-baselines ownership from the current manifest. That is not a way to re-adopt a
  removal already published.

## Profile layout

`sync` writes into `$DSH_HOME/profiles/<name>` (or `~/.dsh/profiles/<name>`):

```
package.json                                dsh.profile.bundles + dependencies
cordis.yml                                  empty root config
cordis.patch.yml                            user layer; created empty only when missing, never rewritten
pnpm-workspace.yaml                         pnpm settings out-of-tree plugins need
.eedsh/plan.json                            inspectable plan mirror
.eedsh/provenance.json                      advisory authoring provenance (labels, per-patch sites)
.eedsh/generated/plans/<generationId>.json  authoritative validated plan (canonical JSON)
.eedsh/generated/patches/<generationId>/0001.yml  patch groups in order, named by 1-based position
.eedsh/generated/package.json               generation record + dsh.bundle.patch; the commit point
```

`.eedsh/plan.json` is a mirror for inspection. The authoritative plan is
`.eedsh/generated/plans/<generationId>.json`, which the generation record locates
and verifies.

The manifest lists managed bundles in plan order with `@eedsh/runtime` immediately
before `@eedsh/generated` at the authored marker (or last among managed bundles).
User-added bundles follow managed bundles; bundles eedsh managed before and no
longer manages are removed. Dependencies are reconciled the same way, and a managed
specification wins on collision. Managed entries are removed from `dependencies`,
`devDependencies`, and `optionalDependencies`; a managed name declared in
`peerDependencies`, `pnpm.overrides`, `overrides`, or `resolutions` is reported as
a conflict because it may change the resolved version.

## Publication guarantees

- Every profile file is replaced atomically: a failed write or rename leaves the
  target with its previous content and no temporary file behind.
- Patch files, the authoritative `plans/<generationId>.json`, and the profile
  manifest are written first. The `.eedsh/plan.json` mirror, then the advisory
  `.eedsh/provenance.json` sidecar, then the generated package manifest (the
  commit point) are written last; a reader never sees a partial generation. An
  unchanged materialization writes no sidecar.
- The generation id covers the canonical plan and every emitted patch-group hash,
  so an unchanged plan with intact artifacts is a no-op, while an emitter change
  produces a new generation.
- A stale plan mirror, or a missing or mismatched authoritative plan, is repaired by
  the next successful sync with the same generation id, without reinstalling.
- The profile manifest, `pnpm-lock.yaml`, plan mirror, and provenance sidecar are
  snapshotted before publication. A failed install, preflight, mirror write,
  sidecar write, or commit restores them, so the previous generation stays
  published and no partial dependency set or stale mirror remains. Extra packages
  left in `node_modules` are harmless because the restored manifest does not
  select them.
- A kernel-held profile lock serializes concurrent syncs; see [Sync locking](#sync-locking).

## Sync locking

`sync` serializes materialization for one profile. The lock is owned by the
operating system, and covers the whole transaction: reading the previous
generation, reconciling the manifest, package installation, preflight, and
publication.

- **Linux and macOS:** an advisory exclusive `flock` on the persistent
  `.eedsh/sync.lock` file. The descriptor stays open for the transaction and
  closing it releases the lock. eedsh never deletes, renames, or replaces the
  file. After acquiring, eedsh verifies that the locked inode still matches the
  path and retries if the file was replaced.
- **Windows:** a named kernel semaphore derived from the canonical profile lock
  path in the `Local` namespace. It creates no profile lock file. The lock is
  scoped to the current Windows login session, so another session, a POSIX
  process sharing the profile, or another host is not excluded.
- **On both platforms:** acquisition is non-blocking. A concurrent sync exits
  non-zero with `another sync is running for this profile; lock: <path>`. The
  kernel releases the lock when the process exits or crashes. A live holder
  keeps the lock until it releases it or exits.
- **Supported platforms:** Linux, macOS, and Windows. On any other platform, or
  when the native lock support cannot be loaded, sync fails before materializing
  with a file-system error naming the lock path.
- **Scope:** the lock is local and advisory. It does not coordinate hosts,
  network filesystems, mixed POSIX/Windows processes, or non-eedsh processes. Do
  not delete `.eedsh/sync.lock` while a POSIX sync is running.
- Old PID-based eedsh versions and this kernel lock do not interoperate; do not
  run them concurrently against one profile.

## Preflight

Before publication the CLI resolves every selected bundle from the discovered DSH
installation and the profile through its capability bridge, reads its patch
files, and composes them with the generated groups once through `composeEntries`
— the same algorithm boot uses. That
composition returns the entries, the raw unmatched-target warnings, and duplicate
ids inserted by generated groups.

Warnings stay raw by default. `sync --explain` attributes them by recomposing
prefixes over the flat patch list and pairing each warning with the patch that
introduced it; the patch maps back to its 1-based group position, optional label,
recorded authoring site, and touched row ids. Attribution stops once every raw
warning is placed, never recomposes the full stack, and never runs without the
flag or when there are no warnings. An empty generated group is reported with the
same positional prefix.

Preflight rejects duplicate ids inserted by generated groups, rejects malformed
patch files, and evaluates nothing (plugin config schemas run only at Loader
activation).

## Limitations

- `--watch` watches the config directory, not transitive imports outside it.
- Local `link:` dependencies are machine-specific.
- Package and bundle-set changes that DSH classifies as restart-required are not
  hot-reloaded; see `@eedsh/runtime`.
- The automatic bootstrap supports pnpm and npm only. It does not parse
  `cmd-shim-target` or probe wrappers from Yarn, Bun, Volta, asdf, Nix, or
  package-manager shims; use `--dsh`, `EEDSH_DSH_ANCHOR`, or a prior eedsh
  profile boot for those.