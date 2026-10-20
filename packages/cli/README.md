# @eedsh/cli

The `eedsh` command. It evaluates a typed config with Node's native ESM loader
(`.ts` files use type stripping), validates the plan, preflights the composition
through DSH's own patch algorithm, publishes a normal DSH profile atomically, and
can boot the pinned launcher.

Effect is used here and only here: tagged failures, `Context.Tag` services for file
access, package installation, DSH resolution, and preflight, plus a `ManagedRuntime`
for watch mode. Node `fs` and `spawn` live only in the live service layer.

## Commands

```sh
eedsh sync [--config <path>] [--strict] [--watch]
eedsh run  [--config <path>] [--no-sync] [-- <dsh args>]
eedsh --help | --version
```

- `--config` accepts an absolute or working-directory-relative path. Without it, the
  CLI looks for `eedsh.config.ts`, `eedsh.config.mts`, `eedsh.config.mjs`, then
  `eedsh.config.js` in the working directory.
- `--strict` makes unmatched id-targeted patches a failure; the generation record is
  not updated.
- `--watch` re-evaluates the config when files under its directory change (debounced).
  A compile or validation failure is reported and the previously published generation
  stays in place; one `ManagedRuntime` serves every run.
- `run` syncs first unless `--no-sync`, then spawns `node <pinned dsh>/lib/bin.js
  --profile <name> <your args>` with inherited stdio and the invoking environment.
- Exit codes: `0` success, `1` config/validation/materialization/preflight/launch
  failure, `2` usage error.

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
