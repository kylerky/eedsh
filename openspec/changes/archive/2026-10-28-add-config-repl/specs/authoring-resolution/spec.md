## Purpose

Lets a config module read the rows a bundle contributes — from the pinned installation, a named profile's installed copy, or an explicit package directory — so authors target real preset and plugin rows instead of hard-coding ids that drift.

## ADDED Requirements

### Requirement: Resolution names its DSH installation explicitly

The authoring package SHALL resolve bundle contents against the DSH installation named by the `EEDSH_DSH_ANCHOR` environment variable, which the CLI sets to its pinned installation before the config module is imported. When the variable is missing, unreadable, or does not identify a DSH package, every query SHALL fail with a structured failure that names the variable.

#### Scenario: The anchor is set

- **WHEN** the config module calls a query while `EEDSH_DSH_ANCHOR` names the pinned installation
- **THEN** the query resolves against that installation

#### Scenario: The anchor is absent

- **WHEN** the config module calls a query outside eedsh, with no `EEDSH_DSH_ANCHOR`
- **THEN** the query fails with a structured failure that names the variable and the pin it needs

#### Scenario: The anchor is not a DSH package

- **WHEN** `EEDSH_DSH_ANCHOR` points at a path that is not a readable DSH manifest
- **THEN** the query fails with a structured failure that identifies the path

### Requirement: Queries resolve from the pinned installation by default

A query that names no root SHALL resolve the bundle from the pinned installation and SHALL NOT consult a profile's installed copy. A bundle that installation does not ship SHALL fail with a structured failure that names the bundle and states that it needs an explicit root.

#### Scenario: An in-box bundle resolves from the pin

- **WHEN** the author queries a bundle shipped with the pinned installation
- **THEN** the query returns that bundle's rows

#### Scenario: A profile copy is ignored

- **WHEN** a profile contains a different copy of a queried in-box bundle
- **THEN** the query still returns the pinned installation's rows, matching boot's installation-first contract

#### Scenario: A custom bundle without a root

- **WHEN** the author queries a bundle the pinned installation does not ship and names no root
- **THEN** the query fails with a structured failure that names the bundle and states that an explicit root is required

### Requirement: Queries can name an explicit resolution root

A query MAY name exactly one root: `{ profile }` for a named profile's installed copy, or `{ packageDir }` for a directory containing the bundle package. A `{ profile }` root SHALL resolve through the shared DSH home, and a relative `{ packageDir }` SHALL resolve against the directory containing the config file. Naming both roots SHALL fail.

#### Scenario: A profile root resolves the installed copy

- **WHEN** the author queries a custom bundle with `{ profile: 'work' }` and that profile has installed it
- **THEN** the query returns that profile's copy of the rows

#### Scenario: The profile has not installed the bundle

- **WHEN** the named profile has not installed the queried bundle
- **THEN** the query fails with a structured failure that names the profile and suggests a package directory or the session preview

#### Scenario: A package directory root

- **WHEN** the author names `{ packageDir }` for a directory containing the bundle's manifest and patch files
- **THEN** the query returns that copy's rows

#### Scenario: A relative package directory

- **WHEN** `{ packageDir }` is relative
- **THEN** it resolves against the directory containing the config file

#### Scenario: Two roots at once

- **WHEN** a query names both a profile and a package directory
- **THEN** the query fails with a structured failure that rejects the combination

### Requirement: Query results are plain, frozen plan data

Every returned value SHALL be plain JSON-compatible data that validates as an ordinary plan patch entry, and SHALL be frozen so a query result cannot be mutated into a different plan.

#### Scenario: Results are inert data

- **WHEN** an author passes a query result to a patch helper
- **THEN** the helper accepts it as an ordinary row entry and the plan validates

### Requirement: Query failures are structured

A query failure SHALL carry a stable code, the queried bundle name, and a human-readable message. A query SHALL NOT return partial or empty data in place of a failure.

#### Scenario: Failure shape

- **WHEN** a query fails
- **THEN** the failure exposes a code, the bundle name, and a message that identifies the cause

#### Scenario: No silent fallback

- **WHEN** a bundle's patch files cannot be read or parsed
- **THEN** the query fails rather than returning the rows it managed to read
