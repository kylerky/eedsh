# atomic-file-replacement Specification

## Purpose
Define atomic replacement of profile files: readers see either the previous or the new content, failed replacements leave the target unchanged, and no temporary files remain.

## Requirements

### Requirement: Replacement is atomic

The replacement operation SHALL write the new content to a temporary file in the target directory and rename it over the target, so a reader observes either the previous content or the complete new content, never a partial write.

#### Scenario: Successful replacement

- **WHEN** a profile file is replaced successfully
- **THEN** the target contains the complete new content
- **AND** no temporary file remains in the target directory

#### Scenario: Concurrent reader

- **WHEN** another reader opens the target while a replacement is in progress
- **THEN** the reader sees either the previous content or the complete new content
- **AND** never a partial or missing file caused by the replacement

### Requirement: Failed replacement cleans up and preserves the target

If writing the temporary file or renaming it over the target fails, the operation SHALL remove the temporary file and SHALL leave the target with its previous content.

#### Scenario: Write failure after the temporary file exists

- **WHEN** writing the temporary file fails after the file was created
- **THEN** the temporary file is removed
- **AND** the target keeps its previous content

#### Scenario: Rename failure

- **WHEN** the final rename fails
- **THEN** the temporary file is removed
- **AND** the target keeps its previous content

### Requirement: Replacement failures are typed

A failed replacement SHALL fail with a `FileSystemFailure` whose operation identifies the atomic write and whose path is the target path.

#### Scenario: Failure diagnostic

- **WHEN** a replacement fails
- **THEN** the failure is a `FileSystemFailure`
- **AND** its operation identifies the atomic write
- **AND** its path is the target path
