# patch-provenance Specification

## Purpose

Records where each authored patch came from in the TypeScript config, so a published profile can explain which line produced a row or a composition warning, without making that information part of the plan or of the composition.

## Requirements

### Requirement: Authoring sites are captured per patch
While a config module is evaluated, the authoring API SHALL record, for every builder call that emits a patch entry, the source file, line, and column of that call, together with an optional group label supplied by the author. Recording SHALL NOT require the author to supply a name, SHALL NOT fail evaluation when a site cannot be determined, and SHALL expose the most recent evaluation's record to the command that evaluated the config.

#### Scenario: A patch records its call site
- **WHEN** a config calls a patch builder from `config.ts`
- **THEN** the recorded site names that file and the line of the call

#### Scenario: A helper module is attributed to the helper
- **WHEN** a config delegates a patch call to a function declared in another file
- **THEN** the recorded site names that other file

#### Scenario: Recording never fails evaluation
- **WHEN** no site can be determined for a call
- **THEN** evaluation continues and the patch carries no site

#### Scenario: An optional label is recorded
- **WHEN** an author supplies a label with a patch group
- **THEN** the record carries that label
- **AND** the label is not an identifier and does not have to be unique

### Requirement: A published generation carries its provenance sidecar
Materialization SHALL write `.eedsh/provenance.json` next to the plan mirror, identifying the generation it describes and carrying the recorded labels and per-patch sites. The sidecar SHALL NOT be read by DSH, SHALL NOT be part of the generated package, and SHALL NOT affect the generation identifier, the plan hash, or the unchanged check. Sites SHALL be recorded as paths relative to the config file's directory rather than as absolute paths.

#### Scenario: Sidecar accompanies a published generation
- **WHEN** a generation is published from an evaluated config
- **THEN** `.eedsh/provenance.json` names that generation id
- **AND** it carries one entry per generated patch group, with the recorded label and sites

#### Scenario: A sidecar from another generation is not trusted
- **WHEN** the sidecar names a generation id other than the committed one
- **THEN** consumers treat its provenance as unavailable
- **AND** no command fails because of it

#### Scenario: Sites never contain absolute host paths
- **WHEN** a site is written
- **THEN** its file is expressed relative to the config file's directory

### Requirement: Provenance never changes composed behavior
Provenance SHALL be advisory: it SHALL NOT enter the profile plan, SHALL NOT be validated with it, SHALL NOT alter which rows compose or which value wins, and SHALL NOT be required for a profile to be correct or bootable.

#### Scenario: A plan without provenance validates
- **WHEN** a plan is produced without any recorded provenance, as with a plain plan export
- **THEN** the plan validates and materializes exactly as it does with provenance

#### Scenario: Provenance does not affect composition
- **WHEN** two configs differ only in recorded sites or labels
- **THEN** the composed entries are identical
