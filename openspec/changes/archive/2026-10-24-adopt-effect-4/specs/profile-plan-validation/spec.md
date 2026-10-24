## Purpose

Defines how an authored profile plan is validated and how an invalid plan fails: the native Effect result and error values a caller receives, the synchronous authoring entry point, and the formatted failure text the CLI reports.

## ADDED Requirements

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

### Requirement: The authoring entry point is synchronous and throws the native error

`defineProfile` and `assertPlan` SHALL remain synchronous functions that return a plan and throw Effect's native schema error when the candidate is invalid. They SHALL NOT return a Result or an Effect.

#### Scenario: Authoring a valid profile returns the plan

- **WHEN** a caller supplies conforming profile input
- **THEN** `defineProfile` returns the validated plan synchronously

#### Scenario: Authoring an invalid profile throws the native error

- **WHEN** a caller supplies input that violates the plan contract
- **THEN** `defineProfile` throws a value whose tag is `SchemaError`
- **AND** the thrown value is an `Error` that satisfies `Schema.isSchemaError`

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

The command-line interface SHALL report an invalid plan by printing the native failure message, preserving its multi-line structure and its location annotations, and SHALL exit with the validation-failure exit code. It SHALL NOT reformat the failure into one `path: message` line per issue.

#### Scenario: An invalid config prints the native message

- **WHEN** a command evaluates a config whose default export is not a valid plan
- **THEN** standard error contains the native formatted failure message, including location annotations
- **AND** the command exits with status 1
