## Context

See `proposal.md` for the motivation and `specs/watch-mode-lifecycle/spec.md` plus `specs/atomic-file-replacement/spec.md` for the behavior contracts. This design covers the technical choices behind those contracts.

The relevant code is small and currently uses three different lifetime styles:

- `packages/cli/src/internal/lock.ts` wraps `Effect.acquireRelease` in `Effect.scoped` and runs the materialization through `Effect.flatMap`. `SyncLockHandle.release` is an infallible `Effect<void>`, and the lock is acquired per materialization, not per service layer.
- `packages/cli/src/internal/atomic-write.ts` is plain async. It writes a same-directory temp file, retries the rename, and removes the temp only when the rename fails. `nodeFileSystem.writeFileAtomic` wraps the promise in `Effect.tryPromise`.
- `packages/cli/src/cli.ts` `syncWatch` keeps a `ManagedRuntime` for service reuse, serializes runs with `running`/`queued` flags, calls `session.close()` and `runtime.dispose()` in sequence, and starts the watcher after the initial sync. `ManagedRuntime.dispose()` runs the layer finalizers but does not cancel or await root fibers started with `runPromise`/`runFork`; in a probe, an in-flight `Effect.never` stayed pending while the layer was released and the process stayed alive. If watcher startup or `session.close()` throws, `runtime.dispose()` is skipped.

Effect 3.22.3 and Node >= 26 are fixed constraints. `Effect.acquireRelease` and `acquireUseRelease` require a release effect of type `Effect<X, never, R>`. `Effect.provide(layer)` builds the layer once around the effect and runs its finalizers on success, typed failure, defect, and interruption. `Queue.sliding(1)` keeps exactly one pending element. `Cause.isInterruptedOnly` distinguishes a stop from a real failure.

The existing watch test constrains the design: the service layer must be constructed once, the watcher must be closed once on abort, and abort must resolve with exit status 0.

## Goals / Non-Goals

**Goals:**

- Give Effect ownership of the lock handle, the atomic-write temp file, and the watch session lifetime.
- Remove manual cleanup, `ManagedRuntime`, `waitForStop`, and the `running`/`queued` flags from watch mode.
- Preserve existing sync, check, and run diagnostics, exit codes, and profile behavior.
- Make failure cleanup and interruption behavior testable without real races.
- Keep the refactor free of new dependencies and public API changes.

**Non-Goals:**

- Converting publication snapshot restore to `Scope`. It is failure-only and fallible; a `never`-error finalizer would lose the typed `FileSystemFailure` diagnostic.
- Changing how POSIX or Windows lock acquisition closes descriptors on failure. Success transfers ownership, so an `acquireUseRelease` rewrite needs a mutable transfer flag and is less clear than the explicit close.
- Scoping child processes in `check`, `pnpmInstall`, or `run`. They must run to completion; a close-time kill would truncate them.
- Adding `Layer.scoped` services. The current services are stateless; the sync lock is acquired per run, not per layer.
- Changing profile layout, generation format, CLI flags, or the Cordis runtime bundle.

## Decisions

### 1. `withSyncLock` uses `acquireUseRelease`

Replace:

```ts
Effect.scoped(
  Effect.acquireRelease(acquire, (handle) => handle.release)
    .pipe(Effect.flatMap(() => effect)),
)
```

with:

```ts
Effect.acquireUseRelease(
  acquire,
  () => effect,
  (handle) => handle.release,
)
```

The release is already infallible, so the type fits exactly. `acquireUseRelease` is the combinator for this pattern and removes the intermediate `Scope` and `flatMap`. `Effect.acquireRelease(...).pipe(Effect.using(() => effect))` is equivalent and was considered; `acquireUseRelease` is chosen because the three phases are visible in one call. There is no behavior change: release still runs on success, typed failure, defect, and interruption, and does not run when acquisition fails.

A characterization test for release-on-defect or release-on-interruption is added before the rewrite. It pins the behavior the refactor must preserve; existing success and typed-failure tests already cover the other paths.

### 2. `writeFileAtomic` becomes a scoped temp-file resource

The function changes from a Promise to:

```ts
export function writeFileAtomic(
  path: string,
  content: string,
  io: AtomicWriteIo = nodeAtomicWriteIo,
): Effect.Effect<void, FileSystemFailure>
```

The acquisition is the same-directory temp path. The use writes the content and renames the temp over the target. The release removes the temp with `rm(temp, { force: true })` and ignores any cleanup error.

No commit flag is needed. A successful rename moves the temp path out of existence, so the release is a no-op on success. On a write or rename failure, the temp still exists and the release removes it. This also covers a write that fails after creating the temp, which the current code does not.

