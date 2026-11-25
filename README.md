# eedsh

Typed TypeScript configuration for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). eedsh publishes ordered bundles, patch layers, and dependencies as profiles that DSH can boot directly.

## Install

You need Node.js 26 or later, pnpm on `PATH`, and a pre-installed DeepSeek
Harness.

```sh
npm install -g @deepseek-ai/dsh @eedsh/cli
eedsh init
```

`init` scaffolds `config.ts`, `package.json`, and `tsconfig.json` in
`$XDG_CONFIG_HOME/eedsh` (default `~/.config/eedsh`), preserves existing files,
and installs dependencies. Use `--no-install` to scaffold only. Initialization
can run before DSH is installed.

## Quick start

Replace the contents of the scaffolded `config.ts` with this profile.

```ts
import { defineConfig } from '@eedsh/config'

export default () => defineConfig()
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
```

```sh
eedsh check
eedsh run -- --port 3080
```

`run` syncs the selected profile before launching DSH. To publish without
launching, use `eedsh sync`. To inspect the published profile, use `eedsh doctor
--profile work`.

## Commands

| Command | What it does |
|---|---|
| `init` | Scaffold the config project. Use `--dsh <path>` to record a DSH installation. |
| `check` | Run the config project's TypeScript compiler with `--noEmit`. Arguments after `--` go to TypeScript. |
| `sync` | Publish all profiles, or only `--profile <name>`. Use `--watch` to publish on edits, `--strict` to fail on preflight warnings, and `--explain` for warning provenance. |
| `doctor` | Check published manifests, generation artifacts, and dependencies. With `--profile <name>`, inspect the published profile directly. Use `--strict` to fail on warnings. |
| `run` | Sync and launch DSH. Use `--no-sync` to launch an existing publication. Arguments after `--` go to DSH. |
| `repl` | Explore the config and composed profile in a TypeScript prompt. Use `--eval <expression>` for a single expression. |

Use `eedsh <command> --help` for flags. Commands that evaluate a config use the
XDG project's `config.ts` by default and accept `--config <path>` for another
`.ts` file. Single-profile commands choose the explicit `--profile`, then the
configured `.defaultProfile(name)`, then the sole profile.

DSH discovery checks `--dsh <path>`, `EEDSH_DSH_ANCHOR`, the `dsh` launcher on
`PATH`, the recorded anchor at `$DSH_HOME/.local/state/installation.json`, and a
project-local installation, in that order.

## Example configuration

The default export is a synchronous factory returning a `defineConfig()`
builder. Its input provides `dshVersion` and `configDir`. Use one
`.profile(name, build)` call per profile.

```ts
import { defineConfig, js } from '@eedsh/config'

export default () => defineConfig()
  .profile('work', (profile) => {
    profile
      .package('@scope/my-plugin', 'link:../packages/my-plugin')
      .bundle('@deepseek-ai/dsh-base')
      .bundle('@deepseek-ai/dsh-web-app')
      .generated()
      .layer((layer) => {
        layer
          .insert({ id: 'my-plugin', name: '@scope/my-plugin', config: { enabled: true } })
          .disable('repeat-tool-reminder')
      })
      .layer((layer) => {
        layer
          .override('agent-default-model', {
            provider: 'deepseek',
            model: 'deepseek-chat',
          })
          .insert({
            id: 'plugin-manager',
            name: '@deepseek-ai/dsh-plugin-manager',
            disabled: js("!ctx.get('profileContext')"),
          })
      })
  })
```

- `.bundle(name)` selects a patch bundle in order. `.generated()` positions your
  generated layers and defaults to the end of the managed bundles when omitted.
- `.layer(build)` adds an ordered patch group. Use `.layer(label, build)` to
  label it in diagnostics. `override` replaces the entire row config. `insert`,
  `enable`, `disable`, and `raw` map to Loader patches. `js()` emits an
  expression evaluated by DSH at activation.
- `.package(name, spec)` declares a profile dependency. Use `.source(name, { from, ref?, prepare? })` for git repositories or local checkouts, and add `.bundle(name)` if the package also contributes a bundle.

