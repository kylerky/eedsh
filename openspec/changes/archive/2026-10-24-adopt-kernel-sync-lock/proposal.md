## Why

The current profile sync lock is a PID-and-file protocol: a process creates `.eedsh/sync.lock`, later runs read its PID, and may `remove` the lock when the PID looks dead. That is a time-of-check-to-time-of-use race: a stale-lock takeover can delete a lock another process has just acquired, and a live lock can be read as empty before its content is written. Two syncs can then enter the same profile's critical section and interleave manifest snapshots, package installation, restoration, and the generated-manifest commit.

The lock should be owned by the kernel on every supported platform. Linux and macOS already have a proven POSIX flock implementation in `@deepseek-ai/node-addon-system/flock`; Windows has a proven named kernel semaphore implementation in DSH's session persistence, reached through koffi. Both release automatically when the holding process dies, so no PID probing, stale-file takeover, or manual lock-file recovery is needed.

## What Changes

- Replace the PID lock protocol in `@eedsh/cli` with a small `SyncLock` service whose live implementation is selected by platform.
- On Linux and macOS, acquire an exclusive non-blocking `flock` on the persistent `.eedsh/sync.lock` file. Keep the descriptor open for the critical section; release by closing it. Never unlink, rename, or atomically replace the lock file. After acquiring, verify the locked inode is still the file at the lock path and retry if it was replaced.
- On Windows, acquire a named kernel semaphore derived from the canonical lock path, using koffi to call `CreateSemaphoreW`, `WaitForSingleObject` with a zero timeout, `ReleaseSemaphore`, and `CloseHandle`. The Windows lock has no filesystem footprint; the path is only a name seed.
- Fail fast with the existing `SyncLocked` diagnostic when another sync holds the lock. Remove the PID field from the diagnostic because kernel locks do not expose a portable holder PID.
- Fail with a clear `FileSystemFailure` when the platform is unsupported, the POSIX flock binding cannot load, or the Windows FFI binding fails. Do not fall back to the old PID/takeover protocol.
- Remove `SyncLockOptions`, `isPidAlive`, the lock-file Schema and PID parser, the polling/takeover loop, and the now-unused `FileSystemShape.writeFileExclusive` primitive.
- Keep the implementation behind a testable `SyncLock` service so materializer tests continue to use in-memory services, and add real kernel-lock tests plus Windows CI coverage.
- Update the CLI documentation to describe the persistent POSIX lock file, the Windows kernel semaphore, automatic crash release, and the platform scope.
- **Out of scope:** the separate Effect-native refactor of `atomic-write.ts`. Atomic-write remains for file replacement only and is not used for the sync lock.

## Capabilities

### New Capabilities

- `profile-sync-locking`: kernel-backed, per-profile serialization of materialization across Linux, macOS, and Windows, including crash-safe release and platform-specific lock lifetime.

### Modified Capabilities

None.

## Impact

- **Code:** `packages/cli/src/internal/lock.ts` becomes a thin `withSyncLock` wrapper over a new `SyncLock` service; add platform implementations for POSIX flock and Windows semaphore; update `packages/cli/src/internal/effect/services.ts`, `layer.ts`, `errors.ts`, `materialize/program.ts`, and the CLI error renderer.
- **Dependencies:** add direct dependencies on `@deepseek-ai/node-addon-system` (Linux/macOS flock) and `koffi` 3.1.1 (Windows FFI), both already present transitively through DSH; update the lockfile. Koffi is imported lazily only on Windows.
- **Tests:** replace PID/stale-takeover tests with `SyncLock` fakes, POSIX two-descriptor flock tests, platform-dispatch tests, and Windows-native semaphore tests. Add Windows CI (the current workflow is Ubuntu-only) and ideally macOS coverage for the Darwin flock binary.
- **Behavior:** concurrent syncs still fail fast with the same exit code; the POSIX lock file now persists across runs, and Windows has no lock file. Old PID lock-file contents are ignored and never parsed for lock decisions.
- **Unaffected:** the plan schema, profile layout, CLI flags and exit codes, publication ordering, and `atomic-write.ts`.
