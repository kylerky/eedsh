# @eedsh/plan

The shared profile plan contract for eedsh: the Effect Schema and derived plan
types, the strict `validatePlan` and `validateConfigValue` entry points, the
multi-profile config envelope, and canonical JSON. Every consumer that validates,
compares, or materializes a plan imports this package; authoring and the CLI are
built on top of it.

The package is pure of Node builtins and imports Effect only through
`effect/Schema` and `effect/Result`. Effect is a peer dependency (also a dev
dependency here), pinned to the same exact version as `@eedsh/config` and
`@eedsh/cli`.

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

- `validatePlan(value)` — `Result<ProfilePlan, Schema.SchemaError>` from the strict
  decode (`errors: "all"`, `onExcessProperty: "error"`); the success value is a
  detached plan. Decoding `ProfilePlanSchema` directly is more lenient and strips
  undeclared fields.
- `ProfilePlanSchema` — the public Effect Schema and the single plan definition.
- `PLAN_FORMAT` / `PLAN_VERSION` — the stable plan identifiers.
- `canonicalJson(value)` — sorted-key JSON used for comparison and hashing.
- `RESERVED_NAMES`, `isSafeProfileName`, `DshPinSchema`, and `ProfileNameSchema` —
  the policy primitives the schema is built from.

## Config envelope

`defineConfig().build()` in `@eedsh/config` produces one `EedshConfig`; this
package owns the envelope schema and the untrusted-export normalization the CLI
uses:

```ts
interface EedshConfig {
  readonly dsh: string
  readonly defaultProfile?: string
  readonly profiles: Readonly<
    Record<string, Result.Result<ProfilePlan, Schema.SchemaError>>
  >
}
```

`EedshConfigSchema` is the public envelope schema: an exact DSH pin, a non-empty
record of safe profile keys, and a `defaultProfile` that is declared. Profile keys
are the sole profile identity; the shared `dsh` pin is injected into every profile
plan.

`validateConfigValue(value)` accepts a plain config value or a config-valued
`Result`. It unwraps a successful Result, validates the envelope, and revalidates
every profile plan, including a profile Result's success value, so a forged Result
cannot bypass the plan contract. A failed Result that is Effect's native
`SchemaError` is preserved; any other failure is a config-level
`InvalidConfigValue`. A lone profile plan is not a config.

`decodeConfigEnvelope`, `validateProfileDefinition`, and `configValue` expose the
primitives `@eedsh/config` composes for authoring.
