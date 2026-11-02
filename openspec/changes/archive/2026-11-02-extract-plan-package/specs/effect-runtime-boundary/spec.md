## RENAMED Requirements

- FROM: `### Requirement: One Effect version is shared by the config and CLI packages`
- TO: `### Requirement: One Effect version is shared by the plan, config, and CLI packages`
- FROM: `### Requirement: The config package limits which Effect modules it uses`
- TO: `### Requirement: The plan package limits which Effect modules it uses`

## MODIFIED Requirements

### Requirement: One Effect version is shared by the plan, config, and CLI packages

`@eedsh/plan`, `@eedsh/config`, and `@eedsh/cli` SHALL declare the same exact Effect version, and the workspace dependency graph SHALL resolve a single Effect installation.

#### Scenario: The two packages agree on the Effect version

- **WHEN** the package manifests are inspected
- **THEN** the CLI Effect dependency, the plan peer and dev dependencies, and the config peer and dev dependencies are the same exact version

#### Scenario: A single Effect copy resolves

- **WHEN** the workspace lockfile is resolved
- **THEN** it records exactly one Effect version

### Requirement: The plan package limits which Effect modules it uses

`@eedsh/plan` SHALL import Effect through the schema and result modules only, so the plan contract depends on the v4 schema and result API and nothing else from the Effect runtime.

#### Scenario: An allowed module is imported

- **WHEN** the plan package imports the schema or result module
- **THEN** the boundary check passes

#### Scenario: A disallowed module is imported

- **WHEN** the plan package imports any other Effect module
- **THEN** the boundary check fails and names the offending file and specifier

## ADDED Requirements

### Requirement: The authoring package stays outside the Effect runtime

`@eedsh/config` SHALL expose synchronous authoring functions, SHALL import Effect through the schema and result modules only, and SHALL NOT use the Effect runtime (no Effect, Layer, Context, Stream, or ManagedRuntime programs). It SHALL import only Effect-free helpers from DSH packages.

#### Scenario: Authoring imports an allowed Effect module

- **WHEN** the authoring package imports the schema or result module
- **THEN** the boundary check passes

#### Scenario: Authoring imports an Effect runtime module

- **WHEN** the authoring package imports an Effect module other than schema or result
- **THEN** the boundary check fails and names the offending file and specifier

#### Scenario: Authoring imports a DSH runtime entry point

- **WHEN** the authoring package imports a DSH package that mounts a runtime
- **THEN** the boundary check fails and names the offending file and specifier

#### Scenario: Authoring is called without an Effect runtime

- **WHEN** an author calls an authoring function such as `defineConfig`
- **THEN** it returns its value synchronously without requiring a running Effect runtime
