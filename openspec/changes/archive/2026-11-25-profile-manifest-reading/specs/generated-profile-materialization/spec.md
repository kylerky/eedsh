## MODIFIED Requirements

### Requirement: Profile dependencies are reconciled

The profile manifest SHALL declare the plan's package dependencies plus the runtime and generated bundle packages. Dependencies removed from the plan after being eedsh-managed SHALL be removed; dependencies added outside eedsh SHALL be preserved. A `dependencies` entry whose value is not a package specification string SHALL be preserved verbatim and reported, except that the managed specification SHALL win when the same name is managed. When `dependencies` is not a JSON object, reconciliation SHALL rebuild the section from the managed specifications and SHALL report that its previous contents could not be preserved. Managed specifications SHALL win when the same package is declared outside eedsh. Managed and previously managed package names SHALL be removed from `devDependencies` and `optionalDependencies`; unrelated entries SHALL be preserved, and a section that is not a JSON object SHALL be left unchanged and reported. Within a section that is an object, an entry whose value is not a package specification string SHALL be preserved unchanged and reported, and readable managed names SHALL still be removed. Managed and previously managed names declared in `peerDependencies`, `pnpm.overrides`, `overrides`, or `resolutions` SHALL be reported as warnings and SHALL NOT be modified. Package installation SHALL run when any reconciled dependency section changes.

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

- **WHEN** `devDependencies` or `optionalDependencies` is not a JSON object
- **THEN** materialization leaves the section unchanged
- **AND** reports that the section could not be reconciled

#### Scenario: Partially readable section is reconciled by entry

- **WHEN** `devDependencies` is an object that declares a managed package and also an entry whose value is not a package specification string
- **THEN** the managed entry is removed
- **AND** the unreadable entry is preserved unchanged
- **AND** the unreadable entry is reported

#### Scenario: Unreadable dependency entry is preserved and reported

- **WHEN** `dependencies` declares a package eedsh does not manage with a value that is not a package specification string
- **THEN** the entry is preserved verbatim in the materialized manifest
- **AND** the entry is reported

#### Scenario: Non-object dependencies section is rebuilt and reported

- **WHEN** `dependencies` is an array, null, or a scalar
- **THEN** the materialized manifest declares the managed specifications
- **AND** materialization reports that the previous contents could not be preserved

#### Scenario: Peer or override conflict is reported

- **WHEN** a managed or previously managed package appears in `peerDependencies`, `pnpm.overrides`, `overrides`, or `resolutions`
- **THEN** materialization reports a warning naming the package and the field
- **AND** leaves that field unchanged

#### Scenario: Section-only change triggers installation

- **WHEN** the only manifest change is the removal of a managed duplicate from `devDependencies` or `optionalDependencies`
- **THEN** package installation runs for the profile
