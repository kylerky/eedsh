## MODIFIED Requirements

### Requirement: The authoring entry point is synchronous and returns the native Result

`defineConfig` SHALL remain synchronous and SHALL return an Effect `Result` whose failure is Effect's native schema error for config-level defects. `defineProfile` SHALL remain synchronous and SHALL return a typed profile descriptor without throwing. Authoring SHALL expose each profile's outcome separately as a validated plan or a native schema error, so one invalid profile is not a config-wide failure. `validatePlan` SHALL remain the Result-returning plan validation entry point, and `assertPlan` SHALL be removed.

#### Scenario: Authoring a valid config returns a success Result

- **WHEN** a caller supplies a valid config with one or more profiles
- **THEN** `defineConfig` returns a success Result synchronously
- **AND** every profile exposes a validated plan

#### Scenario: A config-level defect returns a failure Result

- **WHEN** a caller supplies an invalid DSH pin, no profiles, an unsafe profile key, or an unknown default profile
- **THEN** `defineConfig` returns a failure Result
- **AND** the failure satisfies `Schema.isSchemaError`
- **AND** no exception is thrown

#### Scenario: Authoring a valid profile returns a success Result

- **WHEN** a caller supplies conforming profile input through the config authoring surface
- **THEN** that profile's validation outcome is a success Result carrying the validated plan synchronously

#### Scenario: Authoring an invalid profile returns a failure Result

- **WHEN** a caller supplies profile input that violates the plan contract
- **THEN** that profile's validation outcome is a failure Result
- **AND** the failure satisfies `Schema.isSchemaError`
- **AND** no exception is thrown

#### Scenario: Authoring a profile descriptor does not throw

- **WHEN** a caller supplies profile input to `defineProfile`
- **THEN** the descriptor is returned synchronously without throwing
- **AND** plan validation remains available through the config contract or `validatePlan`

#### Scenario: The throwing authoring helper is absent

- **WHEN** a consumer imports the config package's public entry points
- **THEN** no `assertPlan` helper is exported
- **AND** `validatePlan` remains available for callers that want the Result directly

### Requirement: Plan failures are reported with the native formatted message

The command-line interface SHALL report an invalid config or invalid profile by printing the native failure message, preserving its multi-line structure and location annotations, and SHALL exit with the validation-failure exit code. A config-level failure SHALL be printed once. A profile-level failure SHALL identify the profile by name and print that profile's native message once; when several selected profiles are invalid, every profile's failure SHALL be reported. The CLI SHALL NOT reformat a failure into one `path: message` line per issue, SHALL NOT wrap a schema failure as an import failure, and SHALL NOT truncate issues.

#### Scenario: An invalid config prints the native message

- **WHEN** a command evaluates a config with a config-level defect
- **THEN** standard error contains the native formatted failure message, including location annotations
- **AND** the message is printed once
- **AND** the command exits with status 1

#### Scenario: An invalid profile is reported with its name

- **WHEN** a command selects or attempts a profile whose plan is invalid
- **THEN** standard error identifies the profile by name
- **AND** prints that profile's native formatted failure message, including location annotations
- **AND** the command exits with status 1

#### Scenario: Several invalid profiles are all reported

- **WHEN** bare `eedsh sync` encounters two invalid profiles
- **THEN** both profiles' native failures are reported
- **AND** each is identified by its profile name
- **AND** the command exits with status 1

#### Scenario: An invalid Result export prints the native message

- **WHEN** a command evaluates a config whose default export is a failure Result
- **THEN** standard error contains the native formatted failure message, including location annotations
- **AND** the command exits with status 1

#### Scenario: An authoring failure during evaluation prints the native message

- **WHEN** the authoring API produces a config-level failure Result during config evaluation
- **THEN** standard error contains the native formatted failure message
- **AND** it does not contain a `config.import_failed` prefix

## REMOVED Requirements

### Requirement: A config module may export a plan or a validation Result

**Reason**: The single-plan config export is replaced by a multi-profile config export, so a plan or a plan Result is no longer a valid config.

**Migration**: Create the XDG config project with `eedsh init` and default-export `defineConfig({ ... })` (or a config-valued Result). Legacy config filenames and single-plan exports are not read or migrated automatically.

## ADDED Requirements

### Requirement: A config module may export a config or a validation Result

A config module SHALL default-export either an eedsh config or a `Result` whose success is a config. The CLI SHALL validate a plain config and each profile plan with the strict contracts, unwrap a successful Result and revalidate its value, and report a failed Result as its native schema failure. A plain profile plan or profile-plan Result SHALL NOT be accepted. A config with an invalid profile SHALL retain that profile's failure rather than fail as a whole.

#### Scenario: Config Result export is unwrapped

- **WHEN** a config default-exports the success Result produced by `defineConfig`
- **THEN** the CLI evaluates it as a config
- **AND** its valid profiles are published when materialization succeeds

#### Scenario: Plain config export is validated

- **WHEN** a config default-exports a config-shaped value rather than a Result
- **THEN** the CLI validates it with the strict config contract
- **AND** each profile plan is validated independently
- **AND** an invalid value fails with the native schema message

#### Scenario: Failed Result export prints the native message

- **WHEN** a config default-exports a failure Result
- **THEN** the CLI prints the native formatted schema message
- **AND** it does not prefix the message with `config.import_failed`

#### Scenario: Forged success Result is revalidated

- **WHEN** a config default-exports a success Result whose value violates the config contract
- **THEN** the CLI rejects the value with the native schema failure

#### Scenario: Single-plan export is rejected

- **WHEN** a config default-exports a profile plan or a profile-plan Result
- **THEN** the CLI rejects it with the native config schema failure
- **AND** no profile is published

#### Scenario: Invalid profile is retained, not promoted

- **WHEN** a successful config Result contains one invalid profile
- **THEN** the CLI keeps that profile's native failure
- **AND** does not report the whole config as a failed Result
