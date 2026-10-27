# @eedsh/config

The public typed authoring surface for eedsh: `defineConfig`, which validates a
shared DSH pin and a keyed record of `defineProfile` descriptors, plus helpers that
map one-to-one onto DSH Loader patch concepts, a versioned JSON plan, the public
Effect Schemas that are the config and plan validators and type sources,
Effect-native validation, and canonical hashing.

There is no DSH runtime dependency. Effect is part of the public contract: the
config and plan schemas, the `Result` validation values, and the native
`Schema.SchemaError` failures are Effect-native, and `effect` is a peer dependency
(also a dev dependency here). `defineProfile` returns a synchronous descriptor and
`defineConfig` returns a synchronous `Result`, because a config module must
default-export data before tsx and DSH can consume it; `validatePlan` and
`validateConfigValue` are the Effect-native entry points.

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
  plan independently. Returns `Result<EedshConfig, Schema.SchemaError>`; an envelope
  defect fails the whole Result, while an invalid profile is stored as that
  profile's failure. It does not throw.
- `defineProfile(input)` — return a detached, synchronous profile descriptor. The
  config record's key is the profile name and the config's shared `dsh` pin is
  applied to the plan; `defineProfile` itself validates nothing and does not throw.
- `validateConfigValue(value)` — normalize and validate a plain config value or a
  config-valued `Result`. It unwraps a successful Result, revalidates every profile
  (including a profile Result's success value), rejects a lone profile plan, and
  reports a failed Result as its native schema failure. A non-schema Result failure
  is a config-level `InvalidConfigValue`.
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

## Config

`defineConfig`/`validateConfigValue` produce one `EedshConfig`:

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
`EedshConfigSchema` is the public envelope schema; `ProfilePlanSchema` is the plan
schema.

## Plan

The plan type is derived from `ProfilePlanSchema`. Its properties and arrays are
readonly, and patch payloads are opaque `unknown` values:

```ts
interface ProfilePlan {
  readonly format: 'eedsh/profile-plan'
  readonly version: 1
  readonly profile: { readonly name: string }
  readonly dsh: string // exact DSH pin
  readonly bundles: readonly (
    | { readonly kind: 'bundle'; readonly name: string; readonly source?: string }
    | { readonly kind: 'generated' }
  )[]
  readonly layers: readonly {
    readonly id: string
    readonly patches: readonly { readonly [field: string]: unknown }[]
  }[]
  readonly packages: { readonly [name: string]: string }
}
```

The plan is JSON-compatible by contract. Validation rejects functions, symbols,
BigInt, `undefined`, non-finite numbers, circular references, class instances, and
malformed expression nodes, and it rejects missing identity, duplicate or unsafe
layer ids, duplicate bundles or markers, reserved names, and invalid package specs.
Each failure is reported with Effect's native formatted message: a message line
followed by its path annotation (for example
`profile name "" is not usable as a profile directory` and
`  at ["profile"]["name"]`). Issues carry no semantic error code, and the strict
decode reports every located issue in one pass (there is no deduplication or
truncation).

Additional exports:

- `validatePlan(value)` — `Result<ProfilePlan, Schema.SchemaError>` from the strict
  decode (`errors: "all"`, `onExcessProperty: "error"`); the success value is a
  detached plan. Decoding `ProfilePlanSchema` directly is more lenient and strips
  undeclared fields.
- `ProfilePlanSchema` — the public Effect Schema and the single plan definition.
- `EedshConfigSchema` — the public config envelope schema.
- `canonicalJson(value)` / `hashPlan(plan)` — sorted-key JSON and SHA-256.
