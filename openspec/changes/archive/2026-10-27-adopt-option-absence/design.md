## Context

See `proposal.md` - Why. The CLI has finished moving its external data readers onto `effect/Schema`, but absence is still encoded as `undefined` or a sentinel string. The workspace uses strict TypeScript, including `exactOptionalPropertyTypes`, and already has two explicit multi-state representations: `GenerationLookup` and `readStrictSection`'s `SectionRead`. Effect 4.0.6 provides `Option` and `Option.fromUndefinedOr`.

This change is CLI-only. `@eedsh/config` keeps its Schema/Result boundary and `@eedsh/runtime` remains Effect-free.

## Goals / Non-Goals

**Goals:**

- Make absence a first-class CLI domain value with `Option<T>`.
- Force callers to choose a fallback or branch explicitly at the point where absence matters.
- Keep `undefined` only at JavaScript, JSON, process-environment, and third-party boundaries.
- Preserve every current CLI behavior: output text, exit codes, on-disk formats, and diagnostic wording.
- Leave total container readers and multi-state ADTs intact.

**Non-Goals:**

- Changing CLI flags, exit codes, generation or profile formats, or diagnostics.
- Introducing `Option` into `@eedsh/config` or `@eedsh/runtime`.
- Replacing `Result` with `Option` for fallible I/O.
- Reworking `resolveTypeScript` into a richer diagnostic type.
- Converting optional JavaScript parameters, uninitialized state, or environment maps.

## Decisions

### D1. Option marks CLI domain absence; undefined stays at the edge

The CLI domain uses `Option` when a value may be absent. `undefined` remains acceptable only where an external shape requires it:

| Boundary | Representation |
| --- | --- |
| JSON properties that must be omitted | `undefined` |
| `process.env` values | `undefined` |
| Third-party option bags and callbacks | `undefined` |
| Internal uninitialized state (timers, loader registration) | `undefined` |
| CLI readers and domain fields | `Option<T>` |
| Fallible I/O and validation | `Result` / Effect failure |

*Alternatives.* Keeping `undefined` everywhere leaves the current ambiguity. Making `Option` mandatory even for JS APIs would add wrapping noise at boundaries and change third-party contracts.

### D2. Absence-returning readers return Option

Convert the leaf readers to `Option`:

- `readOptionalString` returns `Option<string>` and decodes `Schema.String` directly, so missing and malformed both become `None` and empty strings remain `Some('')`.
- `readVersion` returns `Option<string>`; its `fallback` parameter is removed, and callers use `Option.getOrElse`.
- `readOptional` returns `Effect<Option<string>, PlatformError>`.
- `readJsonFile` returns `Effect<Option<Record<string, unknown>>, PlatformError>`; JSON parse failures remain Effect failures.
- `findConfigPath`, `findUnsupportedConfigPath`, `findTsconfigPath`, `readPackageBin`, and `resolvedVersion` return `Option<string>`.
- `resolveTypeScript` returns `Option<TypeScriptInstallation>`.

The fallback decision moves to the caller. This removes sentinels such as `'unknown'`, `'0.0.0'`, and the conditional spreads that turn optional fields back into `undefined`.

*Alternatives.* Keeping `readVersion(value, fallback)` hides policy in the reader. Returning `Result` for every optional read would overstate malformed data as a failure where the current contract is a fallback.

### D3. Domain fields are required Option values

Domain types use required `Option` fields, not optional properties and not `Option | undefined`:

- `LockfileEntry` fields.
- `ReconcileManifestInput.manifest` and `.previous`.
- `CleanedDependencySections` fields.
- `PublishProfileInput.previousManifest` and `ProfileSnapshot` contents.
- `DoctorFinding.path` and doctor's internal record, plan, and lockfile returns.
- CLI command inputs such as `configPath` and `profile`.
- Manifest reader parameters, including `readProfileBundles`, `readProfileDependencies`, `declaredDependencyNames`, `hasManagedBundles`, and `scanDependencyConflicts`.

