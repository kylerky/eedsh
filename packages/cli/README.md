# @eedsh/cli

The `eedsh` command. It evaluates a typed config with Node's native ESM loader
(`.ts` files use type stripping), validates the plan, preflights the composition
through DSH's own patch algorithm, publishes a normal DSH profile atomically, and
can boot the pinned launcher.

Effect is the default here: tagged failures, `Context.Tag` services for file access,
package installation, DSH resolution, and preflight, plus a `ManagedRuntime` for
watch mode. Node `fs` and `spawn` live only in the live service layer. `@eedsh/config`
also uses Effect for the plan schema and validation, while `@eedsh/runtime` stays a
plain Cordis plugin; `defineProfile` remains synchronous at the config boundary.

## Commands

```sh
eedsh sync  [--config <path>] [--strict] [--watch]
eedsh check [--config <path>] [-- <tsc args>]
eedsh run   [--config <path>] [--no-sync] [-- <dsh args>]
eedsh --help | --version
```

- `--config` accepts an absolute or working-directory-relative path. Without it, the
  CLI looks for `eedsh.config.ts` then `eedsh.config.mts` in the working directory;
  JavaScript configs (`.js`, `.mjs`) are rejected with
  `config.unsupported_extension` before they are imported.
- `--strict` makes unmatched id-targeted patches a failure; the generation record is
  not updated.
- `--watch` re-evaluates the config when files under its directory change (debounced).
  A compile or validation failure is reported and the previously published generation
  stays in place; one `ManagedRuntime` serves every run.
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

- Patch files and `plan.json` are written before the generated package manifest,
  which is the commit point. A reader never sees a partial generation.
- The generation id covers the canonical plan and every emitted layer hash, so an
  unchanged plan is a no-op and an emitter change produces a new generation.
- The profile `package.json` and `pnpm-lock.yaml` are snapshotted before installation
  and restored if installation or preflight fails. Extra packages left in
  `node_modules` are harmless because the restored manifest does not select them.
- A profile-local lock (`.eedsh/sync.lock`) serializes concurrent syncs; a stale lock
  is recovered with a PID liveness check.

## Preflight

Before publication the CLI resolves every selected bundle from the pinned DSH
installation and the profile, reads its patch files, and composes them with the
generated layers through `composeEntries` — the same algorithm boot uses. It reports
unmatched id-targeted patches with their layer, rejects duplicate ids inserted by
generated layers, rejects malformed patch files, and evaluates nothing (plugin
config schemas run only at Loader activation).

## Limitations

- `--watch` watches the config directory, not transitive imports outside it.
- Local `link:` dependencies are machine-specific; published packaging is deferred.
- Package and bundle-set changes that DSH classifies as restart-required are not
  hot-reloaded; see `@eedsh/runtime`.