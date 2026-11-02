## 1. Plan contract: anonymous patch groups

- [x] 1.1 Add failing schema cases to `packages/plan/test/schema.test.ts` and `packages/plan/test/validate.test.ts`: a layer with no `id` validates; two layers carrying the same legacy `id` validate; a layer whose `id` is not a string still fails. Verify with `pnpm vitest run packages/plan/test` and confirm the new cases fail for the expected reason.
- [x] 1.2 Make `id` an optional deprecated field on `PlanLayerSchema` and delete the `layerIssues` uniqueness refinement in `packages/plan/src/schema.ts`, keeping the `id` doc comment in the style of the deprecated `NamedBundle.source`. Verify the new schema cases pass and that no existing schema case regresses.
- [x] 1.3 Confirm `@eedsh/plan` exports and derived types still typecheck after the change by running `pnpm typecheck`; fix any now-unused import or narrowing error.
- [x] 1.4 Immediately use git to commit the plan-contract change, excluding `openspec/` artifacts.

## 2. Generation record: identifiers become optional

- [x] 2.1 Add failing cases to `packages/cli/test/materialize/generated-bundle.test.ts`: a built record lists layers without `id`; a legacy record whose layers carry `id` still classifies as valid through `classifyGenerationRecord`; a record whose layer has no `file` still fails. Verify with `pnpm vitest run packages/cli/test/materialize`.
- [x] 2.2 Make `GenerationLayerSchema.id` optional and deprecated, and stop emitting it from `buildGeneratedBundle` in `packages/cli/src/materialize/generated-bundle.ts`, keeping `file` and `hash` unchanged. Verify group 2.1 passes.
- [x] 2.3 Immediately use git to commit the record change, excluding `openspec/` artifacts.

## 3. Authoring surface: `layer(build)` and `layer(label, build)`

- [x] 3.1 Add failing cases to `packages/config/test/config.test.ts`: `.layer(fn)` yields a plan layer with no `id`; `.layer('lsp', fn)` also yields no `id`; both keep declaration order. Verify with `pnpm vitest run packages/config/test` and confirm the failure is the missing optional-label signature.
- [x] 3.2 Change `ProfileBuilder.layer` in `packages/config/src/builders.ts` to accept `(build)` or `(label, build)`, store the label on the builder, and stop writing `id` into `PlanLayer`. Verify group 3.1 passes and `packages/config/test/preset-definition.test.ts` stays green.
- [x] 3.3 Update `packages/config/README.md` examples to the two accepted forms and verify every code block still typechecks through `pnpm typecheck`.
- [x] 3.4 Immediately use git to commit the authoring change, excluding `openspec/` artifacts.

## 4. Per-patch site capture and the provenance registry

- [x] 4.1 Add failing unit tests in `packages/config/test/provenance.test.ts`: a builder call from the test file records that file and the call line; a call made through a helper in a second fixture file records the helper file; the registry returns the latest evaluation only; clearing removes the record. Verify with `pnpm vitest run packages/config/test/provenance.test.ts`.
- [x] 4.2 Implement `packages/config/src/provenance.ts`: a stack reader that selects the first frame outside the authoring package root (resolved from `import.meta.url` for both `lib/` and `src/`), a per-group record of label plus one site per patch, and a `Symbol.for('@eedsh/config.provenance')` global slot with clear and read accessors. Import only what the architecture test allows. Verify with `pnpm typecheck` and group 4.1 passing.
- [x] 4.3 Wire capture into every `LayerBuilder` method (`insert`, `override`, `disable`, `enable`, `raw`, `selectPreset`) so each emitted patch carries a site, and record each profile's groups at `ConfigBuilder.build()`. Verify group 4.1 passes and a `build()` with capture failure still succeeds.
- [x] 4.4 Verify the architecture boundary still holds with `pnpm vitest run test/architecture.test.ts`, and that capture adds no Node builtin import to `@eedsh/config`.
- [x] 4.5 Immediately use git to commit the provenance capture, excluding `openspec/` artifacts.

## 5. Preflight attribution over the flat patch list

- [x] 5.1 Add failing cases to the preflight suite: an unmatched target under `--explain` renders `generated #<n>` with the site when provided and with the touched row ids; a warning from a bundle keeps its `bundle:<name>` label; an empty generated group warns with the same prefix. Verify with `pnpm vitest run packages/cli/test` on the preflight tests.
- [x] 5.2 Rewrite `attributePreflightWarnings` in `packages/cli/src/preflight.ts` to recompose prefixes over the flat patch list and map the identified patch back to its group and offset, keeping the raw-message path untouched when `--explain` is absent. Verify with group 5.1.
- [x] 5.3 Replace the empty-layer warning text with the positional, site-aware form and make the duplicate-insert check operate on group positions. Verify group 5.1 passes and the strict-mode cases still fail publication.
- [x] 5.4 Measure `--explain` attribution on a config with at least 40 generated patches and record the observed time in the commit message; if it exceeds 200ms, note the fallback to group granularity as follow-up. Verify by running the measured config once.
- [x] 5.5 Immediately use git to commit the attribution change, excluding `openspec/` artifacts.

## 6. Materialization: positional files and the provenance sidecar

