## Purpose

Defines how one config declares several named profiles, how the CLI selects between them, and how validation and publication failures stay isolated to the affected profile.

## ADDED Requirements

### Requirement: One config declares named profiles with a shared DSH pin

The authoring surface SHALL accept an exact DSH pin, an optional default profile name, and a record of named profiles. Each key SHALL be a safe profile name and the profile's sole identity. Each profile SHALL accept ordered bundles, ordered layers, and package dependencies. The shared pin SHALL apply to every plan, and records built dynamically from spreads, computed keys, loops, or environment values SHALL be accepted.

#### Scenario: Several profiles produce separate plans

- **WHEN** a config declares profiles `work` and `home`
- **THEN** eedsh produces one profile plan for `work` and one for `home`

#### Scenario: The shared pin is applied to every plan

- **WHEN** a config declares one DSH pin and two profiles
- **THEN** both profile plans carry that exact pin

#### Scenario: The record key is the profile name

- **WHEN** a profile is declared under the key `work`
- **THEN** its plan names the profile `work`

#### Scenario: Profiles can be built dynamically

- **WHEN** a config constructs its profile record with a spread or a computed key
- **THEN** every resulting key produces a profile with that key as its name

### Requirement: Config-level defects fail the whole config

Config-level defects SHALL fail the whole config before any profile is selected or published: an absent or malformed DSH pin, an empty profile record, an unsafe profile key, or a default profile name that is not a key. The failure SHALL be Effect's native schema failure, the command SHALL exit 1, and no profile SHALL be published or booted.

#### Scenario: Empty profile record is rejected

- **WHEN** a config declares no profiles
- **THEN** the command exits 1 with the native schema failure
- **AND** no profile is published or booted

#### Scenario: Unsafe profile key is rejected

- **WHEN** a profile key is empty, contains a path separator, or is otherwise unusable as a profile directory
- **THEN** the command exits 1 with the native schema failure identifying the key

#### Scenario: Unknown default profile is rejected

- **WHEN** `defaultProfile` names a key that is not declared
- **THEN** the command exits 1 with the native schema failure identifying the default name

#### Scenario: Malformed DSH pin is rejected

- **WHEN** the config's DSH pin is not an exact version
- **THEN** the command exits 1 with the native schema failure identifying the pin

### Requirement: Profiles validate independently

Each profile plan SHALL be validated independently. An invalid profile SHALL be reported by name with its native schema failure and SHALL NOT prevent a different valid profile from being selected, run, or published. A command that explicitly selects an invalid profile, or that resolves to one by default, SHALL fail with that profile's native failure and exit 1. A plain config export SHALL be validated profile by profile under the same rule.

#### Scenario: An invalid sibling does not block a valid profile

- **WHEN** `home` has an invalid plan and the user runs `eedsh run --profile work`
- **THEN** `work` is synced and booted normally
- **AND** `home` is not reported on that run

#### Scenario: Bare sync publishes valid profiles and reports invalid ones

- **WHEN** `home` is invalid and the user runs bare `eedsh sync`
- **THEN** every valid profile is materialized
- **AND** `home`'s native schema failure is reported with its name
- **AND** the command exits 1

#### Scenario: Selecting an invalid profile fails

- **WHEN** the user runs `eedsh sync --profile home` and `home`'s plan is invalid
- **THEN** the command prints `home`'s native schema failure
- **AND** exits 1
- **AND** publishes no profile

#### Scenario: An invalid default does not block another explicit profile

- **WHEN** the default profile is invalid and the user runs `eedsh run --profile work`
- **THEN** `work` runs
- **AND** the invalid default is not selected

#### Scenario: Plain config export is validated per profile

- **WHEN** a config default-exports a plain config object rather than the result of `defineConfig`
- **THEN** the CLI validates the envelope and each profile plan independently
- **AND** an invalid profile is retained as that profile's native failure

### Requirement: Commands select profiles deterministically

