## Purpose

Defines how eedsh reads a profile's package manifest: one classified read that separates a missing document from an unusable one, a typed interpretation computed once, and the guarantees that make a rewrite safe. It exists so materialization, doctor, and the REPL interpret the same document the same way, and so a malformed manifest is reported rather than replaced.

## ADDED Requirements

### Requirement: The profile manifest is classified before it is interpreted

The system SHALL read the profile manifest at `<profile>/package.json` once and classify it as missing, invalid, or valid before any consumer interprets it. An invalid classification SHALL carry a stable reason and a detail naming the parse or shape failure. A file-system failure SHALL be reported as a failure and SHALL NOT be classified as missing or invalid.

#### Scenario: Missing document is not an error

- **WHEN** the profile has no `package.json`
- **THEN** the read is classified as missing
- **AND** no consumer receives a document to interpret

#### Scenario: Unparseable document is invalid

- **WHEN** the manifest contains malformed JSON
- **THEN** the read is classified as invalid with reason `unparseable`
- **AND** the detail names the JSON parse failure

#### Scenario: Non-object document is invalid

- **WHEN** the manifest parses to an array, null, or a scalar
- **THEN** the read is classified as invalid with reason `not-an-object`

#### Scenario: Unreadable file is a failure, not absence

- **WHEN** reading the file fails with a file-system error
- **THEN** the read reports that failure
- **AND** it is not classified as missing or invalid

#### Scenario: Object document is valid

- **WHEN** the manifest parses to a JSON object
- **THEN** the read is classified as valid
- **AND** it carries the interpreted view

### Requirement: Interpretation is computed once and the document is preserved

The reader SHALL expose the managed bundle list, the three install-relevant dependency sections, and the conflict sections as typed values computed in a single pass. Each SHALL be classified as absent, valid, partially readable, or malformed, naming every entry it cannot interpret. The document SHALL be preserved, including unmanaged fields and their order, and consumers SHALL NOT interpret raw fields themselves.

#### Scenario: Sections are read once

- **WHEN** a valid manifest is read
- **THEN** the bundle list, the dependency sections, and the conflict sections are all available from that read
- **AND** no consumer reads or decodes the document again

#### Scenario: A malformed section does not block the others

- **WHEN** `devDependencies` is an array and the other sections are well formed
- **THEN** `devDependencies` is classified as malformed
- **AND** the remaining sections are still classified and available

#### Scenario: An unreadable entry is named

- **WHEN** a dependency section is an object containing a value that is not a package specification string
- **THEN** that section is partially readable
- **AND** the unreadable entry is named while the readable entries remain available

#### Scenario: Fields eedsh does not manage survive a rewrite

- **WHEN** a manifest carrying unrelated fields in a particular order is read and later rewritten
- **THEN** those fields and their order are unchanged

#### Scenario: A non-object dsh section is read as empty

- **WHEN** `dsh` or `dsh.profile` is null, an array, or a scalar
- **THEN** the reader treats it as an empty object
- **AND** the rest of the document is preserved

### Requirement: An invalid manifest is reported, not treated as absent

When the profile manifest is invalid, materialization SHALL fail without writing, replacing, or deleting the file, and SHALL report the path, the reason, and how to proceed. Doctor SHALL report the same invalid classification as a finding, and the REPL SHALL distinguish an invalid manifest from a missing one. No consumer SHALL treat an invalid manifest as a missing one.

#### Scenario: Materialization refuses a non-object manifest

- **WHEN** the profile manifest parses to an array and `eedsh sync` runs
- **THEN** the command reports the path and the reason and exits with status 1
- **AND** the manifest bytes are unchanged
- **AND** no generation is published

#### Scenario: Materialization refuses an unparseable manifest

- **WHEN** the profile manifest contains malformed JSON and `eedsh sync` runs
- **THEN** the command reports the path and the reason and exits with status 1
- **AND** the manifest bytes are unchanged

#### Scenario: Doctor and sync agree on the reason

- **WHEN** an invalid manifest is inspected by doctor and by materialization
- **THEN** both report the same invalid reason for the same document

#### Scenario: The REPL distinguishes invalid from missing

- **WHEN** a profile manifest is invalid
- **THEN** the REPL view reports it as unusable rather than as absent

#### Scenario: A missing manifest still starts a first run

- **WHEN** the profile has no manifest and no eedsh-managed artifact
- **THEN** materialization publishes a new profile as a first run

### Requirement: Reading the manifest performs no writes

The reader SHALL access the profile only through the provided filesystem service and SHALL perform no writes. Reading SHALL be safe to call from materialization, doctor, and the REPL without changing profile state.

#### Scenario: Reading leaves the profile unchanged

- **WHEN** doctor, the REPL, or materialization reads the manifest
- **THEN** the file's bytes and the profile directory's contents are unchanged by the read

#### Scenario: Reading uses only the provided filesystem

- **WHEN** the reader runs against a provided in-memory filesystem
- **THEN** it reads that filesystem and does not consult the process filesystem
