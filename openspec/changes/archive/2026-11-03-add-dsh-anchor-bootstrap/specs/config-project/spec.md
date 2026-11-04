## ADDED Requirements

### Requirement: Init records an explicit installation anchor

`eedsh init` SHALL accept an optional `--dsh <package dir|package.json>`. When supplied, init SHALL validate it as a supported `@deepseek-ai/dsh` package and record it in the machine-local installation anchor. Init SHALL remain non-interactive and usable without DSH. The anchor SHALL be written outside the config project.

#### Scenario: Init records an explicit anchor

- **WHEN** `eedsh init --dsh /path/to/@deepseek-ai/dsh` runs
- **THEN** init validates the package and records its anchor
- **AND** a subsequent `eedsh sync` uses that anchor without querying pnpm or npm

#### Scenario: Invalid explicit anchor fails without writing the project

- **WHEN** `eedsh init --dsh` names a missing path or a package that is not `@deepseek-ai/dsh`
- **THEN** init exits 1 with a tagged discovery failure naming the path
- **AND** it writes no `config.ts`, `package.json`, or `tsconfig.json`

#### Scenario: Re-running init keeps the config and refreshes the anchor

- **WHEN** `eedsh init --dsh` runs over an existing config project
- **THEN** the existing three project files remain byte-for-byte unchanged
- **AND** the installation anchor is refreshed
- **AND** init reports both the kept files and the recorded installation

#### Scenario: Anchor write failure leaves a usable config project

- **WHEN** init validates an explicit anchor but cannot write the anchor cache
- **THEN** it reports the failure and keeps the written config project
- **AND** a later `eedsh sync` can still bootstrap or use `--dsh`

### Requirement: Init reports an existing anchor without querying

Without `--dsh`, init SHALL read and validate an existing installation anchor and report it when present. It SHALL NOT query pnpm, npm, or any launcher. An absent anchor SHALL NOT fail init; init SHALL report how the first sync bootstraps one.

#### Scenario: Init reports an existing anchor without querying

- **WHEN** a valid installation anchor already exists and `eedsh init` runs without `--dsh`
- **THEN** init reports the recorded installation
- **AND** it does not query pnpm, npm, or any launcher

#### Scenario: Init without DSH still succeeds

- **WHEN** `eedsh init` runs on a machine with no DSH installation and no anchor
- **THEN** init creates the config project and exits 0
- **AND** it writes no installation anchor
- **AND** it reports how the first sync can bootstrap an installation
