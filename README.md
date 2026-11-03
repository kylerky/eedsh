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

Install the CLI globally and create the config project with `eedsh init`:

```sh
npm install -g @eedsh/cli
eedsh init
```

`eedsh init` writes `config.ts`, `package.json`, and `tsconfig.json` under
`$XDG_CONFIG_HOME/eedsh` (falling back to `~/.config/eedsh` when
`XDG_CONFIG_HOME` is unset or not absolute) and installs the typed authoring API,
its `effect` peer, and TypeScript with pnpm. The generated config declares
profiles only; it has no DSH declaration and needs no DSH installation to be
written. Add `--no-install` to write the files and run `pnpm install` yourself.

eedsh requires a separate DSH installation; it does not bundle one. Install
`dsh` next to the CLI, then create the config project:

```sh
npm install -g @deepseek-ai/dsh
npm install -g @eedsh/cli
eedsh init
```

`eedsh sync`, `eedsh run`, and `eedsh repl` discover exactly one installation
per invocation: `--dsh <path>`, then `EEDSH_DSH_ANCHOR`, then a `dsh` launcher
on `PATH`, then the recorded installation anchor at
`$DSH_HOME/.eedsh/installation.json`, then a project-local `@deepseek-ai/dsh`.
When a `dsh` launcher is on `PATH` but its package cannot be located (for
example a pnpm or npm shim), `eedsh sync` and the sync step of `eedsh run`
bootstrap the installation through pnpm or npm global metadata on that first
run and record the anchor, so later commands do not query a package manager.
`eedsh init --dsh <path>` records an explicit anchor too. The discovered
version must satisfy eedsh's supported range, `^0.2.1-rc.2`; `eedsh init`,
`eedsh check`, and `eedsh doctor --profile` work without any installation. The
config project declares its own dependencies.

