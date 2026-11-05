## MODIFIED Requirements

### Requirement: Publication is atomic and idempotent
Materialization SHALL write generated artifacts atomically and SHALL publish the generation record only after every other artifact is complete. The generated package manifest SHALL remain the commit point. A failed validation, package operation, preflight, plan-mirror write, provenance-sidecar write, or commit write SHALL leave the previously published generation intact and bootable, and SHALL restore the profile manifest, lockfile, plan mirror, and provenance sidecar to their pre-publication bytes. Materializing an unchanged plan with intact artifacts SHALL NOT change generated artifact content or the generation identifier. The unchanged check SHALL verify the authoritative plan and the record's `dshVersion` and `eedshVersion`. The plan and layers do not include the running DSH or eedsh version, so when either recorded version differs, materialization SHALL publish with the same generation identifier and refresh the record and its manifest. When the authoritative plan is missing or does not match the record's plan hash, materialization SHALL publish with the same generation identifier and restore the plan artifact.

#### Scenario: Unchanged plan is a no-op
- **WHEN** the same plan is materialized twice, the authoritative plan and mirror are intact, and the recorded DSH and eedsh versions match
- **THEN** no generated artifact content changes and the generation identifier is unchanged

#### Scenario: DSH provenance refresh republishes the same generation
- **WHEN** the plan is unchanged but the record's `dshVersion` differs from the running installation
- **THEN** materialization publishes the same generation identifier with the new `dshVersion`
- **AND** preflight runs against the running installation
- **AND** the command is not treated as unchanged

#### Scenario: Eedsh provenance refresh republishes the same generation
- **WHEN** the plan is unchanged but the record's `eedshVersion` differs from the running eedsh
- **THEN** materialization publishes the same generation identifier with the new `eedshVersion`
- **AND** the command is not treated as unchanged

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
