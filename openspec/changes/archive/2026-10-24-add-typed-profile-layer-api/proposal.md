## Why

DSH profiles are composed from ordered bundle patch layers plus user-owned patch files, but configuring them means hand-writing YAML patch lists. eedsh needs a code-first configuration substrate before it can become an opinionated distribution. This change adds that substrate for the original DSH layer model and its hot-reload behavior, while deliberately postponing the higher-level module/feature API.

## What Changes

- Add a pnpm workspace with `@eedsh/config` (typed API and plan), `@eedsh/cli` (the `eedsh` command and Effect-based materializer), and `@eedsh/runtime` (the profile bundle and HMR watcher).
- Establish the shared quality gate: Biome formatting/linting, strict TypeScript checking, Vitest, `pnpm check`/`pnpm verify`, and a CI workflow.
- Adopt Effect-TS only inside `@eedsh/cli` for typed failures, dependency-injected services, and resource-safe publication; keep `@eedsh/config` and `@eedsh/runtime` free of Effect.
- Add `defineProfile`, a typed TypeScript API over DSH's profile layers: ordered bundles, a positional `generated()` marker, ordered generated patch layers, profile-local package dependencies, and patch helpers that mirror Loader semantics (`insert`, `override`, `disable`, groups/isolate, names, and `!!js` expressions).
- Emit a versioned, JSON-compatible profile plan as the contract between the typed API and the materializer. The plan is validated before publication.
- Materialize the plan into a normal DSH profile: a local generated bundle package with ordered patch files, a reconciled `package.json` bundle list and dependencies, an untouched `cordis.patch.yml`, and a generation record published atomically.
- Keep the allowed coexist model: generated configuration is a bundle layer beneath the profile patch, home patch, and `--patch` overlays, so Web GUI edits and machine-local overrides continue to win.
- Add a static `@eedsh/runtime` bundle whose HMR watcher observes the published generated bundle manifest and calls DSH's profile reconciliation, so patch-layer changes can reload through the existing HMR queue.
- Add the `eedsh sync`, `eedsh sync --watch`, and `eedsh run` commands. `run` boots the pinned vanilla DSH launcher against the materialized profile.
- Cover the plan API, materialization merge rules, atomic publication, HMR reload, and coexist behavior with tests, the Biome/TypeScript quality gate, and user documentation.

**Out of scope for this change:**

- The Doom-style module/fragment API, preset helpers and `extends`, generated plugin-config types, project-level config, GUI manager augmentation, multiple profile surfaces, and upgrade/migration machinery.
- Hot-reloading package installation or bundle-set changes that DSH reports as requiring a restart.
- Changes to upstream DSH packages or the shipped `web` profile.
- Published npm distribution mechanics; the first cut may link workspace packages.
- Effect in `@eedsh/config` or `@eedsh/runtime`, or as a public configuration model.

## Capabilities

### New Capabilities

- `typed-profile-layering`: the TypeScript authoring API and its versioned JSON plan, including bundle ordering, the positional `generated()` marker, patch-layer semantics, expressions, and validation.
- `generated-profile-materialization`: turning a profile plan into a bootable DSH profile, including the generated bundle, manifest and dependency reconciliation, coexist preservation, and atomic/idempotent publication.
- `generated-layer-hmr`: reloading a published generated layer through DSH's HMR service, including the static runtime bundle, generated-manifest watch, full-layer reconciliation, and behavior when HMR is unavailable.

### Modified Capabilities

- None. This repository has no existing capabilities.

## Impact

- **New packages**: `packages/config` (`@eedsh/config`: typed API, plan schema, validation), `packages/cli` (`@eedsh/cli`: `eedsh` command, config loading, Effect-based materializer, preflight, publication), and `packages/runtime` (`@eedsh/runtime`: bundle and HMR watcher).
- **Dependencies**: exact `@deepseek-ai/dsh` runtime pin; a YAML emitter that can represent DSH's `!!js` scalars; a JSON-schema-capable validator for the plan; `chokidar` for `sync --watch`; Effect-TS pinned in `@eedsh/cli`; Biome for formatting/linting; TypeScript for strict type checking; Vitest for tests. The runtime bundle declares an exact DSH engine and type-only HMR compatibility.
- **Toolchain**: Biome 2.x for formatting/linting, `tsc --noEmit` for checking, Vitest for tests, and a GitHub Actions CI matrix running `pnpm verify` on Node 24 and 26.
- **Filesystem**: creates or updates `$DSH_HOME/profiles/<name>/` with `package.json`, `cordis.yml`, a generated `.eedsh/generated/` bundle whose manifest records the generation, and `.eedsh/plan.json`. It creates `cordis.patch.yml` only when missing and never overwrites it.
- **CLI**: new `eedsh` command from `@eedsh/cli`; `dsh --profile <name>` remains the boot path, so the profile stays usable by vanilla DSH.
- **Upstream behavior**: no DSH code changes. The generated bundle is a normal bundle and will appear in plugin-management surfaces.
