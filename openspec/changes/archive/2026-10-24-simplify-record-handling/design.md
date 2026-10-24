## Context

See `proposal.md` for motivation. The current write path is `buildManifest` in `packages/cli/src/materialize/manifest.ts`: it clones the existing manifest, narrows `dsh` and `dsh.profile` with a local `isObject`, spreads each level, mutates the result, and assigns it back. The same local guard is duplicated in `preflight.ts` and inline in `program.ts`. The manifest is a foreign JSON document, not a validated plan: unknown top-level keys and unknown `dsh`/`dsh.profile` fields must survive reconciliation.

Two boundaries shape the approach. `@eedsh/runtime` may not import Effect because of DSH's constraints, enforced by `test/architecture.test.ts`, so its local guard stays. The plan boundary in `@eedsh/config` uses a prototype-strict `isPlainObject` that rejects `Date`, `Map`, and class instances; that is a different predicate and must not be replaced by the loose record guard.

## Goals / Non-Goals

**Goals:**

- One definition of "a child node as a record, or an empty record".
- One source for the loose record guard, using Effect's predicate.
- A manifest write path that reads as a value transformation.
- Record the existing tolerance policy in the materialization spec.

**Non-Goals:**

- Changing reconciliation, publication, or generation-identifier behavior.
- Introducing a shared utility package or a generic path/lens abstraction.
- Replacing the plan boundary's `isPlainObject` with `isRecord`.
- Touching `@eedsh/runtime`.

## Decisions

### Use `effect/Predicate.isRecord` for the loose guard

`Predicate.isRecord` is the same check the local helpers use: non-null, `typeof value === 'object'`, and not an array. It is a 1:1 replacement, including for `Date`, `Map`, and class instances, which it accepts. Effect's `.d.ts` claims `isRecord(new Date())` is `false`; the implementation returns `true`, so the characterization tests pin the semantics we rely on rather than the docstring.

Alternatives considered: keeping the three local copies (the duplication is the problem); Effect's `isObject` (also accepts arrays and functions, so it is the wrong predicate); a shared `@eedsh/util` package (a package for six lines, and the runtime still cannot depend on Effect or config).

### Add a private `childRecord(parent, key)` accessor

```ts
function childRecord(
  parent: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> {
  const value = parent?.[key]
  return isRecord(value) ? value : {}
}
```

It is the one place that says "absent or malformed reads as empty". It stays private to `manifest.ts` because both callers are there; `@eedsh/config` re-exports everything from its index, so putting it there would make a manifest concern part of the public authoring API.

Alternatives considered: `asRecord(value)` alone (callers still index twice and the read/write sites are less clear); `ensureChildRecord(parent, key)` (smaller diff, but it mutates its argument and makes `structuredClone` load-bearing); a generic `updateIn(base, ['dsh', 'profile'], fn)` lens (untyped path segments, hides the one path eedsh owns, and is more code than the single write site justifies); decoding the manifest with Effect Schema (the manifest is preserved, not validated, and a malformed section is non-fatal, so decode failures would have to fall back to the same narrowing anyway).

### Build the reconciled manifest as a value

```ts
const dsh = childRecord(base, 'dsh')
return {
  ...base,
  dsh: { ...dsh, profile: { ...childRecord(dsh, 'profile'), bundles: [...bundles] } },
  dependencies,
}
```

The per-level spreads become one object literal, the write-backs disappear, and the shape states the contract: take the user's `dsh`, replace only `profile.bundles`, keep everything else. The old leaf copies were redundant because `base` is already `structuredClone(existing)`; the existing function also mutated `base` for `dependencies`, so the copies were inconsistent. `structuredClone` stays so the returned manifest remains independent of the caller's object, which is the existing guarantee this refactor should not change.

### Scope the predicate sweep to CLI guard sites

Included: `manifest.ts`, `preflight.ts`, `program.ts`, and the exactly-equivalent checks in `check.ts` and `cli.ts`. Excluded: `config.ts` (a thrown array currently formats through `JSON.stringify` and would format through `String`), `yaml.ts`/`hash.ts` (the array branch runs first; pure transforms gain nothing), `json.ts`/`schema.ts` (prototype-strict by design), and `watcher.ts` (no Effect).

### Make the spec delta additive

No existing requirement's behavior changes; the tolerance policy was previously unspecified. The delta therefore uses `## ADDED Requirements` for `Manifest reconciliation tolerates absent or non-object sections`. Using `## MODIFIED Requirements` would mean rewriting a requirement whose behavior is unchanged and risks losing detail at archive time.

## Risks / Trade-offs

- **[Effect's `isRecord` docstring contradicts its implementation]** → Characterization tests assert the accepted values; `isRecord` is not used at the plan boundary, where class instances must be rejected.
- **[Importing Effect into `manifest.ts` couples a data module to the CLI's Effect dependency]** → Import the leaf `effect/Predicate` subpath only; the module stays synchronous and touches no service, layer, or runtime.
- **[Manifest key order could change and cause generation churn]** → Object spread preserves existing key positions, and the unchanged-plan check compares canonical JSON; a test asserts that reconciling twice produces a canonically equal manifest.
- **[Behavioral drift for malformed sections]** → Characterization tests in `packages/cli/test/materialize/profile.test.ts` pin the absent, null, array, and scalar cases before and after the refactor.
- **[The sweep leaves one similar inline check in `config.ts`]** → Intentional; the array-formatting difference is observable and out of scope for a behavior-preserving refactor.

## Migration Plan

No migration. Land as small atomic commits: tests first, then the predicate and accessor, then the write-path rewrite. Rollback is reverting those commits; the profile format, generation identifier, and HMR behavior are unchanged.

## Open Questions

None.
