## Context

The root README is 336 lines. Its current order is Requirements, Packages, Effect boundaries, Quick start (which begins with `pnpm install` / `pnpm build`), Config authoring, The layer model, What `eedsh sync` writes, Coexist contract, CLI, Hot reload, Development, Repository layout, Deferred.

The sources of truth for the rewrite are `packages/cli/src/cli.ts` (command surface and flags), `packages/cli/src/doctor.ts` (doctor checks and exit codes), `packages/cli/src/materialize/publish.ts` (publication order and restore), `packages/config/src/api.ts` (authoring helpers), and the root README's example blocks.

`packages/cli/README.md` is the npm-facing README for the binary. It was last updated before `doctor`, the authoritative plan, and the native error format: it lists only `sync`/`check`/`run`, calls `.eedsh/plan.json` the validated plan, says validation errors print `path: message`, names `@effect/cli`, and calls published packaging deferred.

The README's full example is copied into `packages/cli/test/fixtures/readme/eedsh.config.ts`; the two differ only by the `// eedsh.config.ts` header. No test reads the README, so editing the documentation does not fail a test.

`@eedsh/cli` and `@eedsh/config` are not published yet. This change writes the documentation for the published state; package metadata and release automation are a separate concern.

## Goals / Non-Goals

**Goals:**

- A public root README whose first actionable content is installation and CLI usage.
- An install path that works for a typed config: global CLI plus project-local `@eedsh/config`.
- A runnable quick start and a fuller reference configuration.
- A CLI reference that matches `eedsh --help` and the subcommand help, including `sync --explain`.
- A `@eedsh/cli` package README that matches the shipped command surface, profile layout, publication guarantees, and exit codes.
- README examples that are the single source of truth and are tested directly.
- Build-from-source and development material moved to the end.

**Non-Goals:**

- Publishing packages, changing `private`/`version`/metadata, or adding release automation.
- Rewriting `packages/config/README.md` or `packages/runtime/README.md`; only the CLI package README is in scope.
- Changing CLI, config, or runtime behavior.
- Adding a docs build/script or a general Markdown linter.
- Changing the example plan or the canonical JSON/hash constants.
- Adding an automated guard for the CLI help text.

## Decisions

### 1. Section order

Target order: Install, Quick start, CLI reference, Example configuration, Configuration reference, How it works, Architecture, Build from source, Development, Repository layout, Deferred.

Rationale: an ordinary user reaches a working command in the first screen; internals and the contributor workflow follow. Alternative considered: keep Packages near the top because it explains the project - rejected because it is package-internal detail, not a user task.

### 2. Install framing

Use the published commands, with no pre-release caveat:

    npm install -g @eedsh/cli
    npm install --save-dev @eedsh/config

The second command runs in the project that holds `eedsh.config.ts`. A global CLI's copy of `@eedsh/config` is not on the config's module resolution path, so the local install is required for the typed API. `typescript` is added when the user wants `eedsh check`, which runs the project's `tsc`.

Alternative considered: lead with a build-from-checkout pointer (Option B) - rejected by the user. The README is written for the release state; the release process is assumed to publish the packages.

### 3. Two configuration examples

