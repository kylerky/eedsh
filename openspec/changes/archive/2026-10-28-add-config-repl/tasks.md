## 1. Resolution anchor and pinned default

- [x] 1.1 Write failing tests: a query with no `EEDSH_DSH_ANCHOR` fails with a structured failure naming the variable; a query with a valid anchor resolves from the pinned installation; a profile copy of an in-box bundle is ignored.
- [x] 1.2 Implement the anchor read, the pinned resolver, and the structured failure, and set/restore `EEDSH_DSH_ANCHOR` around the config import in `loadConfig`; verify the anchor tests and the existing config tests pass.
- [x] 1.3 Immediately use git to commit the anchor and pinned resolver, excluding openspec artifacts.

## 2. Explicit roots

- [x] 2.1 Write failing tests for `{ profile }` (installed copy, profile without the bundle, unknown profile) and `{ packageDir }` (absolute, relative to the config file, missing manifest, directory without `dsh.bundle`), plus the both-roots rejection.
- [x] 2.2 Implement the two roots and their failure codes, and expose the resolved package path and version so the session can print provenance; verify the root tests pass.
- [x] 2.3 Add an integration test where `config.ts` queries in-box and custom rows through both root forms and the plan validates and composes in preflight; verify it passes.
- [x] 2.4 Immediately use git to commit the explicit roots, excluding openspec artifacts.

## 3. Session layer and command

- [x] 3.1 Write failing tests for the session: an annotated expression, a binding persisting across entries, an awaited expression, profile selection, and loading the authoring package from the config directory.
- [x] 3.2 Implement the session layer, the bindings, profile selection, and the basic `eedsh repl` command; verify the session tests pass and the banner prints the resolved package path.
- [x] 3.3 Write failing tests for save-triggered reload: a patch addition reports the diff and composed row count, an invalid save keeps the previous plan, and `.reload` retries after a failure.
- [x] 3.4 Implement the watcher-driven reload, canonical plan diffing, and the composition summary; verify the reload tests pass.
- [x] 3.5 Immediately use git to commit the session layer, excluding openspec artifacts.

## 4. Preview resolution

- [x] 4.1 Write failing tests: `.resolve` prepares the hash-keyed directory, installs the exact spec, prints the path and profile-root override, and leaves `config.ts` naming only `{ profile }`; a failed install is structured and keeps the previous evaluation; two sessions with the same key serialize.
- [x] 4.2 Implement the preview cache (hash key, per-key lock, `.resolve`), the profile-root override used only for session evaluation, and provenance output for preview-sourced queries.
- [x] 4.3 Write failing tests for cache reuse and cleanup: a reused key skips the install, a stale key is not reused, and a missing package directory fails before evaluation.
- [x] 4.4 Implement reuse checks and age-based cleanup; verify no profile file is written by `.resolve` or `.reload`.
- [x] 4.5 Immediately use git to commit preview resolution, excluding openspec artifacts.

## 5. Sync in the session

- [x] 5.1 Write failing tests for `.sync`: an unchanged generation reports up to date without writing, a patch-only change publishes and reports the generation, lock contention is reported, an install failure keeps the prompt usable, and a bundle/package change reports restart required.
- [x] 5.2 Implement `.sync` through the existing materialize program with the session's evaluated plan, plus outcome, failure, lock, and restart-required formatting.
- [x] 5.3 Write failing tests for continuous mode: `--sync` syncs on a valid save, skips an invalid config, pauses after a failure until a changed save, and `.sync off` returns to inspection.
- [x] 5.4 Implement continuous sync by reusing the debounced watch loop and the pause rule, and show the mode in the banner.
- [x] 5.5 Write failing tests for preview-baked publish verification: an identical re-evaluation deletes the preview and reports the bootstrap complete; a divergent re-evaluation reports the divergence and keeps the preview.
- [x] 5.6 Implement the post-publish re-evaluation, plan comparison, preview deletion, and divergence reporting.
- [x] 5.7 Immediately use git to commit in-session sync, excluding openspec artifacts.

## 6. Command polish, documentation, and gate

- [x] 6.1 Write failing tests for the shell commands: `.help` lists built-ins and session commands, `.exit` ends the session, an unknown dot word reports an invalid command, and prompt output stays readable while a sync prints.
- [x] 6.2 Implement the remaining dot-command registrations, prompt repainting, and the non-TTY session test; verify the tests pass.
- [x] 6.3 Implement `--eval` as a one-shot evaluation with a printed value and a non-zero exit on failure; verify both paths.
- [x] 6.4 Document `eedsh repl`, the query roots, the preview bootstrap, and continuous sync in the README; verify the documented example matches a test fixture.
- [x] 6.5 Run `pnpm verify` and `openspec validate add-config-repl --strict`; verify both pass, then immediately use git to commit the polish and docs, excluding openspec artifacts.
