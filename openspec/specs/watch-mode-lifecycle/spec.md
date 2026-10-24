# watch-mode-lifecycle Specification

## Purpose
Define the ownership, ordering, and shutdown guarantees of `eedsh sync --watch`: one service layer per session, a ready watcher before the initial sync, coalesced reruns, and cleanup on every exit.

## Requirements

### Requirement: One service layer per watch session

The watch command SHALL construct one service layer for the session and SHALL reuse it for the initial sync and every rerun. The layer SHALL be released when the session ends.

#### Scenario: Reruns reuse services

- **WHEN** the watcher triggers multiple syncs in one session
- **THEN** the service layer is constructed once
- **AND** the same service instances are used for every sync

#### Scenario: Layer is released on stop

- **WHEN** the watch session stops
- **THEN** the service layer is released before the command returns

### Requirement: Watcher is ready before the initial sync

The watch command SHALL start and fully initialize the file watcher before running the initial sync. Changes observed while a sync is running SHALL be coalesced into at most one follow-up sync.

#### Scenario: Change during the initial sync is not lost

- **WHEN** a watched file changes while the initial sync is running
- **THEN** exactly one follow-up sync runs after the initial sync completes

#### Scenario: Burst of changes coalesces

- **WHEN** several watched files change while a sync is running
- **THEN** at most one additional sync runs after it

### Requirement: Cleanup on every exit

The watch command SHALL close the watcher exactly once and SHALL release the service layer when the session ends by stop signal, startup failure, run failure, or interruption. Cleanup SHALL complete before the command returns.

#### Scenario: Normal stop

- **WHEN** the watch session receives an abort signal, SIGINT, or SIGTERM
- **THEN** the watcher is closed once
- **AND** the service layer is released
- **AND** the command exits 0

#### Scenario: Startup failure

- **WHEN** the watcher cannot be constructed
- **THEN** the command exits unsuccessfully
- **AND** the service layer is released
- **AND** no sync runs

#### Scenario: In-flight sync is interrupted

- **WHEN** a stop signal arrives while a sync is running
- **THEN** the sync is interrupted
- **AND** its profile lock is released
- **AND** the watcher and service layer are released before the command returns

### Requirement: A failed rerun does not stop watch mode

A config load or sync failure during watch mode SHALL be reported, the previously published generation SHALL remain in place, and the watcher SHALL continue to accept later changes.

#### Scenario: Config load failure

- **WHEN** a changed config fails to load
- **THEN** the error is reported
- **AND** the previous generation remains published
- **AND** a later change still triggers a sync

#### Scenario: Sync failure

- **WHEN** a rerun fails during materialization or publication
- **THEN** the error is reported
- **AND** the watch session stays active

### Requirement: Startup fails fast

If the service layer or the watcher cannot be constructed, watch mode SHALL fail before running a sync and exit unsuccessfully. It SHALL NOT continue watching with a layer or watcher that could not be built.

#### Scenario: Layer construction failure

- **WHEN** the service layer cannot be built
- **THEN** the command exits unsuccessfully
- **AND** the watcher is not started

#### Scenario: Watcher construction failure

- **WHEN** the file watcher cannot be started
- **THEN** the command exits unsuccessfully
- **AND** no sync runs

### Requirement: Normal stop is successful

A normal watch stop SHALL exit 0. A watcher-close failure during a normal stop SHALL be reported as a warning and SHALL NOT change the exit status.

#### Scenario: Watcher close fails during stop

- **WHEN** the watcher reports a close failure after a stop signal
- **THEN** the failure is reported as a warning
- **AND** the command still exits 0
