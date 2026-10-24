## Context

`composePreflightLayers` currently composes every layer prefix to learn which layer produced each warning, then composes the full stack again for the entries. That is `n + 1` full patch applications, each deep-cloning the flattened layer list. The fast path is the common path: most syncs have no warnings at all, and the default output does not need attribution.

The CLI's argument parser is a hand-written `parseCliArgs` with its own `UsageError` and `USAGE` string. This change adds a new `sync` option, and the project wants the whole command surface parsed by Effect's CLI parser instead of extending the hand-written one. `effect@3.22.3` is already pinned; the compatible CLI generation is `@effect/cli@0.77.2` (peer `effect ^3.22.2`, `@effect/platform ^0.97.2`, `@effect/printer ^0.51.0`, `@effect/printer-ansi ^0.51.0`). The earlier design's "no Effect CLI / Effect Platform" boundary is intentionally superseded for `@eedsh/cli` only. The package is bin-only: the exported `runCli`, `CliDeps`, and `ParsedCli` types exist for tests, not as a public library contract, so their shapes do not need to survive the migration.

See `proposal.md` for motivation and `specs/preflight-diagnostics/spec.md` for the behavior contract.

## Goals / Non-Goals

**Goals:**

- Make the default composition path a single `composeEntries` call that returns raw warnings.
- Keep attribution exact and opt-in, with prefix recomposition running only when `sync --explain` is present and warnings exist.
- Preserve the existing patch semantics, warning set, strictness, publication behavior, and generated-layer diagnostic rules.
- Parse the whole `eedsh` command surface with `@effect/cli`, preserving the current commands and options, `--` passthrough, help/version behavior, and the `0`/`1`/`2` exit-code contract. Keep the CLI testable through an explicit-argv entry with injected output and service layers; preserving the old `runCli`/`CliDeps` interface is not required.

**Non-Goals:**

- Carrying composed entries forward layer by layer, using boundary marker patches, or replaying the patch match rules locally to attribute warnings. Each changes or duplicates the behavior preflight borrows from DSH.
- Attributing warnings automatically on strict failure, or adding `--explain` to `run`/`check`.
- Changing patch composition, plan validation, generation ids, publication, dependency installation, or HMR.
- Preserving the exact old help/usage text, undocumented aliases, the hand-written parser's error wording, or the `runCli`/`CliDeps`/`ParsedCli` internal entry shapes.

## Decisions

### 1. Split composition from attribution

`composePreflightLayers` becomes a one-pass composer:

```ts
interface PreflightComposition {
  entries: Record<string, unknown>[]
  warnings: string[]          // raw DSH messages, patch order
  duplicateInsertIds: string[]
}
```

A separate exported helper owns the demand path:

```ts
interface PreflightWarning { layer: string; message: string }

function attributePreflightWarnings(
  layers: readonly PreflightLayer[],
  warnings: readonly string[],
): PreflightWarning[]
```

The helper takes the full raw warning list already produced by the one-pass composition and recomposes only prefixes `1..n-1`. After each prefix it assigns the new warning tail to that layer, stops once the whole raw list is placed, and gives the last layer any remainder. Empty warnings return immediately; one layer assigns everything directly; the full stack is never recomposed. It relies on the prefix-extension property DSH documents for its own `renderConfigDump`: earlier layers see identical preceding state in every prefix, so a prefix's warnings are a prefix of the full list.

Alternatives rejected:

- **Per-layer carry-forward composition** is faster but not equivalent to boot. A single flattened `applyEntryPatches` builds the id map once; a config replacement does not index its new group children, and a detached child stays indexed. Rebuilding the map at a layer boundary makes those children visible, changing both entries and warnings.
- **Boundary marker patches** would give one-pass attribution but inject synthetic "not found" warnings and couple attribution to warn-message text.
- **A local replay of the match rules** would avoid prefix composition but duplicate the insert/group/name semantics the design deliberately borrows, especially for bundle patch files parsed outside the plan schema.
- **Dropping labels entirely** was rejected because attribution is still wanted, just deferred.

`PreflightComposition.entries` remains available and `check` continues to ignore it, as today.

### 2. Thread one explicit `explain` flag; keep the hint in the CLI

`explain: boolean` is added to `MaterializeOptions`, `PublishProfileInput`, and `PreflightInput`, defaulted from the parsed `sync` options. In `check`:

```ts
const raw = composition.warnings
const messages =
  input.explain && raw.length > 0
    ? attributePreflightWarnings(layers, raw).map((w) => `${w.layer}: ${w.message}`)
    : raw
```

Strict and duplicate-id checks keep using `messages`; the failure condition and publication ordering do not move. Strict failures therefore stay raw unless `--explain` was supplied.

The raw-warning hint is presentation, so it stays in the CLI layer: after `printResult` prints raw warnings, and after a `PreflightFailure` with raw warnings is reported, the CLI prints one line telling the user to add `--explain`. The preflight service returns messages only and does not know about hints. The check for "were warnings attributed?" is the already-parsed `explain` flag, so no extra structure crosses the service boundary.

### 3. Replace the `runCli` parser and entry shape with `@effect/cli`

The parser is replaced, not wrapped by a second parser. The command surface is expressed as an `@effect/cli` `CliApp` with a root `eedsh` command and `sync`, `run`, and `check` subcommands:

- `sync`: `--config` (optional text), `--strict`, `--watch`, `--explain`.
- `run`: `--config` (optional text), `--no-sync`.
- `check`: `--config` (optional text).
- No positional arguments on any command; run/check passthrough is not parsed as options.

