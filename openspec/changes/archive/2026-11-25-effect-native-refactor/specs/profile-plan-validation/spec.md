# profile-plan-validation Specification

## MODIFIED Requirements

### Requirement: Config authoring is synchronous and returns the native Result

`defineConfig()` SHALL be synchronous and SHALL return a `ConfigBuilder`. Its terminal `build()` SHALL normalize typed authoring objects and recorded query descriptors to plain config data, resolve them from the resolution the invocation supplies, validate the config and every profile, and return `Result<EedshConfig, Schema.SchemaError>` without throwing on invalid input. Failures SHALL carry Effect's native schema error. `defineProfile` and `assertPlan` SHALL be removed; `validatePlan` SHALL remain.

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

#### Scenario: Build consumes the invocation resolution without IO

- **WHEN** `build()` runs with the resolution the invocation supplied
- **THEN** it produces the validated config from that resolution alone
- **AND** it reads no file and starts no runtime

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

- **WHEN** the exported factory builds to a failure Result
- **THEN** standard error contains the native formatted failure message, including location annotations
- **AND** it does not prefix the message with `config.import_failed`
- **AND** the command exits with status 1

#### Scenario: An authoring failure during evaluation prints the native message

- **WHEN** an authoring call receives an out-of-contract value during evaluation
- **THEN** standard error contains the reported message once
- **AND** it does not contain a `config.import_failed` prefix

## REMOVED Requirements

### Requirement: A config module exports a validated config Result

**Reason**: The module default export is now a factory that receives invocation inputs, per the `config-evaluation-inputs` capability; a module can no longer export the `Result` itself, because the build phase runs after the invocation resolves the queries the factory records.

**Migration**: Export a factory instead of a built value. The CLI validates whatever the factory builds, rejects a lone profile plan, and revalidates a built value that violates the contract, so the guarantees of this requirement are preserved by the build phase rather than by the export shape.
