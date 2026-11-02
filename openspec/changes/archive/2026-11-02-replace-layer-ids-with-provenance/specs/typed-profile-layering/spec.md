## MODIFIED Requirements

### Requirement: TypeScript authoring produces a versioned profile plan
The system SHALL provide a TypeScript authoring surface that accepts a profile name, a DSH runtime pin, ordered bundle selections, ordered generated patch groups, and profile-local package dependencies, and produces a JSON-compatible profile plan with an explicit format version. A generated patch group SHALL be declared without an identifier, and the order of declaration SHALL be the group order.

#### Scenario: Minimal authoring produces a plan
- **WHEN** an author supplies a profile name, a DSH runtime pin, and at least one bundle
- **THEN** the system produces a plan containing the format version, profile name, runtime pin, ordered bundles, ordered patch groups, and package dependencies

#### Scenario: Patch groups are declared without a name
- **WHEN** an author declares two patch groups
- **THEN** neither declaration supplies an identifier
- **AND** the plan records the two groups in declaration order

#### Scenario: Plan round-trips through JSON
- **WHEN** a plan containing nested config objects and expression values is serialized and parsed as JSON
- **THEN** the parsed plan is semantically identical and remains valid

#### Scenario: Unsupported authoring values are rejected
- **WHEN** an author supplies a function, a circular object, or another non-JSON value in a plan position
- **THEN** validation fails with the location of the unsupported value and no plan is emitted

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
