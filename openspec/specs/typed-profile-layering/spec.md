# typed-profile-layering Specification

## Purpose
Lets eedsh authors describe a DSH profile's ordered bundles and generated patch layers in ordinary TypeScript, producing a validated, versioned plan that the materializer can apply.

## Requirements

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
Each generated patch group SHALL be an ordered patch list whose identity is its position in the plan. A patch entry SHALL support inserting entries, overriding an existing entry by id with whole-config replacement, disabling or enabling an entry, declaring a group and isolate scope, asserting an entry name, and preserving any additional Loader patch field. Raw patch entries SHALL be accepted.

#### Scenario: Later override wins
- **WHEN** one patch group inserts a row and a later patch group overrides the same id
- **THEN** the composed result carries the later value

#### Scenario: Override replaces the whole config
- **WHEN** an override supplies a config object for an existing row
- **THEN** the row's config is the supplied object and fields from the earlier config are not merged in

#### Scenario: Disable and enable are patches
- **WHEN** an author disables a row and a later patch group enables it
- **THEN** the composed result has the row enabled

#### Scenario: Group and isolate fields survive
- **WHEN** an author declares a group with an isolate map and child entries
- **THEN** the plan preserves the group flag, isolate map, and ordered children

#### Scenario: Raw patch entry is accepted
- **WHEN** an author supplies a raw Loader patch entry
- **THEN** it is preserved in the patch group as an ordinary patch entry

#### Scenario: A legacy identifier is tolerated
- **WHEN** a plan declares a patch group with an identifier
- **THEN** validation accepts the plan
- **AND** the identifier does not affect the group order, the emitted patch file name, or the composed entries

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
Validation SHALL reject missing profile identity, multiple generated markers, invalid bundle or package specifications, malformed expression nodes, and unsupported JSON values. Every rejection SHALL identify the failing plan location and a human-readable message. Validation SHALL NOT attach a semantic error code to an issue.

#### Scenario: Missing profile name
- **WHEN** a plan omits the profile name
- **THEN** validation fails with an error naming the missing profile name and its location

#### Scenario: Duplicate layer identifier
- **WHEN** a plan declares two patch groups that carry the same legacy identifier
- **THEN** validation succeeds, because an identifier no longer names a group
- **AND** both groups keep their declared order

#### Scenario: Invalid expression node
- **WHEN** an expression node lacks its source text or has an extra shape
- **THEN** validation fails with the expression location

#### Scenario: Valid plan is accepted
- **WHEN** a complete plan contains only supported values
- **THEN** validation succeeds

### Requirement: The plan exposes only Loader layer concepts
The plan SHALL represent DSH bundle, layer, patch, package, and expression concepts only. Module, feature, fragment, and preset-extension concepts SHALL NOT be required to author or validate a profile; a preset is an ordinary inserted row.

#### Scenario: Preset is authored as a row
- **WHEN** an author declares an agent preset
- **THEN** it appears as an inserted Loader row with its configuration and no module or preset-extension metadata is required

#### Scenario: Bundle-only profile is complete
- **WHEN** an author supplies only ordered bundles and their patch layers
- **THEN** the plan is complete and valid without a module registry, flags, or a fragment graph

### Requirement: The plan exposes a public Effect schema as the validator

The system SHALL export a public plan schema that is an Effect Schema value and the single source of truth for validation and the plan type. Decoding a value that is not a valid plan SHALL fail.

#### Scenario: A valid plan decodes through the public schema

- **WHEN** a value contains version 2, a safe profile name, ordered bundles, ordered layers, and package specifications, and contains no `dsh` field
- **THEN** decoding through the public schema succeeds and returns the plan

#### Scenario: An invalid plan is rejected

- **WHEN** a value omits a required plan field or violates any validation rule
- **THEN** decoding fails and the failure identifies the offending plan location

### Requirement: The public schema validates the complete plan contract
The schema SHALL validate the plan shape, profile identity and naming rules, duplicate bundle identifiers, the generated-marker count, reserved names, patch rules, JSON compatibility, and expression-node shape.

#### Scenario: A structurally invalid plan is rejected
- **WHEN** a value supplies a plan field with the wrong type or an unknown plan field
- **THEN** decoding fails and the failure identifies the offending plan location

#### Scenario: A semantically invalid plan is rejected
- **WHEN** a plan contains a duplicate bundle name, more than one generated marker, a reserved name, or an invalid profile name
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
