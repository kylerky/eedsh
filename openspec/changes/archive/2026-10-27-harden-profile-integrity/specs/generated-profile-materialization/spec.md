## ADDED Requirements

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

## MODIFIED Requirements

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

Materialization SHALL write generated artifacts atomically and SHALL publish the generation record only after every other artifact is complete. The generated package manifest SHALL remain the commit point. A failed validation, package operation, preflight, plan-mirror write, or commit write SHALL leave the previously published generation intact and bootable, and SHALL restore the profile manifest, lockfile, and plan mirror to their pre-publication bytes. Materializing an unchanged plan with intact artifacts SHALL NOT change generated artifact content or the generation identifier. The unchanged check SHALL verify the authoritative plan; when it is missing or does not match the record's plan hash, materialization SHALL publish with the same generation identifier and restore the plan artifact.

#### Scenario: Unchanged plan is a no-op

- **WHEN** the same plan is materialized twice and the authoritative plan and mirror are intact
- **THEN** no generated artifact content changes and the generation identifier is unchanged

#### Scenario: Failure does not publish a partial generation

- **WHEN** materialization fails after writing some generated files
- **THEN** the generation record still names the previous complete generation
- **AND** the profile manifest, lockfile, and plan mirror equal their pre-publication bytes

#### Scenario: Changed plan publishes after all artifacts

- **WHEN** the plan changes
- **THEN** the generation record changes only after the new patch files, authoritative plan, and manifest are complete

#### Scenario: Commit write failure restores the profile files

- **WHEN** writing the generated package manifest fails
- **THEN** the manifest write is not published
- **AND** the profile manifest, lockfile, and plan mirror are restored to their pre-publication bytes

#### Scenario: Missing authoritative plan triggers a same-identifier republish

- **WHEN** the current generation record is valid but its authoritative plan file is missing or mismatched
- **THEN** the next materialization publishes the plan artifact again with the same generation identifier
- **AND** the command is not treated as unchanged

#### Scenario: Unpublished artifacts are unreferenced

- **WHEN** publication fails after writing content-addressed patch files or the authoritative plan for a new generation
- **THEN** those files may remain on disk
- **AND** the committed generation record does not reference them

### Requirement: The generation record is observable provenance

The system SHALL write a generation record containing the format version, generation identifier, plan hash, eedsh and DSH versions, ordered layer identifiers and hashes, managed bundle order, and managed package specifications. It SHALL write the validated plan as canonical JSON inside the generated package at `plans/<generationId>.json`, before the package manifest, so the record's generation identifier locates it and its canonical content hashes to the record's plan hash. It SHALL also maintain `.eedsh/plan.json` as a mirror of the committed plan, written at the publication commit point. The mirror is not authoritative. The generation identifier SHALL change only when the validated plan or its generated artifacts change. A later successful materialization SHALL rewrite a missing or differing mirror.

#### Scenario: Generation record lists layers in order

- **WHEN** a plan with multiple layers is published
- **THEN** the generation record lists every layer in application order with its file and hash

#### Scenario: Identical plan keeps the identifier

- **WHEN** the same validated plan is published again
- **THEN** the generation identifier is unchanged

#### Scenario: Changed layer changes the identifier

- **WHEN** any layer's plan content changes
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
