## 1. The classified reader

- [x] 1.1 Add failing tests in `packages/cli/test/materialize/profile-manifest.test.ts` covering the four read outcomes against a memory filesystem (missing file, malformed JSON, a non-object document, a valid object); verify the suite fails because the module does not exist
- [x] 1.2 Implement `readProfileManifest` and the pure `parseProfileManifest` in `packages/cli/src/materialize/profile-manifest.ts` returning `missing | invalid | valid` with reasons `unparseable` and `not-an-object`; verify 1.1 passes and that a file-system read failure still surfaces as a platform failure rather than as absence
- [x] 1.3 Add failing tests for the typed view: the managed bundle list, the three dependency sections, the conflict sections, a partially readable section that names its unreadable entries, a malformed section that does not block the others, and non-object `dsh`/`dsh.profile` sections treated as empty; verify they fail
- [x] 1.4 Implement the field decode and the single-pass section classification; verify 1.3 passes
- [x] 1.5 Add tests asserting that the document preserves unmanaged fields and their key order, and that reading performs no writes; verify they pass
- [x] 1.6 Verify `pnpm typecheck` and `pnpm test packages/cli/test/materialize/profile-manifest.test.ts`
- [x] 1.7 Immediately use git to commit the reader excluding openspec artifacts

## 2. Reconciliation and materialization read the view

- [x] 2.1 Add failing tests in `packages/cli/test/materialize/profile.test.ts`: an unreadable non-managed `dependencies` entry is preserved verbatim and reported, a non-object `dependencies` section is rebuilt from the managed specifications and reported, and a partially readable `devDependencies` loses its managed name while keeping and reporting the unreadable entry; verify they fail
- [x] 2.2 Change `ReconcileManifestInput.manifest` to `Option<ProfileManifest>`, read the typed sections in `materialize/manifest.ts`, and implement the entry policy; verify 2.1 passes
- [x] 2.3 Add `ProfileManifestInvalid` to `MaterializeError`, migrate `materialize/program.ts` to `readProfileManifest`, and make an invalid manifest fail closed while `createdProfile` stays true only for a missing manifest; write the reporter arm and verify new tests for both invalid reasons (nonzero exit, untouched bytes, no published generation) and for the still-working first run
- [x] 2.4 Make `publishProfile` compare the previous view's sections with the reconciliation result instead of re-parsing the built manifest; verify `packages/cli/test/materialize/publish.test.ts` passes and no second parse of the built manifest remains
- [x] 2.5 Rewrite the "tolerant profile readers" block in `profile.test.ts` as classification tests and update the fixtures in `publish.test.ts`; verify `pnpm test packages/cli/test/materialize` passes
- [x] 2.6 Verify `pnpm typecheck`
- [x] 2.7 Immediately use git to commit the reconciliation changes excluding openspec artifacts

## 3. Doctor and the REPL share the classification

- [x] 3.1 Add failing tests: doctor reports the same reason as materialization for a non-object manifest, reads the profile manifest once per diagnosis, and names an unreadable dependency entry; the REPL view reports an invalid manifest as unusable rather than absent; verify they fail
- [x] 3.2 Read the manifest once at the top of doctor's diagnosis and pass the classification to `checkManifest` and `checkSources`, keeping the missing, invalid, and conflict finding text byte-identical; verify the doctor suite passes
- [x] 3.3 Carry the classification into `PublishedSnapshot`/`PublishedProfileView`; verify the REPL suites pass
- [x] 3.4 Verify `pnpm test packages/cli/test/doctor.test.ts packages/cli/test/repl`
- [x] 3.5 Immediately use git to commit the doctor and REPL changes excluding openspec artifacts

## 4. Remove the helper layer

- [x] 4.1 Delete `manifestField`, `readStrictSection`, `conflictValue`, `readStringRecord` and its test block, plus the REPL's `stringRecord` and `manifestPackageSpecs`; verify no references remain and `pnpm typecheck` passes
- [x] 4.2 Update the module documentation that describes the old reader; verify no reference to `readJsonFile` remains under `packages/cli/src` or in `README.md`
- [x] 4.3 Run `pnpm verify` and confirm the architecture checks still pass
- [x] 4.4 Immediately use git to commit the cleanup excluding openspec artifacts
