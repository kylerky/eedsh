## Context

See `proposal.md` - Why. The constraints that shape this refactor:

- Effect is pinned at `4.0.6`. `@eedsh/config` uses `effect/Schema` as the plan's validator and type source; `@eedsh/cli` already uses the full Effect runtime, including `Result`, `FileSystem`, and `effect/cli`.
- Effect 4.0.6 provides `Schema.decodeUnknownResult`, `Schema.decodeUnknownOption`, `Schema.catchDecoding`, `Schema.withDecodingDefault`, and `SchemaGetter`. Strict and tolerant decoding can therefore share one validation idiom.
- The current working tree has already centralized `asRecord` in `packages/cli/src/internal/record.ts` and `messageOf` in `internal/error-message.ts`; those are deduplication changes, not Schema adoption. This design builds on them and does not revert them.
- The generation record is a strict external contract: an invalid record must remain invalid and map to the existing `GenerationInvalidReason`, detail text, and `adoptable` decision. It must not be "repaired" by a fallback.
- Several profile and lockfile readers are intentionally tolerant: malformed sections, non-string bundle/dependency entries, non-object lockfile sections, and non-string package versions currently degrade to empty values or defaults. Those behaviors are pinned by tests and must survive.
- The profile manifest is both read and written. A whole-document tolerant schema would strip unknown fields and could change `buildManifest` output, so tolerant reads must remain views over the raw manifest.
- `@eedsh/runtime` must remain Effect-free; it keeps its own generation-id reader. `@eedsh/config` keeps its narrower import boundary, so Effect-based tolerant helpers belong in the CLI.
- The architecture test forbids new `throw`, `try`, and `.catch` sites in config and CLI production source. JSON parsing remains inside `Effect.try`/`Result.try` adapters.
- A previous exploration of Effect 4.0.6 found that `Schema.withDecodingDefault` did not compose cleanly with transformed array/record schemas. The design therefore relies on leaf helpers and explicit fallbacks rather than nesting defaults through transformed containers.

## Goals / Non-Goals

**Goals:**

- Use one Schema-based validation idiom for strict and tolerant CLI readers.
- Derive `GenerationLayer` and `GenerationRecord` from a single generation-record schema so the type and validator cannot drift.
- Preserve the existing generation reasons, detail strings, `adoptable` values, tolerant fallbacks, and doctor findings.
- Remove hand-rolled `typeof`/`Predicate.isObject` data checks from the targeted readers without changing their external behavior.
- Keep the change testable in small, behavior-pinning increments.

**Non-Goals:**

- Changing the generation format, profile layout, CLI flags, exit codes, or intended diagnostic text.
- Rebuilding the profile manifest as a decoded object. The raw manifest remains the write source.
- Rewriting the config package's JSON/cycle walker or the plan schema. They are already Schema refinements.
- Rewriting the expression-node emitter guard in `materialize/yaml.ts`; that safety net can be consolidated in a later change.
- Adding Schema to `@eedsh/runtime` or changing its watcher.
- Replacing the tagged-error formatter with Schema unions. `asRecord` remains appropriate for inspecting an unknown thrown value's `_tag`.

## Decisions

### D1. The generation schema lives beside the record writer and constants

Add `GenerationLayerSchema`, `GenerationRecordSchema`, and a narrow `GenerationManifestSchema` (the reader view: `{ name, eedsh }`) to `packages/cli/src/materialize/generated-bundle.ts`. Derive `GenerationLayer` and `GenerationRecord` with `Schema.Schema.Type`; keep `GeneratedManifest` as the writer-facing interface because the reader does not consume `version`, `private`, `description`, `engines`, or `dsh.bundle.patch`.

The schema uses `Schema.Literal(GENERATION_VERSION)` so the derived type keeps the literal `1`. It keeps extra manifest fields tolerated through the default excess-property behavior, matching the current reader. Policy checks that need custom messages (plan hash, non-empty managed sets, required runtime/generated bundles) are Schema filters.

*Alternatives.* A new `generation-schema.ts` would mirror the plan's `schema.ts` layout, but it would require moving or re-exporting the record constants and creates churn without a second consumer. A full `GeneratedManifestSchema` would validate fields the reader does not trust and could reject otherwise usable records; the narrow reader view is deliberate.

### D2. Strict decode with an issue-path-to-reason mapping

`classifyGenerationRecord` performs one `Schema.decodeUnknownResult(GenerationManifestSchema, { errors: 'first' })` and maps the first issue path to the existing reason:

