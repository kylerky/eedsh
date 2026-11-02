# preflight-diagnostics Specification

## Purpose
Defines how `eedsh` reports preflight composition diagnostics: raw by default, attributed to their source layer only when the user asks with `--explain`, and raw for strict failures.

## Requirements

### Requirement: Raw diagnostics by default

`eedsh sync` SHALL report each preflight composition warning exactly as the composition algorithm emits it, without a source-layer prefix, unless the user requests attribution.

#### Scenario: Unmatched patch without --explain

- **WHEN** a plan contains an id-targeted patch that matches no composed row and `eedsh sync` runs without `--explain`
- **THEN** the CLI reports the raw warning message
- **AND** the message does not include a `layer:` prefix
- **AND** publication proceeds in non-strict mode with exit status 0

### Requirement: Attribution on demand
`eedsh sync --explain` SHALL attribute each preflight warning to the patch entry whose application produced it, using the form `<group>: <message>`, where `<group>` identifies the generated patch group by its 1-based position and, when known, the authoring site and the row ids that patch touches. Attribution SHALL run only when `--explain` is present and at least one warning exists.

#### Scenario: Attributed warning with --explain
- **WHEN** `eedsh sync --explain` composes patches that produce an unmatched-patch warning
- **THEN** the reported warning identifies the position of the generated patch group whose patch produced it
- **AND** the raw message follows the group identification

#### Scenario: Attribution names the authoring site when it is known
- **WHEN** the config was evaluated in this process and the warning comes from a generated patch
- **THEN** the attributed warning includes the source file and line that declared that patch

#### Scenario: Attribution degrades when the site is unknown
- **WHEN** an attributed warning comes from a published generation whose authoring site is not available
- **THEN** the warning still identifies the patch group by position and lists the row ids the patch touches
- **AND** attribution does not fail

#### Scenario: Explained run without warnings
- **WHEN** `eedsh sync --explain` composes a layer stack that produces no warnings
- **THEN** the command publishes normally with exit status 0
- **AND** reports no warnings

### Requirement: Strict failures stay raw

`eedsh sync --strict` SHALL fail on warnings using raw messages. Attributed messages SHALL appear only when `--explain` is also present. The strict failure condition, failure exit status, and publication behavior SHALL NOT change.

#### Scenario: Strict failure without --explain

- **WHEN** `eedsh sync --strict` encounters an unmatched patch and `--explain` is absent
- **THEN** the command exits with the failure status 1
- **AND** the diagnostics are raw messages without layer prefixes
- **AND** the output includes the raw-warning hint
- **AND** no generation is committed

#### Scenario: Strict failure with --explain

- **WHEN** `eedsh sync --strict --explain` encounters an unmatched patch
- **THEN** the command exits with the failure status 1
- **AND** each diagnostic names its source layer
- **AND** the output does not include the raw-warning hint
- **AND** no generation is committed

### Requirement: Raw-warning discoverability

When the CLI prints raw preflight warnings, it SHALL print a one-line hint that `--explain` attributes them to their source layer. When warnings are already attributed, it SHALL NOT print that hint.

#### Scenario: Hint after raw warnings

- **WHEN** `eedsh sync` prints at least one raw warning
- **THEN** the output includes a hint mentioning `--explain`

#### Scenario: No hint after attributed warnings

- **WHEN** `eedsh sync --explain` prints attributed warnings
- **THEN** the output does not include the raw-warning hint

### Requirement: Explain is a sync-only option

`--explain` SHALL be accepted only by `eedsh sync`. Other commands SHALL reject it as a usage error and exit with the usage-error status 2.

#### Scenario: run rejects --explain

- **WHEN** the user runs `eedsh run --explain`
- **THEN** the command reports a usage error
- **AND** exits with status 2
- **AND** does not boot DSH

#### Scenario: check rejects --explain

- **WHEN** the user runs `eedsh check --explain`
- **THEN** the command reports a usage error
- **AND** exits with status 2

### Requirement: Empty patch groups are reported
Preflight SHALL report a generated patch group that contributes no patches, identifying it by 1-based position and, when known, its authoring site. The report SHALL be a warning, SHALL use the existing raw, attributed, and strict preflight behavior, SHALL be subject to strict mode like every other preflight warning, and SHALL NOT change the plan, composition, or generated group set or fail non-strict publication.

#### Scenario: Empty generated group
- **WHEN** a plan declares a generated patch group with no patches
- **THEN** preflight reports that group by position
- **AND** non-strict publication proceeds

#### Scenario: Raw empty-group warning
- **WHEN** `eedsh sync` composes a generated patch group with no patches and `--explain` is absent
- **THEN** the CLI reports a raw warning naming the empty group
- **AND** publication proceeds in non-strict mode with exit status 0

#### Scenario: Attributed empty-group warning
- **WHEN** `eedsh sync --explain` composes a generated patch group with no patches
- **THEN** the reported warning identifies the source group in the attributed form

#### Scenario: Strict mode fails on an empty group
- **WHEN** `eedsh sync --strict` encounters a generated patch group that contributes no patches
- **THEN** the command exits with the failure status 1
- **AND** the diagnostics are raw messages without group prefixes unless `--explain` is also present
- **AND** no generation is committed
