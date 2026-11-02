# error-handling Specification

## Purpose

Defines one failure model for eedsh: expected failures are values, exceptions from external APIs are adapted at their boundary, and the CLI converts one process outcome into diagnostics and an exit code.

## Requirements

### Requirement: Expected failures are values rather than exceptions

A synchronous operation that can fail for an expected reason SHALL return an Effect `Result`. An asynchronous or IO operation that can fail for an expected reason SHALL fail in the Effect error channel. Expected failures SHALL NOT be thrown, except at the synchronous authoring boundary where bundle queries and preset child lookups throw tagged authoring failures so fluent config composition stays direct. The authoring boundary SHALL throw only tagged authoring errors with stable codes, and config import SHALL preserve those tags. Programmer errors and impossible states MAY remain defects, but they SHALL be distinguishable from expected failures.

#### Scenario: Invalid plan is a Result failure

- **WHEN** a caller validates a value that does not satisfy the plan contract
- **THEN** validation returns a failure Result carrying the native schema error
- **AND** no exception is thrown

#### Scenario: Malformed generated layer is a typed failure

- **WHEN** a generated layer file cannot be parsed or has the wrong shape
- **THEN** the parse operation returns a failure carrying the preflight failure
- **AND** the failure carries the layer identifier and the warnings collected so far

#### Scenario: Missing bundle is a typed resolution failure

- **WHEN** a selected profile bundle cannot be resolved or declares no bundle
- **THEN** bundle resolution returns a failure carrying the bundle name and cause
- **AND** no raw exception escapes the resolver

#### Scenario: Authoring lookup is a tagged exception

- **WHEN** a bundle query or preset child lookup fails for an expected authoring reason
- **THEN** the synchronous authoring API throws a tagged authoring failure with a stable code
- **AND** no untagged exception escapes the authoring boundary

#### Scenario: Asynchronous config failure is a typed Effect failure

- **WHEN** a config file cannot be read, the TypeScript loader cannot be initialized, or the module cannot be imported
- **THEN** config loading fails in the Effect error channel with a config failure
- **AND** the caller observes the failure without a JavaScript catch

### Requirement: External exceptions are adapted once at the boundary

Code that calls an API that throws or rejects SHALL adapt the failure exactly once, in the module that calls the API, using `Result.try`, `Effect.try`, or `Effect.tryPromise`. The raw exception SHALL NOT escape the adapter. File-system failures SHALL surface as the platform's file-system error; domain-specific failures SHALL use tagged errors.

#### Scenario: Dynamic import failure becomes a config failure

- **WHEN** evaluating a config module rejects
- **THEN** the import adapter produces a config failure naming the config path
- **AND** the original cause is preserved for the diagnostic

#### Scenario: YAML parse failure becomes a preflight failure

- **WHEN** the generated layer parser throws on malformed content
- **THEN** the parser returns a preflight failure naming the layer
- **AND** no parse exception escapes

#### Scenario: Native lock failure becomes a platform failure

- **WHEN** loading or calling a native lock binding throws
- **THEN** the lock adapter produces a platform failure carrying the lock path and cause
- **AND** cleanup still closes any acquired handle

#### Scenario: Watcher startup failure is reported

- **WHEN** the file watcher cannot be constructed
- **THEN** the command reports the failure and exits unsuccessfully
- **AND** no sync runs

### Requirement: Domain and platform failures keep their identities

Expected failures SHALL retain a stable identity: domain failures SHALL be tagged errors with a stable tag, schema failures SHALL remain the native schema error, and file-system failures SHALL remain the platform's file-system error. Diagnostics SHALL be selected by tag or native error type rather than by matching message text.

#### Scenario: Domain failure is matched by tag

- **WHEN** a preflight, lock, installation, resolution, config, check, or spawn failure reaches the reporter
- **THEN** the reporter selects its diagnostic by the failure's tag
- **AND** the diagnostic includes the facts that tag carries

#### Scenario: Platform failure is reported as a platform error

- **WHEN** a file operation fails
- **THEN** the failure is the platform's file-system error
- **AND** the diagnostic retains its operation and path