The write receives `Effect.tryPromise`'s `AbortSignal` so interruption can cancel a large write. The rename retry and delay remain uninterruptible for simplicity; they are short. Restoring the target is not attempted after a failed rename because the target was never changed.

`AtomicWriteIo` exposes `writeFile`, `rename`, and `remove`. The default implementation uses `node:fs/promises` and the existing `renameWithRetry`. Tests inject a write that creates a partial temp and rejects, a rename that rejects, or a remove spy. This is the smallest seam that proves the cleanup contract without relying on permissions or disk exhaustion.

`nodeFileSystem.writeFileAtomic` assigns the Effect-native function directly and drops its `tryPromise` wrapper. The `FileSystemFailure` operation is `writeFileAtomic` and the path is the target path, matching the existing diagnostic shape.

Alternatives considered:

- Keep the Promise function and wrap the whole body in `try/catch`. This fixes the temp leak but does not integrate with interruption, and the layer keeps a redundant `tryPromise`.
- Use `Effect.acquireRelease` with an explicit `Effect.scoped` and a commit flag. The rename already removes the temp, so the flag is unnecessary complexity.
- Add `writeFile`/`rename` to `FileSystemShape` for testing. That widens the service interface for a single internal operation; an optional IO parameter on the module is narrower.

### 3. Watch mode is one scoped Effect program

The new shape is:

```text
Effect.provide(layer)                 layer built once, released last
  |
  +-- Queue.sliding(1)                change events; replaces queued flag
  +-- watcher (acquireRelease)        closed before queue and layer
  |
  +-- race
        +-- initial sync -> forever: take change -> load -> materialize
        +-- stop signal (AbortSignal | SIGINT | SIGTERM)
  |
  finalizers: watcher close -> queue shutdown -> layer release
```

Details:

- **Layer.** `Effect.provide(layer)` replaces `ManagedRuntime.make(layer)`. It builds the layer once for the whole session, so the existing "services constructed once" test still holds, and releases it after the program scope. A layer construction failure fails before the watcher starts, which is the fail-fast behavior in the spec.
- **Watcher.** The watcher is acquired with `Effect.acquireRelease`. Its release calls `session.close()` and catches any failure, reporting it through the command's stderr sink. A close failure on a normal stop is a warning, not a command failure; the process is stopping and the OS will clean up an unreleased watcher.
- **Changes.** `Queue.sliding<void>(1)` is acquired with a `Queue.shutdown` release. The watcher callback uses `Queue.unsafeOffer`; this is synchronous and safe for an unbounded, sliding queue. While a sync runs, additional changes replace the single pending slot, which is exactly the current `queued = true` semantics. `Queue.take` then runs one follow-up sync.
- **Stop.** `stopSignal(signal)` is an `Effect.async` that completes on `AbortSignal`, SIGINT, or SIGTERM. Its cleanup removes the abort listener or both process listeners. If the signal is already aborted, it completes immediately. `Effect.race(initial.pipe(Effect.zipRight(loop)), stopSignal)` stops the loop and runs the finalizers.
- **Ordering.** The watcher is acquired before the initial sync. The initial run and the loop run after the watcher is ready; changes during the initial run stay in the queue and cause one follow-up run. This removes the current gap where changes during the initial run are lost.
- **Per-run errors.** Each load and materialization runs under `Effect.exit`. Success prints the result; a typed failure or defect is reported with `Cause.squash` and the run returns to the loop; an interruption-only cause is re-raised with `Effect.interrupt` so the stop path is not mistaken for a failed run. This preserves the current "report and keep watching" behavior for config and sync failures.
- **Removals.** `ManagedRuntime`, `waitForStop`, `running`, `queued`, the recursive `runOnce`, `session.close()`, and `runtime.dispose()` are removed. `syncWatch` still returns a Promise to `dispatch` and runs the program with `Effect.runPromise`, so the command wiring is unchanged.
- **Exit status.** Normal stop returns 0. A layer or watcher construction failure rejects the program and exits 1. Per-run failures are reported but do not change the eventual 0. This matches the spec and the existing watch test.

Alternatives considered:

- **Keep the async function and add nested `try/finally`.** This fixes the skipped cleanup but not the in-flight run under a disposed runtime, the running/queued flags, or the initial-run ordering. It is the fallback if the Effect refactor proves too large.
- **Wrap only the runtime in `acquireUseRelease`.** This is a half-conversion: the watch body still uses promises, the watcher is still manual, and the Effect boundary buys little.
- **Use `ManagedRuntime` and await a `Deferred` before disposal.** This can drain an in-flight run but still requires manual lifecycle code and does not cancel work on stop.
- **Convert `dispatch` and `syncWatch` to Effects end to end.** Unnecessary for this change; `dispatch` already wraps the command in `Effect.tryPromise`, and `runPromise` at the watch boundary is the existing style.

