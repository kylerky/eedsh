## ADDED Requirements

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
