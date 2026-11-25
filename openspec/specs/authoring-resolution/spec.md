# authoring-resolution Specification

## Purpose
Lets a config module read the rows a bundle contributes — from the pinned installation, a named profile's installed copy, or an explicit package directory — so authors target real preset and plugin rows instead of hard-coding ids that drift.

## Requirements

### Requirement: Resolution names its DSH installation explicitly

The CLI SHALL resolve the bundle contents a config queries against the DSH installation discovered for that invocation, in a phase that runs after the config module is evaluated and before the build phase. The authoring package SHALL NOT install, look up, or depend on ambient installation state. `EEDSH_DSH_ANCHOR` SHALL remain an explicit installation override for discovery, not the query-time source of truth. When the selected installation cannot provide a required capability, or a bundle cannot be read from it, the invocation SHALL fail with a structured failure naming the bundle, the root, and the installation problem, and no partial rows SHALL be used.

#### Scenario: The anchor is set

- **WHEN** the invocation has selected an installation, explicitly or by discovery
- **THEN** every recorded query resolves against that installation

#### Scenario: The anchor is absent

- **WHEN** no installation is discovered and none is selected with `--dsh`
- **THEN** the command fails with the discovery failure before the config module is evaluated
- **AND** the message states that an installation must be selected with `--dsh` or by installing `dsh`

#### Scenario: The anchor is not a DSH package

- **WHEN** the selected installation cannot provide a required bundle-resolution or composition capability
- **THEN** resolution fails with a structured failure naming the missing capability
- **AND** no partial rows are returned

#### Scenario: The selected installation supplies the rows

- **WHEN** the invocation resolves a recorded query
- **THEN** the rows come from the installation selected for that invocation
- **AND** the authoring package reads no installation state of its own

#### Scenario: No installation is selected

- **WHEN** evaluation would need the selected version but no installation was discovered
- **THEN** the command fails before evaluation
- **AND** no builder is created and no query is resolved

#### Scenario: The installation cannot serve a query

- **WHEN** a bundle a recorded query names cannot be read from the selected installation
- **THEN** resolution fails with a structured failure naming the bundle and the installation path
- **AND** the build phase does not run

### Requirement: Queries resolve from the pinned installation by default

A `bundle(name)` handle that names no root SHALL resolve the bundle from the active installation and SHALL NOT consult a profile's installed copy. A bundle the active installation does not ship SHALL fail with a structured failure that names the bundle and states that it needs an explicit root.

#### Scenario: An in-box bundle resolves from the pin

- **WHEN** the author queries a bundle shipped with the active installation
- **THEN** the handle's `.rows()` and `.presets()` return that bundle's rows

#### Scenario: A profile copy is ignored

- **WHEN** a profile contains a different copy of a queried in-box bundle
- **THEN** the handle still returns the active installation's rows, matching boot's installation-first contract

#### Scenario: A custom bundle without a root

- **WHEN** the author queries a bundle the active installation does not ship and names no root
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

### Requirement: Query results are plain, frozen plan data

Typed query handles SHALL expose plain JSON-compatible plan data through `.toJSON()`, and layer insertion SHALL normalize a handle to plan data that validates as an ordinary plan patch entry. Every runtime expression parsed from DSH patch data SHALL be represented by the plan's expression node shape, not by a DSH-internal marker. Returned values SHALL be frozen so a query result cannot be mutated into a different plan.

#### Scenario: Results are inert data

- **WHEN** an author passes a query result to `layer.insert()`
- **THEN** the helper accepts it as an ordinary row entry and the plan validates

#### Scenario: Runtime expressions are plan-shaped

- **WHEN** an author queries a preset whose children contain runtime expressions and inserts that preset into a generated layer
- **THEN** the plan validates without a user-written conversion helper
- **AND** the generated patch preserves the expressions as `!!js` scalars

#### Scenario: Query data cannot be mutated

- **WHEN** an author attempts to mutate a returned query result or its nested data
- **THEN** the mutation fails or does not affect the resolved data

### Requirement: Query failures are structured

A query failure SHALL carry a stable code, the queried bundle name, and a human-readable message. A query SHALL NOT return partial or empty data in place of a failure.

#### Scenario: Failure shape

- **WHEN** a query fails
- **THEN** the failure exposes a code, the bundle name, and a message that identifies the cause

#### Scenario: No silent fallback

- **WHEN** a bundle's patch files cannot be read or parsed
- **THEN** the query fails rather than returning the rows it managed to read