`eedsh run` and `eedsh doctor` without `--profile` SHALL select `--profile`, then the config's default profile, then the sole profile. `eedsh sync --profile` SHALL select exactly the named profile and SHALL NOT fall back to the default. `eedsh check` SHALL NOT accept `--profile`.

#### Scenario: Explicit profile wins

- **WHEN** a config declares a default and the user runs `eedsh run --profile home`
- **THEN** `home` is selected

#### Scenario: Default profile is used

- **WHEN** the config declares a default and the user runs `eedsh run` without `--profile`
- **THEN** the default profile is selected

#### Scenario: Sole profile is implicit

- **WHEN** the config declares one profile and no default
- **THEN** `eedsh run` selects that profile

#### Scenario: Sync does not fall back to the default

- **WHEN** the config declares a default and the user runs `eedsh sync --profile home`
- **THEN** only `home` is selected

#### Scenario: Check rejects a profile selection

- **WHEN** the user runs `eedsh check --profile work`
- **THEN** the command exits 2 with a usage error
- **AND** no compiler check runs

### Requirement: Ambiguous or unknown profile selection is a usage error

When a command needs one profile and the config declares several with no default, it SHALL exit 2 with a usage error listing the names before publishing, booting, or inspecting. An unknown `--profile` SHALL also exit 2 and list the names.

#### Scenario: Ambiguous selection is a usage error

- **WHEN** the config declares several profiles and no default and the user runs `eedsh run`
- **THEN** the command exits 2
- **AND** the diagnostic lists the available profile names

#### Scenario: Unknown profile is a usage error

- **WHEN** the user passes `--profile missing`
- **THEN** the command exits 2
- **AND** the diagnostic lists the available profile names

### Requirement: Bare sync publishes every profile

With no `--profile`, `eedsh sync` SHALL materialize every profile, each as its own publication transaction; `--profile` SHALL materialize only the named profile. Unchanged profiles SHALL be no-ops. Removing a profile from the config SHALL NOT delete its published DSH profile.

#### Scenario: All profiles are published

- **WHEN** bare `eedsh sync` runs for a config with `work` and `home`
- **THEN** both published profiles are created or updated
- **AND** the command exits 0

#### Scenario: Unchanged profiles are no-ops

- **WHEN** bare sync runs again with no plan changes
- **THEN** each profile reports unchanged
- **AND** no generation identifier changes

#### Scenario: A profile selection narrows the run

- **WHEN** the user runs `eedsh sync --profile home`
- **THEN** only `home` is materialized

#### Scenario: Removing a profile keeps its published state

- **WHEN** `home` is removed from the config and sync runs
- **THEN** the published `home` profile remains on disk
- **AND** the run does not report `home` as synced

### Requirement: Profile failures are isolated during sync

A profile that is invalid, fails materialization, or is locked by another process SHALL be reported and SHALL NOT prevent the remaining profiles from being attempted. The command SHALL exit 0 only when every selected profile is valid and succeeds; otherwise it SHALL exit 1. Profile-level diagnostics SHALL identify the profile by name, and each selected profile SHALL use its own lock.

#### Scenario: One materialization failure does not stop the rest

- **WHEN** `work` fails during materialization and `home` is valid
- **THEN** `home` is still attempted and published
- **AND** `work`'s failure is reported with its name
- **AND** the command exits 1

#### Scenario: One invalid profile does not stop the rest

- **WHEN** `work` is invalid and `home` is valid
- **THEN** `home` is still published
- **AND** `work`'s native schema failure is reported with its name
- **AND** the command exits 1

#### Scenario: One locked profile does not stop the rest

- **WHEN** another process holds `work`'s sync lock and `home` is free
- **THEN** `home` is still published
- **AND** `work`'s lock contention is reported
- **AND** the command exits 1

#### Scenario: Strict failure is isolated to its profile

- **WHEN** `--strict` fails in `work` and `home` is valid
- **THEN** `home` is still attempted
- **AND** the command exits 1

#### Scenario: Diagnostics name the profile

- **WHEN** a multi-profile run reports a warning, notice, or failure
- **THEN** the message identifies the profile it belongs to
