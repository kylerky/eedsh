## Purpose

Lets a DeepSeek Harness agent evaluate eedsh configuration code, inspect plan facts, and publish a profile through an optional bundle and agent mode, while the eedsh CLI remains the only writer and publication stays behind an explicit human approval.

## ADDED Requirements

### Requirement: The integration is optional and isolated to its mode

`@eedsh/repl` SHALL be an optional DSH bundle. Selecting it SHALL provide an `eedsh` agent preset that exposes the eedsh tools and authoring skill; not selecting it SHALL register no eedsh tools and leave existing presets, including standard and PTC, unchanged. The preset SHALL appear as a selectable mode, and its tools SHALL NOT be visible to an agent running a preset that does not declare them.

#### Scenario: Selected bundle adds the mode and tools

- **WHEN** a profile selects `@eedsh/repl` and a session uses the `eedsh` mode
- **THEN** the agent sees `eedsh_eval`, `eedsh_inspect`, and `eedsh_sync`
- **AND** the authoring skill is available to that session

#### Scenario: Unselected bundle changes nothing

- **WHEN** a profile does not select `@eedsh/repl`
- **THEN** no eedsh tool is registered
- **AND** no `eedsh` mode appears
- **AND** existing presets and commands behave as before

#### Scenario: Standard mode does not gain the tools

- **WHEN** a session runs the standard or PTC preset
- **THEN** the eedsh tools are not visible
- **AND** the session cannot call them

### Requirement: The agent can evaluate the config through a dedicated tool

The `eedsh_eval` tool SHALL accept a TypeScript code string and an optional profile name and return the machine evaluation result: success or failure, the projected value and rendered text, the selected profile, declared profiles, diff, warnings, and traces. It SHALL use a persistent per-agent session so bindings survive across calls in the same agent. The tool SHALL surface eedsh's structured error codes and SHALL NOT terminate the agent turn on an ordinary evaluation failure.

#### Scenario: Evaluate a binding

- **WHEN** the agent calls `eedsh_eval` with `selectedProfile.name`
- **THEN** the result contains the selected profile name
- **AND** the session keeps its bindings for the next call

#### Scenario: A failed expression is recoverable

- **WHEN** the expression is invalid or throws
- **THEN** the tool returns a structured failure with the error code and message
- **AND** the session remains usable for a corrected expression

#### Scenario: Switching profile

- **WHEN** the agent calls `eedsh_eval` with a declared profile name
- **THEN** that profile becomes the session's selection
- **AND** later calls use it until another switch

### Requirement: The agent can inspect common facts without writing code

The `eedsh_inspect` tool SHALL expose read-only operations for profiles, one profile's plan and rows, composed entries, packages, published state, and doctor findings. Each operation SHALL return structured facts, not `util.inspect` text. An unknown or invalid profile SHALL be reported as an error without changing the session's selection.

#### Scenario: Inspect a plan

- **WHEN** the agent calls `eedsh_inspect` for a profile's plan
- **THEN** the result lists the plan's bundles, layers, packages, and row counts
- **AND** the result is valid JSON

#### Scenario: Inspect a missing profile

- **WHEN** the agent asks for a profile that the config does not declare
- **THEN** the tool reports the unknown profile
- **AND** the current selection is unchanged

#### Scenario: Inspect published state

- **WHEN** the agent asks for a profile's published state
- **THEN** the result reports whether a generation exists, its identity, and doctor findings
- **AND** a missing profile is reported as absent rather than as a crash

### Requirement: Publication requires one explicit approval

The `eedsh_sync` tool SHALL publish one profile through the existing `eedsh sync` command. Before starting the process it SHALL request a one-shot approval from the composition's approval service, naming the profile and the directory that will be written. A denied, cancelled, unavailable, or failed approval SHALL return a structured failure and SHALL NOT start the process.

#### Scenario: Approved sync publishes

- **WHEN** the agent calls `eedsh_sync` and the human approves
- **THEN** one `eedsh sync` process runs for the named profile with the Host-fixed config and DSH paths
- **AND** the result reports the generation outcome and restart requirement

#### Scenario: Denied sync does nothing

- **WHEN** the approval is denied, cancelled, or unavailable
- **THEN** no `eedsh sync` process starts
- **AND** the tool returns a structured failure

### Requirement: Publication is never cached or implicit

