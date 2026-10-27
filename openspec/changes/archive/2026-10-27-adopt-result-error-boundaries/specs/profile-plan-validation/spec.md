## REMOVED Requirements

### Requirement: The authoring entry point is synchronous and throws the native error

**Reason**: The authoring API now returns a Result and `assertPlan` is removed. A synchronous throwing authoring helper no longer exists.

**Migration**: Use `defineProfile`, which returns `Result<ProfilePlan, Schema.SchemaError>`, or call `validatePlan` directly. Inspect the Result instead of catching an exception.

## MODIFIED Requirements

### Requirement: Plan failures are reported with the native formatted message

The command-line interface SHALL report an invalid plan by printing the native failure message, preserving its multi-line structure and its location annotations, and SHALL exit with the validation-failure exit code. It SHALL apply to an invalid plain export, a failed Result export, and a schema failure raised by the authoring API while the config module is evaluated. It SHALL NOT reformat the failure into one `path: message` line per issue and SHALL NOT wrap a schema failure as an import failure.

#### Scenario: An invalid config prints the native message

- **WHEN** a command evaluates a config whose default export is not a valid plan, whether plain data or a failure Result
- **THEN** standard error contains the native formatted failure message, including location annotations
- **AND** the command exits with status 1

#### Scenario: An invalid Result export prints the native message

- **WHEN** a command evaluates a config whose default export is a failure Result
- **THEN** standard error contains the native formatted failure message, including location annotations
- **AND** the command exits with status 1

#### Scenario: An authoring failure during evaluation prints the native message

- **WHEN** the authoring API returns a failure Result during config evaluation
- **THEN** standard error contains the native formatted failure message
- **AND** it does not contain a `config.import_failed` prefix

## ADDED Requirements

### Requirement: The authoring entry point is synchronous and returns the native Result

`defineProfile` SHALL remain synchronous and SHALL return `Result<ProfilePlan, Schema.SchemaError>`. It SHALL NOT throw when the candidate is invalid. `assertPlan` SHALL be removed. `validatePlan` SHALL remain the Result-returning validation entry point.

#### Scenario: Authoring a valid profile returns a success Result

- **WHEN** a caller supplies conforming profile input
- **THEN** `defineProfile` returns a success Result carrying the validated plan synchronously

#### Scenario: Authoring an invalid profile returns a failure Result

- **WHEN** a caller supplies input that violates the plan contract
- **THEN** `defineProfile` returns a failure Result
- **AND** the failure satisfies `Schema.isSchemaError`
- **AND** no exception is thrown

#### Scenario: The throwing authoring helper is absent

- **WHEN** a consumer imports the config package's public entry points
- **THEN** no `assertPlan` helper is exported
- **AND** `validatePlan` remains available for callers that want the Result directly

### Requirement: A config module may export a plan or a validation Result

A config module SHALL be allowed to default-export either a profile plan value or a `Result<ProfilePlan, Schema.SchemaError>`. The CLI SHALL validate a plain export with the strict plan options, SHALL unwrap a successful Result export, and SHALL report a failed Result export as its native schema failure. The CLI SHALL NOT wrap a schema failure exported by a config as an import failure. A successful Result whose value does not satisfy the plan contract SHALL be rejected by validation.

#### Scenario: Result export is unwrapped

- **WHEN** a config default-exports the success Result produced by `defineProfile`
- **THEN** the CLI evaluates it as a validated plan
- **AND** the profile is published when materialization succeeds

#### Scenario: Plain plan export is validated

- **WHEN** a config default-exports a plan-shaped value rather than a Result
- **THEN** the CLI validates it with the strict plan options
- **AND** an invalid value fails with the native schema message

#### Scenario: Failed Result export prints the native message

- **WHEN** a config default-exports a failure Result
- **THEN** the CLI prints the native formatted schema message
- **AND** it does not prefix the message with `config.import_failed`

#### Scenario: Forged success Result is revalidated

- **WHEN** a config default-exports a success Result whose value violates the plan contract
- **THEN** the CLI rejects the value with the native schema failure
