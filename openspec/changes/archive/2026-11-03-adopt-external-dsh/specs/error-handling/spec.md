## ADDED Requirements

### Requirement: DSH discovery and capability failures are tagged

A missing, invalid, unsupported, or capability-incomplete DSH installation SHALL produce a tagged domain failure with a stable code and the facts needed to act. The CLI SHALL report it once and exit 1 without publishing or booting. A missing authoring bridge SHALL remain a tagged resolution failure through config import.

#### Scenario: No DSH installation is found

- **WHEN** discovery cannot find an installation
- **THEN** the failure code is `dsh.not_found`
- **AND** the message names `--dsh`, `EEDSH_DSH_ANCHOR`, and installing `dsh`
- **AND** the command exits 1

#### Scenario: Version is outside the supported range

- **WHEN** the discovered version does not satisfy the supported range
- **THEN** the failure code is `dsh.unsupported_version`
- **AND** the failure carries the discovered version and the supported range

#### Scenario: A composition capability is missing

- **WHEN** the selected installation cannot provide entry composition
- **THEN** the failure code is `dsh.capability_missing`
- **AND** the failure names the missing capability
- **AND** no generation is committed

#### Scenario: Authoring runs without a bridge

- **WHEN** a config query runs with no bridge installed
- **THEN** the failure code is `resolution.bridge_missing`
- **AND** config loading preserves that tagged resolution failure
- **AND** the CLI does not report `config.import_failed`
