## Context

This repository is greenfield: it has OpenSpec but no implementation. The target runtime is DSH `0.2.1-rc.2`, whose profile composition is an ordered stack of bundle patch layers followed by the profile patch, the harness-home patch, and invocation overlays. HMR watches the profile manifest and the two user patch files; it does not watch bundle patch files. Its public `Hmr.watchConfig` and `Hmr.reconcileProfile` APIs give us the seam needed to watch a generated layer without changing upstream DSH.

The coexist decision is already made: generated configuration is a bundle layer beneath the profile patch, so Web GUI edits, Settings writes, and machine-local overrides continue to win. The higher-level module/fragment API is deliberately out of scope. See `proposal.md` for motivation and the three capability specs for the required behavior.

## Tech Stack

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript, strict ESM (`NodeNext`) | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax` |
| Runtime | Node.js >= 24 | DSH baseline; local development is Node 26 |
| Packages | `@eedsh/config`, `@eedsh/cli`, `@eedsh/runtime` | Config API and plan; Effect-based CLI/materializer; static DSH bundle and HMR watcher |
| Package manager | pnpm 12.14.0 | `packageManager` pin; workspace |
| Build | `tsc` to `lib/` | package `exports` point at built JS and declarations |
| Effect runtime | `effect` (pinned) | Only `@eedsh/cli`: typed errors, Layers, and `ManagedRuntime`/`runPromise`; no Effect Schema, CLI, Config, or Platform; not in `@eedsh/config` or `@eedsh/runtime` |
| Formatter and linter | Biome 2.x | `biome.json`; recommended rules; single quotes, no semicolons, 100-column lines; import organization; excludes `node_modules`, `lib`, `coverage`, `openspec`, `.dsh`, and `pnpm-lock.yaml`; `pnpm format`, `pnpm format:check`, `pnpm lint`, `pnpm lint:fix` |
| Checker | `tsc --noEmit` | `tsconfig.check.json` covers `src` and `test`; `pnpm typecheck` |
| Editor baseline | `.editorconfig` | UTF-8, LF, two-space indentation, final newline |
| Tests | Vitest | `pnpm test`; the slow Web HMR test keeps a longer timeout |
| Plan validation | TypeBox | plan schema and static types |
| YAML | js-yaml with a custom `!!js` type | generated patch files |
| Watch | chokidar | `eedsh sync --watch` |
| CI | GitHub Actions | Node 24 and 26 matrix; `pnpm install --frozen-lockfile`, then `pnpm verify` |
| Local gates | `pnpm check` / `pnpm verify` | `check` = Biome check + typecheck; `verify` = check + test + build |

Biome owns formatting, linting, and import organization in one tool; `tsc --noEmit` remains the authoritative type checker. Biome is not a type-aware linter, so promise and async correctness rely on TypeScript plus tests rather than typescript-eslint rules. That trade-off is deliberate: one fast toolchain now, and a focused typescript-eslint addition only if type-aware lint rules become necessary.

Effect is adopted only in `@eedsh/cli`, where the materializer, preflight, and publication pipeline benefit from a typed error channel, dependency-injected services, and resource-safe acquisition. `@eedsh/config` and `@eedsh/runtime` declare no Effect dependency and import no Effect module; a workspace architecture test enforces that boundary. The public config API stays plain TypeScript returning plain plan data, and the runtime stays a Cordis plugin. No Effect Schema, Effect CLI, Effect Config, or Effect Platform: TypeBox, Node `fs`/`spawn`, and a plain argv parser remain the boundary implementations.

## Goals / Non-Goals

**Goals:**

- A typed TypeScript authoring surface that is a direct projection of the Loader layer model.
- A versioned, JSON-compatible plan that is the only input to materialization.
- A generated bundle that appears at the authored marker position and is bootable by vanilla `dsh`.
- Atomic, idempotent profile publication that never rewrites user-owned patch layers.
- Generated-layer reload through DSH's existing HMR queue, with restart-required outcomes reported honestly.
- A small, testable runtime bundle that survives regeneration of the generated layer.
- An Effect-based CLI/materializer confined to `@eedsh/cli`, with the public config API and runtime free of Effect.

**Non-Goals:**

- Modules, fragments, feature flags, preset helpers/extension, or generated plugin-config types.
- Project-level configuration, multiple profile surfaces, GUI manager changes, or upgrade/migration machinery.
- Hot-reloading package installation or bundle-set changes that DSH classifies as restart-required.
- Changing upstream DSH packages or the shipped `web` profile.
- Published npm packaging; the first cut may link workspace packages.
- Effect in `@eedsh/config`, `@eedsh/runtime`, the public plan, or the runtime watcher; the Effect island is confined to `@eedsh/cli`.

## Decisions

### 1. Three packages: `@eedsh/config`, `@eedsh/cli`, and `@eedsh/runtime`

`packages/config` publishes `@eedsh/config`: the public typed API, plan schema, validation, and canonicalization. It is a pure data package built on TypeScript and TypeBox, with no DSH or Effect runtime dependency. Config authors import this package; it is all their configuration needs for types and helpers.

`packages/cli` publishes `@eedsh/cli` and the `eedsh` bin. It depends on `@eedsh/config`, `@eedsh/runtime`, the pinned Effect runtime, the pinned DSH launcher and app-boot, chokidar, and js-yaml. It owns config evaluation, materialization, preflight, publication, watch orchestration, and spawning the harness. Effect is confined to this package.

`packages/runtime` publishes `@eedsh/runtime`, a normal DSH bundle package that is also the HMR watcher plugin. It has no Effect dependency.

The command stays `eedsh`; `@eedsh/cli` is its package name. The split exists so the public config package does not pull in Effect, the CLI, or DSH runtime code, and so `@eedsh/cli` can own the Effect island without leaking it into configuration.

`@eedsh/runtime` must be separate from the generated bundle because the generated bundle is replaced on every generation. Putting the watcher there would risk the watcher being replaced while it is handling the change. The materializer places the runtime bundle immediately before the generated bundle, so it is part of every eedsh-managed profile.

The runtime package is a bundle and a plugin in one package: its `cordis.patch.yml` inserts a single row named `@eedsh/runtime`, and its package entry exports the watcher plugin. The plugin imports only Node builtins and uses `ctx.hmr` and `profileContext` at runtime; DSH types are type-only dependencies.

*Alternatives considered:* a single `@eedsh/cli` package exporting both the config API and the CLI. It is rejected because config authors would install Effect and every CLI dependency just to get types, and the Effect boundary would depend on entry-point discipline rather than package structure. A separate watcher package adds packaging surface without benefit; a watcher generated into the profile is self-replacing and is rejected.

### 2. The typed API is a thin projection of Loader patches

In `@eedsh/config`, `defineProfile` returns a `ProfilePlan`. It does not hide patch semantics. The initial helpers are:

- `bundle(name, { source? })` for an ordered bundle selection.
- `generated()` for the single positional marker.
- `layer(id, patches)` for an ordered patch list.
- `insert(entry)`, `override(id, patch)`, `disable(id)`, `enable(id)`, `group(id, fields, children)`, `js(source)`, and `raw(entry)`.
- `packages` for profile-local dependency specifications.

`override` replaces the target row's whole config, matching DSH; it does not merge. `group` is a convenience over an ordinary group patch entry. No module, fragment, or preset-extension concept appears in the plan. A preset is authored as an `insert` row.

The plan is versioned independently from the `@eedsh/config` package and the DSH runtime version. `defineProfile` validates the plan when called; the CLI validates again after importing the config so raw plan exports and other future frontends receive the same checks.

*Alternatives considered:* a fluent builder or a custom DSL. Both can be added later as sugar over the same plan. Starting with a transparent object keeps the plan inspectable and makes the upper layer additive.

### 3. The generated marker is positional and belongs to the plan

`bundles` accepts at most one `generated()` entry. The plan stores it as an ordered marker; omission means the generated bundle is last among managed bundles. The materializer inserts the runtime bundle immediately before the generated bundle at that position.

A bundle placed after the marker therefore overrides generated defaults, while the profile patch still has the final word. This is the direct expression of DSH's bundle order. If the marker is placed before the bundles the generated layers patch, preflight reports the unmatched targets; strict mode fails.

The reserved names `@eedsh/runtime` and `@eedsh/generated` are rejected in authored bundles and packages. They are materializer-owned.

### 4. The generated bundle package.json is both bundle manifest and generation record

The generated bundle lives at `$DSH_HOME/profiles/<name>/.eedsh/generated/`. Its `package.json` carries:

- `name: "@eedsh/generated"`, a private local version, and `engines.dsh`;
- `dsh.bundle.patch` pointing at the generation's ordered patch files;
- an `eedsh` metadata block with generation id, plan hash, eedsh and DSH versions, ordered layer ids and hashes, and the managed bundle/package sets.

This one file is the publication record and the HMR signal. Patch files are written first under `.eedsh/generated/patches/<generationId>/<layerId>.yml`; the package manifest is written last with an atomic rename. The manifest always points at a complete generation. Old generation directories remain on disk for rollback and because a running process may still be using them.

The profile's dependency on the generated bundle is `link:./.eedsh/generated`. The target directory is stable; only its `package.json` and versioned patch files change.

*Alternatives considered:* a separate `.eedsh/generation.json` signal plus a stable patch file. Two files create a two-commit window and require the watcher to coordinate them. Making the bundle manifest the commit point gives one atomic publication boundary and reuses DSH's own bundle manifest as the record.

### 5. Patch files are versioned per generation and emitted with real YAML tags

Each layer becomes one YAML patch file. Layer ids are constrained to safe kebab-case so they can be filenames; duplicate or unsafe ids are rejected. Patch files are written with a structured YAML emitter and a custom `!!js` type, not string concatenation. Expression nodes are represented in the plan as `{ "$eedsh": { "expr": "<source>" } }` and converted to `!!js` scalars only at emission. A round-trip test through DSH's patch loader verifies the output shape.

The plan is also written as `.eedsh/plan.json` for inspection and future frontends. It is canonical JSON (sorted object keys) and is not used to compose the profile.

*Alternatives considered:* stable filenames overwritten in place. That makes a partial write visible and loses the previous generation. Versioned files cost little for profile-sized patches.

### 6. Materialization is a reconciliation of managed and user-owned state

The materializer reads the previous generated package metadata (when present) to know what eedsh managed before. It computes:

- **Managed bundles**: the plan's bundles in order, with the runtime bundle and generated bundle inserted at the marker (runtime immediately before generated; generated last among managed if no marker).
- **User-added bundles**: existing bundles not managed by the previous generation and not reserved; they are preserved after managed bundles in their previous relative order.
- **Managed packages**: the plan's packages plus the runtime and generated link specs. Previously managed packages absent from the new plan are removed. User-added dependencies are preserved, and a managed specification wins on collision.
- **Profile patch**: existing `cordis.patch.yml` is never rewritten; it is created empty only when missing. The home patch and invocation overlays are untouched.
- **Generated bundle**: versioned patch files plus the generated package manifest.

The profile manifest is written with a temporary file and rename. The generated package manifest is the final publication commit. Package installation is performed only when dependency specifications change. The profile `package.json` and lockfile are snapshotted before package operations and restored if installation or subsequent preflight fails. Extra packages left in `node_modules` are harmless because the restored manifest does not select them.

*Alternatives considered:* treating every non-plan bundle as user-owned. That makes removing a bundle from code impossible because it would be resurrected as user state. Using the previous generation's managed sets makes removal deterministic.

### 7. Preflight composes the target layers without booting plugins

Before the generated package manifest is committed, the materializer resolves every target bundle from the pinned DSH installation and the profile, reads its patch files, and composes them with the generated layers through DSH's own `composeEntries`/patch algorithm. It does not need the generated bundle to be selected in the manifest yet.

The preflight checks:

- selected bundles resolve and their patch files parse;
- generated patch entries are structurally valid;
- no duplicate row ids are inserted by the generated layers;
- unmatched id-targeted patches are reported by layer and target id;
- strict mode turns unmatched targets into a nonzero failure and skips the commit.

Plugin config schemas are not executed here; that would require importing plugins. `dsh --dump-config-schema` remains a later doctor/boot-check feature. The preflight uses the same patch algorithm as boot, so patch-target semantics cannot drift.

### 8. HMR watches the generated package manifest and reconciles through DSH

The runtime watcher resolves `profileContext.dir`, then watches `.eedsh/generated/package.json` through `ctx.hmr.watchConfig`. The watch callback runs inside HMR's exclusive queue after application readiness. It reads the `eedsh.generationId`; if it differs from the last observed id, it calls `ctx.hmr.reconcileProfile()`.

`reconcileProfile()` re-reads the complete profile patch stack through `readProfilePatches`, including all bundle layers, the profile patch, the home patch, and the invocation overlays. It then uses the normal `recomposeProfile` path, including module replacement and activation judgment. No new DSH API and no separate composition path are introduced.

The watcher is registered only inside `ctx.inject(['hmr'], ...)` and no-ops without `profileContext`. HMR-disabled surfaces therefore keep running their current composition until restart. Malformed generation records and reconciliation failures are logged; the watcher remains registered for a later valid generation. Restart-required results (`pending` modules or a `restartReason`) are logged and never presented as a hot reload.

The watcher does not evaluate TypeScript. Only a published generated package manifest triggers reload; editing the config file alone does nothing.

*Alternatives considered:* evaluating TypeScript inside a runtime plugin. That would add a TS loader and config code execution to the harness process, make config errors arrive after boot, and duplicate the preflight path. The CLI compiles; the runtime only reloads published data.

### 9. The CLI owns evaluation, publication, and boot

`@eedsh/cli` provides the `eedsh` command, resolves its pinned `@deepseek-ai/dsh`, evaluates `eedsh.config.ts` with native ESM import (Node's type stripping, erasable TypeScript only), validates the plan, and materializes the profile. The config file imports its types and helpers from `@eedsh/config`.

Commands:

- `eedsh sync [--config <path>] [--strict]`: evaluate, validate, preflight, publish.
- `eedsh sync --watch`: same, re-running on changes under the config directory; compile failures keep the last published generation and are printed.
- `eedsh run [--config <path>] [--no-sync] [-- <dsh args>]`: sync unless disabled, then spawn the pinned `dsh` with `--profile <name>` and the remaining arguments.

`run` spawns rather than imports the launcher so argv parsing, signals, environment, and shutdown stay exactly those of the pinned DSH CLI. The config directory is used for module resolution and local imports; the harness working directory stays the invoking directory.

Config evaluation uses native Node type stripping to avoid adding a runtime TS loader. The first cut assumes the config project can resolve `@eedsh/config` (for example, it is a workspace or dev dependency); `eedsh init` scaffolding is deferred.

The materializer, preflight, and publication pipeline is the Effect island. It is an `Effect` program with tagged failures, `Context.Tag` services for file access, package installation, and DSH resolution, and resource-safe acquisition for the sync lock and temporary files. One-shot commands use `Effect.runPromise`; `sync --watch` uses a `ManagedRuntime` so services are reused across runs. The CLI parser, config import, watch callback, and `run` process spawn stay plain TypeScript; Effect does not leak into their public types.

### 10. Validation is schema-first, with a JSON-compatibility walk

The plan schema is defined with a TypeScript-schema library that emits JSON Schema and static types (TypeBox is the working choice; Zod is a reasonable alternative). A separate recursive walk enforces JSON compatibility: no functions, symbols, BigInt, undefined, circular references, or class instances; expression nodes must have exactly the reserved shape. Plugin config values remain structurally opaque to the plan schema and are validated at Loader activation.

The canonical plan hash and generation id use sorted-key JSON and SHA-256. The generation id covers the canonical plan and the emitted layer hashes, so a formatting-only change in the emitter also produces a new generation.

### 11. Tests and quality gates cover contracts, not just helpers

- Unit tests: plan schema, marker position, layer ordering, whole-config replacement, raw entries, expression round-trip, canonical hash, YAML `!!js` output.
- Materializer tests: new and existing profiles, manifest merge/removal, user-added bundles/deps, profile patch byte preservation, package removal, idempotence, failure restoration, `dsh --dump-config` on a temp profile. Effect services are replaced with test `Layer`s, and tagged failures are asserted by error tag.
- Preflight tests: unmatched targets, strict failure, duplicate inserted ids, malformed patch shape.
- HMR watcher tests: registration only with HMR/profile context, generation-id dedupe, malformed record containment, restart warning, later-generation recovery. The watcher logic is factored into a small function that can be tested with a fake HMR service and temp files.
- One slow integration test boots the Web profile with `--no-open` on a free port, publishes a generation that disables a harmless row, and asserts the watcher reports an applied generation or reload. If the DSH testkit cannot boot HMR headlessly, this test uses the Web profile as the only HMR-capable surface and is marked slow.
- CLI tests: sync idempotence, watch debounce/error retention, run argument forwarding.

Quality is enforced by `pnpm check` (Biome check plus `tsc --noEmit`) and `pnpm verify` (check, Vitest, build); CI runs `pnpm verify` on Node 24 and 26.

### 12. Security and failure posture

The config is trusted executable code with the user's privileges. The plan is data: validation rejects non-JSON values, and expression source is evaluated only by DSH at boot. Generated YAML is emitted with a structured emitter. The materializer never writes the profile patch, home patch, or overlays. Package installation is trusted configuration; incompatible packages are left to DSH's normal compatibility admission where possible.

Reconciliation can partially apply a generation before failing; this change reports the failure and keeps the watcher alive rather than promising rollback. Atomic publication prevents a partial generated layer from being announced, but it does not make the whole running process transactional.

## Risks / Trade-offs

- **HMR does not watch bundle patch files** -> the static runtime watcher watches the generated bundle manifest and calls `reconcileProfile`; the generated package manifest is the single commit signal.
- **DSH HMR is prerelease API** -> pin DSH exactly and cover the watch/reconcile path with a real integration test; the runtime bundle declares an exact `engines.dsh`.
- **Reconciliation failure can leave a mixed composition** -> preflight before publication, log failures, keep the watcher registered, and document that rollback is not guaranteed.
- **Bundle/package changes may require restart** -> report `restartRequired`/pending modules and do not claim hot reload; `run` always boots fresh.
- **Generated bundle is visible in plugin-management surfaces** -> give it a clear description and `eedsh` metadata; sync restores managed selections, and a future GUI manager can recognize it. No hiding scheme in this change.
- **Profile patch overrides generated rows** -> intentional coexist; sync does not remove them. Drift detection is deferred.
- **`link:` dependencies are machine-specific** -> first cut targets the source/workspace installation; published packaging and stable specifiers are deferred.
- **`sync --watch` watches the config directory, not transitive imports outside it** -> document the limitation; a dependency-graph watcher is a later improvement.
- **Atomic rename behavior differs on Windows** -> use a tested atomic-write helper with same-directory temp files and a retry path, and cover the helper with a unit test.
- **Concurrent sync runs** -> a profile-local lock file with a clear failure message; stale-lock recovery is limited to a PID liveness check.
- **Effect adds a runtime, a large dependency, and a new paradigm** -> confine it to `@eedsh/cli`; keep `@eedsh/config` and `@eedsh/runtime` free of Effect, enforce the boundary with an architecture test, pin `effect` exactly, and wrap Node `fs`/`spawn` at the service boundary rather than adopting the wider Effect platform.

## Migration Plan

This is greenfield; no existing profile is migrated. The first successful `eedsh sync` creates `$DSH_HOME/profiles/<name>` and installs the runtime and generated bundles. If the target profile already exists, its `cordis.patch.yml` is preserved, its manifest is snapshotted, and user-added bundles/dependencies are preserved.

Rollback is manual and safe: remove `@eedsh/runtime` and `@eedsh/generated` from the profile bundle list and dependencies, or delete the eedsh-managed profile. The profile patch and other bundles remain. The generated package metadata records exactly what eedsh managed, so a later cleanup tool can reverse it.

Upgrading DSH requires updating the `@eedsh/cli` DSH pin, re-running validation, and syncing; a plan whose `dsh` pin no longer matches the pinned runtime is rejected before materialization.

## Open Questions

- Whether published `@eedsh/cli` should link `@eedsh/runtime` from its installation or install a versioned package from a registry. The first cut uses a resolved local link.
- Whether `sync --watch` should follow TypeScript imports outside the config directory. The first cut watches the config directory.
- How long old generation patch directories are retained; the first cut retains them.
- How the future GUI manager should mark managed bundles/rows. The `eedsh` metadata block is the intended hook.
- Whether `docs` should live at the repository root or per package. The first cut uses a root README plus package READMEs.
- Which internal operations should remain plain TypeScript rather than becoming Effect services. The first cut keeps config evaluation, argv parsing, file watching, and process spawning plain, and confines Effect to materialization, preflight, and publication.
