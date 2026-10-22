# @eedsh/cli

The `eedsh` command. It evaluates a typed config with `tsx`, validates the plan,
preflights the composition through DSH's own patch algorithm, publishes a normal
DSH profile atomically, and can boot the pinned launcher.

The package is bin-only: `lib/bin.js` (the `eedsh` binary) is the only build output,
and there is no library export.

Effect is the default here: tagged failures, `Context.Tag` services for file access,
package installation, DSH resolution, preflight, and sync locking, plus one scoped
service layer per watch session. `@effect/cli` parses the command surface; its generated help and usage
errors are rendered through an injected Console with ANSI escapes stripped, and the
CLI binds only the narrow Node file-system, path, and terminal layers. Node `fs` and
`spawn` live only in the live service layer. `@eedsh/config` also uses Effect for the
plan schema and validation, while `@eedsh/runtime` stays a plain Cordis plugin;
`defineProfile` remains synchronous at the config boundary.

## Commands

```sh
eedsh sync  [--config <path>] [--strict] [--watch] [--explain]
eedsh check [--config <path>] [-- <tsc args>]
eedsh run   [--config <path>] [--no-sync] [-- <dsh args>]
eedsh --help | --version
```

- `--config` accepts an absolute or working-directory-relative path. Without it, the
  CLI looks for `eedsh.config.ts` then `eedsh.config.mts` in the working directory;
  JavaScript configs (`.js`, `.mjs`) are rejected with
  `config.unsupported_extension` before they are imported.
- Preflight warnings are raw DSH messages by default, without a source-layer prefix.
  Raw warnings are followed by a one-line hint pointing at `--explain`.
- `--explain` attributes each preflight warning as `<layer>: <message>`. It is
  sync-only; `run` and `check` reject it as a usage error.
- `--strict` makes unmatched id-targeted patches a failure; strict failures stay raw
  unless `--explain` is also supplied, and the generation record is not updated.
- `--watch` re-evaluates the config when files under its directory change (debounced).
  The watcher is ready before the initial sync; changes during a run coalesce into at
  most one follow-up, and one service layer serves the whole session. A compile or
  validation failure is reported and the previously published generation stays in
  place. A stop signal interrupts an in-flight sync and releases its profile lock
  before the command exits 0. Layer or watcher construction failure exits 1 before
  any sync; a watcher-close failure is reported as a warning without changing the
  exit status.
- `check` typechecks the config's project with its own `tsc --noEmit -p <tsconfig>`,
  forwards arguments after `--`, never evaluates the config or publishes a profile,
  and exits with the compiler's exit code.
- `run` syncs first unless `--no-sync`, then spawns `node <pinned dsh>/lib/bin.js
  --profile <name> <your args>` with inherited stdio and the invoking environment.
- Exit codes: `0` success, `1` config/validation/materialization/preflight/launch
  failure, `2` usage error. Validation failures print `path: message` locations
  (`plan` for a root failure) from Effect's native issue formatter; there are no
  stable `plan.*` codes.

## Profile layout

`sync` writes into `$DSH_HOME/profiles/<name>` (or `~/.dsh/profiles/<name>`):

```
package.json                     dsh.profile.bundles + dependencies
cordis.yml                       empty root config
cordis.patch.yml                 user layer; created empty only when missing, never rewritten
pnpm-workspace.yaml              pnpm settings out-of-tree plugins need
.eedsh/plan.json                 the validated plan (canonical JSON)
.eedsh/generated/package.json    generation record + dsh.bundle.patch; written last
.eedsh/generated/patches/<generationId>/<layerId>.yml
```

The manifest lists managed bundles in plan order with `@eedsh/runtime` immediately
before `@eedsh/generated` at the authored marker (or last among managed bundles).
User-added bundles follow managed bundles; bundles eedsh managed before and no
longer manages are removed. Dependencies are reconciled the same way, and a managed
specification wins on collision.

## Publication guarantees

- Every profile file is replaced atomically: a failed write or rename leaves the
  target with its previous content and no temporary file behind.
- Patch files and `plan.json` are written before the generated package manifest,
  which is the commit point. A reader never sees a partial generation.
- The generation id covers the canonical plan and every emitted layer hash, so an
  unchanged plan is a no-op and an emitter change produces a new generation.
- The profile `package.json` and `pnpm-lock.yaml` are snapshotted before installation
  and restored if installation or preflight fails. Extra packages left in
  `node_modules` are harmless because the restored manifest does not select them.
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

Before publication the CLI resolves every selected bundle from the pinned DSH
installation and the profile, reads its patch files, and composes them with the
generated layers once through `composeEntries` — the same algorithm boot uses. That
composition returns the entries, the raw unmatched-target warnings, and duplicate
ids inserted by generated layers.

Warnings stay raw by default. `sync --explain` attributes them by recomposing only
layer prefixes and pairing each warning with the layer that introduced it; attribution
stops once every raw warning is placed, never recomposes the full stack, and never
runs without the flag or when there are no warnings.

Preflight rejects duplicate ids inserted by generated layers, rejects malformed patch
files, and evaluates nothing (plugin config schemas run only at Loader activation).

## Limitations

- `--watch` watches the config directory, not transitive imports outside it.
- Local `link:` dependencies are machine-specific; published packaging is deferred.
- Package and bundle-set changes that DSH classifies as restart-required are not
  hot-reloaded; see `@eedsh/runtime`.
