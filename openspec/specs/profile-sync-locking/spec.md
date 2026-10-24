# profile-sync-locking Specification

## Purpose
Serialize materialization of a single DSH profile across cooperating eedsh processes, using a kernel-owned lock with crash-safe release on Linux, macOS, and Windows.

## Requirements

### Requirement: Serialize materialization per profile

The CLI SHALL allow at most one materialization to execute for a given profile at a time. The lock SHALL cover the complete materialization transaction, including reading the previous generation, reconciling the manifest, package installation, preflight, and publication. The lock SHALL be scoped per profile, so syncs targeting different profiles do not exclude each other.

#### Scenario: Second sync is rejected before changing the profile

- **WHEN** one sync is already materializing profile `work`
- **THEN** a second sync for `work` fails before reading or writing the profile, reports that another sync is running, and exits unsuccessfully

#### Scenario: Lock covers installation and publication

- **WHEN** a sync is running package installation, preflight, or the publication commit for a profile
- **THEN** a concurrent sync for that profile is rejected rather than entering the transaction

#### Scenario: Different profiles proceed independently

- **WHEN** two syncs target different profiles
- **THEN** each can acquire its own profile lock and proceed without being rejected by the other

### Requirement: Kernel-owned lock with automatic release

The lock SHALL be owned by an operating-system kernel primitive, not by a PID-and-file protocol. The CLI SHALL release the lock when the materialization completes, fails, or is interrupted, and the operating system SHALL release it when the holding process exits or crashes. No user-space stale-lock takeover, PID liveness probe, timestamp expiry, or manual lock removal SHALL be required for a subsequent sync to proceed.

#### Scenario: Crashed holder does not block a successor

- **WHEN** a process holding the lock exits without releasing it
- **THEN** a later sync for the same profile acquires the lock without manual cleanup

#### Scenario: Failed materialization releases the lock

- **WHEN** materialization fails or is interrupted
- **THEN** the lock is released before the command finishes

#### Scenario: Live holder is not expropriated

- **WHEN** the lock is held by a live process that is slow or paused
- **THEN** the lock remains held until that process exits or releases it; the CLI does not expire or take it over

### Requirement: POSIX lock file identity and lifecycle

On Linux and macOS, the lock SHALL be an advisory exclusive lock on the persistent `.eedsh/sync.lock` file. The implementation SHALL keep the locked descriptor open for the critical section, SHALL release the lock by closing it, and SHALL NOT delete, rename, or atomically replace the lock file. The lock-file content SHALL NOT be used to decide whether the lock is held.

#### Scenario: Lock file persists after a sync

- **WHEN** a sync completes or fails on Linux or macOS
- **THEN** `.eedsh/sync.lock` remains in place and is not removed by eedsh

#### Scenario: Existing file content does not imply a held lock

- **WHEN** `.eedsh/sync.lock` exists with arbitrary or stale content and no process holds its kernel lock
- **THEN** a sync acquires the lock without parsing the content or treating the file as stale

### Requirement: POSIX lock identity verification

After acquiring the lock, the implementation SHALL verify that the locked file is still the file at the lock path. If the path was replaced, it SHALL retry or fail without entering the critical section.

#### Scenario: Replaced lock file is not trusted

- **WHEN** the file at the lock path is replaced between opening it and acquiring the kernel lock
- **THEN** the sync verifies the locked file still matches the path, retries or fails, and does not enter the critical section under an unverifiable lock

### Requirement: Windows kernel lock scope and lifetime

On Windows, the lock SHALL be a named kernel object derived from the canonical profile lock path and SHALL NOT create, read, or remove a profile lock file. Acquisition SHALL be non-blocking. The lock SHALL be scoped to the current Windows login session. Release SHALL restore the object and close the handle, and process exit SHALL release the lock without leaving a stale profile file.

#### Scenario: Windows sync has no lock file

- **WHEN** a sync completes on Windows
- **THEN** no `.eedsh/sync.lock` is created or required for the profile

#### Scenario: Same-session Windows syncs exclude each other

- **WHEN** two syncs for the same profile run in the same Windows login session
- **THEN** the second sync is rejected while the first holds the lock

#### Scenario: Windows holder exits without release

- **WHEN** a process holding the Windows lock exits without releasing it
- **THEN** a later sync in the same login session acquires the lock without manual cleanup

### Requirement: Supported platforms and fail-closed behavior

The CLI SHALL support kernel-backed profile locking on Linux, macOS, and Windows. On any other platform, or when the platform-native lock support cannot be loaded, sync SHALL fail before entering the critical section with a clear diagnostic and SHALL NOT fall back to a PID file, stale takeover, or any other non-kernel lock protocol.

#### Scenario: Unsupported platform fails before materialization

- **WHEN** a sync runs on a platform without supported kernel locking
- **THEN** it fails with a clear unsupported-platform diagnostic and does not begin materializing the profile

#### Scenario: Missing native support does not degrade the lock

- **WHEN** the platform-native locking support cannot be loaded
- **THEN** sync fails with a file-system error that identifies the lock path and does not use the old PID/takeover protocol

### Requirement: Lock contention diagnostics and no user-space takeover

A contention failure SHALL identify the profile lock path and state that another sync is running. The diagnostic SHALL NOT report a holder PID because kernel locks do not expose one portably. The implementation SHALL NOT delete or replace a lock based on PID liveness, timestamps, or file content.

#### Scenario: Contention diagnostic

- **WHEN** a sync is rejected because another sync holds the profile lock
- **THEN** the error names the lock path, says another sync is running, and does not print a PID

#### Scenario: Old PID metadata is ignored

- **WHEN** an existing POSIX lock file contains a dead or reused PID, or malformed metadata
- **THEN** the implementation does not remove or take over the file because of that content; acquisition is decided only by the kernel lock
