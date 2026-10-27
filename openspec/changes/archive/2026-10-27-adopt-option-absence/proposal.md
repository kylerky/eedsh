## Why

The CLI now validates its external data with Effect Schema, but absence is still represented by `undefined` throughout its readers and domain types. That single value stands for a missing key, a malformed value, a recovered fallback, and an optional JSON property, so callers cannot tell absence from a decode policy and readers hide sentinels such as `'unknown'` and `'0.0.0'`. Option makes absence a first-class value and forces the caller to unwrap it deliberately.

## What Changes

- Convert absence-returning readers to `Option`: `readOptionalString`, `readVersion`, `readOptional`, `readJsonFile`, `findConfigPath`, `findUnsupportedConfigPath`, `findTsconfigPath`, `resolveTypeScript`, `readPackageBin`, and `resolvedVersion`.
- Drop the `fallback` parameter from `readVersion`; each caller chooses its own default at the call site.
- Convert domain fields that mean "absent" to `Option`: lockfile entry fields, manifest and previous-generation inputs, cleaned dependency sections, publication snapshots, doctor findings, doctor's generation/plan/lockfile returns, and CLI command inputs such as `configPath` and `profile`.
- Use `Option.fromUndefinedOr` at third-party and JSON boundaries, and `Option.getOrUndefined` only where an external API or serialized object requires `undefined`.
- Keep plain fallbacks for total container readers: `readStringArray`, `readStringRecord`, and `readRecord` still return `[]`, `{}`, and `{}`.
- Keep multi-state ADTs: `readStrictSection` (`absent | valid | malformed`) and `GenerationLookup` (`missing | invalid | valid`) stay unchanged.
- Keep `undefined` for process environment values, optional function parameters, internal mutable state, and third-party option bags.
- Update tests and the Effect-boundaries documentation. No CLI output, exit code, on-disk format, or validation behavior changes.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- None.

This is a pure internal type-refactor with no spec-level behavior change, so the change sets `skip_specs: true`.

## Impact

- **Code:** `packages/cli/src/internal/schema-readers.ts`, `internal/read-optional.ts`, `config.ts`, `check.ts`, `cli.ts`, `dsh.ts`, `doctor.ts`, `materialize/manifest.ts`, `materialize/program.ts`, `materialize/publish.ts`.
- **Tests:** schema-reader, config, CLI, doctor, profile, program, publish, and check tests.
- **Docs:** the Effect-boundaries note in `README.md`.
- **Dependencies:** none.
- **Compatibility:** internal TypeScript types only; no on-disk format, CLI flag, exit code, or intended diagnostic wording changes.
