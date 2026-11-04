# config-project Specification

## Purpose
Defines where eedsh reads its user configuration and how `eedsh init` turns that location into a working TypeScript project whose imports, typecheck, and profiles resolve.

## Requirements

### Requirement: Configuration resolves from the XDG config home

eedsh SHALL load its default config from `$XDG_CONFIG_HOME/eedsh/config.ts`, or `~/.config/eedsh/config.ts` when `XDG_CONFIG_HOME` is unset, empty, or not absolute. It SHALL NOT discover a config in the working directory or a parent. An explicit `--config <path>` SHALL override the default. When no config exists at the selected path, the command SHALL exit 1 and name both `eedsh init` and `--config <path>`.

#### Scenario: XDG config home selects the config

- **WHEN** `XDG_CONFIG_HOME` is set to an absolute directory containing `eedsh/config.ts`
- **THEN** eedsh loads that file without consulting the working directory

#### Scenario: Unset or relative XDG config home falls back

- **WHEN** `XDG_CONFIG_HOME` is unset, empty, or relative
- **THEN** eedsh loads `~/.config/eedsh/config.ts`

#### Scenario: Working-directory config is not discovered

- **WHEN** the working directory contains `eedsh.config.ts` but the XDG config path does not exist
- **THEN** eedsh reports that no config exists at the XDG path and does not load the working-directory file
- **AND** exits with status 1

#### Scenario: Explicit config path overrides the default

- **WHEN** a command supplies `--config ./local/config.ts`
- **THEN** eedsh loads that path and ignores the XDG default

#### Scenario: Missing config names the fix

- **WHEN** no config exists at the selected path
- **THEN** the command exits 1 and names both `eedsh init` and `--config <path>` as the ways to provide one
- **AND** no profile is published or booted

### Requirement: Init creates a working config project

`eedsh init` SHALL create the resolved config directory and write `config.ts`, `package.json`, and `tsconfig.json`. The manifest SHALL declare `@eedsh/config` at the running CLI's version or link the CLI's copy in an unpublished workspace, plus `effect` at its peer version and `typescript`; the tsconfig SHALL include `config.ts`. Init SHALL install with pnpm and print the config path, profiles, and next commands. A new directory SHALL be owner-only where supported.

#### Scenario: Fresh init produces a runnable project

- **WHEN** `eedsh init` runs with no existing config project
- **THEN** `config.ts`, `package.json`, and `tsconfig.json` exist under the resolved config directory
- **AND** pnpm installs the declared dependencies
- **AND** the generated config loads and `eedsh check` passes against the generated tsconfig

#### Scenario: Declared versions match the installed CLI

- **WHEN** init writes the project manifest
- **THEN** `@eedsh/config` uses the running CLI's version, or a local link when the CLI is an unpublished workspace
- **AND** `effect` uses the peer version required by that config package
- **AND** the manifest declares `typescript`

#### Scenario: Local workspace init links the CLI packages

- **WHEN** init runs from an unpublished local workspace
- **THEN** the manifest links the CLI's own `@eedsh/config` and `effect` installations
- **AND** install succeeds without a registry lookup for those packages

#### Scenario: Init follows the same path resolution as config loading

- **WHEN** `XDG_CONFIG_HOME` is set to an absolute directory
- **THEN** init writes the project below that directory
- **AND** when `XDG_CONFIG_HOME` is unset or relative, init writes below `~/.config`

#### Scenario: New directory is owner-only

- **WHEN** init creates a new config directory on a platform with POSIX permissions
- **THEN** the directory is readable and writable only by its owner

#### Scenario: Init reports where it wrote and what to do next

- **WHEN** init succeeds
- **THEN** its output names the config path, the scaffolded profile names, and the next `eedsh sync` and `eedsh check` commands

### Requirement: Init is non-destructive and idempotent

Init SHALL be non-interactive and safe to run repeatedly. It SHALL NOT overwrite an existing `config.ts`, `package.json`, or `tsconfig.json`; an existing file SHALL remain byte-for-byte unchanged and init SHALL report that it was kept. It SHALL create only missing project files. It SHALL NOT initialize a version-control repository. It SHALL NOT read, rename, or adopt a legacy `eedsh.config.ts`, `eedsh.config.mts`, or any other config filename.

#### Scenario: Re-running init preserves the authored config

- **WHEN** `eedsh init` runs over a project whose `config.ts` exists
- **THEN** the file is byte-for-byte unchanged
- **AND** missing project files are created
- **AND** the command exits 0 when the project is complete

#### Scenario: Legacy config filenames are ignored

- **WHEN** the config directory contains `eedsh.config.ts` but no `config.ts`
- **THEN** init writes a new `config.ts` and does not rename, read, or delete the legacy file

#### Scenario: Existing project files are preserved

- **WHEN** `package.json` or `tsconfig.json` already exists
- **THEN** init leaves that file unchanged
- **AND** reports that it was kept

#### Scenario: Init does not create a repository

- **WHEN** init completes in a directory that is not already a repository
- **THEN** no `.git` directory or other version-control metadata is created

### Requirement: Init can defer installation and reports failures

Init SHALL accept `--no-install` to write the project files without running a package manager, print the exact install command for the config directory, and exit 0. Without `--no-install`, a failed installation SHALL leave the written files in place, report the config directory and the failed step, and exit 1. Init SHALL exit 0 when the requested work completes and SHALL exit 2 on a usage error.

#### Scenario: Offline init writes files only

- **WHEN** `eedsh init --no-install` runs
- **THEN** the project files are written
- **AND** no package-manager command runs
- **AND** the output prints the install command to run in the config directory

#### Scenario: Installation failure keeps a repairable project

- **WHEN** dependency installation fails during init
- **THEN** the written project files remain
- **AND** the diagnostic names the config directory and the failed install step
- **AND** the command exits 1

#### Scenario: Unknown init flag is a usage error

- **WHEN** init receives an unknown option
- **THEN** the command prints a usage diagnostic
- **AND** exits 2
- **AND** writes no project files

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
