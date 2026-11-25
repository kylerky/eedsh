## Context

Effect 4.0.6 is pinned across `@eedsh/plan`, `@eedsh/config`, and `@eedsh/cli`. Today the CLI runs one Effect program per invocation but reaches the world through eighteen optional seams on `CliRunOptions`, a mutable `let exitCode` in the composition root, `spawnSync`, synchronous `node:fs`, chokidar callbacks, an `AbortSignal`, and a readline REPL that re-enters `Effect.runPromise`. `@eedsh/config` performs its IO through a `globalThis` bridge the CLI installs before importing the config module, and reports failures by throwing. Three failure channels (`Result`, the Effect error channel, and `throw` behind a twenty-file allowlist) converge on one reporter that inspects `unknown` and switches on `_tag` strings.

Constraints carried into the design: the plan format stays version 2 and byte-identical for an unchanged config; publication keeps its atomic commit point; configs are still evaluated in-process through tsx with no build step; Windows parity is required; `@eedsh/runtime` stays a plain Cordis plugin and is out of scope.

## Goals / Non-Goals

**Goals:**

- One effect boundary, drawn at the package line: `@eedsh/cli` owns every effect; `@eedsh/plan` and `@eedsh/config` own none.
- One failure vocabulary with exhaustive diagnostics and no exception allowlist.
- Authoring that performs no IO and receives its invocation inputs as plain values.
- An end state the repository can enforce with architecture checks rather than review.

**Non-Goals:**

- Bridging Cordis and Effect inside `@eedsh/runtime` (the deferred T3 work).
- Changing the plan format, generation id derivation, publication ordering, or the text of existing diagnostics.
- Introducing a `ManagedRuntime` for embedders; a single one-shot runtime at the process entry is enough.
- Replacing `Result` for pure computation, or adopting `@effect/vitest` as part of this change.

## Decisions

### D1. Draw the boundary at the package line, not inside the CLI

`@eedsh/cli` is the only effectful package. `@eedsh/plan` stays schema and pure validation; `@eedsh/config` becomes a pure authoring and descriptor library. The CLI already owns every capability, so the boundary costs no new abstraction and makes the effect-free packages mechanically checkable.

Alternative rejected: allow Effect programs in every package (B2 authoring). It imports a runtime into every config project and makes authoring viral for no behavioral gain.

### D2. One service tag per capability, composed as layers

`Output`, `Environment`, `DshDiscovery`, `BundleResolver`, `ConfigLoader`, `Watcher`, plus the existing `SyncLock`, `PackageManager`, `DshInstallation`, `Preflight`, and the core `FileSystem`/`ChildProcessSpawner`/`Terminal`. The composition root merges them once in `main`; a test replaces any subset by providing its own layer.

Alternative rejected: one `EedshServices` mega-interface. It recreates the `CliRunOptions` seam list as a single record and gives tests no finer override than "all of it".

### D3. Commands return their exit code; the entry point derives the process result

Each adapter returns `Effect<number, never, CliServices>` and reports its own typed failure through the `Output` service before returning `EXIT_FAILURE`. `main` therefore has error type `never`; `bin.ts` observes one `Exit` and maps: success to the value, `CliError` to `EXIT_USAGE`, interrupts to `EXIT_FAILURE`, and a defect to a reported diagnostic plus `EXIT_FAILURE`. `setFailureContext` disappears because the reporting command no longer needs to be inferred at the boundary.

Alternative rejected: keep a `Report` service to carry the failure context to the boundary. It preserves a global switch whose only purpose is to compensate for the boundary not knowing which command ran.

### D4. One closed union per package, one `EedshError` at the edge, exhaustive rendering

Domain failures stay `Data.TaggedError` values; each package exports the closed union it can report; the CLI exports `EedshError` and renders it with a single exhaustive match. `Result` remains the return type for pure computation only, and the single `Effect.fromResult` seam marks where pure meets effect. `Schema.Class` errors are rejected: everything runs in one process, so serializability buys nothing.

Alternative rejected: purge `Result` entirely. It converts every pure validator into a generator and removes the only way to express "this computation cannot perform IO" in the type.

### D5. Authoring is a factory over inputs; queries are descriptors resolved in one phase

A config module exports `(input: ConfigInput) => ConfigBuilder`. `ConfigInput` carries `dshVersion` and `configDir` as plain values. Query handles record `{ bundle, root, row? | preset? }` and never read the filesystem. The CLI calls `builder.queries()`, resolves each distinct `(bundle, serialized root)` pair once, and then calls `builder.build(table)`.

The resolution table is total by construction: the CLI resolved every descriptor the builder reported, so a missing entry in `build` is an impossible state and is classified as a defect rather than a failure. `build` therefore keeps returning `Result<EedshConfig, Schema.SchemaError>`.

Resolution itself moves from `@eedsh/config` to `@eedsh/cli`: finding the package directory, reading its manifest, composing patch layers, and calling DSH capabilities are all IO. `@eedsh/config` keeps the handle types and the pure composition of already-loaded data.

