# eedsh

Typed, code-first configuration for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) profiles.

eedsh turns a TypeScript file into a normal DSH profile: ordered bundles, generated patch layers, reconciled dependencies, and a generation record that `dsh` boots like any other profile. DSH itself is untouched; its own patch precedence, plugin manager, and HMR keep working.

## Install

eedsh runs on Node.js >= 26 and needs `pnpm` on `PATH`. DSH is installed separately:

```sh
npm install -g @deepseek-ai/dsh @eedsh/cli
eedsh init
```

`eedsh init` writes `config.ts`, `package.json`, and `tsconfig.json` under `$XDG_CONFIG_HOME/eedsh` (default `~/.config/eedsh`) and installs `@eedsh/config`, its `effect` peer, and TypeScript with pnpm. It never overwrites existing files, creates no repository, and needs no DSH installation. Add `--no-install` to write the files and run `pnpm install` yourself.

`eedsh sync`, `eedsh run`, and `eedsh repl` discover exactly one DSH installation per invocation: `--dsh <path>`, then `EEDSH_DSH_ANCHOR`, then a `dsh` launcher on `PATH`, then the recorded anchor at `$DSH_HOME/.local/state/installation.json`, then a project-local `@deepseek-ai/dsh`. The version must satisfy `^0.2.1-rc.2`. When a `PATH` launcher exists but its package cannot be located, `sync` and the sync step of `run` bootstrap through pnpm or npm global metadata and record the anchor; later commands do not query a package manager. `init --dsh <path>` records an explicit anchor; `init`, `check`, and `doctor --profile` work without any installation.

## Quick start

The config lives at `$XDG_CONFIG_HOME/eedsh/config.ts`; eedsh never discovers one in the working directory.

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

