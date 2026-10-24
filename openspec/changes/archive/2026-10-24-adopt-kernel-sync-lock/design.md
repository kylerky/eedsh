## Context

See proposal.md for the motivation and specs/profile-sync-locking/spec.md for the behavior contract.

The current lock lives in packages/cli/src/internal/lock.ts. It creates .eedsh/sync.lock with an exclusive write, reads the holder PID, probes it with process.kill(pid, 0), and removes the file when the PID looks dead. That is the TOCTOU path: the read and the unlink are separate operations, the file can be read before its content is written, and release unlinks by pathname without checking ownership. The lock also depends on a FileSystemShape.writeFileExclusive primitive that exists only for this protocol.

DSH's session-persistence lease already solves the same problem with kernel primitives: POSIX flock through @deepseek-ai/node-addon-system/flock, and a named kernel semaphore on Windows through koffi and kernel32.dll. Its lease documentation and implementation are the reference for the platform-specific behavior. DSH's separate dsh-atomic-write package uses a PID lock file for withFileLock; that is not the model here.

## Goals / Non-Goals

**Goals:**

- Replace all PID, timestamp, and content-based lock decisions with kernel-owned locks.
- Make a crashed holder stop blocking the next sync on every supported platform.
- Preserve fast failure and the existing CLI exit behavior for concurrent syncs.
- Keep the materializer testable through an injectable service rather than real filesystem locks in unit tests.
- Add real Windows and macOS coverage rather than claiming support only from Linux.

**Non-Goals:**

- Cross-host or network-filesystem locking. The lock is local and advisory.
- Cross-OS exclusion for a profile shared simultaneously by POSIX and Windows processes.
- Waiting, queueing, or retrying when the lock is busy; contention remains an immediate failure.
- Changing the materialization transaction, generation publication, or profile layout.
- The Effect-native refactor of atomic-write.ts; it is a separate change and is not used for the sync lock.

## Decisions

### 1. A dedicated SyncLock service

Add SyncLockShape and a SyncLock tag to packages/cli/src/internal/effect/services.ts.

- SyncLockHandle has one member: release, an infallible Effect.
- SyncLockShape.acquire(lockPath) returns Effect<SyncLockHandle, SyncLocked | FileSystemFailure>.
- withSyncLock(lockPath, effect) wraps Effect.acquireRelease(acquire, release) in Effect.scoped and runs the materialization effect inside it.
- materialize's environment gains SyncLockShape; CliServiceLayer and the test harnesses provide it.
- A fake service models contention and records acquire/release, so the materializer tests do not need real files or kernel objects.

Alternatives considered:

- Extending FileSystemShape with lock operations. Rejected: it mixes OS locking and opaque handles into the generic file service and forces every file-system fake to model locks.
- Calling Node fs and the native libraries directly from lock.ts. Rejected: it makes materialize tests hit real profile paths and pulls live platform code into the service-agnostic module.
- Passing an acquire callback through MaterializeOptions. Rejected: the service abstraction is the project's established test seam.

### 2. POSIX: persistent flock with inode verification

On linux and darwin:

1. Create the parent directory with mkdir(dirname(lockPath), { recursive: true }).
2. Open the lock file with open(lockPath, 'a') so it is created when absent and never truncated.
3. Call tryLockExclusive(handle.fd) from @deepseek-ai/node-addon-system/flock.
4. On EAGAIN or EWOULDBLOCK, close the descriptor and fail SyncLocked with the lock path.
5. On success, compare the descriptor's stat({ bigint: true }) with stat(lockPath, { bigint: true }) on device and inode. If the path was removed or replaced, close and retry up to three times; then fail FileSystemFailure with operation verifyLock.
6. Return a handle whose release closes the descriptor. Close failures are ignored because process exit also closes the descriptor.

The lock file is never unlinked, renamed, or atomically replaced. Its content is never read or written; old PID JSON is inert. The descriptor, not the path alone, holds the kernel lock. The inode check catches the common unlinked-and-recreated race during acquisition; deleting the file while the descriptor is held still forfeits exclusion, as documented in Risks.

Why not the current PID protocol: it cannot make the read/remove decision atomic, and flock already provides exactly the needed ownership and lifetime semantics.

### 3. Windows: named kernel semaphore through koffi

On win32:

