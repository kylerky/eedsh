## MODIFIED Requirements

### Requirement: `eedsh check` runs the project's TypeScript compiler
`eedsh check [--config <path>] [-- <tsc args>]` SHALL discover the config using the same rules as `sync`, locate the nearest `tsconfig.json` at or above the config file, resolve the TypeScript installation from the config's project, and run `tsc --noEmit` against that project. It SHALL support both a classic JavaScript TypeScript installation and a TypeScript 7 native installation, SHALL NOT evaluate the config, materialize a profile, or modify any profile state, and SHALL exit with the compiler's exit code.

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

#### Scenario: A TypeScript 7 native project is checked
- **WHEN** `eedsh check` runs for a config whose project resolves a TypeScript 7 native installation
- **THEN** the command prints the resolved 7.x compiler version
- **AND** the native compiler runs against the selected `tsconfig.json`
- **AND** the command exits with that compiler's exit code

## ADDED Requirements

### Requirement: The repository toolchain runs the native TypeScript compiler
The repository SHALL typecheck and build with the TypeScript 7 native compiler. The pinned compiler SHALL be a 7.x release whose package exposes the native declaration-emit API consumed by the bundler, and package builds SHALL emit declarations through that native path instead of the classic JavaScript compiler API that TypeScript 7 removed. When declaration emit cannot use the native API, the package build SHALL fail rather than fall back to a non-native compiler.

#### Scenario: Typecheck runs the native compiler
- **WHEN** the repository's typecheck command runs
- **THEN** every TypeScript file in the repository is checked by the pinned TypeScript 7 native compiler
- **AND** the command exits non-zero on any type error

#### Scenario: Declarations are emitted natively
- **WHEN** a package build emits declarations for a package that publishes them
- **THEN** the declarations are produced by the native TypeScript 7 compiler
- **AND** they continue to describe the package's public API

#### Scenario: A compiler without native declaration emit is rejected
- **WHEN** the pinned TypeScript version lacks the native declaration-emit API
- **THEN** the package build fails
- **AND** it does not emit declarations through a non-native fallback compiler
