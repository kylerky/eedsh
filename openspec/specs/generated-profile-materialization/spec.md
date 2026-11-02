# generated-profile-materialization Specification

## Purpose
Turns a validated profile plan into a normal DSH profile that vanilla `dsh` can boot, with a generated bundle layer, reconciled manifest and dependencies, and atomic publication while preserving user-owned layers.

## Requirements

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

The profile manifest SHALL declare the plan's package dependencies plus the runtime and generated bundle packages. Dependencies removed from the plan after being eedsh-managed SHALL be removed; dependencies added outside eedsh SHALL be preserved. Managed specifications SHALL win when the same package is declared outside eedsh. Managed and previously managed package names SHALL be removed from `devDependencies` and `optionalDependencies`; unrelated entries SHALL be preserved, and a section that is not a record of string specifications SHALL be left unchanged and reported. Managed and previously managed names declared in `peerDependencies`, `pnpm.overrides`, `overrides`, or `resolutions` SHALL be reported as warnings and SHALL NOT be modified. Package installation SHALL run when any reconciled dependency section changes.

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

#### Scenario: Managed duplicate is removed from devDependencies

- **WHEN** a managed package is also declared in `devDependencies`
- **THEN** the materialized manifest removes the `devDependencies` entry
- **AND** the package remains declared in `dependencies`
- **AND** the removal is reported

#### Scenario: Managed duplicate is removed from optionalDependencies

- **WHEN** a managed package is also declared in `optionalDependencies`
- **THEN** the materialized manifest removes the `optionalDependencies` entry
- **AND** the package remains a required dependency
- **AND** the removal is reported

#### Scenario: Unrelated dev dependency is preserved

- **WHEN** `devDependencies` contains a package the plan does not manage
- **THEN** the entry and its specification remain unchanged

#### Scenario: Previously managed duplicate is cleaned up

- **WHEN** a package was managed by the previous generation, is absent from the new plan, and is also declared in `devDependencies`
- **THEN** it is removed from both `dependencies` and `devDependencies`

#### Scenario: Malformed dependency section is left alone

- **WHEN** `devDependencies` or `optionalDependencies` is not a record of string specifications
- **THEN** materialization leaves the section unchanged
- **AND** reports that the section could not be reconciled

#### Scenario: Peer or override conflict is reported

- **WHEN** a managed or previously managed package appears in `peerDependencies`, `pnpm.overrides`, `overrides`, or `resolutions`
- **THEN** materialization reports a warning naming the package and the field
- **AND** leaves that field unchanged

#### Scenario: Section-only change triggers installation

- **WHEN** the only manifest change is the removal of a managed duplicate from `devDependencies` or `optionalDependencies`
- **THEN** package installation runs for the profile

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

### Requirement: Manifest reconciliation tolerates absent or non-object sections

When an existing profile manifest is reconciled, the system SHALL treat an absent `dsh` section or an absent `dsh.profile` section as an empty object. It SHALL also treat a `dsh` or `dsh.profile` value that is null, an array, or a scalar as an empty object. The system SHALL replace such a section with an object carrying the values eedsh manages. When the section is a JSON object, the system SHALL preserve that object's other fields and SHALL replace only the values eedsh manages.

#### Scenario: Absent dsh section is created

- **WHEN** the existing profile manifest has no `dsh` object
- **THEN** reconciliation writes a `dsh` object containing the reconciled bundle list and leaves the manifest's unrelated top-level fields intact

#### Scenario: Non-object dsh section is replaced

- **WHEN** the existing manifest's `dsh` value is null, an array, or a scalar
- **THEN** reconciliation replaces it with a `dsh` object containing the reconciled profile bundle list

#### Scenario: Non-object profile section is replaced

- **WHEN** `dsh.profile` is null, an array, or a scalar
- **THEN** reconciliation replaces it with a profile object containing the reconciled bundle list

#### Scenario: Other fields in a dsh object are preserved

- **WHEN** `dsh` is a JSON object with fields other than `profile`
- **THEN** those fields remain unchanged and only the values eedsh manages are replaced

#### Scenario: Other fields in a profile object are preserved

- **WHEN** `dsh.profile` is a JSON object with fields other than `bundles`
- **THEN** those fields remain unchanged and only the bundle list is replaced

### Requirement: An invalid generation record blocks reconciliation

Before reconciling, materialization SHALL classify the generation record as absent, valid, or invalid. An absent record SHALL be a first materialization only when the profile has no eedsh-managed artifact: no runtime or generated bundle in the manifest, no plan mirror, and no generated package. Any invalid record on a profile with an eedsh-managed artifact SHALL fail with a diagnostic naming the record path and reason, and SHALL NOT reconcile or publish.

#### Scenario: Invalid record blocks publication

- **WHEN** an eedsh-managed profile has a generation record with an unknown format or malformed shape and `eedsh sync` runs without `--adopt-ownership`
- **THEN** the command reports an error naming the record path and the reason
- **AND** exits with status 1
- **AND** the profile manifest and the existing generation record are unchanged

#### Scenario: First materialization proceeds without a record

- **WHEN** the target profile has no manifest entry for the runtime or generated bundle, no plan mirror, and no generated package
- **THEN** materialization treats the record as absent and publishes normally

#### Scenario: Unparseable record blocks publication

- **WHEN** the generation record cannot be parsed as JSON
- **THEN** the command fails without reconciling or publishing
- **AND** the existing profile files are unchanged

### Requirement: Ownership can be re-baselined explicitly

`eedsh sync --adopt-ownership` SHALL re-baseline ownership from the current manifest: it treats every entry not managed by the plan as user-owned, writes a fresh record, and reports the adoption. A record with an unsupported newer version SHALL name the eedsh upgrade and SHALL NOT be adoptable.

#### Scenario: Adoption re-baselines ownership

- **WHEN** the user runs `eedsh sync --adopt-ownership` against a profile with an invalid record
- **THEN** every live entry not managed by the plan is treated as user-owned
- **AND** a fresh generation record is written
- **AND** the command reports which entries were adopted

#### Scenario: Newer record version refuses adoption

- **WHEN** the record declares a format version newer than the command supports
- **THEN** the command reports an error instructing the user to upgrade eedsh
- **AND** `--adopt-ownership` does not proceed

### Requirement: Ownership is last-applied

Ownership SHALL be determined by the generation record of the last successful publication, not by an ever-managed history. A bundle or dependency that the plan no longer manages SHALL be removed when the removal is published. After that publication, adding the same name to the profile manifest outside eedsh SHALL make it user-owned on the next materialization, and eedsh SHALL preserve it. Eedsh SHALL NOT retain a separate release or historical ownership state.

#### Scenario: Removed bundle re-added after publication survives

- **WHEN** a managed bundle was removed by a published generation and is later added to the profile manifest outside eedsh
- **THEN** the next materialization preserves it as a user-added bundle

#### Scenario: Removed dependency re-added after publication survives

- **WHEN** a managed dependency was removed by a published generation and is later added to the profile manifest outside eedsh
- **THEN** the next materialization preserves it as a user-added dependency

#### Scenario: Re-addition before removal is published is still removed

- **WHEN** a bundle is absent from the new plan and is added to the manifest before the removal is published
- **THEN** the pending removal removes it, because the previous record still marks it managed