1. Derive a name from the canonical lock path: Local namespace prefix, eedsh-profile-lock, and sha256(resolve(lockPath).toLowerCase()) in hex. Use node:crypto.
2. Lazily load koffi and bind CreateSemaphoreW, WaitForSingleObject, ReleaseSemaphore, CloseHandle, and GetLastError from kernel32.dll, using the same signatures DSH uses. Put those five calls behind a small injected Win32 binding interface: the live implementation uses koffi, while tests can inject a fake binding to exercise the acquire/contend/release protocol on any platform.
3. Call CreateSemaphoreW(null, 1, 1, name). A zero handle is a FileSystemFailure.
4. Call WaitForSingleObject(handle, 0):
   - WAIT_OBJECT_0 (0): acquired; return a handle.
   - WAIT_TIMEOUT (258): close the handle and fail SyncLocked with the lock path.
   - Anything else: close the handle and fail FileSystemFailure with operation lock.
5. Release calls ReleaseSemaphore(handle, 1, null), then CloseHandle(handle). Close is attempted even if release fails; the handle is never used afterward. Release is idempotent.

The semaphore is a kernel object, not a file. It has no filesystem footprint, so .eedsh/sync.lock is not created, read, or removed on Windows. Contenders use a zero-timeout wait and close their handle on failure, so a crashed holder is normally the last handle; the named object is destroyed and the next create starts at count 1. A live but wedged holder keeps the count at 0 and blocks, with no expiry.

The name uses the Local namespace, matching DSH's per-login-session scope. This is deliberate for an interactive CLI; using the Global namespace would require a different permission and cross-user naming design. The trade-off is documented in Risks.

Why not a Windows named mutex: a mutex has thread-ownership and release-from-owning-thread rules that are awkward for asynchronous Node code. A counted semaphore is thread-agnostic and DSH has already validated the pattern.

### 4. Platform selection and fail-closed behavior

The live layer chooses:

- linux, darwin: POSIX flock implementation.
- win32: Windows semaphore implementation.
- Anything else: an implementation whose acquire fails FileSystemFailure with a clear unsupported-platform cause before touching the profile.

There is no fallback from a missing POSIX binding or a failed koffi load to the old PID protocol. A fallback would silently restore the bug this change removes. On POSIX, a missing addon rejects with a clear file-system diagnostic; on Windows, a missing koffi binding does the same.

The Windows implementation lazy-imports koffi inside acquire, so POSIX runs never load it and the CLI's help/check paths do not depend on it. The POSIX implementation imports the flock entry at the live layer; its JavaScript entry is safe to load on Windows and only rejects when called.

### 5. Dependency strategy

Add direct dependencies to packages/cli/package.json:

