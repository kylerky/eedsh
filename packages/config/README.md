# @eedsh/config

The public typed authoring surface for eedsh profiles: `defineProfile` plus helpers
that map one-to-one onto DSH Loader patch concepts, a versioned JSON plan, recursive
validation, a TypeBox schema, and canonical hashing.

No DSH runtime and no Effect: this package is plain TypeScript data, so config
authors install only what they need.

## Example

```ts
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
})
```

## API

- `defineProfile(input)` — validates and returns a `ProfilePlan`. It throws
  `PlanValidationError` with stable codes and plan locations; it does not execute
  anything.
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

## Plan

```ts
interface ProfilePlan {
  format: 'eedsh/profile-plan'
  version: 1
  profile: { name: string }
  dsh: string // exact DSH pin
  bundles: ({ kind: 'bundle'; name: string; source?: string } | { kind: 'generated' })[]
  layers: { id: string; patches: Record<string, unknown>[] }[]
  packages: Record<string, string>
}
```

The plan is JSON-compatible by contract. Validation rejects functions, symbols,
BigInt, `undefined`, non-finite numbers, circular references, class instances, and
malformed expression nodes, with a stable code and the failing location (for
example `plan.unsupported_value at layers[0].patches[0].config.fn`). It also rejects
missing identity, duplicate or unsafe layer ids, duplicate bundles or markers,
reserved names, and invalid package specs.

Additional exports:

- `validatePlan(value)` — `{ ok: true, plan } | { ok: false, issues }`.
- `assertPlan(value)` — validated plan or `PlanValidationError`.
- `ProfilePlanSchema` — the TypeBox structure contract.
- `canonicalJson(value)` / `hashPlan(plan)` — sorted-key JSON and SHA-256.
