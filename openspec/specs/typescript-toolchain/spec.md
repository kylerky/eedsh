# typescript-toolchain Specification

## Purpose
Defines the runtime and evaluation contract for eedsh configs: the Node 26 baseline, TypeScript-only config discovery, full-syntax config evaluation, the resolution rules eedsh relies on, and the boundary that eedsh validates plans at runtime but never typechecks them.

## Requirements

### Requirement: Node 26 is the only supported runtime
eedsh SHALL declare and support Node.js 26 or later only. Package metadata SHALL declare the Node 26 floor for every workspace package that runs at the user's runtime, and continuous integration SHALL verify the toolchain on Node 26 only.

#### Scenario: Node 26 floor is declared
- **WHEN** a consumer inspects the workspace package metadata
- **THEN** the declared Node engine minimum is 26 for the root and for each published package
- **AND** continuous integration runs the quality gate on Node 26 alone

#### Scenario: Node declarations match the runtime
- **WHEN** the repository typechecks against Node's API surface
- **THEN** the declared Node type definitions correspond to the Node 26 line, not an older release

### Requirement: Config discovery accepts TypeScript entry points only
eedsh SHALL discover its default config as `config.ts` in the resolved eedsh config home and SHALL accept an explicit `--config <path>` to a `.ts` file. It SHALL NOT discover a config in the working directory or a parent directory, and SHALL NOT accept `.mts`, `.js`, or `.mjs`. An explicit non-`.ts` path SHALL fail with a stable `config.unsupported_extension` failure that names `config.ts`, and SHALL NOT be evaluated.

#### Scenario: TypeScript config is discovered
- **WHEN** `eedsh sync` runs and the resolved eedsh config home contains `config.ts`
- **THEN** that file is selected

#### Scenario: Working-directory config is not discovered
- **WHEN** the working directory contains `eedsh.config.ts` and the resolved eedsh config home has no `config.ts`
- **THEN** the command reports that no config exists at the XDG path
- **AND** the working-directory file is not selected

#### Scenario: Explicit TypeScript config path is accepted
- **WHEN** `eedsh sync --config path/to/custom.ts` runs
- **THEN** the named `.ts` config is loaded

#### Scenario: MTS config is rejected before evaluation
- **WHEN** `eedsh sync --config path/to/config.mts` runs
- **THEN** the command exits non-zero with `config.unsupported_extension`
- **AND** the message names `config.ts`
- **AND** the config is never imported and no profile is published

#### Scenario: JavaScript config is rejected before evaluation
- **WHEN** `eedsh sync --config config.js` or `--config config.mjs` runs
- **THEN** the command exits non-zero with `config.unsupported_extension`
- **AND** the message names `config.ts`
- **AND** the config is never imported and no profile is published

### Requirement: Configs are evaluated with full TypeScript syntax
eedsh SHALL evaluate a config as TypeScript through a loader that supports both erasable and non-erasable TypeScript syntax, including enums, namespaces, and decorators. Evaluation SHALL occur in the running process with no build step, generated temporary file, or project-wide compilation. A config that cannot be evaluated SHALL fail with `config.import_failed` and exit non-zero, and a config without a default export SHALL fail with `config.missing_default_export`.

#### Scenario: Non-erasable TypeScript evaluates
- **WHEN** a config declares an `enum` and uses it in the exported plan
- **THEN** the config evaluates and the profile is published

#### Scenario: Syntax failure is reported as an import failure
- **WHEN** a config contains a syntax error that prevents evaluation
- **THEN** the command exits non-zero with `config.import_failed`
- **AND** no profile is published

#### Scenario: Missing default export is reported
- **WHEN** a config evaluates but exports no default plan
- **THEN** the command exits non-zero with `config.missing_default_export`

#### Scenario: CommonJS project config evaluates
- **WHEN** the config's nearest package manifest does not declare `"type": "module"` and the config exports its plan through CommonJS interop
- **THEN** the default export is read and the profile is published

### Requirement: Config resolution uses one documented loader model
eedsh SHALL resolve the config and its imports with the evaluation loader's own resolution rules — relative specifiers, bare package specifiers such as `@eedsh/config`, and tsconfig path mappings — and SHALL NOT maintain a separate resolution model. Evaluation SHALL use the nearest `tsconfig.json` at or above the config file, so imports resolve against the config's own project rather than the working directory where eedsh was launched.

#### Scenario: Relative and package imports resolve
- **WHEN** a config imports a local helper through a relative specifier and `@eedsh/config` through its package name
- **THEN** both imports resolve and the config evaluates

#### Scenario: Path-mapped imports resolve through the project tsconfig
- **WHEN** a config imports a local helper through a `paths` mapping declared in a tsconfig at or above the config file
- **THEN** the import resolves and the config evaluates

#### Scenario: Caller working-directory path mappings are ignored
- **WHEN** the invoking working directory has a tsconfig with `paths` that conflict with the config project
- **THEN** evaluation uses the config project's tsconfig
- **AND** the caller's path mappings are not applied

#### Scenario: Missing config tsconfig does not inherit caller mappings
- **WHEN** the config project has no `tsconfig.json` and the invoking working directory has one
- **THEN** the caller's `paths` mappings are not applied
- **AND** relative and package imports still resolve through the loader's ordinary rules

### Requirement: eedsh does not typecheck configs at load time
Loading a config SHALL NOT run a TypeScript compiler, request compiler diagnostics, or reject a config because of type errors. Type correctness SHALL be established before evaluation, by the authoring loop or by `eedsh check`; a type error that still allows evaluation SHALL NOT fail the load. Runtime integrity of the plan SHALL be enforced only by plan validation.

#### Scenario: Type-level mistake does not block evaluation
- **WHEN** a config contains a type error that does not prevent evaluation
- **THEN** the config evaluates and the profile is published

#### Scenario: Plan validation remains the runtime gate
- **WHEN** a config exports a structurally invalid plan
- **THEN** the command exits non-zero with the corresponding `plan.*` failure
- **AND** no profile is published

#### Scenario: Watch reruns after an edit
- **WHEN** `eedsh sync --watch` is running and the config changes
- **THEN** the config is re-evaluated and the new plan is used

### Requirement: The evaluation loader stays inside the CLI package
The TypeScript evaluation loader SHALL be a runtime dependency of the command package only. `@eedsh/config` and `@eedsh/runtime` SHALL NOT depend on the loader or on the TypeScript compiler, and the repository boundary checks SHALL enforce this.

#### Scenario: Package boundary is enforced
- **WHEN** the repository boundary check runs
- **THEN** neither `@eedsh/config` nor `@eedsh/runtime` declares the loader or the TypeScript compiler as a dependency
- **AND** neither imports them
