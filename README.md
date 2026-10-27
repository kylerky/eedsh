# eedsh

Typed, code-first configuration for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) profiles.

eedsh turns a TypeScript file into a normal DSH profile: an ordered bundle stack, a
generated patch layer at the position you choose, reconciled dependencies, and a
generation record that `dsh` boots like any other profile. DSH itself is untouched;
its own patch precedence, plugin manager, and HMR keep working.

## Install

eedsh runs on Node.js >= 26; Node 24 and earlier are not supported. It also needs
`pnpm` on `PATH`, because `eedsh sync` runs pnpm's install command whenever a
profile's dependencies change.

Install the CLI globally and the typed authoring API in the project that holds
`eedsh.config.ts`:

```sh
npm install -g @eedsh/cli
# in the project that holds eedsh.config.ts
npm install --save-dev @eedsh/config
```

`eedsh check` runs the project's own compiler, so install TypeScript there too:

```sh
npm install --save-dev typescript
```

You do not need a separate DSH install: `@eedsh/cli` pins
`@deepseek-ai/dsh@0.2.1-rc.2` and runs that launcher.

## Quick start

```ts
// eedsh.config.ts
import {
  bundle,
  defineProfile,
  disable,
  generated,
  layer,
  override,
} from '@eedsh/config'

export default defineProfile({
  name: 'work',
  dsh: '0.2.1-rc.2',
  bundles: [
    bundle('@deepseek-ai/dsh-base'),
    bundle('@deepseek-ai/dsh-web-app'),
    generated(),
  ],
  layers: [
    layer('overrides', [
      override('agent-default-model', {
        provider: 'deepseek',
        model: 'deepseek-chat',
      }),
      disable('repeat-tool-reminder'),
    ]),
  ],
})
```

```sh
eedsh sync
eedsh doctor
eedsh run -- --port 3080
```

`eedsh sync` publishes the profile to `$DSH_HOME/profiles/work` (by default
`~/.dsh/profiles/work`); `eedsh doctor` verifies it, and `eedsh run` boots the pinned
DSH. The CLI installs the profile dependencies with pnpm during sync.

