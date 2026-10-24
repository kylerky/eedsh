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

`eedsh sync --explain` SHALL attribute each preflight warning to the layer whose patches produced it, using the `<layer>: <message>` form. Attribution SHALL run only when `--explain` is present and at least one warning exists.

#### Scenario: Attributed warning with --explain

- **WHEN** `eedsh sync --explain` composes layers that produce an unmatched-patch warning
- **THEN** the reported warning names the source layer followed by the raw message

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
