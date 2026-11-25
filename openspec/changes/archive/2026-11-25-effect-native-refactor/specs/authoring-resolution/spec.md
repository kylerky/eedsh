# authoring-resolution Specification

## MODIFIED Requirements

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
