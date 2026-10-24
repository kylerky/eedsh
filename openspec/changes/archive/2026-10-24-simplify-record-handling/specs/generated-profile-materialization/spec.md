## ADDED Requirements

### Requirement: Manifest reconciliation tolerates absent or non-object sections

When an existing profile manifest is reconciled, the system SHALL treat an absent `dsh` section or an absent `dsh.profile` section as an empty object. It SHALL also treat a `dsh` or `dsh.profile` value that is null, an array, or a scalar as an empty object. The system SHALL replace such a section with an object carrying the values eedsh manages. When the section is a JSON object, the system SHALL preserve that object's other fields and SHALL replace only the values eedsh manages.

#### Scenario: Absent dsh section is created

- **WHEN** the existing profile manifest has no `dsh` object
- **THEN** reconciliation writes a `dsh` object containing the reconciled bundle list and leaves the manifest's unrelated top-level fields intact

#### Scenario: Non-object dsh section is replaced

- **WHEN** the existing manifest's `dsh` value is null, an array, or a scalar
- **THEN** reconciliation replaces it with a `dsh` object containing the reconciled profile bundle list

#### Scenario: Non-object profile section is replaced

- **WHEN** `dsh.profile` is null, an array, or a scalar
- **THEN** reconciliation replaces it with a profile object containing the reconciled bundle list

#### Scenario: Other fields in a dsh object are preserved

- **WHEN** `dsh` is a JSON object with fields other than `profile`
- **THEN** those fields remain unchanged and only the values eedsh manages are replaced

#### Scenario: Other fields in a profile object are preserved

- **WHEN** `dsh.profile` is a JSON object with fields other than `bundles`
- **THEN** those fields remain unchanged and only the bundle list is replaced