- **Quick start:** a minimal, runnable config using `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `generated()`, `override('agent-default-model', ...)`, and `disable('repeat-tool-reminder')`. It has no profile-local package, so a first `eedsh sync` succeeds without extra setup.
- **Example configuration:** the fuller reference, keeping `packages` + `insert` + `js` from the current README. It stays plan-identical to the pinned plan - same profile name, package spec, bundles, layer order, and patch order - so the canonical JSON and hash constants do not move.

Alternative considered: one example only. Rejected because the quick start must run as written, while the reference must show the helper surface.

### 4. CLI reference ownership

The CLI reference is the only place that documents `check`; Configuration reference links to it. The synopsis is:

    eedsh sync   [--config <path>] [--strict] [--watch] [--explain] [--adopt-ownership]
    eedsh doctor [--profile <name> | --config <path>] [--strict]
    eedsh check  [--config <path>] [-- <tsc args>]
    eedsh run    [--config <path>] [--no-sync] [-- <dsh args>]

`--explain` is documented as sync-only warning attribution, with the raw-warning default and the hint behavior.

### 5. Package README scope

`packages/cli/README.md` is the npm-facing reference for the binary. It stays package-scoped: command surface, `doctor`, profile layout, publication guarantees, sync locking, preflight, and limitations. It does not duplicate the root README's install, quick start, or authoring guide; it adds one line pointing there.

Reconcile it against the live CLI and the root README:

- add `doctor [--profile <name> | --config <path>] [--strict]` and `sync --adopt-ownership`, and keep `sync --explain`;
- replace the `path: message` exit-code text with Effect's native formatted schema message and add the doctor, check, and run exit behavior;
- show `.eedsh/plan.json` as a mirror and `.eedsh/generated/plans/<generationId>.json` as the authoritative plan;
- state the actual commit order, same-id repair, and failure restore in the publication guarantees;
- note that managed entries are cleaned from every dependency section and conflicts are reported;
- remove the deferred-packaging limitation, correct `@effect/cli` to `effect/cli`, and add the root-README pointer.

Alternative considered: shrink the package README to a pointer at the root README - rejected because npm users land on the package page and need the command/profile detail there.

### 6. README as the example source

The README is the only source for both examples. A shared helper in `test/support/readme.ts` extracts the first `ts` block under a heading and writes it to a unique module under `test/.tmp/`. It imports the module through Vitest's existing transform, accepts the default export as a plan or a `Result`, validates it with `validatePlan`, returns the plan, and removes the temporary directory in `finally`.

Vitest maps `@eedsh/config` to `packages/config/src/index.ts`, so the temporary module uses source and the test works on a fresh checkout before `pnpm build`. No separate tsx invocation or import rewrite is part of the primary path.

The CLI tests evaluate `## Quick start` and `## Example configuration`; the config hash test evaluates the full example and keeps the existing canonical JSON and hash constants. `packages/cli/test/fixtures/readme/eedsh.config.ts` is deleted. The fixture and the README can no longer disagree because there is no fixture.

Alternatives considered:

- **Fixture parity** - copy/test comparison: rejected because it leaves two sources and does not test the documentation itself.
- **Generate the README from the fixture** - rejected because it adds a docs build/script.
- **tsx + `loadConfig`** - rejected as the primary path because the temporary module would resolve `@eedsh/config` to `lib/` unless the import is rewritten, and it couples the docs test to the CLI loader. It remains the fallback if Vitest cannot transform a runtime-written module.
- **Hash-only comparison** - rejected because it would not validate the example code.

### 7. Move technical prose, do not rewrite it

The layer model, what `sync` writes, publication guarantees, ownership, hot reload, and Effect-boundary sections keep their current wording and examples. Only their headings and order change. This limits review noise and avoids reintroducing claims that no longer match the code.

### 8. Verification

There is no new Markdown lint or docs build. Verification compares the root README against the live command surface (`node packages/cli/lib/bin.js --help` and each subcommand help), compares the package README against `cli.ts`, `doctor.ts`, and `publish.ts`, runs the README-derived plan tests and the hash test with `pnpm test`, checks internal anchors and build-command placement with `grep`, and leaves `pnpm typecheck` green. A temporary mutation of a plan value in the README must fail the hash test; that proves the test reads the documentation, not a fixture.

## Risks / Trade-offs

- **Install commands assume the release publishes the packages** -> the proposal records this boundary; the README is written for the release state, and package publication is a prerequisite outside this change.
- **Two examples can drift from each other** -> the quick start deliberately omits `packages`; the reference stays identical to the pinned plan, which the hash test enforces.
- **Moving large sections can drop or duplicate prose** -> move blocks verbatim, then compare the section inventory and run `git diff` before each commit task.
- **Internal anchor links can break when headings move** -> verify every `#...` link target during final verification.
- **The CLI reference can drift again** -> the synopsis is verified against `--help` in this change; an automated guard is deliberately out of scope.
- **The package README is the npm landing page** -> keep it current in the same pass and link to the root README instead of duplicating the guide.
- **The runtime-written module may not be transformed** -> write it under the Vitest root, clean up in `finally`, and use the mutation check to prove the primary path; fall back to `loadConfig` with the source-import rewrite only if needed.
- **Heading/fence extraction is fragile** -> fail loudly with the heading name and keep the helper small.
- **The hash constants move only with the plan** -> the mutation check demonstrates the failure, and the constants stay unchanged for this rewrite.

## Migration Plan

Docs and tests only. No migration. Rollback reverts `README.md`, `packages/cli/README.md`, `packages/cli/test/cli.test.ts`, `packages/config/test/plan/hash-parity.test.ts`, `test/support/readme.ts`, and restores the deleted fixture.
