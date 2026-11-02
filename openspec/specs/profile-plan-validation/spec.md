# profile-plan-validation Specification

## Purpose
Defines how an authored profile plan is validated and how an invalid plan fails: the native Effect result and error values a caller receives, the synchronous authoring entry point, and the formatted failure text the CLI reports.

## Requirements

### Requirement: Plan validation returns an Effect Result

Validation SHALL return an Effect `Result`. A successful validation SHALL carry a detached copy of the plan. A failed validation SHALL carry Effect's native schema error (`Schema.SchemaError`) rather than a project-defined error type.

#### Scenario: A valid plan validates successfully

- **WHEN** a value satisfies the complete plan contract
- **THEN** validation succeeds and the success value is a plan
- **AND** mutating the returned plan does not affect the value that was validated

#### Scenario: An invalid plan fails with the native schema error

- **WHEN** a value omits a required plan field, supplies a wrong type, or contains an unknown field
- **THEN** validation fails and the failure value satisfies `Schema.isSchemaError`
- **AND** the failure exposes its structured issue through `error.issue`

### Requirement: Validation reports every located issue

Validation SHALL collect all issues in one pass with the strict plan options: every reported issue is collected rather than stopping at the first, and undeclared fields are rejected rather than stripped.

#### Scenario: Several invalid fields are reported together

- **WHEN** a plan contains more than one contract violation
- **THEN** the failure message reports more than one issue

#### Scenario: An undeclared field is rejected

- **WHEN** a plan object contains a field the schema does not declare
- **THEN** validation fails and the failure identifies that field

### Requirement: No project-defined issue or validation error type exists

The public surface SHALL NOT export a plan issue type, a plan validation error, a failure-summary builder, duplicate suppression, or issue truncation. Failures SHALL be Effect's own values, and the human-readable failure text SHALL be Effect's native formatted message.

#### Scenario: The package exports no plan-specific failure types

- **WHEN** a consumer imports the config package's public entry points
- **THEN** no plan issue type and no plan validation error type are exported

#### Scenario: The failure serializes through the native representation

- **WHEN** a validation failure is serialized to JSON
- **THEN** it contains the error tag and the formatted message only

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

### Requirement: Config authoring is synchronous and returns the native Result

`defineConfig()` SHALL be synchronous and SHALL return a `ConfigBuilder`. Its terminal `build()` SHALL normalize typed authoring objects to plain config data, validate the config and every profile, and return `Result<EedshConfig, Schema.SchemaError>` without throwing on invalid input. Failures SHALL carry Effect's native schema error. `defineProfile` and `assertPlan` SHALL be removed; `validatePlan` SHALL remain.

#### Scenario: A valid fluent config returns a success Result

- **WHEN** a caller supplies a conforming fluent config
- **THEN** `build()` returns a success Result carrying the validated config synchronously

#### Scenario: An invalid fluent config returns a failure Result

- **WHEN** a caller supplies input that violates the config or plan contract
- **THEN** `build()` returns a failure Result
- **AND** the failure satisfies `Schema.isSchemaError`
- **AND** no exception is thrown

#### Scenario: Typed objects are normalized before validation

- **WHEN** a caller builds a config composed of typed authoring objects
- **THEN** the success value is plain JSON-compatible data with no methods or class instances

#### Scenario: The legacy authoring helper is absent

- **WHEN** a consumer imports the config package's public entry points
- **THEN** no `defineProfile` or `assertPlan` helper is exported
- **AND** `validatePlan` remains available for callers that want the Result directly

### Requirement: A config module exports a validated config Result

A config module SHALL default-export the `Result` produced by `defineConfig().build()`. The CLI SHALL unwrap a successful Result, report a failed Result as its native schema failure, and validate a plain config value with the strict config schema. A lone profile plan SHALL NOT be accepted as a config, and a successful Result whose value violates the contract SHALL be rejected.

#### Scenario: Result export is unwrapped

- **WHEN** a config default-exports the success Result produced by `defineConfig().build()`
- **THEN** the CLI evaluates it as a validated config
- **AND** the profile is published when materialization succeeds

#### Scenario: Plain config export is validated

- **WHEN** a config default-exports a config-shaped value rather than a Result
- **THEN** the CLI validates it with the strict config schema
- **AND** an invalid value fails with the native schema message

#### Scenario: Failed Result export prints the native message

- **WHEN** a config default-exports a failure Result
- **THEN** the CLI prints the native formatted schema message
- **AND** it does not prefix the message with `config.import_failed`

#### Scenario: Lone profile plan is rejected as a config

- **WHEN** a config default-exports a single profile plan rather than a config value
- **THEN** the CLI rejects it with the native config schema failure

#### Scenario: Forged success Result is revalidated

- **WHEN** a config default-exports a success Result whose value violates the config contract
- **THEN** the CLI rejects the value with the native schema failure

#### Scenario: Invalid profile is retained, not promoted

- **WHEN** a successful config Result contains one invalid profile
- **THEN** the CLI keeps that profile's native failure
- **AND** does not report the whole config as a failed Result
