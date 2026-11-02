## MODIFIED Requirements

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

## ADDED Requirements

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
