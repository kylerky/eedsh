# error-handling Specification

## ADDED Requirements

### Requirement: Resolution and evaluation failures keep their identities

A query-resolution failure, a schema rejection from the build phase, and a config import failure SHALL keep distinct identities. The CLI SHALL report a resolution failure with its stable code, the bundle name, the root, and the underlying cause; SHALL report a build rejection as the native schema message without an import prefix; and SHALL report only an unexpected exception during evaluation as `config.import_failed`. A missing default export SHALL remain `config.missing_default_export`, and a default export that is not a factory SHALL fail with `config.invalid_default_export`.

#### Scenario: A resolution failure is reported with its facts

- **WHEN** a recorded query cannot be resolved against the selected installation
- **THEN** standard error carries the resolution code, the bundle name, and the root
- **AND** the command exits 1 without reporting `config.import_failed`

#### Scenario: A build rejection prints the native message

- **WHEN** the build phase returns a failure Result
- **THEN** standard error contains the native formatted schema message, including location annotations
- **AND** it does not contain a `config.import_failed` prefix

#### Scenario: An unexpected evaluation exception stays an import failure

- **WHEN** a config module throws an untagged exception while being evaluated
- **THEN** the command reports `config.import_failed` naming the config path
- **AND** the original cause is retained for the diagnostic

#### Scenario: A non-factory default export is rejected

- **WHEN** a config module exports a value that is not a function
- **THEN** the command reports `config.invalid_default_export`
- **AND** the build phase does not run

## MODIFIED Requirements

### Requirement: Expected failures are values rather than exceptions

A failure produced by pure computation SHALL be returned as an Effect `Result`. Every operation that touches the world — filesystem, process, network, clock, environment, or module loading — SHALL express an expected failure in the Effect error channel. Expected failures SHALL NOT be thrown. Authoring misuse that the type system cannot exclude SHALL be a defect rather than a thrown expected failure, and a config author SHALL NOT be required to catch it. Programmer errors and impossible states MAY remain defects, but a defect SHALL remain distinguishable from an expected failure.

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

- **WHEN** an authoring call's input cannot satisfy its contract at run time
- **THEN** the invocation reports a defect naming the call rather than throwing an expected failure
- **AND** no untagged exception escapes the authoring boundary

#### Scenario: Asynchronous config failure is a typed Effect failure

- **WHEN** a config file cannot be read, the TypeScript loader cannot be initialized, or the module cannot be imported
- **THEN** config loading fails in the Effect error channel with a config failure
- **AND** the caller observes the failure without a JavaScript catch

#### Scenario: Pure computation keeps Result

- **WHEN** a pure validator or normalizer rejects its input
- **THEN** it returns a failure Result
- **AND** it requires no running runtime and performs no IO

### Requirement: Domain and platform failures keep their identities

Expected failures SHALL retain a stable identity: each package SHALL export one closed union of the domain failures it can report, each domain failure SHALL be a tagged error with a stable tag, schema failures SHALL remain the native schema error, and file-system failures SHALL remain the platform's file-system error. The CLI edge SHALL expose one union of every failure a command can report and SHALL render a diagnostic by matching that union exhaustively, so a failure without a diagnostic SHALL fail the type check. Diagnostics SHALL NOT be selected by inspecting an untyped record, by converting a tag to a string, or by matching message text.

#### Scenario: Domain failure is matched by tag

- **WHEN** a preflight, lock, installation, resolution, config, check, or spawn failure reaches the reporter
- **THEN** the reporter matches it against the closed failure union
- **AND** the diagnostic includes the facts that tag carries

#### Scenario: A failure without a diagnostic fails the build

- **WHEN** a new tagged failure is added to the union without a diagnostic arm
- **THEN** the type check fails and names the missing case

#### Scenario: Platform failure is reported as a platform error

- **WHEN** a file operation fails
- **THEN** the failure is the platform's file-system error
- **AND** the diagnostic retains its operation and path

#### Scenario: Schema failure is native

- **WHEN** a validation failure reaches the reporter
- **THEN** the reporter prints the native formatted schema message
- **AND** does not wrap it in a project-defined failure

### Requirement: The CLI observes one process outcome

Each `eedsh` invocation SHALL execute as one Effect program, observed once at the process entry point, which SHALL be the only place in the CLI that starts a runtime. A command SHALL return its exit code as the program's value, and the process result SHALL be derived from that value together with the single `Exit`. A typed failure SHALL be reported once, by the command that produced it; the entry point SHALL report only defects, interruptions, and usage errors. A failure SHALL NOT be reported more than once, and interactive evaluation SHALL run inside the same program rather than in a nested runtime.

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