Required fields force every constructor to state absence. JSON writers unwrap only when constructing the serialized object. Markdown/text diagnostics use `Option.match` or `Option.getOrElse` rather than `??`.

*Alternatives.* Optional `Option` properties would reintroduce `undefined` and defeat the convention. Using `Option` only in readers while leaving domain fields optional would produce constant unwrapping and no clarity gain.

### D4. Containers and multi-state results stay plain

- `readStringArray`, `readStringRecord`, and `readRecord` keep returning `[]`, `{}`, and `{}`. A container fallback is not absence; `Option<string[]>` would conflate an empty array with a missing one.
- `readStrictSection` keeps its `absent | valid | malformed` ADT, and `GenerationLookup` keeps `missing | invalid | valid`. `Option` cannot carry the malformed or invalid state.
- `Result` remains the failure channel for parsing, filesystem, and validation errors.

*Alternatives.* `Option` for containers or ADTs would lose distinctions the existing code deliberately preserves.

### D5. Convert at explicit boundaries

- `effect/cli` already parses optional flags as `Option`; propagate those values instead of calling `Option.getOrUndefined` immediately.
- Use `Option.fromUndefinedOr` for third-party values and `.at()` lookups before switching to `Option`.
- Use `Option.getOrUndefined` only when an external serializer or API requires an omitted property, never as a routine unwrap.
- Keep `process.env`, spawn option bags, callback parameters, and internal mutable state as `undefined`.

*Alternatives.* A blanket grep-and-replace would produce `Option` wrappers around environment values and third-party options, adding noise without improving domain clarity.

### D6. Preserve behavior exactly

- Missing and malformed optional strings both become `None`.
- Empty strings remain present values.
- Version fallbacks remain `'unknown'` for TypeScript and DSH, and `'0.0.0'` for the CLI package.
- Missing files, non-object JSON, absent manifest sections, and unresolved package metadata keep their current outcomes.
- Doctor findings, messages, ordering, and exit codes are unchanged.

Tests pin both the new Option shape and the unchanged external behavior.

### D7. Verify the boundary with tests and documentation

- Update reader tests to assert `Option.none()` and `Option.some(...)`.
- Add coverage for `readOptional`, `readJsonFile`, config discovery, and `resolvedVersion` Option results where existing tests only covered downstream behavior.
- Keep integration tests unchanged unless their expected objects expose internal finding shapes.
- Document in `README.md` that CLI domain absence is `Option`, while JSON/JS/third-party edges and the config walker and runtime remain `undefined`/Effect-free exceptions as appropriate.

## Risks / Trade-offs

- **Option leaks into JSON** -> Unwrap at the exact serialization site and assert serialized output in publication tests.
- **Schema optional produces `Some(undefined)`** -> Decode `Schema.String` directly for optional strings and versions; never return `Schema.optional` output as `Option`.
- **Option hides why a value is absent** -> Keep the existing collapse; if cause-specific behavior is needed later, introduce a Result/ADT rather than overloading `None`.
- **Wide type ripples** -> Migrate leaves first, then manifest/program/publish, then doctor/CLI; run focused suites after each.
- **Test churn obscures behavior changes** -> Review diffs for output changes, not just assertion shape; integration tests remain the behavior contract.
- **Doctor finding paths become noisier** -> Use `Option.match` in formatting and keep the rendered location omitted for `None`.

## Migration Plan

1. Convert the leaf readers and their tests: schema readers, optional file reads, config discovery, TypeScript package reads, and version/bundle helpers.
2. Convert manifest, program, and publication domain types and call sites.
3. Convert doctor findings and internal Option returns.
4. Convert CLI command inputs and stop unwrapping `effect/cli` flags early.
5. Audit remaining `undefined` uses and document the boundary.
6. Run `pnpm check` and `pnpm test`; rollback is a revert of this internal refactor with no data migration.

## Open Questions

None.
