## 1. CLI anchor record schema and decoder

- [x] 1.1 Add failing cases in `packages/cli/test/installation-anchor.test.ts` for `decodeInstallationAnchor`: a full record, required fields only, malformed JSON, a non-object root, format 2, missing/relative/non-`package.json` `installAnchor`, wrong types and empty strings for the optional fields, extra fields dropped, and a combined-invalid record whose first reason must be the relative `installAnchor`. Run `pnpm vitest run packages/cli/test/installation-anchor.test.ts`; verify the new cases fail because the CLI decoder is not exported.
- [x] 1.2 Add `InstallationAnchorSchema` and `decodeInstallationAnchor` to `packages/cli/src/installation-anchor.ts` using `Schema.Struct`, `Schema.Literal(INSTALLATION_ANCHOR_FORMAT)`, `Schema.NonEmptyString`, the manager literal union, and ordered path refinements. Parse JSON with `Result.try`, decode once with `Schema.decodeUnknownResult(..., { errors: 'first' })`, and map the first issue path to the existing reasons. Replace the runtime `decodeInstallationAnchor` import with the local decoder for `readInstallationAnchorSnapshot`; run the anchor test and verify all cases pass.
- [x] 1.3 Reuse the runtime `INSTALLATION_ANCHOR_FORMAT` and `InstallationAnchor` type, and annotate the decoder/schema so the schema output is assignable to the runtime record type; run `pnpm typecheck` and verify it passes.
- [x] 1.4 Immediately use path-scoped git commands to commit only the CLI schema, decoder, and tests, excluding `openspec/`; verify `git show --stat` lists only those files.

## 2. Switch the CLI to its decoder and retire the runtime reader

- [x] 2.1 Switch `packages/cli/src/init.ts` to import `decodeInstallationAnchor` from `./installation-anchor`; update any CLI test imports; run `pnpm vitest run packages/cli/test/installation-anchor.test.ts packages/cli/test/init.test.ts packages/cli/test/dsh.test.ts` and verify they pass.
- [x] 2.2 In `packages/runtime/test/installation-anchor.test.ts`, remove the decode and `readInstallationAnchorFile` imports/cases, rewrite the read-back cases with `readFile` plus `JSON.parse`, and add an assertion that the module namespace no longer exports `decodeInstallationAnchor`, `validateInstallationAnchorValue`, or `readInstallationAnchorFile`. Run `pnpm vitest run packages/runtime/test/installation-anchor.test.ts`; verify only the removal assertion fails.
- [x] 2.3 Remove the read-side exports, `InstallationAnchorDecode`, and the helpers/imports that become unused from `packages/runtime/src/installation-anchor.ts`; update the module doc to state that decoding and validation live in the CLI. Run the runtime anchor test; verify the removal assertion and the remaining path/encode/write/cleanup cases pass.
- [x] 2.4 Run `pnpm vitest run packages/runtime/test/installation-anchor.test.ts packages/runtime/test/startup.test.ts packages/cli/test/installation-anchor.test.ts packages/cli/test/init.test.ts`; verify all pass, then immediately use path-scoped git commands to commit the CLI/init switch and the runtime cleanup, excluding `openspec/`; verify `git show --stat` lists only the intended CLI, runtime, and test files and no `openspec/` paths.

## 3. Schema-backed package manifest reading

- [x] 3.1 Add failing cases for `readNonEmptyString` in `packages/cli/test/internal/schema-readers.test.ts` covering a non-empty string, an empty string, a missing value, and a non-string; run `pnpm vitest run packages/cli/test/internal/schema-readers.test.ts` and verify they fail because the reader is not exported.
- [x] 3.2 Add `readNonEmptyString` to `packages/cli/src/internal/schema-readers.ts` using `Schema.NonEmptyString`; run the schema-reader test and verify it passes.
- [x] 3.3 Add characterization cases in `packages/cli/test/installation-anchor.test.ts` for a string `bin`, an object `bin`, a malformed `bin` falling back to `main`, a malformed `main` falling back to `lib/bin.js`, invalid JSON, and a non-object document; run the anchor test and verify the cases pass against the current reader.
- [x] 3.4 Convert `readPackageManifest`, `installationFromManifestAnchor`, and `resolveLauncherEntry` in `packages/cli/src/installation-anchor.ts` to the Schema record plus leaf readers, and update `packages/cli/src/dsh-discovery.ts` to read `name` through `readOptionalString`; run `pnpm vitest run packages/cli/test/installation-anchor.test.ts packages/cli/test/dsh.test.ts` and verify the cases pass with unchanged messages.
- [x] 3.5 Immediately use path-scoped git commands to commit the manifest and schema-reader changes, excluding `openspec/`; verify `git show --stat` lists only the intended source and test files.

## 4. Schema-backed pnpm metadata reading

- [x] 4.1 Add characterization cases in `packages/cli/test/dsh-bootstrap.test.ts` for an array of roots with one valid root, a malformed root beside a valid one, a malformed dependency group beside a valid one, a missing/empty/non-string `path`, a non-string `version`, and a scalar root; run `pnpm vitest run packages/cli/test/dsh-bootstrap.test.ts` and verify they pass against the current reader.
- [x] 4.2 Convert `parsePnpmCandidates` in `packages/cli/src/dsh-bootstrap.ts` to decode each root, dependency group, and DSH entry with `Schema.Record`/`Schema.Struct`, remove `isObject`, keep JSON parsing in `Result.try`, and preserve "skip malformed, keep valid siblings." Run `pnpm vitest run packages/cli/test/dsh-bootstrap.test.ts packages/cli/test/dsh-command.test.ts packages/cli/test/integration/first-sync-bootstrap.test.ts` and verify all pass.
- [x] 4.3 Immediately use path-scoped git commands to commit the bootstrap source and test changes, excluding `openspec/`; verify `git show --stat` lists only those files.

## 5. Documentation and final verification

- [x] 5.1 Update `packages/runtime/README.md` so the `installation-anchor` subpath is described as the path, format, encoder, and atomic writer, and note that decoding and validation live in the CLI; verify the text still says the runtime has no Effect dependency.
- [x] 5.2 Run `pnpm typecheck` and `pnpm test`; verify both exit 0, including `test/architecture.test.ts`.
- [x] 5.3 Run `pnpm check` and `openspec validate adopt-schema-anchor-inputs --strict`; verify both exit 0 and that the change is valid with `skip_specs: true`.
- [x] 5.4 Immediately use path-scoped git commands to commit the README and any final fixes, excluding `openspec/`; verify `git status --short` contains only the OpenSpec change artifacts.
