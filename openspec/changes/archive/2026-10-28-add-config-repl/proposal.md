# Proposal: Author-time bundle resolution and a config REPL

## Why

Authors can only touch presets (and other bundle-provided rows) by hard-coding row ids they
read out of installed bundle files; eedsh's plan is static while the real composition depends
on the pinned DSH install. Custom bundles are worse: the first sync is a manual two-step
because the config cannot be evaluated before the profile has installed them. Making
resolution available inside `config.ts`, and giving authors one interactive session that
evaluates, previews, and publishes, turns "what will my profile actually compose?" into a
query answered without leaving the prompt.

## What Changes

- `@eedsh/config` gains synchronous author-time resolution: `presets(bundle)`,
  `row(bundle, rowId)`, and `rows(bundle)`. With no root they resolve from the pinned DSH
  installation named by `EEDSH_DSH_ANCHOR` and never from a profile copy. Custom bundles use
  one explicit root: `{ profile }` for that profile's installed copy, or `{ packageDir }`
  for a checkout or vendor directory. Results are frozen, JSON-safe row data; failures are
  structured.
- New `eedsh repl [--profile] [--config] [--sync] [--eval]` command: a TypeScript-capable
  prompt that preloads the loaded config and authoring helpers, watches the config directory,
  and re-evaluates on save.
- The session owns an ephemeral preview for custom bundles the selected profile does not have
  yet: `.resolve <name>@<exact-version>` copies the selected profile's metadata into a
  hash-keyed cache directory, installs there, and evaluates the config with a printed
  profile-root override. The override is session-local, and `config.ts` never names the
  preview.
- The session can publish: `.sync` materializes the selected profile in-process, and
  `--sync` or `.sync on` turns on continuous sync. Inspection never writes; publishing is
  always explicit or explicitly enabled.
- The first sync may publish a plan evaluated against the preview. Immediately after
  publishing, the session re-evaluates against the real profile and compares plans: identical
  rows close the bootstrap and delete the preview; a divergence is reported and the preview is
  kept for the retry.
- Continuous sync reuses the existing watch loop: debounced, skipped on invalid config, paused
  after a failure until the next changed save, and it reports restart-required changes instead
  of implying a hot reload.
- No staging command and no `sync --dry-run`: the preview is a REPL implementation detail.
- Dot commands remain shell-level: `.help`, `.reload`, `.exit`, `.clear`, `.resolve`,
  `.sync`. Domain queries stay ordinary functions.

## Capabilities

### New Capabilities

- `authoring-resolution`: the synchronous query surface in `@eedsh/config` — the anchor,
  pinned-default lookup, explicit roots, returned row data, and structured failures.
- `config-repl`: the `eedsh repl` session — command surface, bindings, preview resolution,
  save-driven diff, in-session sync and continuous mode, preview-baked publish verification,
  and the rule that inspection never writes.

### Modified Capabilities

None. Existing plan, materialization, and doctor requirements are unchanged; queries produce
ordinary inserted rows and the session uses the existing materializer.

## Impact

- `packages/config`: resolution module, root options, new dependencies
  (`@deepseek-ai/dsh-app-boot`, `js-yaml`), and an anchor read from the environment.
- `packages/cli`: `repl` command, session layer, preview cache and locks, in-session sync
  wiring, and formatting for diffs, provenance, and sync outcomes.
- Cache: `$XDG_CACHE_HOME/eedsh/repl/<hash>`, age-GC'd and deleted after a successful
  bootstrap.
- Config projects: transitive dependencies grow; `eedsh init` output is unchanged.
- Docs: README quick start and CLI reference gain `eedsh repl`, the query helpers, and the
  preview bootstrap.
