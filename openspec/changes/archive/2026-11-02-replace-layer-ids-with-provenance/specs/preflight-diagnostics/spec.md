## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Empty patch groups are reported
Preflight SHALL report a generated patch group that contributes no patches, identifying it by 1-based position and, when known, its authoring site. The report SHALL be a warning, SHALL be subject to strict mode like every other preflight warning, and SHALL NOT fail non-strict publication.

#### Scenario: Empty generated group
- **WHEN** a plan declares a generated patch group with no patches
- **THEN** preflight reports that group by position
- **AND** non-strict publication proceeds

#### Scenario: Strict mode fails on an empty group
- **WHEN** strict mode is enabled and a generated patch group contributes no patches
- **THEN** the operation exits nonzero and does not publish
