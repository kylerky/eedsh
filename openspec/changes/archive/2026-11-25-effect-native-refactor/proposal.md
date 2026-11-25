## Why

The workspace pays Effect at the edges and pays for it twice everywhere else. Three packages are fenced out of the Effect runtime, the runtime is confined to five CLI modules, and everything between them is adapted: eighteen optional seams on `CliRunOptions` thread dependencies, a mutable `let exitCode` carries the process result, a `globalThis` symbol bridges authoring to the installation, and the smallest IO seam (readline, chokidar, `spawnSync`, sync `node:fs`) bypasses Effect scoping and interruption entirely. The cost is structural, not cosmetic: three parallel failure channels collapse into one `unknown`-typed string switch, and every new command widens the fork between "effectful" and "plain" code.

Making the workspace Effect-native removes the fork. Effects live on one side of a package boundary, pure computation on the other, and the boundary is enforced rather than aspirational. The authoring layer stops reaching for ambient state and starts receiving its invocation inputs, which is what lets it become pure without becoming useless.

## What Changes

- **One process boundary (T0).** The CLI composes from Effect services (`Output`, `Environment`, `DshDiscovery`, `BundleResolver`, `Watcher`, `ConfigLoader`, `Materializer`, `Preflight`) provided as layers. `CliRunOptions` and `CommandRuntime` stop being dependency bags; each command returns its exit code and `bin.ts` observes the single `Exit`.
- **World access moves behind services (T0).** `spawnSync` becomes `ChildProcess`, sync `node:fs` becomes `FileSystem`, chokidar callbacks and `AbortSignal` become a `Stream` plus interruption, and readline/`node:repl` become `Terminal` plus a `Stream` of lines over `Ref`-held session state. The REPL stops re-entering `Effect.runPromise` from inside an Effect program.
- **One failure vocabulary (T1).** Each package exports one closed failure union; the CLI edge exports `EedshError`, rendered by a single exhaustive match. `describeError(unknown)`, `asRecord`, and `switch (_tag)` disappear. `Result` is restricted to pure computation, authoring misuse becomes a defect instead of a throw, and the twenty-file exception allowlist is deleted.
- **Authoring receives resolved inputs (T2).** **BREAKING** — a config module exports `(input) => ConfigBuilder`; the builder records bundle queries as descriptors instead of resolving them; the CLI resolves every recorded query in one Effect phase and then runs the pure `build()` over that resolution. `input.dshVersion` replaces `dshVersion()`. `installDshBridge`, `clearDshBridge`, the `globalThis` bridge, and the global resolution-trace store are removed, and the config package performs no IO at all.
- **The end state is enforced.** Architecture checks assert: no Node IO modules under `packages/cli/src`, no `runPromise*` outside `bin.ts`, no `throw`/`try` outside the entry safety net, and no optional callable seam standing in for a service.

## Capabilities

### New Capabilities

- `config-evaluation-inputs`: how a config module receives its invocation inputs, how authoring records queries without performing IO, and where the resolution and build phases run.

### Modified Capabilities

- `effect-runtime-boundary`: the authoring packages perform no IO and hold no ambient state, world access reaches the CLI only through Effect services, and tests override services with layers rather than callbacks.
- `error-handling`: expected failures form one closed union with exhaustive diagnostics, `Result` is limited to pure computation, the process observes one outcome at one point, and the exception allowlist is replaced by a single entry safety net.
- `authoring-objects`: the active DSH version becomes an invocation input rather than an ambient call, and bundle handles are resolved by the invocation instead of by query-time bridge state.
- `authoring-resolution`: bundle contents are resolved for the invocation before evaluation, replacing the bridge the CLI used to install before importing the config module.
- `typescript-toolchain`: the config module contract becomes a factory that receives resolved inputs, with a distinct failure for a non-factory default export.
- `profile-plan-validation`: the native `Result` is produced by the pure build phase over the invocation resolution, not by the module default export.

## Impact

- **`@eedsh/config`**: authoring builders and queries become pure and deferred; the bridge, trace store, `dshVersion()`, and resolution-time throws are removed; the module contract changes.
- **`@eedsh/cli`**: composition root, service graph, IO adapters, watcher, REPL, and the diagnostic reporter change; `CliRunOptions` is deleted; roughly forty of seventy-three source files are touched.
- **`@eedsh/plan`**: behavior unchanged; its `Result` usage is documented as the pure-computation exception.
- **`@eedsh/runtime`**: unchanged in this change (the Cordis/Effect bridge remains deliberately out of scope).
- **Config authors**: **BREAKING** — `export default defineConfig()….build()` becomes `export default (input) => defineConfig()…` with `input.dshVersion` replacing `dshVersion()`.
- **Tests**: seam-shaped unit tests migrate to layers; black-box exit-code and integration tests keep their contracts. The two modified architecture specs plus the README "Effect boundaries" section are rewritten at archive time.
