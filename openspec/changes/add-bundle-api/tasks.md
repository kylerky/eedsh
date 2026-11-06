## 1. Package boundary and skeleton

- [x] 1.1 Add `packages/bundle` with `package.json`, `tsdown.config.ts`, `tsconfig`, `README.md`, and the repository MIT license reference; verify `pnpm --filter @eedsh/bundle build` emits `lib/index.js` with declarations and `pnpm --filter @eedsh/bundle pack --dry-run` lists the expected files.
- [x] 1.2 Add a smoke test that imports the package from a clean temporary project with no DSH or eedsh installation; verify the import and public declarations resolve.
- [x] 1.3 Immediately use git to commit the package scaffolding excluding OpenSpec artifacts.

## 2. Patch authoring API

- [x] 2.1 Add failing tests for `defineBundlePatch`, `insert`, `override`, `disable`, `enable`, `raw`, `group`, and `js`, covering plain data normalization and call order. Verification: the new suite fails for the expected reasons.
- [x] 2.2 Implement the synchronous builder and helpers; verify 2.1 passes and no DSH installation, bridge, Effect, or network is required.
- [x] 2.3 Add a test that the exported surface contains no profile selection, generated-layer marker, package/source declaration, bundle query, or preset selection; verify the assertion passes.
- [x] 2.4 Immediately use git to commit the authoring API excluding OpenSpec artifacts.

## 3. YAML emission and artifact checks

- [x] 3.1 Add failing tests for the top-level array, groups with `isolate`, `!!js` expressions, authored order, deterministic bytes, a generated-file header, and rejection of `$eedsh` nodes. Verification: the emission suite fails before implementation.
- [x] 3.2 Implement the emitter with the vendored `tag:yaml.org,2002:js` schema; verify the emitted YAML parses with DSH's entry-list schema and repeated emission is byte-identical.
- [x] 3.3 Add failing tests for `writeBundlePatch` and `checkBundlePatch`: written bytes, no write on check, drift detection, actionable mismatch output, and no partial target on failure. Verification: the artifact suite fails before implementation.
- [x] 3.4 Implement atomic writing and the check operation; verify 3.3 passes and a stale file fails without modification.
- [x] 3.5 Immediately use git to commit the emitter and artifact checks excluding OpenSpec artifacts.

## 4. Structural validation and diagnostics

- [x] 4.1 Add failing tests for a non-array `insert`, an inserted entry without `name` or `group: true`, a targeted patch without a non-empty `id`, a non-string `name`, invalid `group`/`disabled` values, and malformed expression nodes. Verification: the validation suite fails before implementation.
- [x] 4.2 Implement the structural validation and actionable diagnostics; verify 4.1 passes and no file is written on failure.
- [x] 4.3 Add a test proving an unmatched override target is accepted because composition belongs to DSH; verify the test passes.
- [x] 4.4 Immediately use git to commit the validation and diagnostics excluding OpenSpec artifacts.

## 5. eedsh integration and dogfooding

- [x] 5.1 Delegate the CLI's patch YAML emitter to the new package and update its imports; verify the existing materialization and YAML tests pass and generated profile bytes are semantically unchanged.
- [x] 5.2 Replace `packages/runtime/cordis.patch.yml` with an artifact generated from a committed TypeScript definition; verify the emitted file is byte-identical to the previous semantics and `pnpm verify` plus the DSH matrix pass.
- [x] 5.3 Immediately use git to commit the CLI integration and runtime dogfooding excluding OpenSpec artifacts.

## 6. Compatibility fixtures and plain-DSH acceptance

- [x] 6.1 Add a fixture plugin whose definition covers rows, groups with `isolate`, presets, disabled rows, and `!!js` expressions; verify the generated YAML parses with DSH's entry-list schema and produces the expected rows.
- [x] 6.2 Add a plain-DSH integration test that installs the fixture as a normal bundle in a temporary profile, starts without eedsh's runtime or generated layer, and observes the fixture's rows. Verification: the test passes against the supported DSH matrix.
- [x] 6.3 Add checks that the plugin manifest has no `@eedsh/*` runtime or peer dependency, no eedsh manifest field, and the YAML has no `$eedsh` node or eedsh-generated bundle name; verify the checks fail when any is introduced.
- [x] 6.4 Immediately use git to commit the compatibility fixtures and checks excluding OpenSpec artifacts.

## 7. Documentation and migration guide

- [x] 7.1 Write the package README: install, definition example, build-script example, emit/write/check usage, the commit-and-check rule, the plain-DSH compatibility contract, Node/ESM support, and the distinction from a runtime DSH bundle. Verification: every code sample compiles or is exercised by a test.
- [x] 7.2 Add a plugin-authoring section to the repository documentation and a migration note for `dsh-superagent`: move the hand-written rows to a TypeScript definition, commit the generated file, keep the existing DSH-loader test, and add the drift check. Verification: the documented commands match the package scripts.
- [x] 7.3 Immediately use git to commit the documentation excluding OpenSpec artifacts.

## 8. Release and publication

- [x] 8.1 Set the package version to `0.1.0`, remove `private`, set `publishConfig.access` to `public`, copy the repository MIT license into the package, and verify `pnpm pack` contents contain only the built entry, declarations, README, and license with no private eedsh dependency.
- [x] 8.2 Verify publish readiness without publishing: pack the tarball, inspect its manifest and files, and record that the repository owner will perform the final `npm publish`. Do not run `npm publish`. Verification: the tarball's package metadata and file list are correct.
- [x] 8.3 In a clean project with no eedsh checkout, install the packed tarball, typecheck a consumer, define and emit a patch, and verify the output parses with DSH's entry-list schema. Verification: the clean-project check passes.
- [x] 8.4 Immediately use git to commit any version, metadata, or documentation changes outside OpenSpec artifacts.

## 9. Verification and archive

- [ ] 9.1 Run `pnpm verify`, the external DSH matrix, and `openspec validate add-bundle-api --strict`; fix actionable failures.
- [ ] 9.2 Mark completed tasks, archive `add-bundle-api` only after 8.2 and 8.3 pass, and verify `openspec status --change add-bundle-api` reports all artifacts complete.
