## MODIFIED Requirements

### Requirement: Resolution names its DSH installation explicitly

The authoring package SHALL resolve bundle contents through the capability bridge installed by the CLI for the active DSH installation. The CLI SHALL discover that installation and install the bridge before importing the config module. `EEDSH_DSH_ANCHOR` SHALL remain an explicit installation override for discovery, not the query-time source of truth. When the bridge is missing, the selected installation cannot provide a required capability, or a bundle cannot be read through it, every query SHALL fail with a structured failure that identifies the active installation problem.

#### Scenario: The anchor is set

- **WHEN** the config module calls a query while the CLI has installed the bridge for the selected installation
- **THEN** the query resolves against that installation

#### Scenario: The anchor is absent

- **WHEN** the config module calls a query outside eedsh, with no bridge installed
- **THEN** the query fails with a structured failure that says queries must run through eedsh or an explicit `--dsh` selection

#### Scenario: The anchor is not a DSH package

- **WHEN** the selected installation cannot provide a required bundle-resolution or composition capability
- **THEN** the query fails with a structured failure naming the missing capability
- **AND** no partial rows are returned

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
