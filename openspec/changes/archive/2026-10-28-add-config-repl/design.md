## Context

See proposal.md - Why. The constraints that shape this design:

- `loadConfig` imports the config in-process through tsx hooks, with a cache-busting query so a watch rerun re-evaluates an edited file. It runs once, before profile selection and before any install.
- DSH resolves bundle patch layers installation-first, then from the profile (`resolveBundleDir`), and that order is its contract: an in-box bundle always comes from the same installation as the running DSH.
- `materialize` takes a validated plan, installs dependencies only when the reconciled dependency set changed, and short-circuits when the generation id, manifest, plan mirror, and authoritative plan are unchanged.
- `syncWatch` already watches the config directory with a debounce, rebuilds the service layer once, re-evaluates on change, and reports failures without exiting.
- The config project installs its own `@eedsh/config`; the CLI has a separate copy, so module identity cannot be assumed across the two.
- Node's REPL ships dot commands and `defineCommand`; the CLI already depends on tsx, whose REPL patch evaluates TypeScript and top-level await (verified against Node 26).

## Goals / Non-Goals

**Goals:**

- Queries in `config.ts` with exactly the data the prompt shows, for in-box and custom bundles.
- A single session that inspects, previews, and publishes without a separate hand-off.
- Publishing stays explicit, verified, and attributable; inspection never writes.

**Non-Goals:**

- Editing or rewriting `config.ts` from the session.
- Deferred query nodes resolved per profile at materialization.
- A persistent staging cache or a `sync --dry-run` command.
- Auto-sync by default, or syncing every profile from a session.
- Booting DSH in-process — `eedsh run` stays the boot path.

## Decisions

### 1. The resolution anchor comes from the environment

The CLI sets `EEDSH_DSH_ANCHOR` to the pinned DSH manifest path before importing the config; the authoring package reads it for every query. This survives module duplication, is inherited by child processes, is visible in the session, and needs no hidden global state.

*Alternatives considered:* a `Symbol.for` global bridge (invisible, not inherited, needs a version marker to fail safely); resolving DSH from the config project (it does not depend on DSH, by design).

### 2. The default root is the pinned installation; explicit roots are how custom bundles are reached

A query with no root resolves from the pinned installation and never from a profile copy, which matches boot's contract for in-box bundles and keeps `config.ts` deterministic. Custom bundles name one root: `{ profile }` for the booted copy (after that profile has installed it) or `{ packageDir }` for a checkout or vendor directory, resolved relative to the config file.

*Alternatives considered:* mirroring the resolver's profile fallback by default - config is evaluated once before profile selection, so there is no single profile anchor, and a fallback that only answers for missing bundles cannot change in-box results. Ambient roots from the environment - same determinism problem with less visibility. Deferred nodes - see Non-Goals; they cannot support author-time logic.

### 3. Queries return summaries; full rows are the escape hatch

`presets(bundle)` returns frozen `{ rowId, id, order?, name?, disabled? }` summaries that paste into `disable`/`override` targeting; `rows(bundle)` and `row(bundle, rowId)` return declared rows for deeper edits. Summaries keep a plan readable and avoid dragging plugin trees into `config.ts`.

### 4. The session is a seam over `node:repl`

A session layer owns evaluation, bindings, reload, preview, sync, and formatting; the command wires streams and the watcher. `.help`, `.reload`, `.resolve`, `.sync`, `.exit`, and `.clear` are `defineCommand` registrations, each delegating to an exported session function so the watcher and `--eval` share one implementation.

### 5. Session bindings load the config project's authoring package

The session resolves `@eedsh/config` from the config directory and imports that copy, so a query at the prompt runs the same code as the same query in `config.ts`. The resolved package path is printed in the banner.

### 6. The preview is a session-owned profile copy, keyed by its inputs

