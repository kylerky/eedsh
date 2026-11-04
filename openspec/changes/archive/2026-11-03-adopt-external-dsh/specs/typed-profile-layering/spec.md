## REMOVED Requirements

### Requirement: TypeScript authoring produces a versioned profile plan

**Reason**: The plan is now version 2 and has no DSH field, and authoring no longer accepts a DSH value.

**Migration**: Delete `.dsh(...)` and re-sync. Version-1 plans are rejected rather than read.

## MODIFIED Requirements

### Requirement: The plan exposes a public Effect schema as the validator

The system SHALL export a public plan schema that is an Effect Schema value and the single source of truth for validation and the plan type. Decoding a value that is not a valid plan SHALL fail.

#### Scenario: A valid plan decodes through the public schema

- **WHEN** a value contains version 2, a safe profile name, ordered bundles, ordered layers, and package specifications, and contains no `dsh` field
- **THEN** decoding through the public schema succeeds and returns the plan

#### Scenario: An invalid plan is rejected

- **WHEN** a value omits a required plan field or violates any validation rule
- **THEN** decoding fails and the failure identifies the offending plan location

## ADDED Requirements

### Requirement: TypeScript authoring produces a version-2 plan without a DSH value

The system SHALL provide a synchronous TypeScript authoring surface in which one config declares an optional default profile and named profiles. Each profile SHALL accept ordered bundles, ordered generated patch groups, and profile-local packages. The config SHALL NOT declare a DSH value. Generated patch groups SHALL be positional. The surface SHALL produce one JSON-compatible version-2 plan per profile and preserve authored order. Dynamic profile records SHALL be accepted.

#### Scenario: Minimal authoring produces a plan

- **WHEN** an author supplies a profile with at least one bundle and no DSH value
- **THEN** the system produces a version-2 plan containing the record key as profile name, ordered bundles, ordered patch groups, and package dependencies

#### Scenario: Several profiles produce one plan each

- **WHEN** an author declares profiles `work` and `home` under one config
- **THEN** the system produces one plan for `work` and one for `home`
- **AND** each plan carries its own bundles, layers, and packages

#### Scenario: The record key becomes the profile name

- **WHEN** an author declares a profile under the key `work`
- **THEN** the resulting plan names the profile `work`

#### Scenario: Dynamically constructed profiles are accepted

- **WHEN** an author builds the profile record with a spread, a computed key, or a loop
- **THEN** every resulting key produces a plan with that key as its name

#### Scenario: Patch groups are declared without a name

- **WHEN** an author declares two patch groups
- **THEN** neither declaration supplies an identifier
- **AND** the plan records the two groups in declaration order

#### Scenario: Plan round-trips through JSON

- **WHEN** a plan containing nested config objects and expression values is serialized and parsed as JSON
- **THEN** the parsed plan is semantically identical and remains valid

#### Scenario: Unsupported authoring values are rejected

- **WHEN** an author supplies a function, a circular object, or another non-JSON value in one profile's plan position
- **THEN** validation fails for that profile with the location of the unsupported value
- **AND** no plan is emitted for that profile

### Requirement: The plan format version is 2

The profile plan SHALL use format version 2. A version-2 plan SHALL NOT contain a `dsh` field. A version-1 plan or a version-2 plan carrying `dsh` SHALL fail validation rather than being read.

#### Scenario: Version 2 is accepted

- **WHEN** a plan declares version 2 and no `dsh` field
- **THEN** validation succeeds

#### Scenario: Version 1 is rejected

- **WHEN** a plan declares version 1
- **THEN** validation fails and identifies the unsupported version

#### Scenario: A DSH field is rejected

- **WHEN** a version-2 plan contains a `dsh` field
- **THEN** validation fails and identifies the unsupported field
