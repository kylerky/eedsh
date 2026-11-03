# @eedsh/config

The typed authoring and query surface for eedsh. `defineConfig()` starts a
synchronous fluent builder, `bundle(name)` returns a handle that is both a plan
selection and a query root, `definePreset(id)` authors an adapted agent preset,
and layers, rows, and presets are typed objects.
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
  .defaultProfile('work')
  .profile('work', (profile) => {
    profile
      .package('@scope/my-plugin', 'link:../packages/my-plugin')
      .bundle('@deepseek-ai/dsh-base')
      .bundle('@deepseek-ai/dsh-web-app')
      .generated()
      .layer((layer) => {
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

- `.defaultProfile(name)` names the profile a command selects when none is named.
- `.profile(name, build)` declares a profile; the callback receives a
  `ProfileBuilder` scoped to that profile, and its return value is ignored.
- `.build()` normalizes typed objects, validates the envelope and every profile,
  and returns `Result<EedshConfig, Schema.SchemaError>`. It never throws; a legacy
  `dsh` field, an empty profile record, an unsafe key, or an unknown default is
  Effect's native schema failure. Each profile is validated independently and an
  invalid profile is stored as that profile's failure.

Builders are mutable because a config is assembled once. Calling `.build()` more
than once returns independent equivalent values.

### `ProfileBuilder`

- `.bundle(name | Bundle)` adds an ordered bundle selection. A rooted query
  is rejected. A local bundle that also needs a profile dependency commonly calls
  both `.bundle(name)` and `.package(name, spec)`; bundle selection never
  declares a dependency.
- `.generated()` adds the single positional generated-bundle marker.
- `.layer(build)` adds an ordered, anonymous patch group and scopes a
  `LayerBuilder` to the callback. `.layer(label, build)` adds the same group
  with an optional display label. A group's identity is its position: the label
  is not unique, is never part of the plan, and does not name a file.
- `.package(name, spec)` adds one profile-local package dependency.

### `LayerBuilder`

- `.insert(entry | entries)` inserts Loader entries, typed rows, or typed
  presets.
- `.override(target, config)` replaces a row's whole config; DSH does not merge.
- `.disable(target)` / `.enable(target)` toggle a row.
- `.raw(entry)` preserves any Loader patch field the builders do not name.
- `.selectPreset(selected, { default })` writes the complete
  `agent-preset-registry` config from two preset references; the deployment
  default is required and never inferred.

Each method appends a patch and returns the layer. A patch target may be a Loader
row id, a `Row`, or a `Preset`; a `Preset` targets its own Loader row id.

`group(id, fields, children)` and `js(source)` remain small value constructors
for a group entry and a runtime expression node.

### `bundle()`, `Bundle`, and `BundleQuery`

`bundle(name)` returns a `Bundle`: an ordered plan selection
(`.toJSON()` is `{ kind: 'bundle', name }`) and a query handle. With no root,
queries resolve from the active installation the CLI selected for the invocation
through its capability bridge, and never from a profile copy. Queries outside
eedsh fail with `resolution.bridge_missing`.

- `.fromProfile(profile | { name })` returns a query-only handle rooted at a
  profile's installed copy. The structural form lets a session view be passed
  directly.
- `.fromPackageDir(dir)` returns a query-only handle rooted at a package
  directory; a relative path resolves against the directory containing the
  config file.

`BundleQuery` is deliberately not a plan selection: it has no plan-normalization
brand, no `toJSON()`, and no second root method. Passing it to
`ProfileBuilder.bundle()` is a type error and a runtime rejection.

The removed bundle `source` authoring option leaves `NamedBundle.source` as
accepted legacy plan data with no version change. Author configs use
`.bundle(name)` for the patch layer and `.package(name, spec)` for the profile
dependency.

### Queries, `Row`, and `Preset`

A handle is an immutable snapshot resolved on first use:

- `.rows()` returns every declared row as a `Row`.
- `.presets()` returns every preset as a `Preset`.
- `.row(id)` returns one `Row` by Loader id; a missing id fails.
- `.preset(id)` returns one `Preset` by preset id; a missing id fails.
- `.version()`, `.packageDir()`, and `.origin()` report the resolved package
  facts; `.origin()` is `active`, `profile`, `packageDir`, or `preview`.

`Row` exposes `bundle`, `id`, `data`, `toJSON()`, and the patch methods
`disable()`, `enable()`, and `override(config)`. `Preset` adds `rowId`,
`id`, `order`, `name`, and `disabled`; its patch methods target `rowId`.
Handles are immutable; patch methods return plain patch data.

Failures are `ResolutionError` values with a stable `code`, the queried
`bundle`, and a message. A failed resolution, missing row or preset, or invalid
root fails rather than returning partial data.

Rows and presets are plan-shaped. A runtime expression parsed from DSH's
`!!js` scalars is exposed as the plan node `{ $eedsh: { expr } }`, never as the
DSH-internal `__jsExpr` marker, so a query result is directly insertable and its
nested expressions round-trip through the emitted patch.

## Preset authoring

`definePreset(id, { rowId? })` returns a mutable `PresetDefinition`. It
normalizes to an ordinary `@deepseek-ai/dsh-agent-preset` row whose config
carries `id`, the optional name, description, and order, and the top-level child
list as `plugins`. The Loader row id defaults to `preset-<id>`.

```ts
import { bundle, defineConfig, definePreset } from '@eedsh/config'

const installed = bundle('@deepseek-ai/dsh-web-app').preset('ptc')
const standard = bundle('@deepseek-ai/dsh-web-app').preset('standard')

const adapted = definePreset('ptc-fresh')
  .from(installed) // copies only installed.config.plugins
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
      .layer((layer) => layer.insert(adapted))
      .layer('registry', (layer) => layer.selectPreset(adapted, { default: standard }))
  })
  .build()
```

- `.from(installed)` copies only the child list; identity and metadata stay with
  the definition, and the installed handle is never mutated or aliased.
- `.children(build)` is a callback scope: `child(id)` returns a short-lived
  handle with `.disable()`, `.enable()`, `.remove()`, and
  `.replaceWith(entry)`; the scope offers `.append(entry)`, `.prepend(entry)`,
  `.insertBefore(anchor, entry)`, and `.insertAfter(anchor, entry)`. Every
  operation is single-target, the callback return value is ignored, and the scope
  returns the definition.
- Only top-level children are addressable. A group is appended, replaced, or
  removed as one entry.
- A missing or duplicate child or anchor fails with a `PresetDefinitionError`
  carrying `code` (`preset.child_not_found` or `preset.child_ambiguous`),
  `presetId`, `rowId`, and `childId`; the lookup happens before any mutation.
- An invalid preset id fails with `preset.invalid_id`; a non-preset selection
  reference fails with `preset.invalid_selection`.

`LayerBuilder.selectPreset(selected, { default })` accepts an installed
`Preset` or an authored `PresetDefinition` for both values and writes
`{ id: 'agent-preset-registry', config: { default, selectedDefault } }`. It
writes the complete config, never merges the existing row, and never infers the
deployment default; a profile with no registry row gets the ordinary preflight
unmatched-target warning.

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
`Row`, `Preset`, `definePreset`, `PresetDefinition`, `PresetChildren`,
`PresetChild`, `PresetDefinitionError`, `group`, `js`, `dshVersion`,
`ResolutionError`, the bridge registry helpers, the resolution-trace helpers, and
the re-exported plan types. The legacy free helpers (`rows`,
`presets`, `row`, `defineProfile`, `insert`, `override`, `disable`,
`enable`, `layer`, `raw`) are not exported.

Runtime plan validation is not re-exported: import `validatePlan`,
`validateConfigValue`, `ProfilePlanSchema`, or `EedshConfigSchema` from
`@eedsh/plan` directly.

## Migration

The free-function API is intentionally replaced. The root [README](../README.md#migrating-from-the-free-function-api)
has the full before/after mapping. The external-DSH release removes `.dsh()`, bumps
the plan to version 2, and turns query resolution into a CLI-installed bridge; see
the root README's upgrade section.
