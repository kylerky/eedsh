# static-typechecking Specification

## Purpose
Defines how type correctness is established for eedsh configs: an explicit `eedsh check` command that runs the project's `tsc`, and the repository gates that keep eedsh's own TypeScript — including its example configs — typechecked.

## Requirements

### Requirement: `eedsh check` runs the project's TypeScript compiler
`eedsh check [--config <path>] [-- <tsc args>]` SHALL discover the config using the same rules as `sync`, locate the nearest `tsconfig.json` at or above the config file, resolve the TypeScript installation from the config's project, and run `tsc --noEmit` against that project. It SHALL NOT evaluate the config, materialize a profile, or modify any profile state, and it SHALL exit with the compiler's exit code.

#### Scenario: Type-clean config passes
- **WHEN** `eedsh check` runs for a config whose project typechecks cleanly
- **THEN** the command exits with code 0
- **AND** no profile is created or modified

#### Scenario: Type error fails with the compiler's diagnostics
- **WHEN** `eedsh check` runs for a config whose project has a type error
- **THEN** the command exits non-zero
- **AND** the compiler's diagnostic text is shown to the user
- **AND** no profile is created or modified

#### Scenario: Arguments are passed through to tsc
- **WHEN** `eedsh check -- --pretty false` runs
- **THEN** the compiler is invoked with `--pretty false` in addition to `--noEmit`

### Requirement: `eedsh check` spells out the compiler invocation
Before running, `eedsh check` SHALL print the resolved TypeScript version, the tsconfig path it selected, and the complete command line it is about to execute, so a user can reproduce the check by hand. After running, it SHALL report success or the compiler's failure without reinterpreting the diagnostics.

#### Scenario: Invocation is reproducible from the output
- **WHEN** `eedsh check` runs
- **THEN** its output names the TypeScript version, the selected `tsconfig.json` path, and the exact command line executed

### Requirement: Missing check prerequisites fail with actionable codes
`eedsh check` SHALL fail with a stable code when it cannot run the check, and SHALL NOT fall back to a bundled compiler or silently skip. A missing config SHALL fail with `config.not_found`; a config project without a resolvable TypeScript installation SHALL fail with `check.typescript_missing`; a config with no `tsconfig.json` at or above it SHALL fail with `check.tsconfig_missing`. Each failure SHALL name the fix.

#### Scenario: TypeScript is not installed in the config's project
- **WHEN** `eedsh check` runs and the config's project has no resolvable TypeScript installation
- **THEN** the command exits non-zero with `check.typescript_missing`
- **AND** the message tells the user to install TypeScript in that project

#### Scenario: No tsconfig is found
- **WHEN** `eedsh check` runs for a config with no `tsconfig.json` at or above it
- **THEN** the command exits non-zero with `check.tsconfig_missing`
- **AND** the message tells the user where a tsconfig is expected

### Requirement: `eedsh check` verifies the config belongs to the project
Before reporting a passing check, `eedsh check` SHALL verify that the config file is part of the selected tsconfig's file set. When the config is outside the project, it SHALL fail with `check.config_not_in_project` naming the selected tsconfig and the change needed to include the config, and SHALL NOT report success.

#### Scenario: Config outside the project fails rather than passing vacuously
- **WHEN** the selected `tsconfig.json` excludes the config file from its file set
- **THEN** the command exits non-zero with `check.config_not_in_project`
- **AND** the message names the tsconfig and how to include the config

#### Scenario: Config inside the project proceeds to the check
- **WHEN** the selected `tsconfig.json` includes the config file
- **THEN** the compiler runs against the project and its exit code is reported

### Requirement: The repository typechecks every TypeScript file
The repository quality gate SHALL typecheck all TypeScript it contains: package sources, package tests, the root `test` directory, the Vitest configuration files, and the CLI config fixtures and examples. `pnpm verify` SHALL fail on any type error, a watch-mode typecheck script SHALL exist for authoring, and continuous integration SHALL run the gate on Node 26.

#### Scenario: Root test type errors fail the gate
- **WHEN** a type error is introduced in a file under the root `test` directory
- **THEN** the repository typecheck fails
- **AND** `pnpm verify` fails

#### Scenario: Example configs are typechecked
- **WHEN** the repository typecheck runs
- **THEN** the CLI's example and fixture configs are included and must typecheck

#### Scenario: Watch mode is available
- **WHEN** a developer runs the repository's typecheck watch script
- **THEN** type errors are reported as files change

### Requirement: The authoring contract is documented
The documentation SHALL state that a config must typecheck in its own project, SHALL name the supported authoring loop (editor, `tsc --noEmit`, and `eedsh check`), and SHALL NOT claim that eedsh typechecks configs while loading them or that configs are limited to erasable TypeScript.

#### Scenario: Documented contract matches behavior
- **WHEN** a user reads the configuration authoring documentation
- **THEN** it describes typechecking as the project's responsibility before `eedsh` runs
- **AND** it documents `eedsh check` as the explicit way to run that check
- **AND** it contains no claim of load-time typechecking or erasable-only configs
