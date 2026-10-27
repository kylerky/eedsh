## MODIFIED Requirements

### Requirement: Replacement failures are typed

A failed replacement SHALL fail with the platform's file-system error whose operation identifies the atomic write and whose path is the target path. The replacement SHALL NOT introduce a project-defined file-system failure type.

#### Scenario: Failure diagnostic

- **WHEN** a replacement fails
- **THEN** the failure is the platform's file-system error
- **AND** its operation identifies the atomic write
- **AND** its path is the target path
