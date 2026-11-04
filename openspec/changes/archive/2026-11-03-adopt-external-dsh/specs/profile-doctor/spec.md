## MODIFIED Requirements

### Requirement: Doctor is read-only

`eedsh doctor` SHALL NOT create, modify, or delete any profile file, directory, lock, package, or generated artifact. It SHALL NOT acquire the sync lock and SHALL NOT require a DSH installation to be present.

#### Scenario: Doctor leaves the profile unchanged

- **WHEN** doctor runs against a valid published profile
- **THEN** every profile file has the same bytes before and after
- **AND** no lock file is created or left behind

#### Scenario: Doctor does not need the DSH installation

- **WHEN** no DSH installation can be discovered
- **THEN** doctor still inspects the selected profile

## ADDED Requirements

### Requirement: Doctor reports discovered DSH provenance and record drift

When a DSH installation is discoverable, doctor SHALL report its path and version. It SHALL report an error when the discovered version is outside eedsh's supported range. It SHALL report a warning when the generation record's exact `dshVersion` differs from the discovered version. With no installation, doctor SHALL report no DSH finding. Doctor SHALL NOT read a version-1 plan or derive a compatibility check from `engines.dsh`, which no longer exists.

#### Scenario: Compatible installation

- **WHEN** the discovered DSH is inside the supported range and matches the record
- **THEN** doctor reports no DSH finding

#### Scenario: Unsupported installation

- **WHEN** the discovered DSH is outside eedsh's supported range
- **THEN** doctor reports an error naming the discovered version and the supported range

#### Scenario: Generation version drift

- **WHEN** the record's `dshVersion` differs from the discovered version
- **THEN** doctor reports a warning recommending `eedsh sync`

#### Scenario: No installation is available

- **WHEN** no DSH installation is discoverable
- **THEN** doctor reports no DSH finding
- **AND** its exit status is determined by the remaining checks
