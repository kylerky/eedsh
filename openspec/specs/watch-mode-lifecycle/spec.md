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

### Requirement: Watch mode follows the config's profile selection

`eedsh sync --watch` SHALL apply the same profile selection as a non-watch sync on its initial run and on every rerun: every profile when `--profile` is absent, or the named profile when present. After each config change it SHALL re-evaluate the selected set, so an added profile is synced and a removed profile is no longer synced.

#### Scenario: Bare watch publishes every profile

- **WHEN** `eedsh sync --watch` starts for a config with several profiles
- **THEN** the initial run publishes every profile
- **AND** each later change re-evaluates and publishes the same set

#### Scenario: Profile selection narrows watch

- **WHEN** `eedsh sync --watch --profile work` starts
- **THEN** only `work` is published on the initial run and on reruns

#### Scenario: Added profile is picked up

- **WHEN** a profile is added to the config while watch mode is running
- **THEN** the next change publishes the new profile as well as the existing ones

#### Scenario: Removed profile is no longer synced

- **WHEN** a profile is removed from the config while watch mode is running
- **THEN** later reruns do not sync that profile
- **AND** its published profile remains on disk

### Requirement: Watch mode isolates profile failures

When a selected profile is invalid or fails materialization during watch mode, the failure SHALL be reported, that profile's previously published generation SHALL remain in place, the remaining selected profiles SHALL still run, and the watch session SHALL remain active.

#### Scenario: One invalid profile does not stop the others

- **WHEN** a rerun finds one selected profile invalid and its siblings valid
- **THEN** the invalid profile's failure is reported
- **AND** the valid profiles are still published
- **AND** the watch session stays active

#### Scenario: One materialization failure does not stop the others

- **WHEN** one selected profile fails during materialization
- **THEN** the failure is reported
- **AND** the remaining selected profiles are still attempted
- **AND** the watch session stays active