Working from a checkout? Build it first; see [Build from source](#build-from-source).

## CLI reference

```sh
eedsh sync   [--config <path>] [--strict] [--watch] [--explain] [--adopt-ownership]
eedsh doctor [--profile <name> | --config <path>] [--strict]
eedsh check  [--config <path>] [-- <tsc args>]
eedsh run    [--config <path>] [--no-sync] [-- <dsh args>]
eedsh --help | --version
```

- `--config` defaults to `eedsh.config.ts` in the working directory, falling back to
  `eedsh.config.mts`. JavaScript configs (`.js`, `.mjs`) are rejected with
  `config.unsupported_extension` before they are imported.
- `--strict` turns unmatched patch targets into a failure and skips publication.
- `--watch` re-evaluates the config when files in its directory change; a compile
  failure keeps the last published generation.
- `--explain` attributes each preflight warning as `<layer>: <message>`. Without it,
  preflight warnings are raw DSH messages followed by a one-line hint pointing at
  `--explain`. It is sync-only; `run`, `check`, and `doctor` reject it as a usage
  error.
- `--adopt-ownership` re-baselines ownership from the current manifest when the
  generation record cannot be read. Without it, sync fails closed on an eedsh-managed
  profile instead of silently treating managed entries as user-owned. It is not for
  re-adopting a removal you already published.
- `doctor` inspects a published profile without changing it. It verifies the
  generation record, the authoritative `plans/<generationId>.json`, the
  `.eedsh/plan.json` mirror, managed bundles and dependencies, dependency-section
  conflicts, scaffolding, the lockfile, and installed package resolution. It takes no
  lock and never repairs; findings point at `eedsh sync` or
  `eedsh sync --adopt-ownership`. `--profile` selects a profile under `DSH_HOME`
  without evaluating a config, `--config` uses the configured profile, and supplying
  both is a usage error. Findings print errors first and end with
  `N errors, M warnings`. `doctor` exits `0` with no errors (warnings are fine
  unless `--strict` is set), `1` with an error or with `--strict` and a warning,
  and `2` on a usage error.
- `check` runs the config project's own TypeScript compiler: it finds the nearest
  `tsconfig.json`, resolves `typescript` from the config's directory, prints the exact
  command line, and runs `tsc --noEmit -p <tsconfig>`. It never evaluates the config
  or publishes a profile, and exits with the compiler's exit code. Arguments after
  `--` are forwarded to tsc, for example `eedsh check -- --pretty false`.
- `run` syncs first (unless `--no-sync`) and then spawns the pinned DSH launcher with
  `--profile <name>` and your arguments. It does not import the launcher, so argv,
  signals, and shutdown stay exactly DSH's.
- Exit codes: `0` success, `1` validation/materialization/launch/check failure, `2`
  usage error. Validation failures print Effect's native formatted schema message,
  including its location annotations; there are no stable `plan.*` codes. Each
  failure is printed once. `check` and `run` forward the compiler's or DSH's own
  exit code as a successful command outcome.

## Example configuration

This reference keeps the same profile name and plan shape as the hash test; it adds a
profile-local package and shows the annotation points for the main helpers.

```ts
// eedsh.config.ts
import {
  bundle,
  defineProfile,
  disable,
  generated,
  insert,
  js,
  layer,
  override,
} from '@eedsh/config'

export default defineProfile({
  name: 'work',
  dsh: '0.2.1-rc.2',
  packages: { '@scope/my-plugin': 'link:../packages/my-plugin' },
  bundles: [
    bundle('@deepseek-ai/dsh-base'),
    bundle('@deepseek-ai/dsh-web-app'),
    generated(), // generated layers sit here: after web-app, before nothing else
  ],
  layers: [
    layer('plugins', [
      // `insert` adds new rows; `disable` targets an existing row by id.
      insert({ id: 'my-plugin', name: '@scope/my-plugin', config: { enabled: true } }),
      disable('repeat-tool-reminder'),
    ]),
    layer('overrides', [
      // `override` replaces the row's whole config, exactly like a DSH Loader patch.
      override('agent-default-model', {
        provider: 'deepseek',
        model: 'deepseek-chat',
      }),
      insert({
        id: 'plugin-manager',
        name: '@deepseek-ai/dsh-plugin-manager',
        // `js` emits a runtime expression that DSH evaluates at activation.
        disabled: js("!ctx.get('profileContext')"),
      }),
    ]),
  ],
})
```

The helpers map one-to-one onto Loader patch concepts. `override` replaces an
existing row's whole config; it does not merge. `raw` preserves a raw Loader patch
entry, including fields these helpers do not name.

| Helper | Purpose |
|---|---|
| `defineProfile(input)` | Validate and return the plan, or Effect's native schema error. |
| `bundle(name, options?)` | Select a bundle; `options.source` overrides its package source. |
| `generated()` | Position the generated bundle among the managed bundles. |
| `layer(id, patches?)` | Declare an ordered generated patch layer. |
| `insert(entries)` | Insert one Loader entry or an array of entries. |
| `override(id, config)` | Replace an existing row's whole config; no merge. |
| `disable(id)` / `enable(id)` | Disable or enable an existing row. |
| `group(id, fields, children)` | Build a group entry for `insert`, with fields, an optional isolate map, and ordered children. |
| `js(source)` | Emit a `!!js` runtime expression evaluated at activation. |
| `raw(entry)` | Preserve a raw Loader patch entry, including fields the helpers do not name. |

## Configuration reference

A config is a TypeScript module named `eedsh.config.ts` or `eedsh.config.mts` that
must typecheck in its own project. eedsh evaluates it with `tsx` at runtime, so full
TypeScript syntax — including enums, namespaces, and decorators — works without a
build step, but eedsh never typechecks it while loading: type correctness is
established by your editor, by your project's `tsc --noEmit`, or by `eedsh check`.
Config imports resolve with tsx's own rules: relative specifiers, package names such
as `@eedsh/config`, and the tsconfig `paths` mappings of the directory you run eedsh
from.

Invalid plans fail before sync with Effect's native formatted schema error: the CLI
prints every message line with its location annotation, for example
`profile name "" is not usable as a profile directory` followed by
`  at ["profile"]["name"]`. There are no `plan.*` error codes, no per-issue
`path: message` rewrite, and no truncation. `defineProfile` returns the same
`Schema.SchemaError` in a failure `Result`, with the structured issue tree on
`error.issue`. A config may export a plain plan or a `Result`: the loader validates
plain data and a successful Result, and reports a failed Result natively.

For project typechecking with the config project's own compiler, see [`eedsh check`](#cli-reference).

## How it works

### The layer model

A DSH profile is an ordered stack of bundle patch layers followed by the profile's
own `cordis.patch.yml`, the harness-home patch, and invocation overlays. eedsh adds
one thing: a **generated bundle** whose patch files are your `layer(...)` lists.

- `bundles` keeps your authored order.
- `generated()` is a single positional marker. Bundles listed after it override
  generated defaults; the profile patch still has the final word.
- Without a marker the generated bundle follows every managed bundle.
- `@eedsh/runtime` is inserted immediately before `@eedsh/generated`. Both names are
  reserved.

Patch helpers mirror Loader semantics one-to-one: `insert`, `override` (whole-config
replacement, no merge), `disable`, `enable`, `group` (group flag, isolate map,
ordered children), `js` (a `!!js` runtime expression), and `raw` (any additional
Loader patch field). No module, fragment, preset-extension, or feature concept
exists in the plan; a preset is an ordinary inserted row.

### What `eedsh sync` writes

```
$DSH_HOME/profiles/<name>/
  package.json                                   bundles + reconciled dependencies
  cordis.yml                                     empty root config (DSH mounts the stack over it)
  cordis.patch.yml                               your layer; created empty only when missing
  pnpm-workspace.yaml                            pnpm settings DSH expects
  .eedsh/plan.json                               plan mirror, written immediately before the commit point
  .eedsh/generated/package.json                  generation record — the publication commit point
  .eedsh/generated/plans/<generationId>.json     authoritative validated plan (canonical JSON)
  .eedsh/generated/patches/<generationId>/<layerId>.yml
```

Publication is atomic and idempotent:

- patch files, the authoritative `plans/<generationId>.json`, and the profile manifest
  are written first; the plan mirror and then the generated package manifest are last;
- an unchanged plan with intact plan artifacts changes nothing (same generation id,
  same bytes);
- the generation id covers the plan hash and every emitted layer hash, so the record's
  `planHash` locates and verifies `plans/<generationId>.json`;
- a stale `.eedsh/plan.json` or a missing/mismatched authoritative plan is repaired by
  the next successful sync with the same generation id, without reinstalling;
- a failed install, preflight, mirror write, or commit leaves the previous generation
  published and restores the profile manifest, lockfile, and plan mirror.

### Coexist contract

The generated bundle is a normal bundle layer **beneath** the profile patch. Web GUI
edits, Settings writes, and machine-local overrides keep winning, and `eedsh sync`
never rewrites `cordis.patch.yml`, the harness-home patch, or `--patch` overlays.
It only creates an empty `cordis.patch.yml` when none exists.

Ownership is **last-applied**. The generation record of the last successful
publication is the whole ownership baseline: bundles and dependencies eedsh managed
before and no longer manages are removed when the removal is published, and entries
the plan does not manage are preserved. So a bundle or dependency that a published
generation removed and you then add back by hand is user-owned and survives every
later sync. Re-adding one while its removal is still unpublished does not save it,
because the previous record still marks it managed.

`--adopt-ownership` is only for a profile whose generation record cannot be read
(missing, malformed, or foreign). It re-baselines ownership from the current
manifest; it is not a way to re-adopt a removal you already published.

### Hot reload

`@eedsh/runtime` registers only when the composition has a profile context and an
active HMR service. It watches `.eedsh/generated/package.json`, skips a generation it
has already reconciled, and calls `hmr.reconcileProfile()` for a new one. DSH rereads
every bundle layer plus the profile patch, home patch, and overlays, so the profile
patch keeps winning after reload.

Restart-required outcomes are reported, never presented as a hot reload: a change
DSH classifies as requiring a restart (pending modules or a moved package) logs a
restart diagnostic and takes effect on the next start. Without HMR the watcher does
not register and the current composition keeps running until restart. Editing the
TypeScript config alone reloads nothing; only a published generation does.

## Architecture

| Package | Role |
|---|---|
| `@eedsh/config` | Public typed authoring API (`defineProfile` and patch helpers), the versioned JSON plan, the Effect Schema plan contract, Effect-native validation, and canonical hashing. |
| `@eedsh/cli` | The `eedsh` command: config discovery and tsx-based evaluation, the `check` command, Effect-based materialization, preflight, atomic publication, `sync --watch`, and `run`. Also depends on Effect and the TypeScript toolchain, which `@eedsh/runtime` does not. |
| `@eedsh/runtime` | A static DSH bundle and plugin that watches the published generation record and reloads it through DSH's HMR service. |

### Effect boundaries

Effect is the default in `@eedsh/config` and `@eedsh/cli`, and both pin
`effect@4.0.6`. `@eedsh/config` uses an Effect Schema as the plan's single validator
and type source, and its validation API is `Result<ProfilePlan, Schema.SchemaError>`:
failures are Effect's native, multi-line, path-stamped schema errors. `@eedsh/cli`
takes the command surface from `effect/cli`, declares `@effect/platform-node@4.0.6`
for Node services, and uses the same Effect runtime for materialization: tagged
domain failures plus the core `FileSystem` and `ChildProcessSpawner` services, with
`NodeServices.layer` supplying the live implementations. `@eedsh/runtime` remains a
plain Cordis plugin because DSH's HMR service owns its lifecycle, and
`defineProfile` remains synchronous because a config module must default-export
data. It returns `Result<ProfilePlan, Schema.SchemaError>`; a config may export
that Result or a plain plan.

Within `@eedsh/cli`, external data contracts and tolerant readers are decoded with
`effect/Schema`, and each tolerant fallback is explicit at the reader. CLI domain
absence is `Option`: readers, command inputs, findings, and reconciliation or
publication inputs carry `Option` rather than `undefined`, so callers choose a
fallback where absence matters. `undefined` remains at JavaScript and JSON
boundaries, in `process.env` values, in third-party option bags and callbacks, and
in internal mutable state. The config package's JSON/cycle walker and the
Effect-free `@eedsh/runtime` remain exceptions.

Each CLI invocation is one Effect program observed by one `Effect.runPromiseExit`.
The resulting `Exit` is rendered once into a diagnostic and an exit code. Expected
failures are `Result` values or Effect failures; only the external API adapters and
the Effect-free runtime use exception handling. `test/architecture.test.ts` rejects
new JavaScript `throw`, `try`, and `.catch` sites in production config and CLI
source outside the one allowlisted impossible-state branch in the generated YAML
emitter.

`test/architecture.test.ts` enforces the boundary: `@eedsh/config` may import only
`effect/Schema` and `effect/Result`, may not depend on DSH, and must use the same
Effect version as `@eedsh/cli`; the workspace declares no separate `@effect/cli`,
`@effect/platform`, or `@effect/printer*` packages and no source imports one;
`@eedsh/runtime` may not depend on or import Effect or the TypeScript toolchain.

## Build from source

Building from a checkout needs Node.js >= 26 and pnpm 12.14.0:

```sh
pnpm install
pnpm build
```

`pnpm build` runs the repository typecheck and then builds every package. Run the
built CLI from the checkout:

```sh
node packages/cli/lib/bin.js --help
node packages/cli/lib/bin.js sync --config ./eedsh.config.ts
```

## Development

Biome 2.x formats, lints, and organizes imports; `tsc --noEmit` is the type checker;
Vitest runs the tests.

Development requires the TypeScript 7.1 native compiler: the root `package.json` pins
`typescript@7.1.0-beta` and `tsdown@0.23.2`, and package builds emit declarations with
the native TypeScript Go generator instead of the classic compiler API that TypeScript 7
removed. A compiler without that API fails the build rather than falling back.

The root `tsconfig.json` is the repository's typecheck project. It extends
`tsconfig.base.json`, which holds the editor/build compiler options with no `paths`
and no `noEmit`, and adds `noEmit`, the `@eedsh/*` path mappings, and the full
include set: package sources and tests, the root `test` directory, both Vitest
configuration files, and every package `tsdown.config.ts`. `pnpm typecheck` therefore
fails on a type error anywhere, including in a config fixture.

Each package builds with `tsdown` to one bundled ESM entry under `lib/`:
`@eedsh/config` and `@eedsh/runtime` emit `lib/index.js` with `lib/index.d.ts` and
source maps, while `@eedsh/cli` emits only the executable `lib/bin.js` and has no
library entry. Dependencies and workspace packages stay external to the bundles.
Relative imports in `packages/*/src` and `packages/*/test` are extensionless;
`tsdown` and Vitest resolve them, and `tsc` typechecks them with bundler resolution.

```sh
pnpm format          # biome format --write .
pnpm format:check    # biome format .
pnpm lint            # biome lint .
pnpm lint:fix        # biome lint --write .
pnpm build           # typecheck, then pnpm -r run build
pnpm build:packages  # pnpm -r run build without the typecheck
pnpm typecheck       # tsc -p tsconfig.json (whole repository)
pnpm typecheck:watch # the same project in watch mode
pnpm test            # vitest run (slow Web HMR test excluded)
pnpm test:slow       # the slow Web-profile HMR integration test
pnpm check           # biome check . && pnpm typecheck
pnpm verify          # check + test + build:packages
```

CI runs `pnpm verify` on Node 26 only.

## Repository layout

```
packages/config   @eedsh/config
packages/cli      @eedsh/cli (bin: eedsh)
packages/runtime  @eedsh/runtime (DSH bundle + HMR watcher)
test/             workspace smoke, architecture, and (slow) integration tests
```

## Deferred

The higher-level layer is deliberately out of scope for this change: modules,
fragments, presets/`extends`, generated plugin-config types, project-level config,
GUI manager augmentation, multiple profile surfaces, and upgrade/migration machinery.
The plan format is versioned so that layer can be added on top without changing what
the materializer reads.