- @deepseek-ai/node-addon-system (currently 0.1.2, already transitive through DSH) for the flock entry.
- koffi 3.1.1 (already transitive through DSH's session persistence) for the Windows FFI.

Both remain external in the tsdown bundle, as other dependencies do. The addon's platform packages cover Linux x64/arm64 (glibc and musl) and macOS x64/arm64; koffi supplies its own Windows binaries. Unsupported architectures fail at acquire with the platform-native error mapped to FileSystemFailure.

### 6. Error and diagnostic model

SyncLocked becomes an object with only lockPath; pid is removed. The CLI renders:

another sync is running for this profile; lock: <path>

There is no PID to show and no recovery instruction to give: both kernel locks release on process death. Platform and binding failures are FileSystemFailure with operations such as lock, flock, verifyLock, openLock, or ensureLockDir, so the existing "cannot <operation> <path>: <cause>" renderer remains useful.

### 7. Remove the old protocol and its primitive

Remove SyncLockOptions, isPidAlive, defaultIsPidAlive, parsePid, SyncLockFileSchema, lockContent, LOCK_POLL_ATTEMPTS, and the takeover loop. Remove FileSystemShape.writeFileExclusive; the lock was its only caller. The Node file-system layer, the memory fakes, and the tests lose that method as well.

MaterializeOptions.isPidAlive is removed. program.ts calls withSyncLock(join(options.profileDir, LOCK_RELATIVE_PATH), effect) and adds SyncLockShape to the materializer's environment. LOCK_RELATIVE_PATH remains .eedsh/sync.lock as the POSIX lock path and the Windows name seed.

### 8. Testing and CI

- Unit/materializer tests use a fakeSyncLock service with a held flag, acquire/release counters, and a SyncLocked failure path. The existing PID, malformed-lock, and stale-takeover tests are deleted; release-on-failure assertions use the fake.
- A POSIX lock test opens the same file through two descriptors, asserts the second non-blocking flock fails, closes the first, retries successfully, and asserts the file still exists. A replacement test exercises the inode-verification retry/failure path where practical.
- The Windows semaphore protocol is unit-tested on every platform through a fake Win32 binding: acquire, second acquire is SyncLocked, release, reacquire, and error mapping. A win32-only test runs the same protocol through the real koffi binding; optionally a child-process exit test covers automatic release. The semaphore name derivation is a pure function and is unit-tested on every platform.
- A platform-selection test injects platform values and fake implementations, so Linux can verify the win32 choice without calling kernel32.
- CI changes from a single Ubuntu job to an OS matrix (Ubuntu, Windows, macOS). Windows is required for the semaphore path; macOS is required for the Darwin flock binary. If a platform job is not added, the corresponding support claim must be removed from the docs rather than left untested.

### 9. Atomic-write stays separate

atomic-write.ts is unchanged by this design. It performs atomic replacement, not mutual exclusion, and the sync lock must never be implemented by replacing or unlinking the lock file. Its Effect-native refactor is a separate task/change.

## Risks / Trade-offs

- **Windows lock is per login session** -> A sync in a Windows service session and one in an interactive session do not exclude each other. Document the scope; if eedsh later needs cross-session exclusion, evaluate the Global namespace with a user-specific name and its permission model rather than silently switching.
- **Network filesystems and cross-host profiles** -> flock is unreliable on some NFS configurations, and neither a local semaphore nor a local flock excludes another host. Document that profiles must be local; cross-host locking is unsupported.
- **Advisory locks** -> A same-user process can ignore or interfere with the lock. This is not a security boundary; it serializes cooperating eedsh processes.
- **POSIX lock-file deletion while held** -> Deleting .eedsh/sync.lock during a sync allows a new inode and a second holder. eedsh never deletes it; the inode check covers replacement during acquisition, not later deletion. Document that operators must not remove it while a sync is running.
- **koffi is a native FFI dependency** -> Installation or ABI failures are possible on Windows. Lazy-load it, pin the tested version, fail closed with a clear diagnostic, and cover it in Windows CI.
- **The POSIX addon has no Windows binary** -> This is expected; Windows uses koffi. Do not fix a missing flock binding on Windows by falling back; the platform selector never calls flock there. On Linux/macOS, a missing binding fails the sync instead of degrading.
- **Release failures** -> A failed release can leave a Windows semaphore or POSIX descriptor until process exit. Always close the handle or descriptor; the kernel cleans up on process exit. Do not let a release failure replace the materialization's primary error.
- **Mixed old and new versions** -> Old PID-based eedsh and the new kernel lock do not interoperate; the old code can remove the POSIX lock file or ignore the Windows semaphore. Upgrading requires no concurrent old sync; document the boundary.
- **POSIX and Windows processes sharing a profile** -> They use different mechanisms and do not exclude each other. Cross-OS concurrent sync is unsupported; the persistent POSIX file is ignored on Windows and the Windows semaphore is invisible to POSIX.
- **Orphaned child processes** -> If the CLI dies during pnpm install, the kernel releases the lock while the orphan may continue writing. This is an existing limitation; a future hardening could pass the lock descriptor to the installer child. Do not claim the lock covers it.
- **No holder PID in diagnostics** -> Kernel locks do not expose a portable owner. Users can use OS tools if needed; the message names the lock path and the profile context.

## Migration Plan

- Update dependencies and the lockfile; no profile or schema migration is needed.
- On POSIX, an existing .eedsh/sync.lock (including old PID JSON) is opened and locked by the new code; its content is ignored. The file becomes the persistent marker and is never removed.
- On Windows, any existing .eedsh/sync.lock is ignored; the new lock is a kernel semaphore and creates no file. Leave the old file alone while an old process may still be running; it is harmless after upgrade.
- Do not run old and new eedsh versions concurrently against the same profile. Stop existing syncs before upgrading; the same applies to rollback.
- Rollback requires stopping all syncs, reverting the dependencies and code, and accepting that an old PID lock may need manual cleanup. The POSIX lock file can remain; the old protocol will parse it as before.
- Update packages/cli/README.md with the platform matrix, the persistent POSIX lock file, the Windows semaphore's session scope, and the no-stale-recovery behavior. The old add-typed-profile-layer-api design note is historical and is superseded by this change's design.
