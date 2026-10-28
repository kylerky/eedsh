# @eedsh/config

The typed authoring and query surface for eedsh. `defineConfig()` starts a
synchronous fluent builder, `bundle(name)` returns a handle that is both a plan
selection and a query root, and layers, rows, and presets are typed objects.
Typed objects normalize to plain plan data only at `build()`, so the persisted
plan stays strict JSON.

The plan contract itself lives in [`@eedsh/plan`](../plan/README.md): the Effect
Schema and derived types, strict plan and config-envelope validation, and canonical
JSON. This package composes those primitives for authoring and re-exports the plan
types, so `ProfilePlan` and friends can be imported from the package you already
use.

There is no DSH runtime dependency and no Effect runtime here. Effect is a peer
dependency (also a dev dependency here) for the `Result`/`Schema.SchemaError`
authoring surface; the source imports Effect through `effect/Result` and
`effect/Schema` only. Authoring is synchronous because a config module must
default-export data before tsx and DSH can consume it.

## Example

```ts
import { bundle, defineConfig, js } from '@eedsh/config'

const standard = bundle('@deepseek-ai/dsh-web-app').presets()[0]

export default defineConfig()
  .dsh('0.2.1-rc.2')
  .defaultProfile('work')
  .profile('work', (profile) => {
    profile
      .package('@scope/my-plugin', 'link:../packages/my-plugin')
      .bundle('@deepseek-ai/dsh-base')
      .bundle('@deepseek-ai/dsh-web-app')
      .generated()
      .layer('plugins', (layer) => {
        layer
          .insert({ id: 'my-plugin', name: '@scope/my-plugin', config: { enabled: true } })
          .disable(standard ?? 'preset-minimal')
          .override('agent-default-model', { provider: 'deepseek', model: 'deepseek-chat' })
          .insert({
            id: 'plugin-manager',
            name: '@deepseek-ai/dsh-plugin-manager',
            disabled: js("!ctx.get('profileContext')"),
          })
      })
  })
  .build()
```

## API

### `defineConfig()` and `ConfigBuilder`

`defineConfig()` returns a mutable, single-use builder:

- `.dsh(pin)` sets one exact DSH version.
- `.defaultProfile(name)` names the profile a command selects when none is named.
- `.profile(name, build)` declares a profile; the callback receives a
  `ProfileBuilder` scoped to that profile, and its return value is ignored.
- `.build()` normalizes typed objects, validates the envelope and every profile,
  and returns `Result<EedshConfig, Schema.SchemaError>`. It never throws; a
  missing pin, an empty profile record, an unsafe key, or an unknown default is
  Effect's native schema failure. Each profile is validated independently and an
  invalid profile is stored as that profile's failure.

Builders are mutable because a config is assembled once. Calling `.build()` more
than once returns independent equivalent values.

### `ProfileBuilder`

- `.bundle(name | Bundle, options = {})` adds an ordered bundle selection.
  `options.source` overrides the package source. A rooted query is rejected.
- `.generated()` adds the single positional generated-bundle marker.
- `.layer(id, build?)` adds an ordered patch layer and scopes a `LayerBuilder`
  to the callback.
- `.package(name, spec)` adds one profile-local package dependency.

### `LayerBuilder`

- `.insert(entry | entries)` inserts Loader entries, typed rows, or typed
  presets.
- `.override(target, config)` replaces a row's whole config; DSH does not merge.
- `.disable(target)` / `.enable(target)` toggle a row.
- `.raw(entry)` preserves any Loader patch field the builders do not name.

Each method appends a patch and returns the layer. A patch target may be a Loader
row id, a `Row`, or a `Preset`; a `Preset` targets its own Loader row id.

`group(id, fields, children)` and `js(source)` remain small value constructors
for a group entry and a runtime expression node.

### `bundle()`, `Bundle`, and `BundleQuery`

`bundle(name, options?)` returns a `Bundle`: an ordered plan selection
(`.toJSON()` is `{ kind: 'bundle', name }`) and a query handle. With no root,
queries resolve from the pinned installation named by `EEDSH_DSH_ANCHOR` and
never from a profile copy.

- `.fromProfile(profile | { name })` returns a query-only handle rooted at a
  profile's installed copy. The structural form lets a session view be passed
  directly.
- `.fromPackageDir(dir)` returns a query-only handle rooted at a package
  directory; a relative path resolves against the directory containing the
  config file.

`BundleQuery` is deliberately not a plan selection: it has no plan-normalization
brand, no `toJSON()`, and no second root method. Passing it to
`ProfileBuilder.bundle()` is a type error and a runtime rejection.

### Queries, `Row`, and `Preset`

A handle is an immutable snapshot resolved on first use:

- `.rows()` returns every declared row as a `Row`.
- `.presets()` returns every preset as a `Preset`.
- `.row(id)` returns one `Row` by Loader id; a missing id fails.
- `.preset(id)` returns one `Preset` by preset id; a missing id fails.
- `.version()`, `.packageDir()`, and `.origin()` report the resolved package
  facts; `.origin()` is `pinned`, `profile`, `packageDir`, or `preview`.

`Row` exposes `bundle`, `id`, `data`, `toJSON()`, and the patch methods
`disable()`, `enable()`, and `override(config)`. `Preset` adds `rowId`,
`id`, `order`, `name`, and `disabled`; its patch methods target `rowId`.
Handles are immutable; patch methods return plain patch data.

Failures are `ResolutionError` values with a stable `code`, the queried
`bundle`, and a message. A failed resolution, missing row or preset, or invalid
root fails rather than returning partial data.

## Normalization

Typed objects carry a global brand symbol and implement `.toJSON()`.
`defineConfig().build()` recursively replaces branded objects with their plain
values before validation; no method or class instance reaches the plan.
`@eedsh/plan` remains unchanged and still rejects functions, class instances,
non-finite numbers, and circular data. A rooted `BundleQuery` has no brand, so it
cannot be silently accepted as a plan selection.

## Config value

`build()` produces one `EedshConfig`, re-exported from `@eedsh/plan`:

```ts
interface EedshConfig {
  readonly dsh: string
  readonly defaultProfile?: string
  readonly profiles: Readonly<
    Record<string, Result.Result<ProfilePlan, Schema.SchemaError>>
  >
}
```

The profile key is the profile's sole identity. Config-level defects fail the
whole config; profile defects stay local, so selecting, publishing, or running a
valid sibling is unaffected.

## Exports

The public surface is the typed authoring API: `defineConfig`, `ConfigBuilder`,
`ProfileBuilder`, `LayerBuilder`, `bundle`, `Bundle`, `BundleQuery`,
`Row`, `Preset`, `group`, `js`, `ResolutionError`, the resolution-trace
helpers, and the re-exported plan types. The legacy free helpers (`rows`,
`presets`, `row`, `defineProfile`, `insert`, `override`, `disable`,
`enable`, `layer`, `raw`) are not exported.

Runtime plan validation is not re-exported: import `validatePlan`,
`validateConfigValue`, `ProfilePlanSchema`, or `EedshConfigSchema` from
`@eedsh/plan` directly.

## Migration

The free-function API is intentionally replaced. The root [README](../README.md#migrating-from-the-free-function-api)
has the full before/after mapping; the persisted plan format is unchanged.
