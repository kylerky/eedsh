## REMOVED Requirements

### Requirement: The authoring entry point is synchronous and returns the native Result

**Reason**: The singleton `defineProfile` contract is replaced by the fluent `defineConfig().build()` contract; `defineProfile` and `assertPlan` are removed.

**Migration**: Replace `defineProfile({...})` with `defineConfig().dsh(pin).profile(name, (profile) => ...).build()` and default-export the returned Result.

### Requirement: A config module may export a plan or a validation Result

**Reason**: A config is a validated multi-profile config value, not a lone profile plan; the fluent builder returns the Result.

**Migration**: Default-export the Result from `defineConfig().build()`. A lone profile plan is no longer accepted as a config.

## ADDED Requirements

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
