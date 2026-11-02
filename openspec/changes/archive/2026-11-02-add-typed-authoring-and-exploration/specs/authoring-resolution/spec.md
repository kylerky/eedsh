## MODIFIED Requirements

### Requirement: Queries resolve from the pinned installation by default

A `bundle(name)` handle that names no root SHALL resolve the bundle from the pinned installation and SHALL NOT consult a profile's installed copy. A bundle the pinned installation does not ship SHALL fail with a structured failure that names the bundle and states that it needs an explicit root.

#### Scenario: An in-box bundle resolves from the pin

- **WHEN** the author queries a bundle shipped with the pinned installation
- **THEN** the handle's `.rows()` and `.presets()` return that bundle's rows

#### Scenario: A profile copy is ignored

- **WHEN** a profile contains a different copy of a queried in-box bundle
- **THEN** the handle still returns the pinned installation's rows, matching boot's installation-first contract

#### Scenario: A custom bundle without a root

- **WHEN** the author queries a bundle the pinned installation does not ship and names no root
- **THEN** the query fails with a structured failure that names the bundle and states that an explicit root is required

### Requirement: Queries can name an explicit resolution root

A bundle handle MAY name exactly one root: `.fromProfile(profile)` for a named profile's installed copy, or `.fromPackageDir(dir)` for a directory containing the bundle package. A rooted handle SHALL be query-only, SHALL NOT be accepted as a plan selection, and SHALL NOT expose a second root. `.fromProfile()` SHALL accept a profile name or a structural handle carrying a name. A profile root SHALL resolve through the shared DSH home, and a relative package directory SHALL resolve against the directory containing the config file.

#### Scenario: A profile root resolves the installed copy

- **WHEN** the author roots a bundle handle with `.fromProfile('work')` and that profile has installed the bundle
- **THEN** the handle returns that profile's copy of the rows

#### Scenario: The profile has not installed the bundle

- **WHEN** the named profile has not installed the queried bundle
- **THEN** the query fails with a structured failure that names the profile and suggests a package directory or the session preview

#### Scenario: A package directory root

- **WHEN** the author roots a handle with `.fromPackageDir(dir)` for a directory containing the bundle's manifest and patch files
- **THEN** the handle returns that copy's rows

#### Scenario: A relative package directory

- **WHEN** the package directory root is relative
- **THEN** it resolves against the directory containing the config file

#### Scenario: A rooted handle cannot become a plan selection

- **WHEN** a rooted handle is passed to `ProfileBuilder.bundle()`
- **THEN** authoring rejects it and does not silently drop the root

#### Scenario: A structural profile handle is accepted

- **WHEN** `.fromProfile()` receives a handle carrying a `name` rather than a string
- **THEN** it resolves from that profile's installed copy

#### Scenario: Two roots at once

- **WHEN** a query handle names both a profile and a package directory
- **THEN** the query fails with a structured failure that rejects the combination

## REMOVED Requirements

### Requirement: Query results are plain, frozen plan data

**Reason**: Query methods now return typed immutable `Row` and `Preset` handles over a frozen resolution snapshot; plain plan data is produced explicitly by `.toJSON()` and by layer insertion.

**Migration**: Use `bundle(name).rows()`, `.row(id)`, `.presets()`, and `.preset(id)`; pass handles to `LayerBuilder.insert()` or call `.toJSON()` when plain plan data is required.