| Issue path | Reason |
| --- | --- |
| `[]` | `unparseable` |
| `['name']` | `name` |
| `['eedsh']`, `['eedsh', 'format']` | `format` |
| `['eedsh', 'version']` | `version` |
| `['eedsh', 'generationId']` | `generation-id` |
| `['eedsh', 'planHash']` | `plan-hash` |
| `['eedsh', 'layers', ...]` | `layers` |
| `['eedsh', 'bundles', ...]` | `bundles` |
| `['eedsh', 'packages', ...]` | `packages` |
| any other `eedsh` field | `format` |

The reader keeps the current precedence: name and format errors are decided before later fields; the schema's field order plus `errors: 'first'` preserves that. The existing detail strings are retained. For the newer-version rule, the reader probes the raw `eedsh.version` with a small Schema (`Schema.decodeUnknownOption` over a `{ eedsh: { version: Schema.Unknown } }` view) and only then compares the number; this keeps the decision Schema-based and avoids `typeof`. A newer version remains `adoptable: false`; a wrong or unsupported version remains adoptable.

The unused `readGenerationId` export is deleted. It has no production or test callers, and `@eedsh/runtime` cannot import Effect and keeps its own reader.

*Alternatives.* Decoding fields one at a time would preserve messages more mechanically but reintroduces the scattered checks this change removes. Decoding `version` as `Schema.Number` and checking afterwards would lose the literal type and complicate precedence. Catching generation-record failures would turn a corrupt ownership record into a silent fallback and violate the fail-closed contract.

### D3. Tolerant readers are Schema-backed leaf helpers

Add `packages/cli/src/internal/schema-readers.ts` with a small wrapper and the readers the CLI actually needs:

- `tolerant(schema, fallback)`: `Schema.catchDecoding(() => Effect.succeed(Option.some(fallback)))`.
- `readStringArray(value)`: `Schema.Array(lenientString)`, keeping only non-undefined items, with `[]` for a non-array.
- `readStringRecord(value)`: `Schema.Record(Schema.String, lenientString)`, keeping only string values, with `{}` for a non-object.
- `readRecord(value)`: `Schema.Record(Schema.String, Schema.Unknown)`, with `{}` for a non-object.
- `readOptionalString(value)`: `Schema.optional(Schema.String)` with `undefined` for a wrong type.
- `readVersion(value, fallback)`: `Schema.String` with the caller's fallback for missing/wrong values.
- `readLockfileEntry(value)`: the lockfile entry struct with `readOptionalString` fields and `{}` for a non-object.

The helpers use `Schema.decodeUnknownOption` and never throw. Per-value catches plus an outer filter implement "drop invalid siblings"; a catch around the whole array or record would lose valid entries. The helpers are CLI-only because `catchDecoding` requires Effect; `@eedsh/config` keeps its narrower imports.

*Alternatives.* Keeping the current `typeof`/`asRecord` loops would not provide the consistency requested and leaves validation rules in several modules. A single tolerant schema per document is attractive, but the profile manifest is a write target and a whole decode would strip unknown fields; nested defaults also proved fragile with transformed arrays/records in 4.0.6. A generic "tolerant everything" wrapper would hide which failures are intentionally recovered, so each reader names its fallback.

### D4. Strict diagnostic boundaries stay strict

These readers decode without a catch and map the failure to the existing finding or classification:

- The generation record.
- `readStrictSection` in the profile manifest: `Schema.Record(Schema.String, Schema.String)`; absence stays absent, any decode failure stays `malformed`, and the warning text is unchanged.
- Doctor's profile-manifest object check, lockfile outer object, root importer, lockfile version, and installed-package manifest.
- `program.ts`'s profile-manifest JSON guard: a non-object still yields `undefined`, not an empty record.
- `preflight.ts`'s generated-layer shape: a non-array or non-object patch entry still fails with the existing layer-specific message.

These are the readers where a malformed value produces a doctor finding, an ownership failure, or a preflight failure. Catching there would change behavior from "report" to "pretend it is fine".

*Alternative.* Using tolerant helpers everywhere would simplify call sites but would erase the distinction between a diagnostic and a fallback, which is the core contract of the generation record and doctor findings.

### D5. `asRecord` remains only for tagged-error introspection

After the data readers move to Schema, `internal/record.ts` is still used by the CLI error formatter to inspect an unknown thrown value's `_tag`/fields. That is not data validation: the value is already a tagged error object, and a Schema union of every error class would add coupling without improving the diagnostic. The module doc is narrowed accordingly. If a remaining data use is found during implementation, it is replaced with a reader; the module is deleted only if no use remains.

