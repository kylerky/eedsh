## Purpose

Lets tools and agents evaluate eedsh configuration code and receive typed values, plan facts, diffs, warnings, and errors as JSON, in one-shot and persistent forms, without parsing a human prompt or `util.inspect` text.

## ADDED Requirements

### Requirement: One-shot evaluations are machine-readable

`eedsh repl --eval <code> --json` SHALL evaluate the code against the loaded config and print exactly one JSON document to stdout. The document SHALL identify the protocol version, success or failure, the selected profile, the declared profile names, and the result. When `--json` is absent the existing text output SHALL remain unchanged. A failed evaluation SHALL still print one JSON document and exit non-zero; human-readable diagnostics SHALL NOT be mixed into stdout.

#### Scenario: Successful evaluation

- **WHEN** a caller runs `eedsh repl --config <path> --eval 'selectedProfile.name' --json`
- **THEN** stdout contains one JSON document with `ok: true`, the selected profile name in `value`, and the resolved profile list
- **AND** no prompt, banner, ANSI sequence, or `util.inspect` text appears on stdout
- **AND** the process exits zero

#### Scenario: Failed evaluation

- **WHEN** the expression throws, or the config cannot be loaded
- **THEN** stdout contains one JSON document with `ok: false` and a structured error
- **AND** the process exits non-zero

#### Scenario: Text mode is unchanged

- **WHEN** `--json` is not passed
- **THEN** the existing `--eval` text output and exit behavior are preserved

### Requirement: Callers can supply code without shell quoting

The CLI SHALL accept the evaluated code from a file (`--eval-file <path>`) or stdin in the machine mode, so callers can send multi-line TypeScript without embedding it in a shell argument. The resulting envelope SHALL be identical to the `--eval` envelope.

#### Scenario: Multi-line code from a file

- **WHEN** a caller writes a multi-line expression to a file and passes `--eval-file`
- **THEN** the code is evaluated as one unit
- **AND** the response is one JSON envelope

#### Scenario: Empty or unreadable input

- **WHEN** the file is missing, unreadable, or empty
- **THEN** the CLI returns a structured error without evaluating an empty expression

### Requirement: Values are projected to JSON

The machine response SHALL project values as JSON. Plain JSON values SHALL be returned directly; a value with a documented view projection SHALL be projected; an error or tagged failure SHALL become a structured object; any other value SHALL fall back to a bounded rendered representation. Serialization SHALL be bounded by depth and bytes and SHALL terminate on cycles.

#### Scenario: A view projects to JSON

- **WHEN** the evaluation returns a profile or bundle view with a documented projection
- **THEN** the response contains that projection rather than `util.inspect` text

#### Scenario: A non-serializable value is bounded

- **WHEN** the evaluation returns a cyclic object or a value outside the JSON model
- **THEN** the response falls back to a bounded rendered string
- **AND** serialization does not fail or hang

### Requirement: Diffs and warnings are structured

A config reload SHALL produce a structured diff list rather than only text lines. Preflight and composition warnings SHALL be returned as strings in the response.

#### Scenario: Config edits produce a diff

- **WHEN** the config file changes between two evaluations in a persistent session
- **THEN** the next response contains a diff list with an operation, kind, and subject
- **AND** warnings from the new evaluation are included

### Requirement: Errors are stable and machine-readable

Machine failures SHALL carry a stable code, a message, and optional diagnostic lines. Existing eedsh error codes SHALL be preserved rather than collapsed into one string. A caller SHALL be able to distinguish a config failure, an authoring-package failure, an evaluation failure, a DSH-discovery failure, and a publication failure from the code alone.

#### Scenario: Invalid config

- **WHEN** the config file is missing, has a non-TypeScript extension, or fails validation
- **THEN** the response carries the corresponding config error code and diagnostics
- **AND** no evaluation result is reported as successful

#### Scenario: Publication failure

- **WHEN** a sync operation fails because another sync holds the lock or preflight rejects the plan
- **THEN** the response preserves the tagged failure and diagnostic lines
- **AND** the caller does not have to parse free-form text