> **Breaking change since the bundled-DSH release:** the config no longer
> declares a DSH version, the plan is version 2 with no `dsh` field, and
> generated and runtime bundles no longer declare `engines.dsh`. Delete
> `.dsh(...)` (and any plain-config `dsh` field), then run `eedsh sync` to
> publish version-2 plans. Version-1 plans are rejected; see
> [Upgrading from a bundled DSH](#upgrading-from-a-bundled-dsh).
>
> **Breaking change:** eedsh no longer reads `eedsh.config.ts`,
> `eedsh.config.mts`, JavaScript configs, or a single-plan default export from the
> working directory. Run `eedsh init`, and remove the old file. There is no
> automatic migration; see
> [Migrating from the free-function API](#migrating-from-the-free-function-api).

## Quick start

The config lives at `$XDG_CONFIG_HOME/eedsh/config.ts`; `eedsh init` writes a
starting point. eedsh never discovers a config in the working directory.

```ts
// $XDG_CONFIG_HOME/eedsh/config.ts
import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .profile('work', (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-base')
      .bundle('@deepseek-ai/dsh-web-app')
      .generated()
      .layer((layer) => {
        layer
          .override('agent-default-model', {
            provider: 'deepseek',
            model: 'deepseek-chat',
          })
          .disable('repeat-tool-reminder')
      })
  })
  .build()
```

```sh
eedsh sync
eedsh doctor
eedsh run -- --port 3080
```

`eedsh sync` publishes every profile in the config to `$DSH_HOME/profiles/<name>`
(by default `~/.dsh/profiles/<name>`); `--profile work` narrows it to one.
`eedsh doctor` and `eedsh run` select `--profile`, then `defaultProfile`, then the
sole profile. The CLI installs each profile's dependencies with pnpm during sync.

Working from a checkout? Build it first; see [Build from source](#build-from-source).

## CLI reference

```sh
eedsh init   [--no-install] [--dsh <path>]
eedsh sync   [--profile <name>] [--config <path>] [--dsh <path>] [--strict] [--watch] [--explain] [--adopt-ownership]
eedsh doctor [--profile <name> | --config <path>] [--dsh <path>] [--strict]
eedsh check  [--config <path>] [-- <tsc args>]
eedsh run    [--profile <name>] [--config <path>] [--dsh <path>] [--no-sync] [-- <dsh args>]
eedsh repl   [--profile <name>] [--config <path>] [--dsh <path>] [--sync] [--eval <expression>]
eedsh --help | --version
```

- `init` creates the XDG config project, never overwrites an existing
  `config.ts`, `package.json`, or `tsconfig.json`, and creates no repository.
  It writes no DSH declaration and needs no DSH installation.
  `--no-install` skips pnpm and prints the install command. `--dsh <path>`
  validates an explicit installation and records the machine-local anchor;
  without it, init reports an existing anchor and never queries pnpm or npm.
  Without any installation or anchor, init still succeeds and names the
  first-sync bootstrap.
- `sync`, `run`, and `repl` require a discovered `@deepseek-ai/dsh`
  installation; discovery order is `--dsh <path>`, `EEDSH_DSH_ANCHOR`, a
  `dsh` launcher on `PATH`, the recorded anchor, then a project-local
  `@deepseek-ai/dsh`. The path may be the package directory or its
  `package.json`. One installation is selected per invocation and reused by
  watch mode. An invalid explicit selection fails instead of falling through.
  Only `sync` and the sync step of `run` bootstrap an unresolved `PATH`
  launcher, through pnpm or npm global metadata; `doctor`, `repl`, and
  `run --no-sync` never query a package manager. The discovered version must
  satisfy `^0.2.1-rc.2`; discovery and the supported range are the only version
  inputs. `doctor` uses the same discovery when available but never requires it.
- `--dsh` is accepted by `init`, `sync`, `run`, `repl`, and `doctor`;
  `check` does not accept a DSH selection.
- `--config` defaults to `$XDG_CONFIG_HOME/eedsh/config.ts`
  (`~/.config/eedsh/config.ts` when unset or relative). The path is absolute after
  resolution; the working directory is never searched. Only `.ts` is accepted, and
  `.mts`, `.js`, and `.mjs` fail with `config.unsupported_extension` before import.
- Bare `sync` publishes every profile in record order, each under its own profile
  lock; `--profile` publishes exactly that profile. An invalid, locked, or failed
  profile is reported and does not stop its valid siblings, and the command exits
  `1` if any selected profile failed.
- `--strict` turns preflight warnings (unmatched patch targets and empty generated
  layers) into a failure for that profile and skips its publication.
- `--watch` re-evaluates the config and the same selection on every change; a
  compile, validation, or profile failure is reported and the session stays active,
  keeping the last published generation.
- `--explain` attributes each preflight warning as `<group>: <message>`. The
  group is `generated #<n>` in application order, followed by the optional
  authoring label, the authoring site (`config.ts:9:5`), and the row ids the
  patch touches; a warning from a bundle keeps its `bundle:<name>` label. An
  empty generated group is reported with the same positional prefix. Without
  `--explain`, preflight warnings are raw DSH messages followed by a one-line
  hint pointing at `--explain`. It is sync-only; `run`, `check`, and `doctor`
  reject it as a usage error.
- `--adopt-ownership` re-baselines ownership from the current manifest when the
  generation record cannot be read. Without it, sync fails closed on an eedsh-managed
  profile instead of silently treating managed entries as user-owned. It is not for
  re-adopting a removal you already published.
- `doctor` inspects a published profile without changing it. When a DSH is
  discoverable it prints its path and version, errors when the version is
  outside the supported range, and warns when the generation record names a
  different version and recommends `eedsh sync`. It reads no `engines.dsh` and
  reports a version-1 plan as unreadable instead of reading it. It verifies the
  generation record, the authoritative `plans/<generationId>.json`, the
  `.eedsh/plan.json` mirror, managed bundles and dependencies, dependency-section
  conflicts, scaffolding, the lockfile, and installed package resolution. The
  advisory `.eedsh/provenance.json` sidecar is outside every check: it may be
  absent, malformed, or from another generation without affecting findings or
  exit status. It takes no lock and never repairs; findings point at `eedsh sync` or
  `eedsh sync --adopt-ownership`. `--profile` selects a profile under `DSH_HOME`
  without evaluating a config; without it, doctor evaluates the config only to take
  the default profile (or the sole profile) and inspects that published profile.
  Supplying both `--profile` and `--config` is a usage error, as is a config with
  several profiles and no default. Findings print errors first and end with
  `N errors, M warnings`. `doctor` exits `0` with no errors (warnings are fine
  unless `--strict` is set), `1` with an error or with `--strict` and a warning,
  and `2` on a usage error.
- `check` runs the config project's own TypeScript compiler: it finds the nearest
  `tsconfig.json`, resolves `typescript` from the config's directory, prints the exact
  command line, and runs `tsc --noEmit -p <tsconfig>`. It never evaluates the config
  or publishes a profile, and exits with the compiler's exit code. Arguments after
  `--` are forwarded to tsc, for example `eedsh check -- --pretty false`.
- `run` selects `--profile`, then `defaultProfile`, then the sole profile, syncs
  that profile first (unless `--no-sync`), and then spawns the discovered DSH
  launcher with `--profile <name>` and your arguments. The same installation is
  used for preflight, the generation record, and the spawned process; `--no-sync`
  skips publication but still requires and boots the discovered installation. An
  ambiguous selection is a usage
  error listing the profile names. `run` does not import the launcher, so argv,
  signals, and shutdown stay exactly DSH's.
- `repl` evaluates TypeScript expressions against the loaded config, watches the
  config directory, and prints the diff and composition summary after each save.
  Bindings persist between entries: `config` is the config view
  (`defaultProfile`, `profiles()`), `dshVersion()` returns the exact selected
  installation version, `selectedProfile` is the selected profile view
  (`name`, `plan()`, `bundles()`, `layers()`, `packages()`, `entries()`,
  `published()`), and `plan` is `selectedProfile.plan()`. The curated authoring
  factories `bundle`, `defineConfig`, `definePreset`, `dshVersion`, `group`, and
  `js` are bound; the legacy
  `profile` string and raw `profiles` map are not. Tab completes commands, chain
  methods, and profile, bundle, row, preset, and package names; a second Tab lists
  ambiguous matches. Dot commands are
  shell-level: `.help`, `.profile <name>`, `.reload`, `.resolve`, `.sync`,
  `.clear`, and `.exit`. Inspection, `.profile`, completion, `.reload`, and
  exploration never write profile files; `.sync` (or `--sync`) publishes. `--eval`
  evaluates one expression, prints its value, and exits with a non-zero status on
  failure.
- Exit codes: `0` success, `1` validation/materialization/launch/check failure, `2`
  usage error. Validation failures print Effect's native formatted schema message,
  including its location annotations; there are no stable `plan.*` codes. Each
  failure is printed once. `check` and `run` forward the compiler's or DSH's own
  exit code as a successful command outcome.

## Example configuration

This reference keeps the same profile name and plan shape as the hash test; it adds a
profile-local package and shows the annotation points for the main helpers.

```ts
// $XDG_CONFIG_HOME/eedsh/config.ts
import { defineConfig, js } from '@eedsh/config'

export default defineConfig()
  .profile('work', (profile) => {
    profile
      .package('@scope/my-plugin', 'link:../packages/my-plugin')
      .bundle('@deepseek-ai/dsh-base')
      .bundle('@deepseek-ai/dsh-web-app')
      .generated() // generated patch groups sit here: after web-app, before nothing else
      .layer((layer) => {
        // `insert` adds new rows; `disable` targets an existing row by id.
        // A group is anonymous and identified by its position; `.layer(label, build)`
        // adds a non-unique display label when you want one in diagnostics.
        layer
          .insert({ id: 'my-plugin', name: '@scope/my-plugin', config: { enabled: true } })
          .disable('repeat-tool-reminder')
      })
      .layer((layer) => {
        // `override` replaces the row's whole config, exactly like a DSH Loader patch.
        layer
          .override('agent-default-model', {
            provider: 'deepseek',
            model: 'deepseek-chat',
          })
          .insert({
            id: 'plugin-manager',
            name: '@deepseek-ai/dsh-plugin-manager',
            // `js` emits a runtime expression that DSH evaluates at activation.
            disabled: js("!ctx.get('profileContext')"),
          })
      })
  })
  .build()
```

The typed builders and value constructors map one-to-one onto Loader patch
concepts. `override` replaces an existing row's whole config; it does not merge.
`raw` preserves a raw Loader patch entry, including fields the builders do not
name. Inserting a resolved `Row` or `Preset` normalizes it to its plain Loader
row; methods never reach the persisted plan.

| API | Purpose |
|---|---|
| `defineConfig()` | Start the synchronous config builder. `.defaultProfile(name)` and `.profile(name, build)` chain; `.build()` validates. There is no DSH declaration. |
| `dshVersion()` | Return the exact version of the selected DSH installation; throws a tagged `resolution.bridge_missing` outside eedsh. |
| `ConfigBuilder.build()` | Normalize typed objects, validate the envelope and every profile, and return `Result<EedshConfig, Schema.SchemaError>`. |
| `ProfileBuilder.bundle(name \| Bundle)` | Add an ordered bundle selection. A rooted query is rejected. Bundle selection never declares a dependency; a local bundle that is both calls `.bundle(name)` and `.package(name, spec)`. |
| `ProfileBuilder.generated()` | Position the generated bundle among the managed bundles. |
| `ProfileBuilder.layer(build)` | Declare an ordered, anonymous patch group scoped to its callback; identity is position. `.layer(label, build)` attaches an optional non-unique display label. |
| `ProfileBuilder.package(name, spec)` | Add a profile-local package dependency. |
| `LayerBuilder.insert(entries)` | Insert Loader entries, typed rows, presets, or preset definitions. |
| `LayerBuilder.override(target, config)` | Replace a row's whole config; no merge. |
| `LayerBuilder.disable(target)` / `.enable(target)` | Toggle a row or preset by id or typed handle. |
| `LayerBuilder.raw(entry)` | Preserve a raw Loader patch entry, including unnamed fields. |
| `group(id, fields, children)` | Build a group entry for `insert`, with fields, an optional isolate map, and ordered children. |
| `js(source)` | Emit a `!!js` runtime expression evaluated at activation. |
| `bundle(name)` | Select a bundle and query handle; `.fromProfile()` and `.fromPackageDir()` root it. |
| `definePreset(id, options?)` | Author a mutable agent-preset definition; `.from()`, `.name()`, `.description()`, `.order()`, and `.children()` chain and `.toJSON()` is an ordinary agent-preset row. |
| `LayerBuilder.selectPreset(selected, { default })` | Write the complete `agent-preset-registry` config from two installed or authored preset references. |

## Authoring queries and the config REPL

`@eedsh/config` resolves bundle rows synchronously while `config.ts` is
evaluated. Queries are methods on typed, immutable handles; rows and presets are
typed values whose `.toJSON()` is the plain Loader row.

```ts
import { bundle, defineConfig } from '@eedsh/config'

const web = bundle('@deepseek-ai/dsh-web-app')
const standard = web.presets()[0]

// No root: the active DSH installation the CLI selected for this run.
const active = bundle('@deepseek-ai/dsh-base').row('timer')

// One explicit root: an installed profile copy, or a package directory.
const installed = bundle('@acme/plugin-bundle').fromProfile('work').rows()
const vendored = bundle('@acme/plugin-bundle')
  .fromPackageDir('../vendor/plugin-bundle')
  .row('acme-row')

export default defineConfig()
  .profile('work', (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-base')
      .bundle('@deepseek-ai/dsh-web-app')
      .generated()
      .layer((layer) => {
        // standard is a Preset: disable() targets its Loader row id.
        layer.disable(standard ?? 'preset-minimal')
      })
      .layer((layer) => {
        layer.insert([...installed, vendored, active])
      })
  })
  .build()
```

`bundle(name)` returns a `Bundle` that is both a plan selection and a query
handle. With no root it resolves the active installation the CLI selected and
never a profile copy; a custom bundle needs an explicit root. Queries run only
while the config is evaluated by `eedsh sync`, `eedsh run`, or `eedsh repl`,
which install the capability bridge for that installation before the import. `ProfileBuilder.bundle()` accepts
a bundle name or an unrooted `Bundle`; a rooted `BundleQuery` is query-only and
is rejected as a plan selection.

| Query | Returns |
|---|---|
| `.rows()` | Every declared row as a `Row`. |
| `.presets()` | Every declared preset as a `Preset`: its row id, preset id, order, name, disabled flag, and row data. |
| `.row(id)` | One `Row` by Loader id; a missing id fails. |
| `.preset(id)` | One `Preset` by preset id; a missing id fails. |
| `.version()`, `.packageDir()`, `.origin()` | The resolved package facts and source. |
| `.fromProfile(name \| { name })` | A query-only handle rooted at that profile's installed copy. |
| `.fromPackageDir(dir)` | A query-only handle rooted at a package directory; a relative path resolves against `config.ts`. |

`Row.disable()`, `.enable()`, and `.override(config)` return plain patch data;
`Preset` does the same but targets its Loader row id. Pass a handle to a layer
builder, or call `.toJSON()` for plain plan data. Failures are structured
`ResolutionError` values with a stable `code`, the queried `bundle`, and a
message. Missing anchors, uninstalled profile bundles, missing manifests,
non-bundle packages, unreadable patches, and unknown row or preset ids fail
instead of returning partial data. The prompt and a config file run the same
query code.

### Authoring a preset from an installed one

`definePreset(id, { rowId? })` returns a mutable definition that normalizes to
an ordinary `@deepseek-ai/dsh-agent-preset` row. The row id defaults to
`preset-<id>`; an explicit `rowId` overrides it. `.from(installed)` copies only
the installed preset's child list, so identity and metadata stay explicit:

```ts
import { bundle, defineConfig, definePreset } from '@eedsh/config'

const installed = bundle('@deepseek-ai/dsh-web-app').preset('ptc')
const standard = bundle('@deepseek-ai/dsh-web-app').preset('standard')

const adapted = definePreset('ptc-fresh') // Loader row id: preset-ptc-fresh
  .from(installed)
  .name('Adapted PTC')
  .description('PTC for personal use')
  .order(2)
  .children((children) => {
    children.child('tool-todo').disable()
    children.child('tool-web').disable()
    children.append({ id: 'tool-lsp', name: '@deepseek-ai/dsh-tool-lsp' })
  })

export default defineConfig()
  .profile('work', (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-web-app')
      .generated()
      .layer((layer) => {
        layer.insert(adapted)
      })
      .layer((layer) => {
        layer.selectPreset(adapted, { default: standard })
      })
  })
  .build()
```

Every child operation names one child or one anchor. `child(id)` returns a
short-lived handle with `.disable()`, `.enable()`, `.remove()`, and
`.replaceWith(entry)`; the scope offers `.append(entry)`, `.prepend(entry)`,
`.insertBefore(anchor, entry)`, and `.insertAfter(anchor, entry)`. The callback
return value is ignored and `.children()` returns the definition. Only
top-level children are addressable; a group is edited or replaced as one entry.
A missing or duplicate child id throws `PresetDefinitionError` with `presetId`,
`rowId`, and `childId` before anything mutates, and config loading preserves
that tagged failure instead of reporting a generic import failure.

Query rows already carry plan expression nodes (`{ $eedsh: { expr } }`), not
DSH's internal `__jsExpr` marker, so a copied child that used `!!js` is
directly insertable and the emitted patch keeps the `!!js` scalar.

`selectPreset(selected, { default })` writes the complete
`agent-preset-registry` config from two preset references (an installed
`Preset` or an authored definition): `selectedDefault` is the selected preset
and `default` is the required deployment default. It never reads or merges the
existing registry row and never infers the deployment default. When the
profile's composition has no registry row, preflight reports the unmatched
target as a warning (fatal with `--strict`).
```sh
eedsh repl
eedsh repl --profile work --sync
eedsh repl --eval 'selectedProfile.name'
```

The prompt evaluates TypeScript, including type annotations and top-level
`await`, and keeps bindings across entries. `config` is the config view,
`selectedProfile` is the selected profile view, and `plan` is
`selectedProfile.plan()`. The curated authoring factories `bundle`,
`defineConfig`, `definePreset`, `group`, and `js` are bound from the config project's
`@eedsh/config`; an export that collides with a view binding fails the session
loudly. The legacy `profile` string and raw `profiles` map are gone: use
`.profile <name>` to switch the selected profile without re-importing, and
`config.profiles()` for the collection.

Tab completion follows the domain grammar: shell commands and their arguments,
chain methods valid at the current step, and profile, bundle, row, preset, and
package names. The first Tab inserts a unique or common prefix; a second Tab
lists ambiguous matches. A rooted chain does not offer a second root, completion
never writes or publishes, and a failing resolution produces no hits.

The exploration views are read-only snapshots rebuilt on load, reload, profile
switch, preview change, and successful sync:

| View | Exposes |
|---|---|
| `config` | `dsh`, `defaultProfile`, `profiles()`, `profile(name)`. |
| `selectedProfile` / `config.profile(name)` | `name`, `valid`, `error`, `plan()`, `bundles()`, `layers()`, `packages()`, `entries()`, `published()`. |
| A bundle view | Plan selection data plus `rows()`, `presets()`, `row()`, `preset()`, `version()`, `packageDir()`, `origin()`. |
| `packages()` | Declared plan packages, managed runtime/generated packages, and installed manifest versions. |
| `entries()` | Composed rows with the last authoring site, group position, or bundle that touched each id. |
| `published()` | Manifest, generation record, authoritative plan path, and doctor findings; a missing profile is `exists: false`, not an error. |

After a save the prompt re-evaluates, debounces bursts of edits, prints a plan
diff (profile, bundle, package, patch group, patch, and row changes), and
prints the composed row count and preflight warnings. Patch groups are matched
by their patch content, so inserting or removing a group reports only that
group. A bad save keeps the previous evaluation; `.reload` retries.

For a custom bundle the selected profile has not installed, prepare a
session-local preview:

```sh
.resolve @acme/plugin-bundle@1.2.3
```

The session copies the profile's manifest, workspace file, and lockfile into
`$XDG_CACHE_HOME/eedsh/repl/<hash>`, installs the exact spec there, and
evaluates with a printed profile-root override. `config.ts` keeps calling
`.fromProfile('work')`; it never names the preview. A failed install keeps the
previous evaluation. Concurrent sessions with the same key serialize, completed
keys are reused, and old previews are removed.

Publishing is explicit: `.sync` publishes the current evaluation, while
`--sync` or `.sync on` syncs after each successful debounced save. An invalid
save is not published, a failed sync pauses continuous mode until a changed
save, and `.sync off` returns to inspection. When a preview-baked plan is
published, the session immediately re-evaluates against the real profile:
identical plans delete the preview and report the bootstrap complete; a
divergence is reported, the preview is kept, and the real evaluation is ready
for the next `.sync`. Bundle or package-set changes are reported as requiring a
restart.

## Configuration reference

`eedsh init` creates one XDG config project: `config.ts`, `package.json`, and
`tsconfig.json` under `$XDG_CONFIG_HOME/eedsh`. The config must default-export the
`Result` from `defineConfig().build()` (or a plain config value); a plain profile
plan and the old single-plan export are not configs. eedsh evaluates the module with `tsx`
at runtime, so full TypeScript syntax — including enums, namespaces, and
decorators — works without a build step, but eedsh never typechecks it while
loading: type correctness is established by your editor, by the config project's
`tsc --noEmit`, or by `eedsh check`. Config imports resolve against the nearest
`tsconfig.json` at or above `config.ts`, so relative specifiers, package names
such as `@eedsh/config`, and the config project's own `paths` mappings work. The
caller's working-directory tsconfig is never used.

`defineConfig()` starts a synchronous builder. `.defaultProfile(name)` may name a
default, and `.profile(name, build)` declares each profile; the callback receives a
`ProfileBuilder` scoped to that profile. Profiles may be added dynamically
(loops, computed keys, environment values) by calling `.profile()` repeatedly.
`.build()` normalizes typed objects, validates the envelope with the strict
config contract, then validates each profile plan independently. It returns
`Result<EedshConfig, Schema.SchemaError>` and never throws; a config module
default-exports it. Config-level defects — a legacy `dsh` field, an empty
profile record, an unsafe key, or an unknown default — fail the whole config
with Effect's native formatted schema error. A profile record built from spreads,
computed keys, loops, or environment values is accepted. Each profile is validated independently:
an invalid profile keeps its own native failure and does not block a valid
sibling from being selected, published, or run.

Bare `sync` selects every profile; `--profile` selects exactly the named profile.
`run` and `doctor` select `--profile`, then `defaultProfile`, then the sole
profile. Unknown or ambiguous one-profile selections are usage errors (exit 2)
listing the available names. `check` takes no profile. Removing a profile from
`config.ts` stops syncing it but does not delete its published DSH profile.

A config no longer declares a DSH version, so plan validation accepts only
version 2 and rejects a `dsh` field. `dshVersion()` is available inside the config
for branching and logging, but the selected version is not written into the plan
or the generated manifest. Published versions are recovered by re-syncing; see
[Upgrading from a bundled DSH](#upgrading-from-a-bundled-dsh) for the migration
and rollback limits.

Invalid configs and profiles print Effect's native multi-line schema message with
location annotations, for example `profile key "a/b" is not usable as a profile
directory` followed by `  at ["profiles"]["a/b"]`. There are no `plan.*` codes,
no per-issue `path: message` rewrite, and no truncation. A profile failure is
labelled with its name and printed once; every selected profile's failure is
reported.

For project typechecking with the config project's own compiler, see [`eedsh check`](#cli-reference).

## Migrating from the free-function API

This earlier release replaced the free-function authoring surface with typed
objects. That migration did not change the persisted plan format.

| Before | After |
|---|---|
| `defineConfig({ profiles: { work: defineProfile({...}) } })` | `defineConfig().defaultProfile(name).profile('work', (profile) => ...).build()` |
| `defineProfile({ bundles, layers, packages })` | the `.profile(name, (profile) => ...)` callback: `.bundle()`, `.generated()`, `.layer()`, `.package()` |
| `layer(id, [insert(...), disable('x')])` | `.layer((layer) => layer.insert(...).disable('x'))`; a group is anonymous and identified by position |
| `.layer('label', build)` | the string is now an optional, non-unique display label, not an identifier |
| `insert(entries)` / `override(id, config)` / `disable(id)` / `enable(id)` / `raw(entry)` | `layer.insert()` / `.override()` / `.disable()` / `.enable()` / `.raw()` |
| `rows(bundle, root)` / `row(bundle, id, root)` / `presets(bundle, root)` | `bundle(name).rows()` / `.row(id)` / `.presets()`, rooted with `.fromProfile()` or `.fromPackageDir()` |
| REPL `profile` string / `profiles` map | `selectedProfile` view / `config.profiles()`; `.profile <name>` switches |
| Query results were frozen plain rows | Query handles are typed; pass them to `insert` or call `.toJSON()` |
| A user-written `__jsExpr` walk before inserting a queried preset | Query results already carry plan `{ $eedsh: { expr } }` expression nodes |
| `bundle(name, { source })` / `.bundle(name, { source })` | `.bundle(name)` for the patch layer, plus `.package(name, spec)` when the profile also needs the dependency |
| `defineProfile` and `assertPlan` exports | Removed; `validatePlan` remains in `@eedsh/plan` |

`defineConfig().build()` is synchronous and returns Effect's native
`Result<EedshConfig, Schema.SchemaError>`; export that Result from `config.ts`.
The REPL no longer binds `profile` or `profiles`.

## Upgrading from a bundled DSH

The external-DSH release is breaking: eedsh no longer bundles an installation,
the config declares no DSH value, and published artifacts carry no DSH engine.

1. Install DSH separately (`npm install -g @deepseek-ai/dsh`) or point eedsh at an
   installation with `--dsh <path>` or `EEDSH_DSH_ANCHOR`. The version must
   satisfy `^0.2.1-rc.2`; `eedsh init`, `eedsh check`, and
   `eedsh doctor --profile` keep working without one.
2. Delete `.dsh(...)` from `config.ts` and any plain-config `dsh` field. A
   config that still declares either is rejected; there is no ignored fallback.
3. Run `eedsh sync`. It publishes a version-2 plan with no `dsh` field and a
   generated manifest with no `engines.dsh`. Older published profiles are not
   migrated in place and version-1 plans are rejected, not read.
4. Use `dshVersion()` only to branch or log. It returns the exact selected
   version and cannot narrow or pin the published artifact.
5. Run `eedsh doctor` to confirm the discovered path and version, the supported
   range, and no generation drift. After any DSH upgrade, `eedsh sync`
   re-bootstraps when the recorded anchor is stale, or boot an eedsh-managed
   profile so the runtime refreshes the anchor, then sync to republish with the
   new version.

**Rollback limits:** the previous eedsh reads version-1 plans, so it cannot read
plans published by this release. Rolling back requires restoring the old config
with `.dsh(...)` and re-syncing with the older release; there is no downgrade
reader.

The installation anchor is additive state: no config or plan migration is
required, and the previous eedsh release ignores
`$DSH_HOME/.eedsh/installation.json`. In this repository's OpenSpec workflow,
archive `adopt-external-dsh` before `add-dsh-anchor-bootstrap` so the pending
external-DSH discovery contract applies first.

### DSH discovery and the installation anchor

Discovery order is `--dsh`, `EEDSH_DSH_ANCHOR`, a direct `dsh` launcher on
`PATH`, the recorded anchor, then a project-local package. Explicit selection
wins over the anchor. Every candidate is validated on read: the package must be
`@deepseek-ai/dsh`, satisfy `^0.2.1-rc.2`, and declare a resolvable launcher
entry. A `PATH` launcher that neither direct resolution nor a valid anchor
resolves fails with `dsh.launcher_unresolved` instead of silently falling
through to a project-local copy.

`eedsh sync` and the sync step of `eedsh run` bootstrap only when a `PATH`
launcher exists but its package cannot be located. The bootstrap runs two
fixed, read-only metadata commands, `pnpm list -g --depth=0 --json` and
`npm root -g`, and requires exactly one validated candidate whose version
equals `dsh --version`. When pnpm and npm both match, the launcher path breaks
the tie. Anything else fails with `dsh.launcher_unresolved`, naming the
launcher, the pnpm/npm-only boundary, `--dsh`, `EEDSH_DSH_ANCHOR`, and the
boot-once recovery. The bootstrap never parses a shim (`cmd-shim-target`) and
supports no other package manager.

The anchor is machine-local state, written outside the config project:

```json
{
  "format": 1,
  "installAnchor": "/.../node_modules/@deepseek-ai/dsh/package.json",
  "version": "0.2.1-rc.2",
  "launcher": "/home/user/.local/share/pnpm/bin/dsh",
  "manager": "pnpm",
  "recordedBy": "sync",
  "recordedAt": "2026-11-03T..."
}
```

Writes are atomic and owner-only. The runtime rewrites the anchor from
`profileContext.installAnchor` and `profileContext.home` on every eedsh profile
boot, even when HMR is disabled, so an upgrade self-heals on the next boot. A
missing, malformed, or version-mismatched record is ignored and the next sync
bootstraps again. `doctor`, `repl`, and `run --no-sync` never query pnpm or npm
and never write the anchor; they rely on explicit selection, direct `PATH`
resolution, or the recorded anchor, and otherwise report the remedies. Other
launchers (Yarn, Bun, Volta, asdf, Nix, custom wrappers) use `--dsh`,
`EEDSH_DSH_ANCHOR`, or a prior eedsh profile boot.

## How it works

### The layer model

A DSH profile is an ordered stack of bundle patch layers followed by the profile's
own `cordis.patch.yml`, the harness-home patch, and invocation overlays. eedsh adds
one thing: a **generated bundle** whose patch files are the `.layer(...)` groups
in your profile builder.

- `bundles` keeps your authored order.
- Each `.layer(...)` call declares an anonymous, ordered patch group. Its identity
  is its 1-based position; no identifier is authored, emitted, or hashed.
  `.layer(label, build)` attaches an optional, non-unique display label used only
  in diagnostics and the provenance sidecar.
- `.generated()` is a single positional marker. Bundles listed after it override
  generated defaults; the profile patch still has the final word.
- Without a marker the generated bundle follows every managed bundle.
- `@eedsh/runtime` is inserted immediately before `@eedsh/generated`. Both names are
  reserved.

While the config is evaluated, the authoring API records the first call site
outside the authoring package for every patch: the file, line, and column in
`config.ts` (or a helper it delegates to), plus the group label. `eedsh sync`
publishes that record as the advisory `.eedsh/provenance.json` sidecar. DSH
never reads it, and it affects neither composition, the plan hash, nor the
generation identifier.

The typed layer builders mirror Loader semantics one-to-one: `insert`, `override`
(whole-config replacement, no merge), `disable`, `enable`, and `raw` (any
additional Loader patch field), plus the `group` (group flag, isolate map,
ordered children) and `js` (a `!!js` runtime expression) value constructors. No
module, fragment, preset-extension, or feature concept exists in the plan; a
preset is an ordinary inserted row.

### What `eedsh sync` writes

```
$DSH_HOME/profiles/<name>/
  package.json                                   bundles + reconciled dependencies
  cordis.yml                                     empty root config (DSH mounts the stack over it)
  cordis.patch.yml                               your layer; created empty only when missing
  pnpm-workspace.yaml                            pnpm settings DSH expects
  .eedsh/plan.json                               plan mirror, written immediately before the commit point
  .eedsh/provenance.json                         advisory authoring provenance (labels, per-patch sites)
  .eedsh/generated/package.json                  generation record — the publication commit point
  .eedsh/generated/plans/<generationId>.json     authoritative validated plan (canonical JSON)
  .eedsh/generated/patches/<generationId>/0001.yml  patch groups in order, named by 1-based position
```

Publication is atomic and idempotent:

- patch files, the authoritative `plans/<generationId>.json`, and the profile manifest
  are written first; the plan mirror, the provenance sidecar, and then the
  generated package manifest are last;
- an unchanged plan with intact plan artifacts changes nothing (same generation id,
  same bytes) and does not write a sidecar; the next real publication repairs a
  missing sidecar;
- the generation id covers the plan hash and every emitted patch-group hash, so the
  record's `planHash` locates and verifies `plans/<generationId>.json`;
- a stale `.eedsh/plan.json` or a missing/mismatched authoritative plan is repaired by
  the next successful sync with the same generation id, without reinstalling;
- a failed install, preflight, mirror write, sidecar write, or commit leaves the
  previous generation published and restores the profile manifest, lockfile, plan
  mirror, and provenance sidecar.

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
| `@eedsh/plan` | The shared plan contract: the Effect Schema and derived plan types, strict `validatePlan`/`validateConfigValue`, the multi-profile config envelope, and canonical JSON. Imports Effect only through `effect/Schema` and `effect/Result`, and no Node builtins. |
| `@eedsh/config` | Public typed authoring API: the fluent `defineConfig()` builder, `bundle()` query handles, layer and value builders, `dshVersion()`, and normalization to plain plan data. Built on `@eedsh/plan`; synchronous, no Effect runtime, re-exports plan types only, and reads bundle contents through the CLI-installed capability bridge rather than any DSH package. |
| `@eedsh/cli` | The `eedsh` command: DSH discovery and supported-range enforcement, XDG config resolution, `init`, tsx-based evaluation, profile selection, `check`, the capability bridge, Effect-based materialization, preflight, atomic publication, all-profile `sync --watch`, and `run`. It declares no production DSH or app-boot dependency: app-boot is loaded from the discovered installation. Also depends on Effect, `@eedsh/plan` at runtime, and the TypeScript toolchain, which `@eedsh/runtime` does not. |
| `@eedsh/runtime` | A static DSH bundle and plugin that watches the published generation record and reloads it through DSH's HMR service. It declares `engines.node` and no `engines.dsh`, probes the HMR capabilities it needs, and warns when the record and running installation versions drift. |

### Effect boundaries

Effect is the default in `@eedsh/plan`, `@eedsh/config`, and `@eedsh/cli`, and all
three pin `effect@4.0.6`. `@eedsh/plan` owns the Effect Schema that is the plan's
single validator and type source, plus the config envelope; its validation API is
`Result<ProfilePlan, Schema.SchemaError>` with Effect's native, multi-line,
path-stamped schema errors. `@eedsh/config` composes those primitives for authoring
and may import Effect only through `effect/Schema` and `effect/Result`.
`@eedsh/cli` takes the command surface from `effect/cli`, declares
`@effect/platform-node@4.0.6` for Node services, and uses the same Effect runtime for
materialization: tagged domain failures plus the core `FileSystem` and
`ChildProcessSpawner` services, with `NodeServices.layer` supplying the live
implementations. `@eedsh/runtime` remains a plain Cordis plugin because DSH's HMR
service owns its lifecycle, and `defineConfig().build()` remains synchronous
because a config module must default-export data. `build()` returns
`Result<EedshConfig, Schema.SchemaError>` with one validation Result per profile;
a config may export that Result, a plain config object, or a config-valued
`Result`.

Within `@eedsh/cli`, external data contracts and tolerant readers are decoded with
`effect/Schema`, and each tolerant fallback is explicit at the reader. CLI domain
absence is `Option`: readers, command inputs, findings, and reconciliation or
publication inputs carry `Option` rather than `undefined`, so callers choose a
fallback where absence matters. `undefined` remains at JavaScript and JSON
boundaries, in `process.env` values, in third-party option bags and callbacks, and
in internal mutable state. The plan package's JSON/cycle walker and the
Effect-free `@eedsh/runtime` remain exceptions.

Each CLI invocation is one Effect program observed by one `Effect.runPromiseExit`.
The resulting `Exit` is rendered once into a diagnostic and an exit code. Expected
failures are `Result` values or Effect failures; only the external API adapters and
the Effect-free runtime use exception handling. `test/architecture.test.ts` rejects
new JavaScript `throw`, `try`, and `.catch` sites in production config and CLI
source outside the documented allowlist of synchronous boundaries and discovery
or bridge adapters.

`test/architecture.test.ts` enforces the boundary: `@eedsh/plan` may import only
`effect/Schema` and `effect/Result` and no Node builtins; `@eedsh/plan` accepts
only plan version 2 and has no version-1 reader; `@eedsh/config` may import only
those Effect modules and re-exports plan types only; `@eedsh/cli` and
`@eedsh/config` declare no production DSH dependency and contain no static DSH
import; no generated or runtime manifest carries `engines.dsh`; plan, config, and
CLI must use the same exact Effect version; the workspace declares no separate
`@effect/cli`, `@effect/platform`, or `@effect/printer*` packages and no source
imports one; `@eedsh/runtime` may not depend on or import Effect or the
TypeScript toolchain.

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
node packages/cli/lib/bin.js init --no-install
node packages/cli/lib/bin.js sync
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
`@eedsh/config`, `@eedsh/plan`, and `@eedsh/runtime` emit `lib/index.js` with
`lib/index.d.ts` and source maps, while `@eedsh/cli` emits only the executable
`lib/bin.js` and has no library entry. Dependencies and workspace packages stay
external to the bundles.
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
packages/plan     @eedsh/plan
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