- [x] 6.1 Add failing cases: `buildGeneratedBundle` names files by 1-based position and lists them in order; publication writes `.eedsh/provenance.json` naming the committed generation with relativized sites; a failed commit leaves the previous sidecar bytes; an unchanged materialization writes no sidecar. Verify with `pnpm vitest run packages/cli/test/materialize`.
- [x] 6.2 Change the emitted file path in `packages/cli/src/materialize/generated-bundle.ts` to the positional name and update the manifest list accordingly. Verify group 6.1 passes.
- [x] 6.3 Add `packages/cli/src/materialize/provenance.ts` with the sidecar schema, a tolerant reader, and a writer that relativizes every site against the config directory and refuses absolute paths. Verify with `pnpm typecheck` and group 6.1.
- [x] 6.4 Extend `packages/cli/src/materialize/publish.ts` to snapshot, write, and restore the sidecar in the documented order around the generated package commit point. Verify group 6.1 passes.
- [x] 6.5 Verify the publication failure paths still restore manifest, lockfile, mirror, and sidecar with `pnpm vitest run packages/cli/test/materialize/publish.test.ts`.
- [x] 6.6 Immediately use git to commit the materialization change, excluding `openspec/` artifacts.

## 7. CLI plumbing: config evaluation carries provenance

- [x] 7.1 Add failing integration cases in `packages/cli/test/cli.test.ts`: a fixture whose patch targets a missing row prints the authoring site under `--explain`; the same fixture without `--explain` prints the raw message; a plain plan export without provenance still syncs with positional attribution. Verify with `pnpm vitest run packages/cli/test/cli.test.ts`.
- [x] 7.2 Change `loadConfig` in `packages/cli/src/config.ts` to clear the registry before the import and return the captured provenance alongside the validated config, without altering any existing failure path.
- [x] 7.3 Thread the provenance through `sync`, `doctor --config`, and the REPL evaluation call sites so preflight and publication receive it; verify no call site silently drops it by running `pnpm typecheck`.
- [x] 7.4 Verify group 7.1 passes, including a config imported twice in one process reporting the second evaluation's sites.
- [x] 7.5 Immediately use git to commit the CLI plumbing, excluding `openspec/` artifacts.

## 8. REPL: content-keyed diffs and row provenance

- [x] 8.1 Add failing cases in `packages/cli/test/repl/` (diff and views): inserting a group in the middle reports only that group as added; removing one reports only that group as removed; a composed row reports its site when known and its bundle name otherwise. Verify with `pnpm vitest run packages/cli/test/repl`.
- [x] 8.2 Match groups by the canonical JSON of their patches in `packages/cli/src/repl/diff.ts`, consuming matches in order, and print the group label when one is recorded. Verify with group 8.1.
- [x] 8.3 Build the composition `sources` map from provenance in `packages/cli/src/repl/session.ts`, falling back to the group position and then the bundle name, and render it in `packages/cli/src/repl/views.ts`. Verify groups 8.1 and 8.4 pass.
- [x] 8.4 Verify group 8.1 passes and that `packages/cli/test/repl/integration.test.ts` still reports the composed row count and warnings.
- [x] 8.5 Immediately use git to commit the REPL change, excluding `openspec/` artifacts.

## 9. Doctor leaves provenance alone

- [x] 9.1 Add failing-then-passing cases in `packages/cli/test/doctor.test.ts`: a missing, malformed, and generation-mismatched sidecar each produce no finding and exit 0, including under `--strict`; a healthy profile with a sidecar is unchanged. Verify with `pnpm vitest run packages/cli/test/doctor.test.ts`.
- [x] 9.2 Confirm no doctor code path reads the sidecar and add the explicit exclusion comment where record, plan, and mirror consistency are checked; verify group 9.1 passes.
- [x] 9.3 Immediately use git to commit the doctor change, excluding `openspec/` artifacts.

## 10. Documentation and fixture sweep

- [x] 10.1 Update the root `README.md` layer model, example configuration, migration table, and `--explain` description to the anonymous-group and site-aware forms, and verify no remaining example shows a layer id.
- [x] 10.2 Sweep fixtures and assertions that match `generated:` or `.layer('…'` text across `packages/*/test` and `test/`, updating expectations to the positional form; verify with `grep -rn "generated:" packages/ test/` returning only intentional legacy cases.
- [x] 10.3 Run `pnpm format` and `pnpm lint` and fix every finding; verify with `pnpm check`.
- [x] 10.4 Immediately use git to commit the documentation sweep, excluding `openspec/` artifacts.

## 11. Release verification

- [x] 11.1 Run `pnpm verify` and confirm typecheck, tests, and package builds all pass.
- [x] 11.2 Publish a fixture profile end to end and confirm the generated package lists `0001.yml`-style files, `.eedsh/provenance.json` names the committed generation, and `eedsh doctor --profile` reports no findings.
- [x] 11.3 Confirm a profile published by the previous release still passes `eedsh doctor --profile` before its next sync, proving the deprecated identifiers stayed readable.
- [x] 11.4 Run `pnpm test:slow` and confirm the Web-profile HMR integration still reconciles a new generation.
