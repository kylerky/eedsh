## Purpose

Turns a validated profile plan into a normal DSH profile that vanilla `dsh` can boot, with a generated bundle layer, reconciled manifest and dependencies, and atomic publication while preserving user-owned layers.

## ADDED Requirements

### Requirement: A valid plan materializes into a bootable DSH profile
Given a valid plan and a target profile directory, the system SHALL create or update a profile package manifest, a generated bundle package whose patch files are the plan's layers in order, a generation record, and the empty root configuration DSH expects. The resulting profile SHALL boot through the vanilla DSH launcher.

#### Scenario: New profile boots
- **WHEN** a valid plan is materialized into a new profile
- **THEN** `dsh --profile <name> --dump-config` succeeds and shows the generated rows

#### Scenario: Existing profile updates in place
- **WHEN** a valid plan is materialized over an existing profile
- **THEN** unrelated manifest fields remain and the generated layer reflects the new plan

#### Scenario: Generated rows are visible to Loader composition
- **WHEN** the materialized profile is dumped
- **THEN** inserted rows and id-targeted overrides from the plan appear in the composed entry list

### Requirement: Managed bundles follow the positional generated layer
The profile manifest SHALL list managed bundles in plan order, with the static runtime bundle immediately before the generated bundle and the generated bundle at the authored marker position. When the marker is omitted, the generated bundle SHALL be last among managed bundles. Bundles added outside eedsh SHALL be preserved after managed bundles in their previous relative order, and duplicate entries SHALL NOT be emitted.

#### Scenario: Midpoint marker controls manifest order
- **WHEN** the plan places the generated marker between two managed bundles
- **THEN** the manifest lists the first bundle, the runtime bundle, the generated bundle, and the second bundle in that order

#### Scenario: Omitted marker places generated last among managed bundles
- **WHEN** the plan omits the generated marker
- **THEN** the generated bundle follows every managed bundle

#### Scenario: User-added bundle survives
- **WHEN** the profile already lists a bundle that the plan does not manage
- **THEN** the bundle remains enabled after all managed bundles

#### Scenario: Previously managed bundle is removed
- **WHEN** a bundle was managed by an earlier generation and is absent from the new plan
- **THEN** it is removed from the manifest unless it was added outside eedsh

#### Scenario: No duplicate bundle entry
- **WHEN** a bundle appears both in the plan and outside it
- **THEN** the manifest contains it once, in the managed position

### Requirement: User-owned layers are never rewritten
Materialization SHALL NOT modify an existing profile `cordis.patch.yml`, the harness-home patch, or invocation overlays. It SHALL create an empty profile `cordis.patch.yml` only when none exists.

#### Scenario: Existing profile patch is untouched
- **WHEN** materialization runs over a profile with an existing patch file
- **THEN** the file's bytes are unchanged

#### Scenario: Existing profile override still wins
- **WHEN** the profile patch overrides a row also configured by the generated layer
- **THEN** the composed configuration uses the profile patch value

#### Scenario: Missing profile patch is created empty
- **WHEN** the profile has no patch file
- **THEN** materialization creates an empty patch file and leaves it user-editable

### Requirement: Profile dependencies are reconciled
The profile manifest SHALL declare the plan's package dependencies plus the runtime and generated bundle packages. Dependencies removed from the plan after being eedsh-managed SHALL be removed; dependencies added outside eedsh SHALL be preserved. Managed specifications SHALL win when the same package is declared outside eedsh.

#### Scenario: Managed dependency is installed
- **WHEN** a plan declares a package dependency
- **THEN** the materialized profile declares it and the package is available to DSH resolution

#### Scenario: Previously managed dependency is removed
- **WHEN** a dependency was managed by an earlier generation and is absent from the new plan
- **THEN** the profile no longer declares it

#### Scenario: User-added dependency survives
- **WHEN** the profile declares a dependency that eedsh does not manage
- **THEN** it remains declared

#### Scenario: Managed specification wins
- **WHEN** the same package is declared both in the plan and outside it
- **THEN** the profile declares the plan's specification

### Requirement: Publication is atomic and idempotent
Materialization SHALL write generated artifacts atomically and SHALL publish the generation record only after every other artifact is complete. A failed validation, package operation, or write SHALL leave the previously published generation intact and bootable. Materializing an unchanged plan SHALL NOT change generated artifact content or the generation identifier.

#### Scenario: Unchanged plan is a no-op
- **WHEN** the same plan is materialized twice
- **THEN** no generated artifact content changes and the generation identifier is unchanged

#### Scenario: Failure does not publish a partial generation
- **WHEN** materialization fails after writing some generated files
- **THEN** the generation record still names the previous complete generation

#### Scenario: Changed plan publishes after all artifacts
- **WHEN** the plan changes
- **THEN** the generation record changes only after the new patch files and manifest are complete

### Requirement: Preflight validates composition before publication
Before publication, the system SHALL compose generated patch layers against the selected bundle layers using DSH-compatible patch semantics. It SHALL report unmatched id-targeted patches and SHALL reject malformed patch entries and duplicate ids inserted by the generated layers. A strict operation SHALL treat unmatched targets as failures and SHALL NOT publish.

#### Scenario: Unmatched override is reported
- **WHEN** a generated patch targets an id that no selected row provides
- **THEN** the operation reports the unmatched target and its layer

#### Scenario: Strict mode blocks publication
- **WHEN** strict mode encounters an unmatched target
- **THEN** the operation exits nonzero and the generation record is unchanged

#### Scenario: Duplicate inserted id is rejected
- **WHEN** generated layers insert the same row id twice
- **THEN** validation fails before publication

#### Scenario: Malformed patch entry is rejected
- **WHEN** a patch entry or expression node has a malformed shape
- **THEN** validation fails before publication

### Requirement: The generation record is observable provenance
The system SHALL write a generation record containing the format version, generation identifier, plan hash, eedsh and DSH versions, ordered layer identifiers and hashes, managed bundle order, and managed package specifications. It SHALL also write the validated plan as JSON. The generation identifier SHALL change only when the validated plan or its generated artifacts change.

#### Scenario: Generation record lists layers in order
- **WHEN** a plan with multiple layers is published
- **THEN** the generation record lists every layer in application order with its file and hash

#### Scenario: Identical plan keeps the identifier
- **WHEN** the same validated plan is published again
- **THEN** the generation identifier is unchanged

#### Scenario: Changed layer changes the identifier
- **WHEN** any layer's plan content changes
- **THEN** the generation identifier changes