`runCli(argv, deps)`, `CliDeps`, `ParsedCli`, and `UsageError` are not retained. The CLI is an `@effect/cli` app: the live bin builds it with process argv and the live service layers, while tests build the same app with an explicit argv and injected output/service layers. The exact entry-point name and return type are implementation details; the live binary maps the result to `process.exitCode`, and tests assert the returned code and captured output. A small explicit-argv entry may remain for tests and embedders, but it need not accept a `deps` object or return `Promise<number>`.

That entry runs `CliApp.run(app, ['node', 'eedsh', ...argv], handler)` because `CliApp.run` always drops the first two explicit arguments. A custom `Console` is installed with `Console.withConsole` so generated help and parse errors go to the injected output sink instead of the process streams; `log` and `error` are the only methods Effect CLI uses for this flow. The console strips ANSI SGR sequences before forwarding, preserving plain-text output. The app is provided the narrow `@effect/platform-node` file-system, path, and terminal layers rather than the full `NodeContext`, so command-executor/worker services are not pulled in.

The `--` passthrough is split before parsing: for `run` and `check`, everything after the first `--` is held verbatim and attached to the mapped command; the head goes to Effect CLI. A `--` on `sync` (or a positional argument before it) is a usage error, as today. This keeps Effect CLI from interpreting passthrough flags such as `--help`, and preserves the current "args only after `--`" rule.

The handler maps each parsed subcommand to the existing internal command shape and calls the existing dispatch with the injected config loader, backend services, spawn, watch, and environment/cwd. It writes the dispatch's return code into a local result cell and returns `Effect.void`. The entry then returns:

- `0` for help, version, or a successful dispatch;
- `2` for an Effect CLI `ValidationError` (usage/parse error; the app has already printed it);
- the dispatch code for sync/check/run failures, including `check`'s forwarded tsc status and `run`'s child exit status;
- `1` for an unexpected handler throw after reporting it.

Help, version, and built-in Effect CLI options are generated by `CliApp`; the hand-written `USAGE`, `parseCliArgs`, and `UsageError` are removed. Help/error text and the availability of Effect CLI's built-ins (`--completions`, `--log-level`, `--wizard`) are accepted as part of adopting the parser; the documented eedsh options remain the contract. The undocumented `-v` shortcut is not preserved (`-h` remains via Effect CLI's built-in alias).

Alternatives rejected:

- **Extending `parseCliArgs`** contradicts the explicit requirement to use Effect's CLI parser.
- **Hybrid parsing** would leave two sources of truth for options, help, and errors.
- **A parse-only use of `Command`** has no supported public parse entry point in this version; `CliApp.run` is the supported seam and accepts explicit argv, which is exactly what the adapter needs.

### 4. Pin the dependency set to the existing Effect version

Add `@effect/cli@0.77.2`, `@effect/platform@0.97.2`, `@effect/printer@0.51.0`, and `@effect/printer-ansi@0.51.0`. Add `@effect/platform-node@0.108.3` for the narrow Node file-system/path/terminal layers; its broad optional infrastructure peers are not imported by those modules, and the install/typecheck must confirm the resolved graph. No Effect CLI or Effect Platform dependency reaches `@eedsh/config` or `@eedsh/runtime`.

## Risks / Trade-offs

- **Effect CLI output drift** (generated help, ANSI styling, new built-ins) changes what users and tests see → strip ANSI in the adapter, update help/CLI tests to assert commands/options rather than exact prose, and document the new help surface.
- **Parser migration regressions** in exit codes, `--` passthrough, or option ownership → keep dispatch separable from the Effect CLI app, build a focused explicit-argv test harness, pre-split passthrough, and test every command/option/exit code, including `run --explain` and `check --explain` failing with 2.
- **CLI test-harness rewrite** is broader than a parser swap → move behavior tests to the explicit-argv entry, reuse the existing backend fakes/service layers, and retain the built-binary smoke test.
- **New dependency/peer resolution** conflicts with `effect@3.22.3` → exact pins, narrow platform-node imports, and `pnpm install` + typecheck in the first task group.
- **Attribution still costs `O(layers^2)` when requested** → it is confined to `--explain` with warnings, stops once the raw list is placed, and never runs on the clean path.
- **Prefix-extension assumption in DSH changes** → the full raw warning set still comes from the official one-pass composition, so reporting and strictness stay correct; add an attribution test asserting the attributed messages equal the raw messages in order, so a drift fails loudly instead of silently mislabelling.
- **Raw warnings lose their source layer by default** → the hint points at `--explain`, and `--strict --explain` retains detailed failure diagnostics.
- **Exit-code cell after `CliApp.run`** must not confuse parse errors with dispatch failures → map `ValidationError` to 2 before consulting the cell, and test help/version/usage alongside dispatch results.

## Migration Plan

1. Add and pin the CLI/platform dependencies; verify install and typecheck.
2. Split composition and attribution, thread `explain` through the preflight/publish/materialize services with a `false` default on the existing path, and update preflight/effect tests. Commit.
3. Replace the parser and CLI entry shape with the Effect CLI app, rework the CLI test harness onto explicit argv and injected layers, and add `--explain` plus the hint; remove `parseCliArgs`/`UsageError`/`USAGE` and the old `runCli`/`CliDeps`/`ParsedCli` types. Commit.
4. Update the README's command/option and preflight sections, run the full `pnpm check`, `pnpm test`, and `pnpm build:packages`, and commit.

There is no persisted-data migration. Reverting the implementation commit and lockfile restores the old CLI and preflight behavior; no published profile or plan format depends on this change.

## Open Questions

None. The parser scope, demand surface, strict-failure behavior, and dependency version are resolved above; only install-time peer resolution and generated help prose are implementation verification details.