### Bundle queries and presets

`bundle(name).row(id)` and `.preset(id)` give typed handles for patch targets or
insertions. Use `.rows()` or `.presets()` to insert a collection. Queries
default to the discovered DSH installation. Use `.fromProfile(name)` for a
profile's installed copy or `.fromPackageDir(dir)` for a package directory.
Relative directories resolve from the config file. The CLI resolves queries
after the factory returns.

`definePreset(id).from(preset)` copies an existing preset's children into a new
definition. Customize it with `.children(build)`, insert it into a layer, and
use `layer.selectPreset(selected, { default })` to configure the registry.

### Rust LSP preset

Use `ConfigInput.dshVersion` to install the LSP packages at the exact version of the selected DSH installation. The stdio provider starts `rust-analyzer`, which must be on `PATH`. This profile adds the LSP tool to a copy of the web app's PTC preset.

```ts
import { bundle, type ConfigInput, defineConfig, definePreset } from '@eedsh/config'

const ptc = bundle('@deepseek-ai/dsh-web-app').preset('ptc')
const rust = definePreset('ptc-rust')
  .from(ptc)
  .name('PTC with Rust LSP')
  .children((children) => {
    children.append({ id: 'tool-lsp', name: '@deepseek-ai/dsh-tool-lsp' })
  })

export default ({ dshVersion }: ConfigInput) =>
  defineConfig().profile('rust', (profile) => {
    profile
      .package('@deepseek-ai/dsh-lsp', dshVersion)
      .package('@deepseek-ai/dsh-lsp-stdio', dshVersion)
      .package('@deepseek-ai/dsh-tool-lsp', dshVersion)
      .bundle('@deepseek-ai/dsh-base')
      .bundle('@deepseek-ai/dsh-web-app')
      .generated()
      .layer('Rust language server', (layer) => {
        layer.insert({ name: '@deepseek-ai/dsh-lsp' }).insert({
          name: '@deepseek-ai/dsh-lsp-stdio',
          config: {
            servers: {
              rust: { command: 'rust-analyzer', extensionToLanguage: { '.rs': 'rust' } },
            },
          },
        })
      })
      .layer('Rust preset', (layer) => {
        layer.insert(rust)
        layer.selectPreset(rust, { default: rust })
      })
  })
```

Launch it with `eedsh run --profile rust`.

### Source packages

Relative local paths resolve from the config directory. A git source defaults to
`pnpm install` and `pnpm run build`, while a local source runs only explicitly
declared preparation commands. `prepare` takes an array of argument arrays. Use
`sync --rebuild` to force preparation or `sync --no-build` to fail when
preparation is needed. See the [source bundle
walkthrough](docs/manual-acceptance-source-bundles.md).

### REPL

Inspect `config`, `selectedProfile`, or `plan`, and use `.profile <name>` to
switch profiles. The prompt re-evaluates on saves and shows plan diffs. Use
`.resolve <package>@<version>` to preview an uninstalled bundle, `.sync` to
publish, or `.sync on` to publish after successful saves. Use `.help` for the
full command list.

## Published profiles

`sync` writes to `$DSH_HOME/profiles/<name>` (default `~/.dsh/profiles/<name>`).
It reconciles managed bundles and dependencies, preserves user-owned manifest
entries, and keeps the previous generation available if publication fails.
Removing a profile from the config leaves its published directory in place.

The generated bundle sits beneath the profile's own `cordis.patch.yml`, the
harness-home patch, and invocation overlays. The runtime watches the published
generation and asks DSH to reconcile when HMR is active. Changes that DSH marks
as restart-required take effect on the next launch.

## Build from source

Use Node.js 26 or later and pnpm 12.14.0.

```sh
pnpm install
pnpm build
node packages/cli/lib/bin.js --help
```

`pnpm verify` runs lint and format checks, typechecking, tests, and package
builds. Run the slow Web HMR integration test with `pnpm test:slow`.

The workspace contains `packages/config` for authoring, `packages/plan` for
validation, `packages/cli` for the command line and publication, and
`packages/runtime` for DSH hot reload.