### 4. Keep publication restore, lock acquisition, and child processes outside Scope

These are deliberate exclusions, not missed opportunities:

- **Publication restore.** `restoreProfileFiles` returns `Effect<void, FileSystemFailure>`. `Scope` finalizers must be `never`-error, so using `acquireRelease` would force `orDie` or swallowing and lose the typed restore diagnostic. The restore is failure-only and the snapshot is data, not a resource. `restoreOnFailure` stays. Extending it to cover the generated-manifest commit or interruption is a separate error-handling change, not a Scope refactor.
- **Lock acquisition.** `acquireAttempt` closes the descriptor on lock or inode-verification failure and transfers it to the caller on success. An `acquireUseRelease` version needs a mutable `transferred` flag and makes a security-sensitive path harder to audit. The explicit close is kept.
- **Child processes.** `check`, `pnpm install`, and `run` wait for completion; a scope finalizer that kills on close would truncate. Interruption design for children is separate.
- **Cordis watcher and tsx loader.** The runtime package cannot import Effect, and the loader is process-wide with no unregister.

### 5. Testing and documentation

- **Lock:** characterization test for release on defect or interruption in `packages/cli/test/internal/lock.test.ts`; existing success and failure tests stay.
- **Atomic write:** new focused tests with `AtomicWriteIo` for success, write failure after temp creation, rename failure, typed error operation/path, and no temp files. The existing real-filesystem test remains as an integration check.
- **Watch:** the test harness gets a layer finalizer counter. Tests cover watcher-ready initial sync, a change during the initial run, burst coalescing, abort closing once and releasing the layer, startup failure exiting 1, and in-flight interruption releasing the lock. A gate in the fake package manager keeps the in-flight test deterministic rather than timing-based.
- **Docs:** update `packages/cli/README.md` to describe one service layer per watch session, watcher-ready initial sync, coalesced reruns, interruption cleanup, fail-fast startup, and the atomic-write cleanup guarantee. Remove any claim that a `ManagedRuntime` serves every run.
- **Slow test:** run `pnpm test:slow` after implementation because the web HMR test spawns the built CLI and exercises watch mode externally.

## Risks / Trade-offs

- **Interrupting an in-flight sync on stop can abort a publication mid-write.** The generated manifest is the commit point and is written last, so readers still see the previous generation; the sync lock is released; the next sync reconciles the profile. Document this and keep the current manifest-last guarantee. If graceful drain becomes a requirement, add a separate "wait for the active run before closing" option rather than hiding it in the scope release.
- **Layer construction now fails before the watcher starts.** A missing DSH installation exits 1 instead of watching with a broken layer. This is a deliberate fail-fast improvement, but it is a behavior change; document it in the README and cover it with a test.
- **Watcher close failure is downgraded to a warning.** A real close error could be missed. Report it prominently and test the warning path; the process is exiting, so failing the command adds little.
- **Atomic-write interruption is best-effort.** `writeFile` honors the `AbortSignal`, but the rename and retry delay do not. The release runs after the use settles and removes the temp with `force`; if the underlying write ignores cancellation, cleanup can race. Normal write and rename failures are exact and tested.
- **`Effect.provide` finalizer failures have different semantics from `runtime.dispose()`.** A layer finalizer defect can surface at the end of the program. The current live services are stateless, so the risk is low; if a stateful service is added later, revisit the layer's finalizers.
- **Queue sliding intentionally drops older events.** This matches the current `queued` flag and avoids unbounded work, but the last event always produces one follow-up run. Test the burst case.
- **Test timing.** The current watch test polls for output. The new tests should use a `Deferred` or gate for "run started" and "run finished" rather than sleep-based assumptions.
- **Overlap with `adopt-kernel-sync-lock`.** Both touch `lock.ts`. Apply this change after the kernel-lock change is verified to avoid rebasing conflicts; the lock refactor is behavior-preserving and does not change the lock spec.

## Migration Plan

This is an internal refactor with a small watch-mode behavior change; there is no data or profile migration.

1. Land the lock characterization test and the `acquireUseRelease` rewrite first. It is behavior-preserving and independently revertible.
2. Land the atomic-write Effect conversion and the layer simplification next. It changes an internal function signature only; no public API is affected.
3. Land the watch conversion last, behind the existing watch tests and the slow HMR test. Update the README in the same commit.
4. Rollback is a normal revert of the three commits. No persisted state, lock-file format, or generation format changes.

Run `pnpm check`, `pnpm test`, `pnpm build:packages`, and `pnpm test:slow` before considering the change complete.
