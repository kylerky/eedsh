# typescript-toolchain Specification

## MODIFIED Requirements

### Requirement: Configs are evaluated with full TypeScript syntax

eedsh SHALL evaluate a config as TypeScript through a loader that supports both erasable and non-erasable TypeScript syntax, including enums, namespaces, and decorators. Evaluation SHALL occur in the running process with no build step, generated temporary file, or project-wide compilation. A config that cannot be evaluated SHALL fail with `config.import_failed` and exit non-zero, and a config without a default export SHALL fail with `config.missing_default_export`. A default export that is not a function SHALL fail with `config.invalid_default_export`. The exported factory SHALL be invoked once, synchronously, with the invocation inputs defined by the `config-evaluation-inputs` capability.

#### Scenario: Non-erasable TypeScript evaluates

- **WHEN** a config declares an `enum` and uses it in the exported plan
- **THEN** the config evaluates and the profile is published

#### Scenario: Syntax failure is reported as an import failure

- **WHEN** a config contains a syntax error that prevents evaluation
- **THEN** the command exits non-zero with `config.import_failed`
- **AND** no profile is published

#### Scenario: Missing default export is reported

- **WHEN** a config evaluates but exports no default factory
- **THEN** the command exits non-zero with `config.missing_default_export`

#### Scenario: A non-factory default export is reported

- **WHEN** a config evaluates and its default export is not a function
- **THEN** the command exits non-zero with `config.invalid_default_export`
- **AND** no builder is created and no profile is published

#### Scenario: CommonJS project config evaluates

- **WHEN** the config's nearest package manifest does not declare `"type": "module"` and the config exports its factory through CommonJS interop
- **THEN** the default export is invoked and the profile is published