For a custom bundle the selected profile has not installed, `.resolve name@exact-version` copies the profile's `package.json`, workspace file, and lockfile into `$XDG_CACHE_HOME/eedsh/repl/<hash>`, installs the exact spec there, and evaluates with a printed profile-root override. The hash covers the copied manifest and lockfile, the DSH pin, and the requested specs; concurrent sessions serialize on a per-key lock. The preview is never named by `config.ts`, never used by the CLI's own `sync`, and is deleted once a sync proves it unnecessary.

*Alternatives considered:* a persistent single-package stage command (weaker than a profile copy, needs its own cache lifecycle); a nonce per session (simple, but pays a cold install every session); writing the preview path into `config.ts` (makes the file depend on a GC-able directory).

### 7. Sync is a session command; continuous sync is opt-in

`.sync` calls the existing materialize program with the plan the session just evaluated; `--sync` or `.sync on` reuses the debounced watch loop to sync after each valid save. Both are opt-in and shown in the banner. Invalid configs are never published, failures pause continuous mode until the next changed save, and restart-required bundle or package changes are reported rather than presented as a hot reload.

*Alternatives considered:* shelling out to `eedsh sync` (loses the evaluated plan and duplicates process state); making sync the default (turns every keystroke save into a publication); auto-syncing all profiles (the session is scoped to one).

### 8. A preview-baked publish is verified immediately

The first sync may publish a plan evaluated through the preview; the preview is the only way to evaluate a config that queries a bundle the profile has not installed. Immediately after publication the session re-evaluates without the override and compares plans. Identical plans close the bootstrap: the preview is deleted and the session reports completion. A divergence is reported, the preview is kept, and the next `.sync` publishes the real evaluation.

*Alternatives considered:* refusing to publish while the preview is active (restores the manual two-step the session exists to remove). Publishing without verification (leaves no evidence that the preview matched the real install).

### 9. Re-evaluation diffs canonical plan JSON

On a save, the session diffs canonical JSON per profile plus the preflight composition summary. Canonical JSON removes key-order noise; the composition summary is where row-level changes become visible without printing the whole tree.

### 10. Failures are values, not session exits

Config import failures, schema failures, query failures, preview install failures, and sync failures are formatted and printed; the last good evaluation stays available and `.reload` retries. The prompt never dies on a bad save.

### 11. Dot commands are shell-level only

`.help`, `.reload`, `.resolve`, `.sync`, `.exit`, and `.clear` cover session state and publication; domain queries stay ordinary functions so they compose, print through the inspector, and work under `--eval`. `.help` lists registered commands automatically.

## Risks / Trade-offs

- **A preview-baked publish could bake rows the real install would not produce** -> exact specs, install-before-publish, and the mandatory post-publish re-evaluation diff; a divergence keeps the preview and is reported.
- **The session becomes a publishing surface** -> publishing is explicit (`.sync`) or explicitly enabled (`--sync`), invalid configs are skipped, the sync lock and the publication rollback protect the profile, and the banner shows the mode.
- **Restart-required changes look like hot reloads** -> classify by comparing the published bundle and package sets and say "restart required".
- **Lock contention with another sync** -> report it, never block the prompt, and let the next changed save retry.
- **Continuous sync spam** -> pause after a failure until the next changed save, and print one outcome line per sync.
- **Preview cache growth** -> hash keys, age-based GC at session start, and deletion immediately after a successful bootstrap.
- **Hash staleness** -> the key covers the manifest, lockfile, pin, and specs; the session verifies the package directory exists before reusing a key.
- **Two copies of `@eedsh/config`** -> resolve from the config directory and print the resolved path in the banner.
- **Cache-busted imports grow the module graph across reloads** -> acceptable for a session; the anchor seam leaves room for a future isolated evaluator.
- **Prompt/output interleaving during reload or sync** -> formatting lives in the session layer and pauses/repaints the prompt around it, so it is testable without a TTY.

## Migration Plan

Additive: a new command, new query options, and new session capabilities. No existing command changes behavior, no plan format changes, and `eedsh init` output is unchanged. The previous "the session never publishes" requirement is replaced within this change.