#### Scenario: Interactive publication runs in the same program

- **WHEN** an interactive session publishes the selected profile
- **THEN** the publication runs inside the invocation's program
- **AND** no nested runtime is started and no failure crosses the boundary as a rejected promise

### Requirement: Defects are reported but never recovered

An unexpected exception, an impossible state, or authoring misuse SHALL be reported and SHALL exit 1. It SHALL NOT be converted into a domain failure, silently swallowed, or retried as an expected failure. Scoped cleanup SHALL still run, and a defect SHALL NOT prevent a scoped resource — a profile lock, a watcher, or a session — from being released.

#### Scenario: Injected service construction throws

- **WHEN** a service layer or injected dependency throws while a command is running
- **THEN** the command reports the message and exits 1
- **AND** it does not report a domain failure tag

#### Scenario: Defect during a sync

- **WHEN** a defect occurs inside the materialization program
- **THEN** the process exits 1 with a diagnostic
- **AND** the profile lock and other scoped resources are released

#### Scenario: Authoring misuse is reported as a defect

- **WHEN** an authoring call receives an out-of-contract value at run time
- **THEN** the command reports a defect and exits 1
- **AND** it does not print a resolution or preset failure code

### Requirement: Expected-failure exceptions are confined

Production source in `@eedsh/plan`, `@eedsh/config`, and `@eedsh/cli` SHALL NOT use JavaScript `throw`, `try`, or `catch` for any purpose, and the workspace SHALL enforce that with an architecture check that carries no per-file allowlist. One exception SHALL remain: the CLI process entry point SHALL hold a single final safety net that converts an unexpected rejection into a reported defect.

#### Scenario: Architecture check rejects a new throw

- **WHEN** production source adds a `throw`, `try`, or `catch` statement
- **THEN** the architecture check fails and names the file

#### Scenario: Allowlisted authoring boundary remains

- **WHEN** a synchronous authoring boundary is proposed as an exception site
- **THEN** no allowlist entry is required, because authoring performs no IO and authoring misuse is a defect
- **AND** the check still rejects an added exception

#### Scenario: Allowlisted defect remains

- **WHEN** the entry safety net converts an unexpected rejection
- **THEN** it is the only permitted exception site in production source
- **AND** it records the rejection as a defect

#### Scenario: The entry net is the only exception site

- **WHEN** the process entry point is inspected
- **THEN** it holds exactly one final rejection safety net
- **AND** no other production module contains exception control flow

#### Scenario: Authoring contains no exception control flow

- **WHEN** the authoring package sources are inspected
- **THEN** no module throws, catches, or wraps an external failure
- **AND** invalid authoring input is reported as a defect through the effect channel

### Requirement: DSH discovery and capability failures are tagged

A missing, invalid, unsupported, or capability-incomplete DSH installation SHALL produce a tagged domain failure with a stable code and the facts needed to act. The CLI SHALL report it once and exit 1 without resolving queries, publishing, or booting. Discovery SHALL complete before config evaluation, because the selected version is an evaluation input; an installation that cannot provide a required capability SHALL fail before any bundle query is resolved.

#### Scenario: No DSH installation is found

- **WHEN** discovery cannot find an installation
- **THEN** the failure code is `dsh.not_found`
- **AND** the message names `--dsh`, `EEDSH_DSH_ANCHOR`, and installing `dsh`
- **AND** the command exits 1

#### Scenario: Version is outside the supported range

- **WHEN** the discovered version does not satisfy the supported range
- **THEN** the failure code is `dsh.unsupported_version`
- **AND** the failure carries the discovered version and the supported range

#### Scenario: A composition capability is missing

- **WHEN** the selected installation cannot provide entry composition
- **THEN** the failure code is `dsh.capability_missing`
- **AND** the failure names the missing capability
- **AND** no generation is committed

#### Scenario: Authoring runs without a bridge

- **WHEN** an invocation evaluates a config with no installation selected
- **THEN** there is no bridge to install and none to be missing
- **AND** the command fails with the discovery failure before evaluation begins

## REMOVED Requirements

### Requirement: Tagged authoring failures survive config import

**Reason**: Config evaluation no longer performs IO, so an authoring resolution or preset lookup cannot fail during import, and the ambient bridge those failures depended on is removed.

**Migration**: Read the selected version from the evaluation input and let authoring record query descriptors; the CLI resolves them in one phase before building and reports each failure by its own code. Unexpected exceptions during import remain `config.import_failed`.