`internal/error-message.ts`, `internal/read-optional.ts`, and `internal/sha256.ts` are unrelated to this change and are left untouched.

### D6. Reader conversions and their exact fallbacks

- `manifest.ts`: `readProfileBundles`, `readProfileDependencies`, the conflict recorder, `childRecord`, and `readStrictSection` use the new helpers or strict decode. The raw manifest remains the `buildManifest` input.
- `doctor.ts`: importers/dependencies/entries and the manifest object use Schema; root importer, lockfile version, and installed package keep their current failure branches. `scanDependencyConflicts` keeps shared with sync.
- `check.ts`: `version` and `bin` decode through `readVersion` and a small Schema union; a missing or wrong `bin` still yields `undefined`.
- `dsh.ts` and `cli.ts`: package versions use `readVersion` with the existing `'unknown'`/`'0.0.0'` fallbacks.
- `program.ts`: the profile manifest shape check uses a strict `Schema.Record` decode result; parse failures keep the existing `PlatformError` mapping.
- `preflight.ts`: generated-layer top-level shape uses a strict `Schema.Array(Schema.Record(Schema.String, Schema.Unknown))`; `checkNoPlanExpression` and `insertedIds` use `readRecord` for record detection. The expression-policy walk remains.

### D7. Tests pin both sides of the boundary

- A new `packages/cli/test/internal/schema-readers.test.ts` covers undefined, null, scalars, arrays, objects, mixed arrays/records, partial lockfile entries, and version fallbacks.
- `packages/cli/test/materialize/generation.test.ts` gains a parity matrix for every reason and `adoptable` value, extra manifest fields still ignored, empty package keys rejected, missing `eedsh`/`dsh` versions, string/fractional/newer versions, and layer/package malformations.
- Existing reconciliation, publication, doctor, preflight, program, and CLI tests remain the behavior contract; no existing test is weakened.
- The architecture test must still pass: no new throw/try sites and no Effect in the runtime.

### D8. Document the boundary

If `README.md`'s Effect-boundaries section names the Schema convention, add one sentence: external data contracts and tolerant readers are decoded with `effect/Schema`; the runtime and the config JSON/cycle walker remain exceptions. Do not restate implementation details.

## Risks / Trade-offs

- **A catch-based reader can mask a future schema error** -> Pin every fallback with direct helper tests and reader-level tests; keep diagnostic boundaries strict.
- **`withDecodingDefault` and transformed containers compose poorly in 4.0.6** -> Use optional/default values at the leaf and explicit coalescing; test each combination. Do not rely on nested defaults.
- **Missing keys are struct-level, not field-level** -> Call leaf readers on `parent?.[key]` or use explicit optional/default handling; test absent sections.
- **Catching a whole array/record would lose valid siblings** -> Catch at the value level, then filter; test mixed valid/invalid input.
- **A decoded read view could be written back** -> Keep tolerant schemas read-only; `buildManifest` continues to use the raw manifest.
- **Diagnostic text drifts** -> Keep the existing detail table and doctor messages; pin them with tests. The generation reason and `adoptable` values are part of the contract.
- **Schema type inference becomes noisy around `catchDecoding`** -> Give the helper return types explicitly and keep each schema small; keep the readers in one module.
- **The working tree contains unrelated uncommitted helper consolidation** -> Base this change on the current tree, do not revert it, and stage only the Schema refactor files.
- **Preflight error mapping loses the layer id** -> Decode with the layer id in scope and map root/index failures to the existing messages; test malformed array and entry cases.

## Migration Plan

1. Add the tolerant helpers and their unit tests first; verify they reproduce the current `stringArray`, `stringRecord`, `asRecord(...) ?? {}`, version, and lockfile-entry behavior.
2. Add the generation schemas, derived types, strict decode, and reason mapping; run the expanded generation matrix.
3. Convert the tolerant readers module by module, running the existing reconciliation, doctor, and CLI tests after each.
4. Convert the strict readers and preflight shape checks, preserving their failure branches.
5. Remove `readGenerationId` and update `internal/record.ts`'s doc/uses.
6. Run `pnpm check` and `pnpm test`; update the README boundary note if applicable.

No persisted format changes, no data migration, no dependency changes. Rollback is a revert of the refactor; existing profiles remain readable by both the old and new readers.

## Open Questions

None.
