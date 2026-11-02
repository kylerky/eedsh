## MODIFIED Requirements

### Requirement: TypeScript authoring produces a versioned profile plan

The system SHALL provide a synchronous TypeScript authoring surface in which one config declares one exact DSH pin, an optional default profile name, and a record of named profiles. Each profile SHALL accept ordered bundles, ordered layers, and package dependencies. The surface SHALL produce one JSON-compatible versioned plan per profile, using the record key as the name and the shared pin, and SHALL preserve authored order. Dynamically constructed profile records SHALL be accepted.

#### Scenario: Minimal authoring produces a plan

- **WHEN** an author supplies a shared DSH pin and a profile with at least one bundle
- **THEN** the system produces a plan containing the format version, the record key as profile name, the shared pin, ordered bundles, ordered layers, and package dependencies

#### Scenario: Several profiles produce one plan each

- **WHEN** an author declares profiles `work` and `home` under one config
- **THEN** the system produces one plan for `work` and one for `home`
- **AND** each plan carries its own bundles, layers, and packages

#### Scenario: The shared pin is applied to every plan

- **WHEN** an author supplies one config-level DSH pin and two profiles
- **THEN** both plans contain that exact pin

#### Scenario: The record key becomes the profile name

- **WHEN** an author declares a profile under the key `work`
- **THEN** the resulting plan names the profile `work`

#### Scenario: Dynamically constructed profiles are accepted

- **WHEN** an author builds the profile record with a spread, a computed key, or a loop
- **THEN** every resulting key produces a plan with that key as its name

#### Scenario: Plan round-trips through JSON

- **WHEN** a plan containing nested config objects and expression values is serialized and parsed as JSON
- **THEN** the parsed plan is semantically identical and remains valid

#### Scenario: Unsupported authoring values are rejected

- **WHEN** an author supplies a function, a circular object, or another non-JSON value in one profile's plan position
- **THEN** validation fails for that profile with the location of the unsupported value
- **AND** no plan is emitted for that profile
