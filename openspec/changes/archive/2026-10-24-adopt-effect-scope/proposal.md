## Why

Effect is the project's default runtime, but three resource lifetimes still rely on manual cleanup. `withSyncLock` is correct but spells `acquireRelease` plus `flatMap` where one combinator exists; `writeFileAtomic` can leave a temporary file behind when the write fails; and watch mode manually disposes a `ManagedRuntime` and a watcher, can skip either cleanup when startup or close throws, and disposes the runtime while an in-flight sync is still running (`ManagedRuntime.dispose()` runs layer finalizers but does not cancel root fibers). Adopting Effect `Scope` for the lifetimes Effect can own removes this class of leak and makes interruption behavior explicit.

## What Changes

- Replace `withSyncLock`'s `Effect.scoped(Effect.acquireRelease(...).pipe(Effect.flatMap(...)))` with `Effect.acquireUseRelease(...)`. The lock is acquired, used, and released by one combinator; behavior is unchanged.
- Make `writeFileAtomic` an Effect resource. Acquire a same-directory temporary path, use it for the write and rename, and release it with a forced removal. A successful rename already removes the temp path, so the release is a no-op on success and cleans up on a write or rename failure. Pass `Effect.tryPromise`'s `AbortSignal` to `writeFile`, map failures to `FileSystemFailure`, and assign the Effect-native function directly in `nodeFileSystem` instead of wrapping it in another `tryPromise`. Add an injectable IO seam so failure cleanup is testable.
- Rewrite `syncWatch` as one scoped Effect program. `Effect.provide(layer)` builds the service layer once and releases it last; a `Queue.sliding(1)` coalesces changes and replaces the `running`/`queued` flags; the watcher is acquired and closed with `Effect.acquireRelease`; a stop signal (`AbortSignal`, SIGINT, or SIGTERM) is an `Effect.async` cleanup; and `Effect.race` stops the change loop. Remove `ManagedRuntime`, `waitForStop`, the manual `session.close()`/`runtime.dispose()` sequence, and the in-flight-run-under-disposed-services race.
- Watch-mode behavior changes: the watcher is ready before the initial sync; changes during a sync coalesce into at most one follow-up sync; a stop signal interrupts an in-flight sync and releases its lock; layer or watcher construction failure exits 1 before running a sync instead of watching; a watcher-close failure is reported as a warning while a normal stop still exits 0. Per-run config and sync failures remain reported and do not stop the session.
- Keep publication restore, lock acquisition failure handling, child-process lifetimes, the Cordis watcher, and the current service graph out of this change. Publication restore is failure-only and fallible, so an Effect finalizer would lose its typed diagnostic; child processes must run to completion; no service is stateful enough to justify `Layer.scoped`.

## Capabilities

### New Capabilities

- `watch-mode-lifecycle`: watch-session ownership and shutdown guarantees: one service layer per session, a ready watcher before the initial sync, coalesced reruns, cleanup on every exit, in-flight-run interruption, and fail-fast startup.
- `atomic-file-replacement`: atomic replacement of profile files with no leftover temporary files after a failed write or rename, an unchanged target on failure, and a typed `FileSystemFailure`.

### Modified Capabilities

None. The sync-lock refactor is behavior-preserving and relies on the existing `profile-sync-locking` contract without changing it.

## Impact

- **Code:** `packages/cli/src/internal/lock.ts`, `packages/cli/src/internal/atomic-write.ts`, `packages/cli/src/internal/effect/layer.ts`, and `packages/cli/src/cli.ts`.
- **Tests:** `packages/cli/test/internal/lock.test.ts`, `packages/cli/test/internal/effect.test.ts`, `packages/cli/test/cli.test.ts`, and a focused atomic-write test with an injected failure seam.
- **Docs:** `packages/cli/README.md` watch-mode and publication notes.
- **Dependencies:** none added or removed.
- **Behavior:** normal sync, check, and run output and exit codes are unchanged; watch startup fails fast, normal watch stop exits 0 even if watcher close warns, and failed atomic writes leave no temp files. No profile layout, generation format, CLI flag, or public API changes.
- **Sequencing:** builds on the kernel-backed `withSyncLock` from `adopt-kernel-sync-lock`; apply after that change is verified to avoid overlapping edits to the lock path.
