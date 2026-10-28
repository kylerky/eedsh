# @eedsh/config

The typed authoring surface for eedsh: `defineConfig`, which validates a shared
DSH pin and a keyed record of `defineProfile` descriptors, plus helpers that map
one-to-one onto DSH Loader patch concepts.

The plan contract itself lives in [`@eedsh/plan`](../plan/README.md): the Effect
Schema and derived types, strict plan and config-envelope validation, and canonical
JSON. This package composes those primitives for authoring and re-exports the plan
types, so `ProfilePlan` and friends can be imported from the package you already
use.

There is no DSH runtime dependency and no Effect runtime here. Effect is a peer
dependency (also a dev dependency here) for the `Result`/`Schema.SchemaError`
authoring surface; the source imports Effect through `effect/Result` and
`effect/Schema` only. `defineProfile` returns a synchronous descriptor and
`defineConfig` returns a synchronous `Result`, because a config module must
default-export data before tsx and DSH can consume it.

## Example

```ts
import {
  bundle,
  defineConfig,
  defineProfile,
  disable,
  generated,
  insert,
  js,
  layer,
  override,
} from '@eedsh/config'

export default defineConfig({
  dsh: '0.2.1-rc.2',
  defaultProfile: 'work',
  profiles: {
    work: defineProfile({
      packages: { '@scope/my-plugin': 'link:../packages/my-plugin' },
      bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
      layers: [
        layer('plugins', [
          insert({ id: 'my-plugin', name: '@scope/my-plugin', config: { enabled: true } }),
          disable('repeat-tool-reminder'),
          override('agent-default-model', { provider: 'deepseek', model: 'deepseek-chat' }),
          insert({
            id: 'plugin-manager',
            name: '@deepseek-ai/dsh-plugin-manager',
            disabled: js("!ctx.get('profileContext')"),
          }),
        ]),
      ],
    }),
    home: defineProfile({
      bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
    }),
  },
})
```

## API

- `defineConfig(input)` — validate the config envelope (one exact DSH pin, safe
  non-empty profile keys, and a declared default) and then validate each profile
  plan independently with `@eedsh/plan`. Returns
  `Result<EedshConfig, Schema.SchemaError>`; an envelope defect fails the whole
  Result, while an invalid profile is stored as that profile's failure. It does not
  throw.
- `defineProfile(input)` — return a detached, synchronous profile descriptor. The
  config record's key is the profile name and the config's shared `dsh` pin is
  applied to the plan; `defineProfile` itself validates nothing and does not throw.
- `bundle(name, { source? })` — one ordered bundle selection. `@eedsh/runtime` and
  `@eedsh/generated` are reserved.
- `generated()` — the positional marker for the generated layer; at most one.
- `layer(id, patches)` — an ordered patch layer. Ids are safe kebab-case and become
  patch file names.
- `insert(entry | entry[])` — insert Loader entries.
- `override(id, config)` — replace a row's whole config (DSH does not merge).
- `disable(id)` / `enable(id)` — toggle a row.
- `group(id, fields, children)` — a group entry with an isolate map and ordered
  children; pass it to `insert`.
- `js(source)` — a structured `{ "$eedsh": { "expr": source } }` expression node. The
  source is stored verbatim and emitted as a `!!js` scalar by the CLI; it is never
  evaluated here.
- `raw(entry)` — preserve any Loader patch field the helpers do not name.

## Authoring queries

The package resolves bundle rows synchronously while `config.ts` is evaluated:

```ts
import { presets, row, rows } from '@eedsh/config'

const presetsInWeb = presets('@deepseek-ai/dsh-web-app')
const timer = row('@deepseek-ai/dsh-base', 'timer')
const fromWork = rows('@acme/plugin-bundle', { profile: 'work' })
const vendored = row('@acme/plugin-bundle', 'acme-row', {
  packageDir: '../vendor/plugin-bundle',
})
```

- No root reads the pinned installation named by `EEDSH_DSH_ANCHOR`; it never
  falls back to a profile copy. The CLI sets the anchor to its pinned DSH
  manifest for the config import.
- `{ profile }` reads that profile's installed copy through the shared DSH home.
- `{ packageDir }` reads the named package directory; a relative path resolves
  against the directory containing `config.ts`.
- Supplying both roots is an error.

`presets(bundle)` returns frozen `{ rowId, id, order?, name?, disabled? }`
summaries. `rows(bundle)` returns every declared row, and `row(bundle, rowId)`
returns one; both are frozen, plain JSON and can be passed to `insert` or used
for targeting. Failures are `ResolutionError` values with a stable `code`, the
queried `bundle`, and a message.

## Config

`defineConfig` produces one `EedshConfig`, re-exported from `@eedsh/plan`:

```ts
interface EedshConfig {
  readonly dsh: string
  readonly defaultProfile?: string
  readonly profiles: Readonly<
    Record<string, Result.Result<ProfilePlan, Schema.SchemaError>>
  >
}
```

The record key is the profile's sole identity. Records built dynamically from
spreads, computed keys, loops, or environment values are accepted. Config-level
defects fail the whole config: an absent or malformed `dsh` pin, an empty profile
record, an unsafe profile key, or a `defaultProfile` that is not a key. Profile
defects stay local: selecting, publishing, or running a valid sibling is unaffected.

Each profile is a `ProfilePlan`; see the [`@eedsh/plan` README](../plan/README.md)
for the plan shape, the validation rules, and canonical JSON.

## Re-exported plan types

`@eedsh/config` re-exports these types from `@eedsh/plan`: `EedshConfig`,
`InvalidConfigValue`, `ProfilePlan`, `PlanBundle`, `PlanLayer`, `PlanPatch`,
`NamedBundle`, `GeneratedBundle`, `ExpressionNode`, `JsonValue`, `JsonObject`,
and `JsonPrimitive`. Runtime validation is not re-exported: import
`validatePlan`, `validateConfigValue`, `ProfilePlanSchema`, or
`EedshConfigSchema` from `@eedsh/plan` directly.