#### Scenario: Schema failure is native

- **WHEN** a validation failure reaches the reporter
- **THEN** the reporter prints the native formatted schema message
- **AND** does not wrap it in a project-defined failure

### Requirement: The CLI observes one process outcome

Each `eedsh` invocation SHALL execute its command as one Effect program and SHALL observe the outcome once with `Effect.runPromiseExit`. The resulting `Exit` SHALL determine the process result: a usage error exits 2, a typed failure is reported and exits 1, a defect is reported and exits 1, and a successful command exits with the exit code it produced. A failure SHALL NOT be reported more than once.

#### Scenario: Typed command failure is reported once

- **WHEN** a command fails with a config, preflight, lock, installation, resolution, check, or spawn failure
- **THEN** the message is written to standard error once
- **AND** the command exits 1

#### Scenario: Usage error exits 2

- **WHEN** the command line is invalid
- **THEN** the usage diagnostic is written
- **AND** the command exits 2

#### Scenario: Successful command forwards its exit code

- **WHEN** `check` finishes with the compiler's nonzero exit code, or `run` finishes with DSH's exit code
- **THEN** the command exits with that code
- **AND** no failure diagnostic is added

#### Scenario: Watch stop is successful

- **WHEN** a watch session receives an abort signal, SIGINT, or SIGTERM
- **THEN** the watcher and service layer are released
- **AND** the command exits 0

### Requirement: Defects are reported but never recovered

An unexpected exception (a defect) SHALL be reported and SHALL exit 1. It SHALL NOT be converted into a domain failure, silently swallowed, or retried as an expected failure. Scoped cleanup SHALL still run.

#### Scenario: Injected service construction throws

- **WHEN** a service layer or injected dependency throws while a command is running
- **THEN** the command reports the message and exits 1
- **AND** it does not report a domain failure tag

#### Scenario: Defect during a sync

- **WHEN** a defect occurs inside the materialization program
- **THEN** the process exits 1 with a diagnostic
- **AND** the profile lock and other scoped resources are released

### Requirement: Expected-failure exceptions are confined

Production source outside `@eedsh/runtime`, the CLI process entry point's final rejection safety net, the synchronous authoring and query boundary, and explicitly documented defects SHALL NOT use JavaScript `throw` or `try/catch` for expected failures. The workspace SHALL enforce this with an architecture check over source files and an explicit allowlist that records why each exception site exists.

#### Scenario: Architecture check rejects a new throw

- **WHEN** production source outside the allowlist adds a `throw` or `try` statement
- **THEN** the architecture check fails and names the file

#### Scenario: Allowlisted authoring boundary remains

- **WHEN** a query or preset child lookup throws a tagged authoring failure
- **THEN** the architecture check permits the documented authoring modules
- **AND** the allowlist records the synchronous-composition rationale

#### Scenario: Allowlisted defect remains

- **WHEN** an explicitly documented impossible state or the Effect-free runtime uses an exception
- **THEN** the architecture check permits it
- **AND** the allowlist records why

### Requirement: Tagged authoring failures survive config import

Config loading SHALL preserve native schema failures and tagged authoring failures instead of wrapping them as generic import failures. The preserved authoring failures SHALL include resolution failures and preset child lookup failures, with their stable codes and facts. Only unexpected exceptions SHALL become config import failures. The CLI and REPL SHALL format preserved authoring failures by tag, code, and message.

#### Scenario: Missing preset reaches the formatter

- **WHEN** a config module requests a preset that its bundle does not declare
- **THEN** config loading preserves the resolution failure
- **AND** the CLI reports its resolution code and message rather than `config.import_failed`

#### Scenario: Missing preset child reaches the formatter

- **WHEN** a config module requests a preset child that the preset does not declare
- **THEN** config loading preserves the preset-definition failure
- **AND** the CLI reports its preset code, preset id, row id, and child id rather than `config.import_failed`

#### Scenario: Unexpected import failure stays a config failure

- **WHEN** a config module throws an untagged exception while being imported
- **THEN** config loading reports a config import failure naming the config path
- **AND** the original cause is retained for the diagnostic