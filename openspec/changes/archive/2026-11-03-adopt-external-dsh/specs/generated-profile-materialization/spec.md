## MODIFIED Requirements

### Requirement: Preflight validates composition before publication
Before publication, the system SHALL compose generated patch layers against the selected bundle layers using the composition semantics of the discovered DSH installation. It SHALL report unmatched id-targeted patches and SHALL reject malformed patch entries and duplicate ids inserted by the generated layers. A strict operation SHALL treat unmatched targets as failures and SHALL NOT publish.

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

#### Scenario: Composition follows the active installation

- **WHEN** preflight composes the selected bundle layers
- **THEN** it uses the entry composition provided by the selected DSH installation
- **AND** a warning emitted by that composition is reported unchanged

## ADDED Requirements

### Requirement: The generated manifest declares no DSH engine

The generated package manifest SHALL NOT contain an `engines.dsh` field. The generation record SHALL keep the exact discovered DSH version as `dshVersion`. The generated bundle SHALL continue to declare its ordered patch files through `dsh.bundle.patch`.

#### Scenario: Generated manifest has no DSH engine

- **WHEN** a profile is materialized
- **THEN** its generated package manifest contains no `engines.dsh`
- **AND** it lists its generated patch files in application order

#### Scenario: Record keeps exact provenance

- **WHEN** a profile is materialized under a discovered DSH
- **THEN** the generation record's `dshVersion` is that exact version
