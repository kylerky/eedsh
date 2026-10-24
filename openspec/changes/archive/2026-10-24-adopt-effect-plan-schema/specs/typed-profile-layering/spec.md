## ADDED Requirements

### Requirement: The plan exposes a public Effect schema as the validator

The system SHALL export a public plan schema that is an Effect Schema value and the single source of truth for validation and the plan type. Decoding a value that is not a valid plan SHALL fail.

#### Scenario: A valid plan decodes through the public schema

- **WHEN** a value contains a supported format and version, a safe profile name, an exact DSH pin, ordered bundles, ordered layers, and package specifications
- **THEN** decoding through the public schema succeeds and returns the plan

#### Scenario: An invalid plan is rejected

- **WHEN** a value omits a required plan field or violates any validation rule
- **THEN** decoding fails and the failure identifies the offending plan location

### Requirement: The public schema validates the complete plan contract

The schema SHALL validate the plan shape, profile identity and naming rules, duplicate bundle and layer identifiers, the generated-marker count, reserved names, patch rules, JSON compatibility, and expression-node shape.

#### Scenario: A structurally invalid plan is rejected

- **WHEN** a value supplies a plan field with the wrong type or an unknown plan field
- **THEN** decoding fails and the failure identifies the offending plan location

#### Scenario: A semantically invalid plan is rejected

- **WHEN** a plan contains a duplicate layer identifier, a duplicate bundle name, more than one generated marker, a reserved name, or an invalid layer or profile name
- **THEN** decoding fails and the failure identifies the offending plan location

#### Scenario: Non-JSON values are rejected

- **WHEN** a plan contains a function, symbol, BigInt, undefined value, non-finite number, circular reference, or class instance
- **THEN** decoding fails and the failure identifies the offending plan location

#### Scenario: A malformed expression node is rejected

- **WHEN** a plan contains an expression node without exactly the reserved source-text shape
- **THEN** decoding fails and the failure identifies the expression location

### Requirement: The public plan type is derived from the schema

The exported plan type SHALL be derived from the schema, SHALL expose readonly properties and arrays, and SHALL expose patch payloads as opaque values.

#### Scenario: The public plan type is readonly and opaque

- **WHEN** a consumer imports the public plan type
- **THEN** its properties and arrays are readonly and its patch payloads are opaque values
- **AND** assigning that type to a mutable plan shape does not typecheck

### Requirement: Validation uses Effect-native results and errors

Validation SHALL expose an Effect `Either` result. A failed validation SHALL be an Effect tagged error carrying located issues. The authoring entry point SHALL remain synchronous and SHALL throw the tagged error.

#### Scenario: Valid validation returns a right value

- **WHEN** a valid plan is validated through the public validation API
- **THEN** the result is a right value containing the plan

#### Scenario: Invalid validation returns a tagged error

- **WHEN** a plan violates a validation rule
- **THEN** the result is a left value containing a tagged validation error with located issues

#### Scenario: Authoring remains synchronous

- **WHEN** an author calls the synchronous authoring entry point with an invalid plan
- **THEN** it throws the tagged error and does not return an Effect

## MODIFIED Requirements

### Requirement: Plan validation rejects invalid profiles

Validation SHALL reject missing profile identity, multiple generated markers, duplicate or empty layer identifiers, invalid bundle or package specifications, malformed expression nodes, and unsupported JSON values. Every rejection SHALL identify the failing plan location and a human-readable message. Validation SHALL NOT attach a semantic error code to an issue.

#### Scenario: Missing profile name

- **WHEN** a plan omits the profile name
- **THEN** validation fails with an error naming the missing profile name and its location

#### Scenario: Duplicate layer identifier

- **WHEN** two layers share an identifier
- **THEN** validation fails and identifies both layers

#### Scenario: Invalid expression node

- **WHEN** an expression node lacks its source text or has an extra shape
- **THEN** validation fails with the expression location

#### Scenario: Valid plan is accepted

- **WHEN** a complete plan contains only supported values and unique layer identifiers
- **THEN** validation succeeds
