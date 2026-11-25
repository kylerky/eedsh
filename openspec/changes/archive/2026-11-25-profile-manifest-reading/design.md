## Context

See `proposal.md` — Why. The current shape matters for the approach: `readJsonFile` in `materialize/program.ts` returns `Option<Record<string, unknown>>`; `materialize/manifest.ts` re-navigates that value in twelve of its sixteen functions; `doctor.ts` parses the same file twice with its own tolerance; `repl/session.ts` has a third reader and `repl/views.ts` a fourth copy of the string-record rule. A document that parses but is not an object becomes `Option.none()`, which materialization reads as a first run.

Constraints carried into the design:

- The profile manifest is user-owned. Fields eedsh does not manage, and their order, must survive a rewrite byte-stably; `publishProfile` writes it with `JSON.stringify(manifest, null, 2)`.
- Publication stays atomic: the snapshot/restore transaction around the manifest, lockfile, plan mirror, and provenance sidecar is unchanged.
- Doctor's existing finding wording is asserted in tests. Missing, invalid, and conflict findings keep their text; only the malformed-section finding is refined (D5).
- Effect 4.0.6 is pinned, the CLI is the only effectful package, and reading goes through the `FileSystem` service so tests can provide a memory filesystem.
- The repository already solves this document class twice: `classifyGenerationRecord`/`lookupGenerationRecord` for the generation record and `decodeInstallationAnchor` for the installation anchor.

## Goals / Non-Goals

**Goals:** one classified read of the profile manifest; one typed interpretation computed in that read; `invalid` never treated as `missing`; no entry silently discarded where eedsh rewrites; the manifest-specific helper layer deleted.

**Non-Goals:**

- The generation record and lockfile readers, which are already classified or out of scope.
- The installation-anchor and DSH package-manifest readers (`readPackageManifest`), which read a different document with different rules.
- `init`'s reader for a project manifest it is about to create.
- Reporting the shape of advisory conflict sections (`peerDependencies`, `overrides`, `resolutions`, `pnpm.overrides`); their entries are read tolerantly and only managed-name conflicts are reported.
- Changing the plan format, the generation record, publication ordering, or the generated manifest.

## Decisions

### D1. A dedicated `materialize/profile-manifest.ts`, not another shared helper

The reader lives beside `generation-record.ts` and mirrors its structure: a schema for the document's shape, one classified lookup, and a typed record. Doctor already imports from `materialize/`, and the REPL can too.

Alternative rejected: extend `internal/schema-readers.ts`. Those are generic tolerant leaves (`readRecord`, `readOptionalString`, …) used by preflight, bootstrap, and the anchor reader; the policy for a foreign document belongs with the document's owner, otherwise the policy stays implicit in each caller's choice of helper.

### D2. Two decodes: keep the parsed document, decode the fields separately

`Schema.fromJsonString(Schema.Unknown)` turns the file text into the parsed document without hand-rolled `JSON.parse`/`Effect.try`; it fails exactly on malformed JSON. A second `Schema.decodeUnknownResult` over a struct of tolerant field codecs produces the typed view. Its only failure mode is a root that is not an object, which is the `not-an-object` classification.

The document is kept raw because `Schema.StructWithRest` — the obvious one-value alternative — reorders keys: declared fields first, then unknown ones. Verified against this document: an input ordered `name, type, scripts, custom, dsh, dependencies` decodes to `name, dsh, dependencies, type, scripts, custom`. A rewritten user-owned `package.json` would then show a spurious diff. The raw parse also preserves order exactly.

Nested tolerance is still declared: `dsh` and `dsh.profile` use nested structs whose unknown keys survive, and a non-object `dsh` falls back to `{}` through `Schema.catchDecoding`, matching the "tolerates absent or non-object sections" requirement.

Alternatives rejected: a single `StructWithRest` decode (key reordering); a closed strict struct (drops fields eedsh does not manage, breaking round-trip).

### D3. `ManifestRead = missing | invalid | valid` mirrors `GenerationLookup`

`invalid` carries a stable reason (`unparseable`, `not-an-object`) and a detail. File-system failures stay in the `PlatformError` channel, as `lookupGenerationRecord` does: the channel describes whether the bytes could be read, the classification describes what they meant.

Alternative rejected: keep `Option<Record>` and add a separate `invalid` boolean. The conflation of absence with unreadability is the defect; a boolean restores it one call site at a time instead of removing it from the type.