The tool SHALL NOT cache an approval across calls. Only an explicit `eedsh_sync` call SHALL publish; editing the config or evaluating new code SHALL NOT publish implicitly.

#### Scenario: Editing does not publish

- **WHEN** the agent edits the config and evaluates the new code without calling `eedsh_sync`
- **THEN** no profile is published
- **AND** the previous generation remains the last published one

#### Scenario: Approval is per call

- **WHEN** the agent publishes once and then calls `eedsh_sync` again
- **THEN** the second call requests a new approval
- **AND** the previous approval does not authorize it

### Requirement: Evaluation is confined to the session sandbox

The tool SHALL run eedsh in a child process confined by the session's resolved sandbox policy. In `read-only` mode evaluation SHALL be able to read the config and inspect plans while file writes are denied; in `workspace-write` it SHALL be confined to the session workspace; the config directory and `$DSH_HOME/profiles` SHALL remain outside the writable boundary unless the deployment explicitly grants them. The integration SHALL NOT evaluate model-written TypeScript inside the DSH Host process.

#### Scenario: Read-only evaluation

- **WHEN** the session policy is `read-only` and the agent evaluates a read-only expression
- **THEN** the evaluation succeeds
- **AND** an expression that writes a file is denied by the sandbox

#### Scenario: Workspace writes stay in the workspace

- **WHEN** the session policy is `workspace-write` and the expression writes inside the workspace
- **THEN** the write succeeds
- **AND** a write to the config directory or `$DSH_HOME/profiles` is denied

#### Scenario: No in-host evaluation

- **WHEN** the tool evaluates code
- **THEN** the evaluation runs in the eedsh child process, not in the DSH Host process

### Requirement: The model cannot choose the command, config, or DSH path

The config path, DSH installation path, and executable SHALL come only from Host configuration or the running profile's installation anchor. The model SHALL NOT be able to supply a path, command, extra argument, or shell fragment. The sync process SHALL be spawned with a fixed argument vector and without a shell. A profile name SHALL satisfy eedsh's safe-name rule before it is passed as an argument.

#### Scenario: Extra arguments are ignored

- **WHEN** a tool call carries an extra field such as a path or CLI flag
- **THEN** the Host does not pass that value to the child process
- **AND** only the configured command and fixed arguments are used

#### Scenario: Invalid profile name

- **WHEN** a call names an invalid profile
- **THEN** the tool rejects it before starting a process

#### Scenario: Running DSH version

- **WHEN** the profile provides an installation anchor
- **THEN** the tool passes that anchor as the DSH selection
- **AND** evaluation does not silently select a different installation from `PATH`

### Requirement: Each agent has an isolated session

The Host SHALL maintain at most one eedsh child session per agent, created lazily and closed when the agent or plugin is disposed. Calls from one agent SHALL be serialized; sessions SHALL NOT be shared between agents. A crashed or timed-out child SHALL be closed and the next call SHALL start a new session and disclose that prior state was lost. The Host SHALL NOT automatically replay an evaluation or a publication after a crash.

#### Scenario: Two agents do not share state

- **WHEN** two agents each evaluate and set a binding
- **THEN** each sees only its own binding
- **AND** a profile switch in one does not change the other

#### Scenario: Crash recovery

- **WHEN** the child exits unexpectedly
- **THEN** the next call starts a new session
- **AND** the result states that state was reset
- **AND** no request is silently replayed

#### Scenario: Disposal

- **WHEN** the agent or plugin is disposed
- **THEN** its child session is closed

### Requirement: Failures are structured and bounded

The tools SHALL return structured failures for a missing config, a missing or unsupported DSH installation, a missing `@eedsh/config` in the config project, an incompatible protocol version, a missing approval service, a held sync lock, or a crashed child. Tool results SHALL be bounded by a size limit and SHALL NOT dump process environment, package-manager tokens, or registry credentials. The integration SHALL NOT retry a publication automatically.

#### Scenario: Configuration missing

- **WHEN** the config path does not exist
- **THEN** the tool reports the config error and an actionable remedy
- **AND** the agent turn continues

#### Scenario: Protocol mismatch

- **WHEN** the installed eedsh CLI does not support the protocol version
- **THEN** the tool reports the incompatibility
- **AND** it does not fall back to parsing human text

#### Scenario: Oversized result

- **WHEN** an evaluation returns more than the configured result limit
- **THEN** the result is truncated with a marker
- **AND** the model still sees that truncation occurred
