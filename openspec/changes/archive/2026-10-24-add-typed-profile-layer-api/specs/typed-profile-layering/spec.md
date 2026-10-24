## Purpose

Lets eedsh authors describe a DSH profile's ordered bundles and generated patch layers in ordinary TypeScript, producing a validated, versioned plan that the materializer can apply.

## ADDED Requirements

### Requirement: TypeScript authoring produces a versioned profile plan
The system SHALL provide a TypeScript authoring surface that accepts a profile name, a DSH runtime pin, ordered bundle selections, ordered generated patch layers, and profile-local package dependencies, and produces a JSON-compatible profile plan with an explicit format version.

#### Scenario: Minimal authoring produces a plan
- **WHEN** an author supplies a profile name, a DSH runtime pin, and at least one bundle
- **THEN** the system produces a plan containing the format version, profile name, runtime pin, ordered bundles, ordered layers, and package dependencies

#### Scenario: Plan round-trips through JSON
- **WHEN** a plan containing nested config objects and expression values is serialized and parsed as JSON
- **THEN** the parsed plan is semantically identical and remains valid

#### Scenario: Unsupported authoring values are rejected
- **WHEN** an author supplies a function, a circular object, or another non-JSON value in a plan position
- **THEN** validation fails with the location of the unsupported value and no plan is emitted

### Requirement: Bundles are ordered and the generated layer is positional
The plan SHALL preserve the authored bundle order and SHALL accept at most one generated-layer marker. When the marker is present, the generated layer occupies that position; when it is absent, the generated layer is last among managed bundles.

#### Scenario: Explicit generated marker keeps its position
- **WHEN** bundles are authored as the first bundle, the generated marker, and then a second bundle
- **THEN** the plan records the first bundle, the generated layer, and the second bundle in that order

#### Scenario: Omitted marker defaults to the end
- **WHEN** a plan lists bundles without a generated marker
- **THEN** the generated layer is placed after every managed bundle

#### Scenario: Duplicate generated markers are rejected
- **WHEN** a plan contains more than one generated marker
- **THEN** validation fails and identifies the duplicate marker

#### Scenario: Bundle order is preserved
- **WHEN** a plan lists bundles in a specific order
- **THEN** the plan preserves that order

### Requirement: Patch layers use Loader patch semantics
Each generated layer SHALL have a unique identifier and an ordered patch list. A patch entry SHALL support inserting entries, overriding an existing entry by id with whole-config replacement, disabling or enabling an entry, declaring a group and isolate scope, asserting an entry name, and preserving any additional Loader patch field. Raw patch entries SHALL be accepted.

#### Scenario: Later override wins
- **WHEN** one layer inserts a row and a later layer overrides the same id
- **THEN** the composed result carries the later value

#### Scenario: Override replaces the whole config
- **WHEN** an override supplies a config object for an existing row
- **THEN** the row's config is the supplied object and fields from the earlier config are not merged in

#### Scenario: Disable and enable are patches
- **WHEN** an author disables a row and a later layer enables it
- **THEN** the composed result has the row enabled

#### Scenario: Group and isolate fields survive
- **WHEN** an author declares a group with an isolate map and child entries
- **THEN** the plan preserves the group flag, isolate map, and ordered children

#### Scenario: Raw patch entry is accepted
- **WHEN** an author supplies a raw Loader patch entry
- **THEN** it is preserved in the layer as an ordinary patch entry

### Requirement: Runtime expressions are structured data
The plan SHALL represent runtime expressions as structured nodes carrying the expression source text. The plan SHALL NOT contain executable functions or other values that cannot be serialized as JSON.

#### Scenario: Expression node survives serialization
- **WHEN** an author supplies a runtime expression for a config value or disabled field
- **THEN** the plan contains a structured expression node with the exact source text and JSON round-trip preserves it

#### Scenario: Expression is not a function
- **WHEN** an author supplies a function instead of an expression node
- **THEN** validation rejects it rather than storing executable code

#### Scenario: Expression source is preserved verbatim
- **WHEN** an expression contains quotes, parentheses, and nested calls
- **THEN** the plan stores and returns the source text without evaluating or rewriting it

### Requirement: Plan validation rejects invalid profiles
Validation SHALL reject missing profile identity, multiple generated markers, duplicate or empty layer identifiers, invalid bundle or package specifications, malformed expression nodes, and unsupported JSON values. Every rejection SHALL identify the failing plan location and a stable error code.

#### Scenario: Missing profile name
- **WHEN** a plan omits the profile name
- **THEN** validation fails with an error naming the missing profile name

#### Scenario: Duplicate layer identifier
- **WHEN** two layers share an identifier
- **THEN** validation fails and identifies both layers

#### Scenario: Invalid expression node
- **WHEN** an expression node lacks its source text or has an extra shape
- **THEN** validation fails with the expression location

#### Scenario: Valid plan is accepted
- **WHEN** a complete plan contains only supported values and unique layer identifiers
- **THEN** validation succeeds

### Requirement: The plan exposes only Loader layer concepts
The plan SHALL represent DSH bundle, layer, patch, package, and expression concepts only. Module, feature, fragment, and preset-extension concepts SHALL NOT be required to author or validate a profile; a preset is an ordinary inserted row.

#### Scenario: Preset is authored as a row
- **WHEN** an author declares an agent preset
- **THEN** it appears as an inserted Loader row with its configuration and no module or preset-extension metadata is required

#### Scenario: Bundle-only profile is complete
- **WHEN** an author supplies only ordered bundles and their patch layers
- **THEN** the plan is complete and valid without a module registry, flags, or a fragment graph
