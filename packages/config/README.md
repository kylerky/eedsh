# @eedsh/config

The public typed authoring surface for eedsh profiles: `defineProfile` plus helpers
that map one-to-one onto DSH Loader patch concepts, a versioned JSON plan, a public
Effect Schema that is the plan's single validator and type source, Effect-native
validation, and canonical hashing.

There is no DSH runtime dependency. Effect is part of the public contract: the plan
schema, validation result, and validation error are Effect-native, and `effect` is a
peer dependency (also a dev dependency here). `defineProfile` and `assertPlan` stay
synchronous because a config module must default-export plain data before tsx and
DSH can consume it; `validatePlan` and `decodePlan` are the Effect-native entry
points.

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

- `defineProfile(input)` — validates synchronously and returns a `ProfilePlan`. It
  throws the tagged `PlanValidationError` with located issues; it does not execute
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
Each failure is a located, human-readable issue with a native path and message (for
example `layers[0].patches[0].config.fn: unsupported function value`); issues do not
carry a semantic error code. When a plan has several independent problems, validation
may report only the failures from the first failing refinement layer; the plan is
still rejected.

Additional exports:

- `validatePlan(value)` — `Either<ProfilePlan, PlanValidationError>`; identical
  issues are deduplicated and the right side is a detached plan.
- `decodePlan(value)` — `Either<ProfilePlan, ParseError>` from the strict decode
  (`errors: "all"`, `onExcessProperty: "error"`). Decoding `ProfilePlanSchema`
  directly is more lenient and strips undeclared fields.
- `assertPlan(value)` — the validated plan, or it throws `PlanValidationError`.
- `ProfilePlanSchema` — the public Effect Schema and the single plan definition.
- `PlanValidationError` — a `Data.TaggedError` carrying `issues` and a summary.
- `PlanIssue` — a `ParseResult.ArrayFormatterIssue` (`_tag`, `path`, `message`).
- `canonicalJson(value)` / `hashPlan(plan)` — sorted-key JSON and SHA-256.
