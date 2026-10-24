## Why

Preflight currently composes every layer prefix just to attribute unmatched-patch warnings, then composes the full stack again: `n + 1` compositions, each deep-cloning and replaying the whole patch list. That is quadratic in layer count for information the default `sync` output does not need. At the same time, adding the opt-in `--explain` option to the hand-written argv parser would deepen an implementation the project now wants on Effect's CLI parser instead.

## What Changes

- **BREAKING** for consumers that parse warning text: `eedsh sync` reports preflight warnings as raw DSH messages by default, without a `layer:` prefix.
- Add `eedsh sync --explain`: when preflight produced warnings, it additionally runs the prefix snapshots to attribute each warning to its source layer. Attribution is never run without the flag, and never runs when there are no warnings.
- Keep `--strict` failures raw as well; `--strict --explain` shows attributed messages, but strictness, publication, and exit-code behavior do not change.
- Print a one-line hint after raw warnings pointing at `--explain` so the attribution remains discoverable.
- Split the preflight API: one-pass composition returns entries, raw warnings, and duplicate insert ids; a separate attribution helper consumes the raw warnings and layers only when demanded. Patch composition semantics, generated-layer marker placement, and duplicate-id detection are unchanged.
- Replace the hand-written `parseCliArgs`/`UsageError` parser with `@effect/cli` for the entire `eedsh` command surface. Preserve the commands (`sync`, `run`, `check`), options (`--config`, `--strict`, `--watch`, `--no-sync`, plus `--explain` on `sync`), `--` passthrough for `run`/`check`, help/version availability, and the `0`/`1`/`2` exit-code contract. Help and usage text may become parser-generated; the documented commands and options remain the same.
- Do not preserve the current `runCli(argv, deps)`/`CliDeps`/`ParsedCli` entry seam. The CLI is restructured as an `@effect/cli` program with an explicit-argv entry and injectable output/service layers for tests; the old internal entry types and signatures are implementation details, not a contract.
- Do not add `--explain` to `run` or `check`, and do not make strict failures attribute automatically.

## Capabilities

### New Capabilities

- `preflight-diagnostics`: how preflight composition diagnostics are reported: raw by default, attributed on demand with `--explain`, raw strict failures, and the no-warning fast path.

### Modified Capabilities

- None. This repository has no existing capability specs.

## Impact

- **Preflight**: `packages/cli/src/preflight.ts`, `packages/cli/src/internal/effect/services.ts`, and the `explain` flag threaded through `packages/cli/src/materialize/publish.ts` and `packages/cli/src/materialize/program.ts`. `PreflightComposition.warnings` becomes `string[]`; a new attribution helper returns the existing `{ layer, message }` shape. `PreflightResult.warnings` stays `string[]`.
- **CLI**: `packages/cli/src/cli.ts`, `packages/cli/src/bin.ts`, and the CLI tests are restructured around an `@effect/cli` app. The old `runCli`/`CliDeps`/`ParsedCli`/`UsageError` shapes are not preserved; tests drive an explicit-argv entry with injected output and service layers, and the binary maps the result to `process.exitCode`. The command/option surface, `--` passthrough, and `0`/`1`/`2` exit codes remain the behavior contract.
- **Dependencies**: add `@effect/cli` and the Effect platform packages it requires for file-system/path/terminal services, pinned to versions compatible with the existing `effect@3.22.3`. This supersedes the earlier "no Effect CLI / Effect Platform" boundary decision for `@eedsh/cli` only; `@eedsh/config` and `@eedsh/runtime` remain Effect-free.
- **Tests/docs**: preflight unit tests for raw warnings and attribution, `check` tests for default/explain/strict modes, CLI parser and output tests (including help/usage and `--` passthrough), and README updates. No DSH changes, no plan format change, no published profile format change, and no change to when a generation is committed.
