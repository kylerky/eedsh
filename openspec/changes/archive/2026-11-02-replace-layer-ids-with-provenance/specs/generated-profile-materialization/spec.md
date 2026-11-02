## MODIFIED Requirements

### Requirement: Publication is atomic and idempotent
Materialization SHALL write generated artifacts atomically and SHALL publish the generation record only after every other artifact is complete. The generated package manifest SHALL remain the commit point. A failed validation, package operation, preflight, plan-mirror write, provenance-sidecar write, or commit write SHALL leave the previously published generation intact and bootable, and SHALL restore the profile manifest, lockfile, plan mirror, and provenance sidecar to their pre-publication bytes. Materializing an unchanged plan with intact artifacts SHALL NOT change generated artifact content or the generation identifier. The unchanged check SHALL verify the authoritative plan; when it is missing or does not match the record's plan hash, materialization SHALL publish with the same generation identifier and restore the plan artifact.

#### Scenario: Unchanged plan is a no-op
- **WHEN** the same plan is materialized twice and the authoritative plan and mirror are intact
- **THEN** no generated artifact content changes and the generation identifier is unchanged

#### Scenario: Failure does not publish a partial generation
- **WHEN** materialization fails after writing some generated files
- **THEN** the generation record still names the previous complete generation
- **AND** the profile manifest, lockfile, plan mirror, and provenance sidecar equal their pre-publication bytes

#### Scenario: Changed plan publishes after all artifacts
- **WHEN** the plan changes
- **THEN** the generation record changes only after the new patch files, authoritative plan, provenance sidecar, and manifest are complete

#### Scenario: Commit write failure restores the profile files
- **WHEN** writing the generated package manifest fails
- **THEN** the manifest write is not published
- **AND** the profile manifest, lockfile, plan mirror, and provenance sidecar are restored to their pre-publication bytes

#### Scenario: Missing authoritative plan triggers a same-identifier republish
- **WHEN** the current generation record is valid but its authoritative plan file is missing or mismatched
- **THEN** the next materialization publishes the plan artifact again with the same generation identifier
- **AND** the command is not treated as unchanged

#### Scenario: Unpublished artifacts are unreferenced
- **WHEN** publication fails after writing content-addressed patch files or the authoritative plan for a new generation
- **THEN** those files may remain on disk
- **AND** the committed generation record does not reference them

#### Scenario: A missing sidecar is repaired by the next publication
- **WHEN** the committed generation has no provenance sidecar and the next materialization publishes a new generation
- **THEN** that publication writes a sidecar for the new generation
- **AND** an unchanged materialization of the same generation does not write one

### Requirement: Preflight validates composition before publication
Before publication, the system SHALL compose generated patch layers against the selected bundle layers using DSH-compatible patch semantics. It SHALL report unmatched id-targeted patches and SHALL reject malformed patch entries and duplicate ids inserted by the generated layers. A strict operation SHALL treat unmatched targets as failures and SHALL NOT publish.

#### Scenario: Unmatched override is reported
- **WHEN** a generated patch targets an id that no selected row provides
- **THEN** the operation reports the unmatched target and the generated patch group whose patch produced it

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
The system SHALL write a generation record containing the format version, generation identifier, plan hash, eedsh and DSH versions, ordered patch-group file names and hashes, managed bundle order, and managed package specifications. It SHALL write the validated plan as canonical JSON inside the generated package at `plans/<generationId>.json`, before the package manifest, so the record's generation identifier locates it and its canonical content hashes to the record's plan hash. It SHALL also maintain `.eedsh/plan.json` as a mirror of the committed plan, written at the publication commit point. The mirror is not authoritative. The generation identifier SHALL change only when the validated plan or its generated artifacts change. A later successful materialization SHALL rewrite a missing or differing mirror.

#### Scenario: Generation record lists layers in order
- **WHEN** a plan with multiple patch groups is published
- **THEN** the generation record lists every patch group in application order with its file and hash

#### Scenario: Patch files are named by position
- **WHEN** a generation is published
- **THEN** each generated patch file is named by its 1-based group position
- **AND** the generated package manifest lists those files in application order

#### Scenario: Identical plan keeps the identifier
- **WHEN** the same validated plan is published again
- **THEN** the generation identifier is unchanged

#### Scenario: Changed layer changes the identifier
- **WHEN** any patch group's plan content changes
- **THEN** the generation identifier changes

#### Scenario: Authoritative plan is locatable and verified
- **WHEN** a generation is published
- **THEN** `plans/<generationId>.json` contains the canonical plan
- **AND** its canonical content hashes to the record's plan hash

#### Scenario: Failed attempt does not replace the committed plan
- **WHEN** a publication attempt fails after writing its authoritative plan
- **THEN** the committed record still resolves to the previous generation's plan
- **AND** the new plan file is unreferenced

#### Scenario: Mirror is rewritten after a successful publication
- **WHEN** a successful publication leaves `.eedsh/plan.json` missing or different from the committed plan
- **THEN** the same publication writes the committed plan to the mirror
