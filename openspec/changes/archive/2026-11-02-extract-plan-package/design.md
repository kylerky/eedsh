## Context

See proposal.md - Why. The current package layout, import sites, and enforced boundaries are the constraints this design works within:

- `packages/config` currently exports both the plan contract (schema, validation, canonical JSON, hashing) and the authoring API, and the Effect boundary spec pins it to `effect/Schema` and `effect/Result` because every consumer shares that contract.
- The CLI imports both kinds of symbols from the same specifier today (`config.ts`, `selection.ts`, `doctor.ts`, `preflight.ts`, `materialize/*`).
- `eedsh init` resolves `@eedsh/config/package.json` to write the config project's dependency spec, so the author-facing package name is load-bearing.
- `plan/hash.ts` already reaches for `node:crypto`, so the plan package is pure only by convention today.
- The architecture test at `test/architecture.test.ts` enumerates packages and enforces the Effect boundary.

## Goals / Non-Goals

**Goals:**

- One home for the plan contract, importable by every consumer without authoring dependencies.
- An authoring package free to read files and resolve bundles while staying synchronous.
- No author-facing change: `config.ts` keeps its import, `eedsh init` keeps its output.
- Enforced boundaries rather than documented conventions.

**Non-Goals:**

- Changing the plan format, plan JSON shape, or generation record.
- Changing CLI command behavior or preflight/doctor semantics.
- Adding authoring queries (that is `add-config-repl`) or publishing packages.
- Making the plan package a general-purpose standalone library.

## Decisions

### 1. Split by contract, not by convenience

`@eedsh/plan` owns everything a consumer needs to validate and compare a plan: constants, types, Effect schema, validation, canonical JSON, config-envelope decoding, and `validateConfigValue`. `@eedsh/config` owns the authoring surface: `defineConfig`, `defineProfile`, and the patch helpers.

*Alternatives considered:* keep one package and relax the Effect rule (every consumer then pays the authoring package's I/O dependencies and the boundary stops being enforceable); move authoring into a new package with a new name (rejected after naming exploration - it churns the one import authors write and the init output for no behavioral gain).

### 2. Config-envelope validation belongs to the plan package

The CLI must revalidate an untrusted export, including a forged config-valued `Result`; that path must not import authoring code. So `EedshConfigSchema`, envelope decoding, `configValue`, `InvalidConfigValue`, and `validateConfigValue` move to `@eedsh/plan`. `defineConfig` composes the same plan primitives (`validatePlan`) from the authoring side.

*Alternative considered:* keep the validator in authoring and have the CLI import it - this pulls bundle resolution, Node I/O, and eventually DSH helpers into the CLI's validation path.

### 3. Dependency direction is one-way

`@eedsh/config` depends on `@eedsh/plan`; `@eedsh/cli` depends on `@eedsh/plan` at runtime. The CLI keeps `@eedsh/config` only to `require.resolve` its manifest for `eedsh init` - never for logic.

*Alternative considered:* let the CLI depend on authoring for convenience - that makes the CLI the second consumer of a package whose purpose is to be imported by authors, and invites the boundary violations the new rule forbids.

### 4. The plan package is pure of Node builtins

`hashPlan` moves to the CLI's materialization code, where the generation record consumes it; `@eedsh/plan` then imports only `effect/Schema`, `effect/Result`, and its own modules. The spec requirement is about Effect modules, but the same reasoning applies to builtins: the plan contract should be usable wherever a schema is usable.

*Alternative considered:* leave `node:crypto` in the plan package - one builtin import is harmless now, but it sets the precedent that the contract may grow I/O.

### 5. Authoring may use Effect-free DSH helpers, and only those

The authoring package will need DSH's bundle-resolution helpers (`@deepseek-ai/dsh-app-boot`) and YAML loading (`js-yaml`) for the queries that land in `add-config-repl`. Those helpers are Effect-free and already used by the CLI, so the boundary extends rather than bends. The DSH version stays pinned and identical to the CLI's, enforced by the manifest and the single-pin test.

*Alternatives considered:* hand-rolled package resolution and YAML parsing (duplicates DSH's `!!js` handling and drifts); passing resolved rows from the CLI into the config evaluation (defeats import-time resolution).

### 6. Type-only re-exports keep author DX

`@eedsh/config` re-exports plan types with `export type`, so authors can still name `ProfilePlan` and friends from the package they already import, while runtime exports stay authoring-only. `verbatimModuleSyntax` plus the typecheck keep a runtime re-export from slipping in.

*Alternative considered:* no re-exports - authors rarely need plan types, but when they do, requiring a second import for a type is gratuitous.

## Risks / Trade-offs

- **Two packages mean two build/test surfaces** -> the workspace already builds every package with tsdown; add the plan package to the architecture test's package list and keep package-local tests beside their code.
- **Drifting Effect copies** -> the spec already requires one exact version; extend the manifest test to plan, config, and CLI and assert one lockfile resolution.
- **Silent runtime re-export from authoring** -> `verbatimModuleSyntax`, the typecheck, and a source-level boundary check that rejects non-type plan imports from `@eedsh/config`.
- **Breaking import for internal consumers** -> pre-1.0 and private; the typecheck finds every site. README notes the split.
- **Plan package used outside eedsh** -> explicitly not a goal; no compatibility promise beyond the workspace.

## Migration Plan

Land as one commit because the packages are workspace-private and nothing is published: scaffold `packages/plan`, move modules and tests, update CLI and test imports, update the architecture test, update the spec and README, then run the full verify gate. Rollback is a revert; there is no published state to reconcile.

## Open Questions

None. Whether `@eedsh/plan` ever ships as a public package is a packaging decision that does not change this design.