`sync` publishes every profile to `$DSH_HOME/profiles/<name>` (default `~/.dsh/profiles/<name>`); `--profile work` narrows it to one. `doctor` and `run` select `--profile`, then `defaultProfile`, then the sole profile. Working from a checkout? Build it first; see [Build from source](#build-from-source).

## CLI reference

```sh
eedsh init   [--no-install] [--dsh <path>]
eedsh sync   [--profile <name>] [--config <path>] [--dsh <path>] [--strict] [--watch] [--explain] [--adopt-ownership] [--rebuild] [--no-build]
eedsh doctor [--profile <name> | --config <path>] [--dsh <path>] [--strict]
eedsh check  [--config <path>] [-- <tsc args>]
eedsh run    [--profile <name>] [--config <path>] [--dsh <path>] [--no-sync] [-- <dsh args>]
eedsh repl   [--profile <name>] [--config <path>] [--dsh <path>] [--sync] [--eval <expression>]
eedsh --help | --version
```

- `init` creates the XDG project, never overwrites `config.ts`, `package.json`, or `tsconfig.json`, and creates no repository. `--no-install` skips pnpm and prints the command. `--dsh <path>` validates and records an explicit anchor; without it init reports an existing anchor and never queries pnpm or npm. Without any installation or anchor, init still succeeds and names the first-sync bootstrap.
- `sync` publishes every profile in record order, or exactly `--profile <name>`, each under a profile lock, and installs changed dependencies with pnpm. Invalid, locked, or failed profiles do not stop valid siblings; the command exits `1` if any selected profile failed. A plan whose layers are unchanged but whose generation record names another DSH or eedsh version is republished with refreshed provenance instead of being skipped, so a manual sync after an upgrade converges without editing `config.ts`. `--strict` turns preflight warnings into a profile failure. `--watch` re-evaluates the config and selection on every change and keeps the last published generation on failure. `--explain` attributes each warning to its group, optional label, authoring site, and row ids; it is sync-only. `--adopt-ownership` re-baselines ownership only when the generation record is unreadable; it is not for re-adopting a published removal. `--rebuild` forces every source preparation step; `--no-build` refuses to prepare and names the source and commands. The two flags are mutually exclusive.
- `doctor` inspects a published profile without changing it. It prints the discovered path and version when available, errors outside `^0.2.1-rc.2`, and warns when the generation record names another version. It verifies the generation record, the authoritative `plans/<generationId>.json`, the `.eedsh/plan.json` mirror, managed bundles and dependencies, dependency-section conflicts, scaffolding, the lockfile, installed packages, and provisioned sources. A missing checkout, specification drift, or an unbuilt entry point is an error; a working tree at a different commit is a warning. It never provisions, prepares, fetches, repairs, or writes; the advisory provenance sidecar is not checked. `--profile` inspects a profile under `$DSH_HOME` without evaluating the config; otherwise doctor evaluates the config only to choose the default or sole profile. `--profile` with `--config` is a usage error, as is a config with several profiles and no default. Findings end with `N errors, M warnings`; exit `0` without errors (unless `--strict` and a warning), `1` on an error or strict warning, and `2` on usage.
- `check` finds the nearest `tsconfig.json`, resolves `typescript` from the config directory, prints the command, and runs `tsc --noEmit -p <tsconfig>`. It never evaluates or publishes; arguments after `--` go to tsc.
- `run` selects a profile, syncs it first unless `--no-sync`, then spawns the discovered launcher with `--profile <name>` and your arguments. It does not import the launcher, so argv, signals, and shutdown are DSH's.
- `repl` evaluates TypeScript against the loaded config, watches the config directory, and prints diffs and composition summaries. Bindings include `config`, `selectedProfile`, `plan`, and the authoring factories; `.profile <name>` switches profiles. Tab completes commands, chain methods, and names. Dot commands are `.help`, `.profile`, `.reload`, `.resolve`, `.sync`, `.clear`, and `.exit`. `--eval` prints one expression and exits non-zero on failure. Inspection and `.reload` never write; `.sync` (or `--sync`) publishes.
- `sync`, `run`, and `repl` require a discovered installation; see [DSH discovery and the installation anchor](#dsh-discovery-and-the-installation-anchor). `--dsh` is accepted by `init`, `sync`, `run`, `repl`, and `doctor`; `check` does not accept it.
- `--config` defaults to `$XDG_CONFIG_HOME/eedsh/config.ts` (`~/.config/eedsh/config.ts` when unset or relative), is absolute after resolution, and is never searched from the working directory. Only `.ts` is accepted; `.mts`, `.js`, and `.mjs` fail with `config.unsupported_extension` before import.
- Exit codes: `0` success, `1` validation/materialization/launch/check failure, `2` usage error. Configuration failures print Effect's native formatted schema message with location annotations; there are no stable `plan.*` codes, and each failure prints once. `check` and `run` forward the compiler's or DSH's own exit code.

## Example configuration

This is the canonical reference plan; the test suite pins its canonical JSON and hash. It adds a profile-local package and shows the main helpers.

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

The builders map one-to-one onto Loader patch concepts. `override` replaces a row's whole config; `raw` preserves a raw Loader patch entry, including fields the builders do not name. Inserting a resolved `Row` or `Preset` normalizes it to its plain Loader row; methods never reach the persisted plan.

| API | Purpose |
|---|---|
| `defineConfig()` | Start the synchronous config builder. `.defaultProfile(name)` and `.profile(name, build)` chain; `.build()` validates. There is no DSH declaration. |
| `dshVersion()` | Return the exact selected DSH version; throws a tagged `resolution.bridge_missing` outside eedsh. |
| `ConfigBuilder.build()` | Normalize typed objects, validate the envelope and every profile, and return `Result<EedshConfig, Schema.SchemaError>`. |
| `ProfileBuilder.bundle(name \| Bundle)` | Add an ordered bundle selection. A rooted query is rejected. Bundle selection never declares a dependency; a local bundle that is both calls `.bundle(name)` and `.package(name, spec)`. |
| `ProfileBuilder.generated()` | Position the generated bundle among the managed bundles. |
| `ProfileBuilder.layer(build)` | Declare an ordered, anonymous patch group scoped to its callback; identity is position. `.layer(label, build)` attaches an optional non-unique display label. |
| `ProfileBuilder.package(name, spec)` | Add a profile-local package dependency. |
| `ProfileBuilder.source(name, { from, ref?, prepare? })` | Declare a package eedsh provisions from a git source or a local checkout, prepares, and links. It declares a dependency only; select the bundle separately with `.bundle(name)`. |
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

`@eedsh/config` resolves bundle rows synchronously while `config.ts` is evaluated. Queries are methods on typed, immutable handles; rows and presets are typed values whose `.toJSON()` is the plain Loader row.

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

`bundle(name)` is both a plan selection and a query handle. With no root it resolves the active installation and never a profile copy; a custom bundle needs an explicit root. Queries run only under `eedsh sync`, `eedsh run`, or `eedsh repl`, which install the capability bridge before the config import. A rooted `BundleQuery` is query-only and rejected as a plan selection.

| Query | Returns |
|---|---|
| `.rows()` | Every declared row as a `Row`. |
| `.presets()` | Every declared preset as a `Preset`: row id, preset id, order, name, disabled flag, and row data. |
| `.row(id)` | One `Row` by Loader id; a missing id fails. |
| `.preset(id)` | One `Preset` by preset id; a missing id fails. |
| `.version()`, `.packageDir()`, `.origin()` | The resolved package facts and source. |
| `.fromProfile(name \| { name })` | A query-only handle rooted at that profile's installed copy. |
| `.fromPackageDir(dir)` | A query-only handle rooted at a package directory; a relative path resolves against `config.ts`. |

`Row.disable()`, `.enable()`, and `.override(config)` return plain patch data; `Preset` does the same but targets its Loader row id. Pass a handle to a layer builder, or call `.toJSON()` for plain plan data. Failures are structured `ResolutionError` values with a stable `code`, the queried `bundle`, and a message. Missing anchors, uninstalled profile bundles, missing manifests, non-bundle packages, unreadable patches, and unknown ids fail instead of returning partial data.

### Authoring a preset from an installed one

`definePreset(id, { rowId? })` returns a mutable definition that normalizes to an ordinary `@deepseek-ai/dsh-agent-preset` row. The row id defaults to `preset-<id>`; `rowId` overrides it. `.from(installed)` copies only the installed preset's child list, so identity and metadata stay explicit:

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

Each child operation addresses one child or anchor. `child(id)` returns a short-lived handle with `.disable()`, `.enable()`, `.remove()`, and `.replaceWith(entry)`; the scope offers `.append()`, `.prepend()`, `.insertBefore(anchor, entry)`, and `.insertAfter(anchor, entry)`. Only top-level children are addressable; a group is edited or replaced as one entry. A missing or duplicate id throws `PresetDefinitionError` with `presetId`, `rowId`, and `childId` before anything mutates. Query rows already carry plan expression nodes, so a copied `!!js` child is directly insertable and the emitted patch keeps the `!!js` scalar.

`selectPreset(selected, { default })` writes the complete `agent-preset-registry` config from two preset references. It never reads or merges the existing row and never infers the deployment default. A profile with no registry row gets the unmatched-target preflight warning (fatal with `--strict`).

### Config REPL

```sh
eedsh repl
eedsh repl --profile work --sync
eedsh repl --eval 'selectedProfile.name'
```

The prompt evaluates TypeScript, including type annotations and top-level `await`, and keeps bindings across entries. `config` is the config view, `selectedProfile` is the selected profile view, and `plan` is `selectedProfile.plan()`. The curated factories `bundle`, `defineConfig`, `definePreset`, `dshVersion`, `group`, and `js` are bound; the legacy `profile` string and raw `profiles` map are not. `.profile <name>` switches the selected profile without re-importing.

Tab completion follows the domain grammar: commands and arguments, chain methods valid at the current step, and profile, bundle, row, preset, and package names. The first Tab inserts a unique or common prefix; a second lists ambiguous matches. A rooted chain does not offer a second root, completion never writes, and a failing resolution produces no hits.

The exploration views are read-only snapshots rebuilt on load, reload, profile switch, preview change, and successful sync:

| View | Exposes |
|---|---|
| `config` | `dsh`, `defaultProfile`, `profiles()`, `profile(name)`. |
| `selectedProfile` / `config.profile(name)` | `name`, `valid`, `error`, `plan()`, `bundles()`, `layers()`, `packages()`, `entries()`, `published()`. |
| A bundle view | Plan selection data plus `rows()`, `presets()`, `row()`, `preset()`, `version()`, `packageDir()`, `origin()`. |
| `packages()` | Declared plan packages, managed runtime/generated packages, and installed manifest versions. |
| `entries()` | Composed rows with the last authoring site, group position, or bundle that touched each id. |
| `published()` | Manifest, generation record, authoritative plan path, and doctor findings; a missing profile is `exists: false`, not an error. |

After a save the prompt re-evaluates, debounces edits, prints a plan diff, and prints the composed row count and preflight warnings. Patch groups are matched by content, so adding or removing a group reports only that group. A bad save keeps the previous evaluation; `.reload` retries.

For a bundle the profile has not installed, prepare a session-local preview with `.resolve @acme/plugin-bundle@1.2.3`. The session copies the manifest, workspace file, and lockfile into `$XDG_CACHE_HOME/eedsh/repl/<hash>`, installs the exact spec, and evaluates with a printed profile-root override. `config.ts` keeps calling `.fromProfile('work')`; it never names the preview. A failed install keeps the previous evaluation; concurrent sessions serialize, completed keys are reused, and old previews are removed.

Publishing is explicit: `.sync` publishes the current evaluation, while `--sync` or `.sync on` syncs after each successful debounced save. An invalid save is not published, a failed sync pauses continuous mode until a changed save, and `.sync off` returns to inspection. When a preview-baked plan is published, the session re-evaluates against the real profile: identical plans are reported complete, divergence keeps the preview, and bundle or package-set changes require a restart.

## Configuration reference

`eedsh init` creates one XDG config project. The config must default-export the `Result` from `defineConfig().build()` (or a plain config value); a plain profile plan and the old single-plan export are not configs. eedsh evaluates the module with `tsx` at runtime, so full TypeScript syntax works without a build, but loading never typechecks. Type correctness comes from your editor, `tsc --noEmit`, or `eedsh check`. Imports resolve against the nearest `tsconfig.json` at or above `config.ts`; the caller's working-directory tsconfig is never used.

`defineConfig()` is synchronous. `.defaultProfile(name)` may name a default, `.profile(name, build)` declares each profile, and profiles may be added dynamically (loops, computed keys, environment values). `.build()` normalizes typed objects, validates the envelope with the strict config contract, then validates each profile plan independently. It returns `Result<EedshConfig, Schema.SchemaError>` and never throws. Config-level defects — a legacy `dsh` field, an empty profile record, an unsafe key, or an unknown default — fail the whole config; each profile's failure stays local and does not block a valid sibling.

Bare `sync` selects every profile; `--profile` selects exactly the named profile. `run` and `doctor` select `--profile`, then `defaultProfile`, then the sole profile. Unknown or ambiguous one-profile selections are usage errors (exit `2`) listing the available names. `check` takes no profile. Removing a profile from `config.ts` stops syncing it but does not delete its published DSH profile.

Plan validation accepts only version 2 and rejects a `dsh` field. `dshVersion()` is available for branching and logging, but the selected version is not written into the plan or generated manifest. Invalid configs and profiles print Effect's native multi-line schema message with location annotations, for example `profile key "a/b" is not usable as a profile directory` followed by `  at ["profiles"]["a/b"]`. There are no `plan.*` codes, no per-issue rewrite, and no truncation; a profile failure prints once with its name.

For project typechecking with the config project's own compiler, see [`eedsh check`](#cli-reference).

### Source provisioning

A source-only package is declared with `.source()`, which adds a dependency; `.bundle()` selects the patch layer it contributes. The `superagent` profile is a complete example: it provisions `dsh-superagent` from its prototype repository, selects its bundle, and overrides the row config it needs.

```ts
// $XDG_CONFIG_HOME/eedsh/config.ts
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@eedsh/config'

// Evaluated by eedsh when it loads the config; the plan stores the resulting
// absolute path.
const home = process.env.HOME?.trim() || homedir()
const stateDir = join(home, '.dsh', 'state', 'superagent')

export default defineConfig()
  .profile('superagent', (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-base')
      .bundle('@deepseek-ai/dsh-web-app')
      .source('dsh-superagent', {
        from: 'https://github.com/deepseek-ai/dsh-superagent-prototype.git',
        ref: 'main',
      })
      .bundle('dsh-superagent')
      .generated()
      .layer((layer) => {
        layer
          .override('webserver', { host: '127.0.0.1', port: 3082 })
          .override('dsh-superagent', { stateDir })
      })
  })
  .build()
```

The repository is `dsh-superagent-prototype`, but its package is `dsh-superagent`: `.source()` takes the package name and `from` names the repository. `.source()` provisions and builds the checkout; `.bundle('dsh-superagent')` selects the patch layer. `override` replaces a row's whole config, so `webserver` supplies both required fields and `dsh-superagent` supplies `stateDir`.

`stateDir` must be absolute. eedsh writes row config values verbatim, so `~/.dsh/state/superagent` is not expanded and the plugin rejects it at boot. Reading `process.env.HOME` while the config is evaluated produces a literal absolute path in the plan; a different `HOME` produces a different plan. For `eedsh check` and editor typechecking, the config project needs Node types:

```sh
cd ~/.config/eedsh
pnpm add -D @types/node
```

`eedsh sync` and `run` still work without them because `tsx` strips types.

The acquisition kind comes from `from` alone: a `git`, `http`, `https`, `ssh`, or `file` scheme, or an scp-like `user@host:path` form, is a git source; anything else is a local checkout. `file://` clones a local repository; a plain path is linked in place. Both name a directory, so a `.git` suffix is neither required nor implied. Relative paths resolve against the config directory; a leading `~/` in `from` expands to the user home, while row config values are written verbatim. `ref` is git-only; naming it on a local checkout is a config error.

`prepare` is an ordered list of fixed argv arrays, run in the checkout with no shell. A git source defaults to `[['pnpm', 'install'], ['pnpm', 'run', 'build']]`; a local checkout defaults to no steps, so eedsh never builds a tree you are working in unless you ask. The resolved list is recorded in the plan, so readers do not apply defaults.

`eedsh sync` provisions every declared source before reconciling the profile:

```
$DSH_HOME/.local/
  state/installation.json        installation anchor
  state/sources/<key>.json       resolved commit, preparation steps, timestamp
  sources/<key>/                 provisioned git working tree
  locks/<key>.lock               per-source provision lock
```

The key derives from the authored location and ref: one repository/ref pair maps to one checkout, and distinct refs never share a tree. A git checkout is fetched and prepared only when it is new, its resolved commit changes, or the declared steps change. A local checkout is read in place and never written unless preparation is declared. Acquisition and preparation hold the per-source kernel lock.

The dependency is materialized as `link:<absolute checkout>` and reconciled as managed: moving DSH or the checkout rewrites the manifest and installs; removing the declaration removes the dependency but leaves the checkout. The plan records the declaration and the resolved row config, including `stateDir`. After preparation the provisioned manifest must name the declared package, and its main (or `.`) and client entries must exist; a missing entry fails sync instead of surfacing at DSH boot. `doctor` reports missing checkouts, specification drift, and unbuilt packages without provisioning anything.

If a git remote is unreachable, a sync with an existing checkout and record warns and keeps the recorded commit; without a usable checkout it fails and names the source. `--rebuild` forces every preparation step, while `--no-build` fails naming the source and the commands it would run. The two flags are mutually exclusive.

## Plugin bundle authoring

A plugin can generate its own `cordis.patch.yml` from TypeScript with the `@eedsh/bundle` package instead of hand-writing the layer. The package is a development dependency only: the generated YAML is committed and included in the plugin tarball, so plain DSH can install the plugin without eedsh, and a profile can still override the plugin's rows by id.

```ts
import { defineBundlePatch, group, js } from '@eedsh/bundle'

export default defineBundlePatch((patch) => {
  patch
    .insert({ id: 'my-plugin', name: 'my-plugin' })
    .insert({
      id: 'my-plugin-windows',
      name: 'my-plugin/windows',
      disabled: js("process.platform !== 'win32'"),
    })
    .insert(
      group('my-plugin-tools', { name: 'cordis:group', isolate: { myPlugin: true } }, [
        { id: 'my-plugin-tool', name: 'my-plugin/tool' },
      ]),
    )
})
```

See [Authoring a plugin bundle patch from TypeScript](docs/plugin-bundle-authoring.md) for the build script, package metadata, compatibility rules, and the external `dsh-superagent` migration.

## How it works

### The layer model

A DSH profile is an ordered stack of bundle patch layers followed by the profile's own `cordis.patch.yml`, the harness-home patch, and invocation overlays. eedsh adds a generated bundle whose patch files are the `.layer(...)` groups.

- `bundles` keeps your authored order.
- Each `.layer(...)` declares an anonymous, ordered patch group. Its identity is its 1-based position; no identifier is authored, emitted, or hashed. `.layer(label, build)` attaches an optional, non-unique display label used only in diagnostics and the provenance sidecar.
- `.generated()` is a single positional marker. Bundles listed after it override generated defaults; the profile patch still has the final word. Without a marker the generated bundle follows every managed bundle. `@eedsh/runtime` is inserted immediately before `@eedsh/generated`; both names are reserved.
- The authoring API records the first call site outside the authoring package for every patch: file, line, column, and group label. `sync` publishes it as the advisory `.eedsh/provenance.json` sidecar. DSH never reads it, and it affects neither composition, the plan hash, nor the generation id.
- Builders mirror Loader semantics one-to-one: `insert`, `override` (whole-config replacement, no merge), `disable`, `enable`, `raw`, plus `group` and `js`. No module, fragment, preset-extension, or feature concept exists in the plan; a preset is an ordinary inserted row.

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

- patch files, the authoritative plan, and the profile manifest are written first; the plan mirror, provenance sidecar, and generated package manifest are last;
- an unchanged plan with intact artifacts changes nothing (same generation id, same bytes) and does not write a sidecar; the next publication repairs a missing one;
- the generation id covers the plan hash and every patch-group hash, so the record's `planHash` locates and verifies `plans/<generationId>.json`;
- a stale mirror or missing/mismatched plan is repaired by the next successful sync with the same generation id, without reinstalling;
- a failed install, preflight, mirror write, sidecar write, or commit leaves the previous generation published and restores the manifest, lockfile, mirror, and provenance sidecar.

### Coexist contract

The generated bundle is a normal bundle layer beneath the profile patch. Web GUI edits, Settings writes, and machine-local overrides keep winning, and `sync` never rewrites `cordis.patch.yml`, the harness-home patch, or `--patch` overlays. It creates an empty `cordis.patch.yml` only when none exists.

Ownership is last-applied. The generation record of the last successful publication is the whole ownership baseline: managed bundles and dependencies that are no longer managed are removed when the removal is published, and entries the plan does not manage are preserved. A bundle or dependency removed by a published generation and then added back by hand is user-owned and survives later syncs. Re-adding one while its removal is still unpublished does not save it, because the previous record still marks it managed.

`--adopt-ownership` is only for a profile whose generation record cannot be read (missing, malformed, or foreign). It re-baselines ownership from the current manifest; it is not a way to re-adopt a removal you already published.

### Hot reload

`@eedsh/runtime` registers only when the composition has a profile context and an active HMR service. It watches `.eedsh/generated/package.json`, skips a generation it has already reconciled, and calls `hmr.reconcileProfile()` for a new one. DSH rereads every bundle layer plus the profile patch, home patch, and overlays, so the profile patch keeps winning after reload.

After a DSH upgrade the runtime warns that the published generation names another version and recommends `eedsh sync`. That sync republishes the same generation with the running installation even when the plan is unchanged, so the warning clears after one manual sync; syncing stays explicit.

Restart-required outcomes are reported, never presented as a hot reload: a change DSH classifies as requiring a restart logs a restart diagnostic and takes effect on the next start. Without HMR the watcher does not register and the current composition keeps running until restart. Editing the TypeScript config alone reloads nothing; only a published generation does.

## Architecture

| Package | Role |
|---|---|
| `@eedsh/plan` | Shared plan contract: Effect Schema, derived plan types, `validatePlan`/`validateConfigValue`, the multi-profile envelope, and canonical JSON. Imports Effect only through `effect/Schema` and `effect/Result`, and no Node builtins. |
| `@eedsh/config` | Public typed authoring API: the fluent builder, query handles, layer/value builders, `dshVersion()`, and plan normalization. Synchronous, no Effect runtime, re-exports plan types only, and reads bundles through the CLI-installed capability bridge. |
| `@eedsh/bundle` | Publishable build-time API for a plugin bundle's Loader patch: typed `insert`/`override`/`disable`/`enable`/`raw`/`group`/`js`, DSH `!!js` YAML emission, and write/check helpers. Self-contained ESM plus declarations; no DSH or eedsh runtime dependency. |
| `@eedsh/cli` | The `eedsh` command: discovery, config resolution, `init`, tsx evaluation, selection, `check`, materialization, preflight, atomic publication, watch, and `run`. It declares no production DSH/app-boot dependency; app-boot comes from the discovered installation. |
| `@eedsh/runtime` | Static DSH bundle and plugin that watches the generation record and reloads through DSH HMR. Declares `engines.node` and no `engines.dsh`, probes the HMR capabilities it needs, and warns on version drift. |

### Effect boundaries

Effect `4.0.6` is pinned in `@eedsh/plan`, `@eedsh/config`, and `@eedsh/cli`. The plan package owns the schema and validation; the config package composes authoring primitives and may import Effect only through `effect/Schema` and `effect/Result`. The CLI takes its command surface from `effect/cli`, declares `@effect/platform-node@4.0.6`, and runs one Effect program per invocation with tagged failures plus the core `FileSystem` and `ChildProcessSpawner` services. `@eedsh/runtime` stays a plain Cordis plugin, and `defineConfig().build()` stays synchronous because a config module exports data.

Within the CLI, external contracts are decoded with `effect/Schema`, domain absence is `Option`, and expected failures are `Result` or Effect failures; only adapters and the Effect-free runtime use exceptions. `@eedsh/bundle` is self-contained and Effect-free so a plugin repository can install it without this workspace. `test/architecture.test.ts` enforces the boundaries: plan imports only `effect/Schema`/`effect/Result` and no Node builtins; plan accepts version 2 only; config re-exports plan types only; CLI/config declare no production DSH dependency and contain no static DSH import; bundle declares no Effect, DSH, or private `@eedsh/*` dependency; generated/runtime manifests omit `engines.dsh`; the same exact Effect version is used; no separate `@effect/cli`, `@effect/platform`, or `@effect/printer*` packages exist; runtime does not import Effect or the TypeScript toolchain.

## Build from source

Building from a checkout needs Node.js >= 26 and pnpm 12.14.0:

```sh
pnpm install
pnpm build
```

`pnpm build` runs the repository typecheck and builds every package. Run the built CLI from the checkout:

```sh
node packages/cli/lib/bin.js --help
node packages/cli/lib/bin.js init --no-install
node packages/cli/lib/bin.js sync
```

## Development

Biome 2.x formats, lints, and organizes imports; `tsc --noEmit` typechecks; Vitest tests. The root pins `typescript@7.1.0-beta` and `tsdown@0.23.2`; package builds emit declarations with the native TypeScript Go generator and fail without that compiler API. The root `tsconfig.json` adds `noEmit`, `@eedsh/*` path mappings, and the full include set, so `pnpm typecheck` fails on a type error anywhere, including config fixtures. Each package builds with `tsdown` to one bundled ESM entry under `lib/`: config, plan, bundle, and runtime emit `lib/index.js` with declarations and maps; CLI emits only `lib/bin.js`. Dependencies and workspace packages stay external; relative imports in package sources and tests are extensionless.

```sh
pnpm format          # biome format --write .
pnpm format:check    # biome format .
pnpm lint            # biome lint .
pnpm lint:fix        # biome lint --write .
pnpm build           # typecheck, then pnpm -r run build
pnpm build:packages  # pnpm -r run build without typecheck
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
packages/bundle   @eedsh/bundle (publish-ready build-time plugin bundle API)
packages/cli      @eedsh/cli (bin: eedsh)
packages/runtime  @eedsh/runtime (DSH bundle + HMR watcher)
test/             workspace smoke, architecture, and (slow) integration tests
docs/             manual acceptance notes
```

## Deferred

The higher-level layer is deliberately out of scope: modules, fragments, presets/`extends`, generated plugin-config types, project-level config, GUI manager augmentation, multiple profile surfaces, and upgrade/migration machinery. The plan format is versioned so that layer can be added without changing what the materializer reads.
