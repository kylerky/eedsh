# eedsh

Typed, code-first configuration for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) profiles.

eedsh turns a TypeScript file into a normal DSH profile: an ordered bundle stack, a
generated patch layer at the position you choose, reconciled dependencies, and a
generation record that `dsh` boots like any other profile. DSH itself is untouched;
its own patch precedence, plugin manager, and HMR keep working.

## Requirements

- Node.js >= 26 (the only supported runtime line; Node 24 and earlier are not supported)
- pnpm 12.14.0
- DSH `0.2.1-rc.2` (pinned by `@eedsh/cli` and declared as the runtime bundle engine)

## Packages

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
`defineProfile`/`assertPlan` remain synchronous because a config module must
default-export plain data.

`test/architecture.test.ts` enforces the boundary: `@eedsh/config` may import only
`effect/Schema` and `effect/Result`, may not depend on DSH, and must use the same
Effect version as `@eedsh/cli`; the workspace declares no separate `@effect/cli`,
`@effect/platform`, or `@effect/printer*` packages and no source imports one;
`@eedsh/runtime` may not depend on or import Effect or the TypeScript toolchain.

## Quick start

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
    generated(), // the generated layers sit here: after web-app, before nothing else
  ],
  layers: [
    layer('plugins', [
      insert({ id: 'my-plugin', name: '@scope/my-plugin', config: { enabled: true } }),
      disable('repeat-tool-reminder'),
    ]),
    layer('overrides', [
      // Whole-config replacement, exactly like a DSH Loader patch.
      override('agent-default-model', {
        provider: 'deepseek',
        model: 'deepseek-chat',
      }),
      insert({
        id: 'plugin-manager',
        name: '@deepseek-ai/dsh-plugin-manager',
        disabled: js("!ctx.get('profileContext')"),
      }),
    ]),
  ],
})
```

```sh
pnpm install
pnpm build

# Publish into $DSH_HOME/profiles/work
node packages/cli/lib/bin.js sync --config ./eedsh.config.ts

# Boot the pinned DSH against the published profile
node packages/cli/lib/bin.js run --config ./eedsh.config.ts -- --port 3080

# Typecheck the config project without syncing
node packages/cli/lib/bin.js check --config ./eedsh.config.ts
```

`eedsh` is the package bin of `@eedsh/cli`; use `node packages/cli/lib/bin.js` from a
checkout, or the linked `eedsh` bin once the package is installed.

## Config authoring

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
`path: message` rewrite, and no truncation; `defineProfile` throws the same
`Schema.SchemaError` a frontend can catch, with the structured issue tree on
`error.issue`.

```sh
eedsh check [--config <path>] [-- <tsc args>]
```

`eedsh check` finds the nearest `tsconfig.json` at or above the config, resolves
`typescript` from the config's directory, prints the resolved version, the selected
tsconfig, and the exact command line, then runs `tsc --noEmit -p <tsconfig>`. It
forwards everything after `--` to tsc and exits with the compiler's exit code.
Missing TypeScript or a missing tsconfig fails with a stable `check.*` code rather
than passing silently, and a config outside the tsconfig's file set fails with
`check.config_not_in_project` instead of reporting a check that never looked at it.

## The layer model

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

## What `eedsh sync` writes

```
$DSH_HOME/profiles/<name>/
  package.json                      bundles + reconciled dependencies
  cordis.yml                        empty root config (DSH mounts the stack over it)
  cordis.patch.yml                  your layer; created empty only when missing
  pnpm-workspace.yaml               pnpm settings DSH expects
  .eedsh/plan.json                  the validated plan, canonical JSON
  .eedsh/generated/package.json     generation record — the publication commit point
  .eedsh/generated/patches/<generationId>/<layerId>.yml
```

Publication is atomic and idempotent:

- patch files and the plan are written first, the generated package manifest last;
- an unchanged plan changes nothing (same generation id, same bytes);
- the generation id covers the plan hash and every emitted layer hash;
- a failed install, preflight, or write leaves the previous generation published and
  restores the profile manifest and lockfile.

## Coexist contract

The generated bundle is a normal bundle layer **beneath** the profile patch. Web GUI
edits, Settings writes, and machine-local overrides keep winning, and `eedsh sync`
never rewrites `cordis.patch.yml`, the harness-home patch, or `--patch` overlays.
It only creates an empty `cordis.patch.yml` when none exists. Bundles and
dependencies added outside eedsh are preserved; things eedsh managed before and no
longer manages are removed.

## CLI

```sh
eedsh sync  [--config <path>] [--strict] [--watch]
eedsh check [--config <path>] [-- <tsc args>]
eedsh run   [--config <path>] [--no-sync] [-- <dsh args>]
eedsh --help | --version
```

- `--config` defaults to `eedsh.config.ts` in the working directory, falling back to
  `eedsh.config.mts`. JavaScript configs (`.js`, `.mjs`) are rejected with
  `config.unsupported_extension` before they are imported.
- `--strict` turns unmatched patch targets into a failure and skips publication.
- `--watch` re-evaluates the config when files in its directory change; a compile
  failure keeps the last published generation.
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
  including its location annotations; there are no stable `plan.*` codes.

## Hot reload

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

## Development

Biome 2.x formats, lints, and organizes imports; `tsc --noEmit` is the type checker;
Vitest runs the tests.

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
GUI manager augmentation, multiple profile surfaces, upgrade/migration machinery,
and published npm packaging. The plan format is versioned so that layer can be
added on top without changing what the materializer reads.