### Requirement: A persistent NDJSON session is available

`eedsh repl --stdio` SHALL start a persistent session that emits one `hello` document, then reads one JSON request per line and writes one JSON response per line. Requests SHALL carry an `id` and an operation; responses SHALL echo the `id`. The protocol SHALL NOT use ANSI, a prompt, or readline output. stdout SHALL be reserved for protocol documents and logs SHALL go to stderr.

#### Scenario: Handshake and evaluation

- **WHEN** a caller starts `--stdio` and sends `{"id":1,"op":"eval","code":"plan"}`
- **THEN** the first response is a `hello` document with the protocol version, eedsh and DSH facts, the config path, profiles, and selection
- **AND** the next response has `id: 1` and the evaluation result

### Requirement: The session executes requests serially and supports lifecycle operations

The session SHALL support at least `eval`, `profile`, `reload`, `sync`, and `close`. Requests SHALL execute serially, and closing the session SHALL release the evaluator without publishing.

#### Scenario: Requests are serialized

- **WHEN** a caller sends two evaluation requests without waiting
- **THEN** they are executed in order
- **AND** each response carries its own request id

#### Scenario: Close and EOF

- **WHEN** the caller sends `close` or closes stdin
- **THEN** the session releases the evaluator and exits
- **AND** no profile is published by shutting down

### Requirement: The session negotiates its protocol version

A caller that does not understand the advertised protocol version SHALL receive an explicit error. The session SHALL NOT reinterpret an unknown protocol version as a different operation.

#### Scenario: Unknown protocol

- **WHEN** a caller sends a protocol version the session does not support
- **THEN** the session returns an explicit protocol error
- **AND** it does not reinterpret the request as a different operation

### Requirement: The persistent session reloads the config predictably

Before an evaluation, the session SHALL notice a changed config file and re-evaluate it. A successful reload SHALL update the evaluation and include the diff. A failed reload SHALL keep the previous successful evaluation and return the failure; it SHALL NOT present the failed state as current. Inspection and reload SHALL NOT write profile files or publish.

#### Scenario: Successful reload

- **WHEN** the config file changes and the caller evaluates again
- **THEN** the session evaluates the new file
- **AND** the response includes the diff against the previous evaluation

#### Scenario: Failed reload keeps the last good state

- **WHEN** the changed config fails to import or validate
- **THEN** the response reports the failure
- **AND** the previous evaluation remains queryable
- **AND** no profile file is written

### Requirement: Publication is explicit and never implicit

A publication SHALL occur only through an explicit `sync` request (or the existing interactive `.sync`/`--sync` behavior). Evaluation, inspection, profile switching, and reload SHALL NOT publish. A sync response SHALL report whether a generation changed, the generation identity, any warnings or notices, and whether a restart is required; it SHALL NOT claim that the runtime applied a generation.

#### Scenario: Evaluation does not publish

- **WHEN** a caller evaluates expressions and switches profiles repeatedly
- **THEN** no generation is published
- **AND** no profile file changes

#### Scenario: Explicit sync reports the outcome

- **WHEN** a caller sends a `sync` request on a session with a publication runner
- **THEN** the response reports the generation outcome, warnings, and restart requirement
- **AND** a failure is returned as an error rather than a successful publish

### Requirement: Inspection cannot write profile state

One-shot evaluation and NDJSON evaluation SHALL be read-only with respect to eedsh's published profile artifacts. The only publication path is the explicit sync operation. Reading views, resolving bundles, diffing plans, and completing expressions SHALL NOT write under `$DSH_HOME/profiles`.

#### Scenario: Views and diffs do not write

- **WHEN** a caller evaluates profile, bundle, package, and published-state views and triggers reloads
- **THEN** no file under the DSH profile directory changes

#### Scenario: Sync is the only writer

- **WHEN** a caller never sends a sync request
- **THEN** no generation under the selected profile is published
