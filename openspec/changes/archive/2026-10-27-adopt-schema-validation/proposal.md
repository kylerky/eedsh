## Why

`@eedsh/config` treats an Effect Schema as the plan's single validator and type source, but the CLI still validates its other external data contracts by hand: the generation record, the tolerant profile-manifest readers, the doctor lockfile reader, and the package-manifest readers in `check`, `dsh`, and `cli`. The working tree has centralized a few guards, but the validation rules and fallback policies remain scattered, the record type can drift from its reader, and diagnostics depend on hand-written branches. Effect 4.0.6 provides `Schema.catchDecoding` and the decoding helpers, so strict and tolerant readers can share one validation idiom without changing behavior.

## What Changes

- Add an Effect Schema for the generation record and derive `GenerationLayer` and `GenerationRecord` from it; keep `GeneratedManifest` as the writer type.
- Replace `classifyGenerationRecord`'s hand-rolled field checks with one strict decode, mapping the first schema issue path to the existing `GenerationInvalidReason` and preserving the existing detail and `adoptable` values. A small Schema probe distinguishes a newer record version from a wrong one.
- Add a small shared set of Schema-backed tolerant readers using `Schema.catchDecoding` and an explicit fallback: string arrays, string records, unknown records, optional strings, package versions, and lockfile entries.
- Convert the tolerant readers in the profile-manifest reconciliation, the doctor lockfile checks, and the TypeScript/DSH/eedsh package-manifest readers, and decode the profile-manifest JSON guard and preflight layer shape strictly.
- Keep report-on-malformed readers strict: dependency-section validity, doctor's root importer and lockfile version, installed-package manifests, and the generation record itself. Do not catch a failure where the current code reports a finding.
- Stop using `asRecord` for data validation. Keep it only for tagged-error introspection, or delete remaining unused uses.
- Delete the unused `readGenerationId` export; the runtime has its own Effect-free reader.
- Add parity tests for every generation reason and `adoptable` case, and direct tests for each tolerant reader's fallback behavior. Existing materialization, doctor, and CLI behavior tests remain the acceptance contract.
- Leave the expression-node emitter guard, the config package's JSON/cycle walker, and the Effect-free `@eedsh/runtime` watcher unchanged.

## Capabilities

No capabilities are added or modified. This is a pure refactor with no spec-level behavior change, so the change sets `skip_specs: true`.

### New Capabilities
- None.

### Modified Capabilities
- None.

## Impact

- **Code:** `packages/cli/src/materialize/generated-bundle.ts`, `generation-record.ts`, `manifest.ts`, `program.ts`, `doctor.ts`, `check.ts`, `dsh.ts`, `cli.ts`, `preflight.ts`, and a new `packages/cli/src/internal/schema-readers.ts`.
- **Tests:** a new schema-reader unit test, an expanded generation-record matrix, and the existing materialization, doctor, and CLI integration tests.
- **Docs:** update the Effect-boundaries note in `README.md` if the Schema convention is documented there.
- **Dependencies:** none. `effect@4.0.6` already provides `Schema`, `SchemaGetter`, and the decoding middleware.
- **Compatibility:** no on-disk format, CLI flag, exit code, or intended diagnostic-wording change. Tolerant readers keep their current fallbacks; strict readers keep their current failure branches.
