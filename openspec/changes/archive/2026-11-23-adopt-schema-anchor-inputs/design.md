## Context

See `proposal.md` - Why. The constraints that shape the approach:

- The anchor record is written by both the CLI (sync and `init --dsh`) and the runtime (profile boot), but it is read only by the CLI: `readInstallationAnchorSnapshot` and `init.ts`. The runtime's `decodeInstallationAnchor`, `validateInstallationAnchorValue`, and `readInstallationAnchorFile` have no production callers inside the runtime.
- `@eedsh/runtime` must remain Effect-free. `test/architecture.test.ts` rejects an `effect` dependency or import, and the runtime README promises no Effect dependency.
- The anchor record is an eedsh-owned, strict contract: format 1, an absolute `package.json`, optional provenance, and user-facing rejection reasons pinned by tests.
- A DSH `package.json` is foreign and tolerant: a malformed `bin` or `main` currently falls back, while the name and version checks carry specific messages.
- pnpm global metadata is foreign and tolerant: malformed roots, dependency sections, and entries are skipped, and valid siblings survive.
- The archived `adopt-schema-validation` change established the strict/tolerant reader idioms in `internal/schema-readers.ts`; the anchor flow landed afterwards and did not use them.
- The architecture test forbids new `throw`/`try` sites in CLI production source. JSON parsing stays inside `Result.try`/`Effect.try`, and the anchor/bootstrap modules remain on the exception allowlist for filesystem and JSON adapters.

## Goals / Non-Goals

**Goals:**

- Move the anchor-record decode and validation into the CLI as an Effect Schema, leaving the runtime as the Effect-free record owner and writer.
- Preserve every current decode reason, validation order, tolerant fallback, and on-disk format.
- Decode the DSH package manifest and pnpm metadata with `effect/Schema` instead of hand-written `typeof`/object walks.
- Move the record-codec tests to the package that owns the codec and pin the remaining behavior.

**Non-Goals:**

- Converting the remaining hand-rolled readers in the REPL, preview, and provisioning modules.
- Changing the runtime Effect boundary, adding an Effect dependency to the runtime, or bundling Schema into the plugin.
- Changing the anchor path, record format, CLI flags, exit codes, or intended diagnostic wording.
- Fixing the unrelated stale `$DSH_HOME/.eedsh/installation.json` wording in the `dsh-installation-anchor` spec.

## Decisions

### D1. The CLI owns the anchor record codec; the runtime stays a writer

The CLI is the only production reader, and validation already happens there in `validateRecordedInstallation`. Move the record decode into `packages/cli/src/installation-anchor.ts` and keep the shared data in `packages/runtime/src/installation-anchor.ts`:

- Runtime keeps `INSTALLATION_ANCHOR_FORMAT`, `INSTALLATION_ANCHOR_PARTS`, `InstallationAnchor`, `installationAnchorPath`, `encodeInstallationAnchor`, the atomic writers, and the retired-location cleanup.
- Runtime removes `InstallationAnchorDecode`, `validateInstallationAnchorValue`, `decodeInstallationAnchor`, `readInstallationAnchorFile`, and the helpers that become unused with them.
- CLI defines the decode result type and `decodeInstallationAnchor(text)`; `readInstallationAnchorSnapshot` and `init.ts` import it locally. The existing `{ ok, anchor } | { ok: false, reason }` shape is retained to keep the snapshot and init call sites unchanged.

*Alternatives.* Keeping the codec in the runtime would require amending `effect-runtime-boundary` and bundling `effect/Schema` into the plugin and CLI (roughly 76 KB minified / 24 KB gzip for the schema and decoder, versus a 7.9 KB anchor module today). A runtime CLI-only schema subpath would split the module but still require a boundary change and more packaging for no functional gain. The CLI already has Effect and is the reader, so moving the codec there is the smallest change that satisfies the convention.

### D2. Strict record schema, field order, and the existing reasons

Define `InstallationAnchorSchema` with `Schema.Struct`:

- `format`: `Schema.Literal(INSTALLATION_ANCHOR_FORMAT)`.
- `installAnchor`: `Schema.NonEmptyString` plus `isAbsolute` and `basename(...) === 'package.json'` refinements.
- `version`, `recordedBy`, `recordedAt`: optional `Schema.NonEmptyString`.
- `launcher`: optional `Schema.NonEmptyString` plus an `isAbsolute` refinement.
- `manager`: optional `Schema.Union([Schema.Literal('pnpm'), Schema.Literal('npm')])`.

`decodeInstallationAnchor` parses JSON with `Result.try`, then performs one `Schema.decodeUnknownResult(InstallationAnchorSchema, { errors: 'first' })`. It maps the first issue path to the existing reason and formats the values that the current messages include (the raw `format`, `installAnchor`, `launcher`, and `manager`) from the parsed record. The field order in the struct matches the current validation order, so a record with several defects reports the same first defect as today. Extra fields are ignored and dropped by the struct, matching the current normalized output.

The path refinements keep the current precedence: a relative `installAnchor` is reported before a bad `version`, and a non-`package.json` anchor is reported before a bad `launcher`. `recordedAt` stays a non-empty string; do not tighten it to a timestamp.

*Alternatives.* Decoding the shape strictly and then checking paths as plain domain code would change the precedence when a record has both a bad path and a bad later field. Putting every rule in one struct with ordered refinements preserves the existing first-reason behavior and keeps all type validation in Schema. `Schema.fromJsonString` would own JSON parsing too, but it would change the current "not valid JSON (<native message>)" wording; keeping the parse adapter preserves it.