### D4. Four section states, classified once, worded by consumers

Each list or section is `absent | valid | partially readable | malformed`, with unreadable entries named by key or index. `partially readable` is the state the old strict decoder collapsed into `malformed`: an object whose readable entries are usable while some values are not package specifications. Classification happens in the reader, so no consumer indexes the raw document.

The reader returns data, not messages. Sync and doctor word the same fact differently today ("left unchanged" versus "eedsh sync leaves it unchanged") and both texts are asserted, so wording stays with each consumer, consistent with `failureDetail` in `generation-record.ts` owning its detail strings.

### D5. An unreadable entry is preserved and reported; an unreadable section is left alone

For `devDependencies` and `optionalDependencies`, a section that is not a JSON object keeps today's behavior: left unchanged and reported. An entry inside an object whose value is not a package specification string is now preserved verbatim and reported, while readable managed names are still removed. For `dependencies`, which must always declare the managed specifications, a non-object section is rebuilt and the loss is reported, and an unreadable non-managed entry is preserved verbatim and reported.

Rationale: dropping an entry is unrecoverable, and silent dropping is what the change exists to remove. Preserving can make `pnpm install` reject the profile, but publication already snapshots and restores every profile file on install failure, so the profile cannot be corrupted and the warning names the offending entry.

Alternative rejected: drop unreadable entries and report them. The report does not restore a dependency the user wrote by hand, so the next successful run silently changes the installed set.

### D6. `invalid` fails materialization through a closed tagged failure

A new `ProfileManifestInvalid` joins `MaterializeError` in `internal/effect/errors.ts`, carrying the path, reason, detail, and recovery text. `describeError`'s `Match.tagsExhaustive` will not compile without its arm, so the diagnostic cannot be forgotten.

No adoption path: `--adopt-ownership` re-baselines from the same manifest, so it cannot help when that manifest is unreadable. `createdProfile` becomes `true` only for `missing`.

### D7. Consumers read once

Doctor reads the manifest once at the top and passes the classification to both `checkManifest` and `checkSources` instead of parsing twice. The REPL's `PublishedSnapshot` carries the classification, so an unreadable manifest renders as unusable rather than absent.

### D8. Delete only the helpers this document needed

`readStringRecord` is used solely by `manifest.ts` and goes with its tests. `readRecord` and `readStringArray` stay for preflight, the DSH bootstrap, the generation record, and the anchor reader. `readJsonFile` is replaced by the new reader; `planMirrorIntact` keeps its own parse because it compares JSON semantics for a plan document, not the profile manifest.

## Risks / Trade-offs

- **Key-order regression** → keep the parsed document as the rewrite base and add a round-trip test with unusual key order; the module doc states why the document is not decoded through the schema.
- **`eedsh sync` now refuses a malformed manifest** where it previously overwrote it → the diagnostic names the path, the reason, and the recovery (fix or delete the file); the bytes are untouched, and tests cover both invalid reasons and the still-working first run.
- **Doctor's malformed-section finding changes from section-level to entry-level** → keep the missing, invalid, and conflict wording byte-identical; update the one malformed-section test and add a partially-readable case.
- **The typed view is closed** → adding a field a consumer needs is one line in the view plus a test; the alternative is the unbounded string-key access this change removes.
- **Preserved unreadable dependencies can fail `pnpm install`** → publication's snapshot/restore already guarantees no partial state, and the warning names the entry so the failure is explainable.
- **Test churn** → concentrated in `packages/cli/test/materialize/profile.test.ts` (the tolerant-reader block), `publish.test.ts` fixtures, and the platform-parse-error contract test in `internal/effect.test.ts`.

## Migration Plan

Each phase is a commit that leaves `pnpm verify` green:

1. **Reader.** Add `materialize/profile-manifest.ts` and its tests, encoding the current tolerance but classifying it. No consumer changes.
2. **Reconciliation.** Migrate `manifest.ts` and `publish.ts` to the typed view and land the D5 entry policy. Behavior changes only for unreadable entries.
3. **Consumers.** Migrate `program.ts`, `doctor.ts`, and the REPL; add `ProfileManifestInvalid` and its reporter arm. This is the only phase that changes what users see for an invalid manifest.
4. **Cleanup.** Delete the dead helpers, update module documentation, and confirm the architecture checks still pass.

Rollback is per commit; phases 1–2 are additive, and phase 3's behavior change is isolated to the materialization entry point and doctor findings.
