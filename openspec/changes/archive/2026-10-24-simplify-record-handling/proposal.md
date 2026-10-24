## Why

The profile manifest write path packs three different intents into one expression — narrowing an unknown JSON node, defaulting to an empty record, and copying it — while the same loose record guard is redefined in three CLI modules. The copy is redundant because the manifest is already a private deep clone, and the default policy (a malformed `dsh` or `dsh.profile` section is replaced, not preserved) exists only in code. This change names that policy once, reuses Effect's record predicate, and records the tolerance contract in the materialization spec.

## What Changes

- Replace the local loose object guards in `@eedsh/cli` with `isRecord` from `effect/Predicate` (identical semantics: non-null, non-array).
- Introduce one named accessor for "read a manifest child as a record, or an empty record" so the empty-record policy has a single definition.
- Rewrite `buildManifest` to construct the reconciled manifest as a value instead of mutating a clone with per-level spreads; keep `structuredClone` so the result stays independent of the caller's object.
- Codify the existing manifest tolerance behavior in the `generated-profile-materialization` capability: absent or non-record `dsh` and `dsh.profile` sections are treated as empty and replaced, while object sections keep their other fields and have only managed values replaced. The delta is additive; no existing requirement text changes and no runtime behavior changes.
- Extend the `isRecord` sweep to `check.ts` and `cli.ts` where the check is exactly the loose guard; leave `config.ts` (thrown-array formatting differs), the runtime watcher (Effect is forbidden), and the config plan boundary's prototype-strict `isPlainObject` untouched.

**Not breaking.** Reconciliation, publication, generation identifiers, and HMR behavior are unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `generated-profile-materialization`: adds an explicit requirement for absent or malformed `dsh` and `dsh.profile` manifest sections during reconciliation. This is an additive delta; no existing requirement is rewritten.

## Impact

- **Code**: `packages/cli/src/materialize/manifest.ts` (guard, accessor, write path), `packages/cli/src/preflight.ts` and `packages/cli/src/materialize/program.ts` (guard), plus `packages/cli/src/check.ts` and `packages/cli/src/cli.ts` for the same exact substitution. Runtime, config, and their specs are unaffected.
- **Dependencies**: no new package; `effect/Predicate` is a subpath of the existing Effect dependency.
- **APIs**: no public API change. `reconcileManifest` keeps its signature and result shape.
- **Tests**: characterization tests for malformed manifest sections; the existing reconciliation tests remain the behavioral contract.
