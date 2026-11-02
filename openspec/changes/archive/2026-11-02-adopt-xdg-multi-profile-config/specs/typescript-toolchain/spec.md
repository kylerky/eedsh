## MODIFIED Requirements

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