### D3. Manifest reading uses Schema leaf readers, not a whole-document struct

`readPackageManifest` parses the file with `Result.try` and decodes the document with `Schema.Record(Schema.String, Schema.Unknown)`. Invalid JSON or a non-object returns `undefined`, preserving the existing "cannot read a DSH manifest" branch.

`installationFromManifestAnchor` reads fields independently:

- `name`: `readOptionalString`; a value other than `@deepseek-ai/dsh` keeps the current message with `JSON.stringify` of the raw value.
- `version`: the new `readNonEmptyString`; an absent, empty, or non-string value keeps "declares no DSH version".
- `bin`: a local union of `Schema.String` and `Schema.Struct({ dsh: Schema.String })`; a malformed shape falls back exactly as today.
- `main`: `readOptionalString`; a non-string or absent value falls back to the default launcher.

Keep the existing order (read, name, version, launcher) and the `existsSync` check on the resolved entry. `dsh-discovery.packageAnchorForLauncher` uses `readOptionalString(manifest.name)` for its ancestor walk.

*Alternatives.* A single strict manifest struct would reject a malformed `bin` or `main` that currently falls back, and would collapse the distinct "not a DSH package", "no version", and "no launcher" messages. Leaf readers keep the tolerant behavior and the messages, consistent with `internal/schema-readers.ts`.

### D4. pnpm metadata is decoded per root, group, and entry

Keep the existing container normalization (an object or an array of roots). Decode each root, each dependency group, and each DSH entry independently with Schema:

- Root: `Schema.Record(Schema.String, Schema.Unknown)`.
- Group: `Schema.Record(Schema.String, Schema.Unknown)`.
- Entry: `Schema.Struct({ path: Schema.NonEmptyString })`; excess properties are ignored. The entry's `version` is not used for selection today, so it must not make an otherwise usable entry disappear.

Malformed JSON yields no candidates; a malformed root, group, or entry is skipped while valid siblings are kept. The manifest remains the authority for the selected version. Remove the local `isObject` helper.

*Alternatives.* One strict root struct would fail the whole root when one dependency group is malformed, losing valid siblings that the current code keeps. One strict entry struct with a required `version` would change today's behavior for non-string versions.

### D5. Tests move with the codec and pin the tolerance

- Move the record decode cases from `packages/runtime/test/installation-anchor.test.ts` to `packages/cli/test/installation-anchor.test.ts`; the runtime keeps path, encode, write, and cleanup coverage.
- Add a table of record reasons, including malformed JSON, non-object, wrong format, missing/relative/non-`package.json` anchor, bad optional fields, extra fields, and a combined-invalid precedence case.
- Add manifest cases for string `bin`, object `bin`, malformed `bin` falling back to `main`, malformed `main` falling back to `lib/bin.js`, invalid JSON, and a non-object document.
- Add pnpm cases for an array of roots, a malformed root beside a valid one, a malformed dependency group beside a valid one, a non-string or empty `path`, and a non-string `version`.
- Add `readNonEmptyString` cases to `packages/cli/test/internal/schema-readers.test.ts`.
- Existing CLI anchor, discovery, init, and bootstrap tests remain the acceptance contract.

### D6. Documentation and boundaries

Update `packages/runtime/README.md` so the `installation-anchor` subpath is described as the path, format, encoder, and atomic writer; note that decoding and validation live in the CLI. The root README already states that CLI external contracts are decoded with `effect/Schema`, so it needs no change. `test/architecture.test.ts` needs no change: the runtime stays Effect-free and the CLI already imports Effect. The change declares `skip_specs: true` because no requirement changes.

## Risks / Trade-offs

- **Reason wording drifts while mapping schema issues** -> Reuse the exact existing strings and pin every reason, including the combined-invalid precedence case.
- **Schema strictness rejects a record the old validator accepted** -> Keep provenance optional, use the format literal, ignore extra fields, and test absent/empty/wrong-type values.
- **Manifest tolerance changes** -> Use leaf readers rather than a strict document struct; test malformed `bin` and `main` fallbacks.
- **pnpm sibling tolerance is lost** -> Decode each root, group, and entry independently; test mixed valid/invalid shapes.
- **Removing runtime exports breaks an unknown caller** -> The package is private; grep `packages` and docs for the exported names, confirm only tests and the CLI use them, and update the README and tests.
- **The schema type drifts from `InstallationAnchor`** -> Reuse `INSTALLATION_ANCHOR_FORMAT` and add a compile-time assignability check between the schema's output and the runtime type.
- **JSON parse failures become schema failures** -> Keep `JSON.parse` in `Result.try` and format the native message, preserving the current reason.
- **New exception sites violate the architecture test** -> Use `Result.try` for parsing and keep filesystem wrapping in the already-allowlisted modules.

## Migration Plan

1. Add the CLI schema, decoder, and record tests, and switch `readInstallationAnchorSnapshot` in the same commit; keep the runtime exports for `init.ts` until the next step.
2. Switch `init.ts` to the CLI decoder, delete the runtime read-side exports and unused helpers, trim the runtime tests, and run the CLI and runtime anchor/init tests plus `pnpm typecheck`.
3. Convert the manifest reader and `dsh-discovery`; run the anchor and discovery tests.
4. Convert the pnpm metadata reader; run the bootstrap tests.
5. Update the runtime README, run `pnpm check` and `pnpm test`, and verify no format, path, message, or exit-code change.

Rollback is a revert of the refactor. The on-disk anchor format and path do not change, so records written before and after remain compatible. No data migration or dependency change is required.

## Open Questions

None.
