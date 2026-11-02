# Proposal: Extract the plan contract into `@eedsh/plan`

## Why

`@eedsh/config` currently carries two responsibilities at once: the pure plan contract
(schema, validation, canonical JSON, hashing, config-envelope validation) and the authoring
API. The Effect boundary spec pins that package to `effect/Schema` and `effect/Result`
*only* because it is the contract every consumer shares. Authoring needs Node I/O and bundle
resolution, so keeping both in one package either breaks the boundary or duplicates the plan.
Splitting the plan out keeps the shared contract pure while the authoring package keeps its
familiar name.

## What Changes

- Add `@eedsh/plan`: plan constants, types, Effect schema, validation, canonical JSON,
  plain-object and hash helpers, plus config-envelope decoding and `validateConfigValue`.
  It imports Effect through `Schema` and `Result` only.
- Redefine `@eedsh/config` as the authoring package: `defineConfig`, `defineProfile`, and
  the patch helpers, built on `@eedsh/plan`, Node builtins, and Effect-free DSH helpers.
  The authoring API stays synchronous and gains no Effect runtime.
- Rewire the CLI to import plan symbols from `@eedsh/plan`; the CLI keeps
  `@eedsh/config` only to resolve its package version for `eedsh init`.
- Update the Effect boundary spec: retarget the schema-and-result requirement to
  `@eedsh/plan`, require one shared Effect version across plan, config, and CLI, and add
  the authoring-package rule (no Effect runtime, synchronous, Effect-free DSH helpers only).
- **BREAKING** (internal, pre-1.0): `@eedsh/config` no longer exports plan symbols. No
  authoring import changes: `config.ts` still imports `@eedsh/config`, and `eedsh init`
  writes the same dependency set.
- Unchanged on purpose: `PLAN_FORMAT` (`eedsh/profile-plan`), the plan JSON shape, the
  generation record, and every published-profile artifact.

## Capabilities

### New Capabilities

None. The split changes package ownership and the enforced boundary, not the behavior the
existing capabilities describe.

### Modified Capabilities

- `effect-runtime-boundary`: the "schema and result only" requirement moves from
  `@eedsh/config` to `@eedsh/plan`; the shared-Effect-version requirement covers plan,
  config, and CLI; a new requirement bounds what the authoring package may import.

## Impact

- `packages/config` shrinks to the authoring surface; `packages/plan` is new (build config,
  exports, tsconfig, workspace entry).
- CLI import sites move: `config.ts`, `selection.ts`, `cli.ts`, `doctor.ts`,
  `preflight.ts`, `materialize/{publish,program,manifest,generated-bundle,yaml}.ts`,
  `internal/effect/services.ts`.
- `packages/config/test/plan/*` moves with the code to `packages/plan/test`; CLI tests
  split their imports by symbol.
- `test/architecture.test.ts` gains the plan package and the new authoring rule.
- README package diagram and descriptions; `pnpm-workspace` already covers `packages/*`.
