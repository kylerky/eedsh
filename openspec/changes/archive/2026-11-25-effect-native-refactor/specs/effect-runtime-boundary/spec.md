# effect-runtime-boundary Specification

## ADDED Requirements

### Requirement: The CLI reaches the world only through Effect services

`@eedsh/cli` SHALL obtain every external capability — filesystem, child process, terminal input and output, environment, watching, and module loading — from an Effect service provided by a layer. It SHALL NOT import `node:fs`, `node:fs/promises`, `node:child_process`, `node:readline`, or `node:repl`, and SHALL NOT run a child process synchronously. Every capability SHALL be replaceable by providing a layer; no command SHALL receive a capability as an optional function parameter, and no command SHALL start a runtime of its own.

#### Scenario: World access is a service

- **WHEN** the CLI sources are inspected
- **THEN** no module imports a filesystem, child-process, readline, or REPL Node module
- **AND** every filesystem, process, terminal, environment, and watcher access goes through a provided service

#### Scenario: A capability is replaced by a layer

- **WHEN** a test supplies a fake filesystem, watcher, or process runner
- **THEN** it provides a layer for that capability
- **AND** the command receives no additional option, callback, or argument

#### Scenario: One runtime per process

- **WHEN** the CLI sources are inspected
- **THEN** only the process entry point starts a runtime
- **AND** no command, watcher, REPL session, or adapter starts another one

## MODIFIED Requirements

### Requirement: The DSH dependency stays outside the Effect boundary

The CLI SHALL import only Effect-free helpers from DSH packages and SHALL launch DSH as a child process rather than importing its runtime, so the two processes never share an Effect runtime.

#### Scenario: The CLI avoids the DSH runtime entry point

- **WHEN** the CLI sources are inspected
- **THEN** they import no DSH runtime package
- **AND** they start DSH through the provided child-process service

### Requirement: The authoring package stays outside the Effect runtime

`@eedsh/config` SHALL expose synchronous authoring functions, SHALL import Effect through the schema and result modules only, and SHALL NOT use the Effect runtime (no Effect, Layer, Context, Stream, or ManagedRuntime programs). It SHALL import only Effect-free helpers from DSH packages. It SHALL perform no IO: it SHALL NOT import an IO or module-loading Node builtin (`node:fs`, `node:fs/promises`, `node:module`, `node:child_process`, `node:readline`, `node:repl`), read or write a file, spawn a process, load a module, or consult ambient module-scope state such as an installed installation handle. Pure helpers such as `node:path`, `node:url`, and `node:crypto` remain permitted. Everything it needs SHALL arrive as plain invocation inputs.

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

#### Scenario: Authoring performs no IO

- **WHEN** the authoring package sources are inspected
- **THEN** no module imports an IO or module-loading Node builtin or reads an ambient installation store
- **AND** building a config reads no file and spawns no process

#### Scenario: Authoring holds no ambient state

- **WHEN** two evaluations run one after the other in one process
- **THEN** the second evaluation observes no state the first installed
- **AND** neither evaluation depends on a module-level binding being set beforehand