Alternatives rejected: a declared `needs` array (cannot express a root, and duplicates what descriptors already say); keeping the bridge but making it Effect-backed (ambient runtime, `runSync` inside a library, every smell T1 removes); viral effectful callbacks (B2).

### D6. Watching is a `Stream`; shutdown is interruption

`Watcher.watch(dir)` returns `Stream.Stream<PathEvent>`; the chokidar adapter converts its callbacks once, inside an `Effect.acquireRelease`. Watch mode becomes `Stream.debounce` plus `Stream.runForEach`, and SIGINT/SIGTERM are delivered by the runtime as fiber interruption, so `stopSignal` and the `Queue.offerUnsafe` bridge disappear. The REPL runs as a loop inside the same program, reading lines from the `Terminal` service and holding its state in a `Ref`.

Alternative rejected: a `ManagedRuntime` for the REPL. It would formalize the re-entrancy this change removes.

### D7. A test seam is a layer, not a callback

`CliRunOptions` is deleted. `runEedsh(argv)` becomes `main(argv): Effect<number, never, CliServices>`, and tests call `main(argv).pipe(Effect.provide(TestLive))`. `bin.ts` keeps `Effect.runPromiseExit`. The black-box exit-code tests keep their shape; only tests that construct options change.

### D8. Enforcement replaces the allowlist

Architecture checks assert: no `node:fs`, `node:fs/promises`, `node:child_process`, `node:readline`, or `node:repl` under `packages/cli/src`; no `runPromise*` outside `bin.ts`; no `throw`, `try`, or `catch` outside the single entry safety net; no IO or module-loading Node builtin in `@eedsh/plan` or `@eedsh/config` (pure `node:path`, `node:url`, and `node:crypto` helpers stay allowed); no optional callable capability on a command input. The entry safety net is the only documented exception, and it is code, not an allowlist entry.

## Risks / Trade-offs

- **The config API break is user-facing.** Every config gains a parameter and loses `dshVersion()`. → Ship a README migration snippet and update every fixture and example in the same change; the failure is a compile error in the author's project, not silent drift.
- **Descriptor indirection surprises authors** who expect `bundle(x).rows()[0].config` at module scope. → Keep patch-target ids eager (`disable`, `enable`, `override` still work from a handle), resolve everything else at build, and document that inspection happens in the REPL where the resolution is visible.
- **The REPL rewrite is the riskiest port** (1,485 lines, 43 awaits). → Land it in two steps: first replace the nested runtime with a direct call so behavior is unchanged, then convert input and state. The existing REPL tests are the safety net.
- **Diagnostic wording churn** while replacing the `_tag` switch with a match. → Port each arm verbatim, keep the `eedsh: ` prefix construction, and add golden assertions on the current lines before deleting the switch.
- **Signal handling differs per platform.** → Keep the runtime's interruption as the single path and test watch shutdown through the fake watcher; the Windows CI matrix already exercises the suite.
- **Layers can hide missing overrides** compared with explicit options. → Provide a `TestLive` base layer so a test can omit capabilities it does not care about, and assert the production layer is never used in tests.
- **Effect 4 is a prerelease.** → No new Effect packages, no version bump; the pin stays 4.0.6 and every module comes from the consolidated `effect` entry points already in use.
- **Two phases read two sources of truth briefly** (T1 before T0b): the reporter accepts `EedshError` while some adapters still import Node modules. → Ordering keeps each commit independently green; the architecture checks flip only in the final phase.

## Migration Plan

Phase order is load-bearing; each phase is independently shippable and reviewable:

1. **Services and the process boundary (T0a).** Add the tags and a test layer, make `main` return an Effect, derive the exit code from the program value, and move reporting into the adapters. No IO converts yet.
2. **Failure vocabulary (T1).** Publish the closed unions, replace the reporter with an exhaustive match, port each diagnostic arm verbatim, and delete `describeError(unknown)`. Doing this before the IO conversions means every converted module already fails into the final union.
3. **IO conversions (T0b).** Child process, filesystem, watcher, REPL — one commit each, in that order, because each is independently testable.
4. **Authoring inputs (T2).** Factory, descriptors, resolution phase, build over the table; remove the bridge and `dshVersion()`; update fixtures, the example config, and the README.
5. **Enforcement.** Add the architecture checks, delete the allowlist, and rewrite the README boundary section.

Rollback is per phase: every phase is a commit that leaves `pnpm verify` green, and the config API break lands only in phase 4, after the CLI is already native. Archive the OpenSpec change last, when the checks are the enforcement.

## Open Questions

- Should `ConfigInput` also carry the selected profile name, letting a config branch per profile? No spec needs it today; adding a field later is backward compatible.
- Should the repository adopt `@effect/vitest` for clock and console control? Deferrable tooling choice that changes no behavior.
