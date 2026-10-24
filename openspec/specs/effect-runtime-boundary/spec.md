# effect-runtime-boundary Specification

## Purpose
Defines the Effect dependency contract the workspace publishes: which Effect version every package shares, which Effect modules each package may use, the consolidated v4 package topology, and the enforced absence of Effect from the runtime package.

## Requirements

### Requirement: One Effect version is shared by the config and CLI packages

`@eedsh/config` and `@eedsh/cli` SHALL declare the same exact Effect version, and the workspace dependency graph SHALL resolve a single Effect installation.

#### Scenario: The two packages agree on the Effect version

- **WHEN** the package manifests are inspected
- **THEN** the CLI Effect dependency, the config peer dependency, and the config dev dependency are the same exact version

#### Scenario: A single Effect copy resolves

- **WHEN** the workspace lockfile is resolved
- **THEN** it records exactly one Effect version

### Requirement: The runtime package stays free of Effect

`@eedsh/runtime` SHALL NOT declare a dependency on Effect or the TypeScript toolchain, and SHALL NOT import an Effect module.

#### Scenario: The runtime declares no Effect dependency

- **WHEN** the runtime package manifest is inspected
- **THEN** it declares no Effect dependency

#### Scenario: The runtime imports no Effect module

- **WHEN** the runtime package sources are inspected
- **THEN** no module imports `effect` or a path beneath it

### Requirement: The config package limits which Effect modules it uses

`@eedsh/config` SHALL import Effect through the schema and result modules only, so the plan contract depends on the v4 schema and result API and nothing else from the Effect runtime.

#### Scenario: An allowed module is imported

- **WHEN** the config package imports the schema or result module
- **THEN** the boundary check passes

#### Scenario: A disallowed module is imported

- **WHEN** the config package imports any other Effect module
- **THEN** the boundary check fails and names the offending file and specifier

### Requirement: The Effect ecosystem packages are consolidated

The workspace SHALL take Effect functionality from the `effect` package and, for Node-platform services, `@effect/platform-node` only. The separate ecosystem packages for CLI, platform, and printing SHALL NOT be declared.

#### Scenario: The CLI declares the consolidated dependency set

- **WHEN** the CLI package manifest is inspected
- **THEN** `effect` and `@effect/platform-node` are declared
- **AND** the CLI, platform, and printing ecosystem packages are absent

#### Scenario: The command surface comes from the core package

- **WHEN** the CLI sources are inspected
- **THEN** command and flag constructors are imported from the core package's CLI entry point

### Requirement: The DSH dependency stays outside the Effect boundary

The CLI SHALL import only Effect-free helpers from DSH packages and SHALL launch DSH as a child process rather than importing its runtime, so the two processes never share an Effect runtime.

#### Scenario: The CLI avoids the DSH runtime entry point

- **WHEN** the CLI sources are inspected
- **THEN** they import no DSH runtime package
- **AND** they start DSH through the injectable spawn seam
