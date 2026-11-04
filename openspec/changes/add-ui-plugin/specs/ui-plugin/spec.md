## Purpose

Lets eedsh expose published profile status, sync, and doctor in the DSH Web GUI as an optional plugin, while the eedsh CLI remains the only writer of profile artifacts.

## ADDED Requirements

### Requirement: The UI is an optional DSH bundle

`@eedsh/ui` SHALL be a DSH bundle whose single Loader row provides a Host plugin and a browser half through `dsh.client` and a built `./client` export. Selecting the bundle SHALL load both halves; not selecting it SHALL load no UI code and register no `/eedsh` routes.

#### Scenario: Selected bundle adds the page and routes

- **WHEN** a web profile selects `@eedsh/ui`
- **THEN** Settings shows an `eedsh` section
- **AND** the Host serves the `/eedsh` routes

#### Scenario: Unselected bundle changes nothing

- **WHEN** a profile does not select `@eedsh/ui`, including a headless profile
- **THEN** no eedsh settings section is registered
- **AND** no `/eedsh` route is registered
- **AND** profile boot and existing commands behave as before

#### Scenario: Missing browser bundle fails loudly

- **WHEN** the package declares `dsh.client` but its built `./client` artifact is absent
- **THEN** DSH activation reports the missing client bundle and the build instruction
- **AND** the page does not silently render an empty plugin

### Requirement: Profile status reflects published artifacts

The eedsh page SHALL show the current profile and the profile directories under `$DSH_HOME/profiles`. For each profile it SHALL show whether a generation is published, the generation id and publish time when present, the recorded eedsh and DSH versions, the bundle and layer counts, and whether HMR is available for the running profile. It SHALL NOT evaluate `config.ts` and SHALL NOT return config contents, environment values, or credentials.

#### Scenario: Current profile and published peers are listed

- **WHEN** the current profile has a published generation and another profile directory has none
- **THEN** the page marks the current profile
- **AND** the published profile shows its generation id, publish time, versions, bundle count, and layer count
- **AND** the unpublished profile shows a not-published state without an error

#### Scenario: Invalid generation is not presented as current

- **WHEN** a profile's generated package manifest is malformed or unreadable
- **THEN** the page shows the profile as invalid with the reason
- **AND** it does not display the malformed record as a successful generation

#### Scenario: No profiles yet

- **WHEN** no profile directory is readable below `$DSH_HOME/profiles`
- **THEN** the page shows an empty state naming `eedsh init` and `eedsh sync`
- **AND** it still shows the configured config path when one is available

### Requirement: Sync is explicit, serialized, and owned by the CLI

A sync action SHALL start a job that runs the existing `eedsh` CLI with fixed argv for one named profile or all profiles. The Host SHALL NOT write profile artifacts itself and SHALL NOT import the materializer. At most one sync job per profile SHALL run, and a sync-all job SHALL be mutually exclusive with single-profile jobs. A duplicate request SHALL be rejected with the existing job reference. The job SHALL expose running, succeeded, failed, and cancelled states and a bounded output tail.

#### Scenario: Sync one profile

- **WHEN** the user starts a sync for the current profile
- **THEN** one child process runs `eedsh sync` for that profile with the Host's configured config and installation paths
- **AND** the page shows the running state and output tail
- **AND** the job finishes with the CLI exit code

#### Scenario: Sync all profiles

- **WHEN** the user starts a sync with no profile
- **THEN** one child process runs `eedsh sync` without a `--profile` argument
- **AND** no other sync job starts until it finishes

#### Scenario: Duplicate sync is rejected

- **WHEN** a sync job is already running for the selected profile or for all profiles
- **THEN** the request is rejected with the existing job id
- **AND** no second child process starts

#### Scenario: Cancel a running sync

- **WHEN** the user cancels a running sync job
- **THEN** the Host terminates the child process and reports the cancelled state
- **AND** the CLI's existing profile lock and publication rules remain the final authority

#### Scenario: Invalid profile is rejected at the boundary

- **WHEN** a request names a profile that is empty, contains a path separator, or otherwise fails the eedsh safe-name rule
- **THEN** the Host rejects the request without starting a process

### Requirement: Sync reports the published outcome

After a sync job finishes, the page SHALL re-read the profile status and report the resulting generation. When HMR is available it SHALL say that the runtime will apply the published generation; when HMR is unavailable it SHALL say that a restart is required. It SHALL NOT claim that a generation is applied when the Host has no evidence.

#### Scenario: Successful sync publishes a new generation

- **WHEN** the CLI exits successfully and the generation id changes
- **THEN** the page shows the new generation id and publish time
- **AND** it reports the HMR or restart requirement for the running profile

#### Scenario: Successful sync publishes no change

- **WHEN** the CLI exits successfully and the generation id is unchanged
- **THEN** the page reports that the profile is up to date
- **AND** it does not claim a new publication

#### Scenario: Failed sync keeps the previous status visible

- **WHEN** the CLI exits non-zero
- **THEN** the page shows the failure, the exit code, and the bounded output tail
- **AND** the previously published generation remains visible as the last published state

### Requirement: Doctor runs on demand and is not cached as durable state

The page SHALL run `eedsh doctor` for a selected profile as a job and show its exit code and output. The Host SHALL NOT write profile artifacts for doctor and SHALL NOT present a previous doctor result as current after the underlying files or packages change.

#### Scenario: Doctor reports no findings

- **WHEN** `eedsh doctor` exits successfully
- **THEN** the page shows the success state and the doctor output

#### Scenario: Doctor reports findings

- **WHEN** `eedsh doctor` exits non-zero
- **THEN** the page shows the exit code and the findings output
- **AND** it does not silently convert the result to success

#### Scenario: Doctor is unavailable without the CLI

- **WHEN** the configured eedsh command cannot be found
- **THEN** the doctor action is disabled and the page explains how to provide the command
- **AND** no child process is started

### Requirement: Routes are authenticated before any work

Every `/eedsh` route SHALL call the composition's `connection.requestRejection` before reading a profile or starting a process and SHALL return the rejection when present. A composition without `connection` SHALL NOT register the routes.

#### Scenario: Unauthenticated or cross-origin request is rejected

- **WHEN** a request lacks the connection service's authentication or fails its Host/Origin fence
- **THEN** the route returns the connection rejection
- **AND** no profile is read for a write action and no child process starts

#### Scenario: Missing connection prevents registration

- **WHEN** the Host composition has no `connection` service
- **THEN** the plugin does not register the `/eedsh` routes
- **AND** DSH reports the unresolved `connection` dependency instead of exposing unauthenticated endpoints

### Requirement: Mutations are POST-only and constrained

Only `GET /eedsh/status` may read state; sync, doctor, and cancellation SHALL be POST. POST bodies SHALL be `application/json`, at most 64 KiB, and SHALL name a profile that satisfies the eedsh safe-name rule. The browser SHALL NOT supply a command, argv, file path, or config path.

#### Scenario: GET cannot start a sync

- **WHEN** a client sends `GET /eedsh/sync`
- **THEN** the route rejects the method
- **AND** no sync job starts

#### Scenario: Oversized or malformed body is rejected

- **WHEN** a POST body exceeds 64 KiB, is not JSON, or names an invalid profile
- **THEN** the route rejects the request
- **AND** no child process starts

#### Scenario: Browser input cannot add CLI arguments

- **WHEN** a request body carries extra fields such as a command, flag, or path
- **THEN** the Host does not pass those values to the child process
- **AND** only the Host-configured command, config path, and installation path are used

### Requirement: Job output is bounded and secret-free

Job output SHALL be a bounded tail and SHALL NOT include config contents, environment values, or credentials. The Host SHALL NOT return the config file or the complete plan document to the browser.

#### Scenario: Long output is truncated

- **WHEN** a sync or doctor job produces more output than the tail limit
- **THEN** the page shows the bounded tail and marks it as truncated
- **AND** the complete output is not sent to the browser

#### Scenario: Status contains only safe profile facts

- **WHEN** the status route returns a profile
- **THEN** the response contains names, versions, counts, paths, and generation facts
- **AND** it does not contain config text, environment values, or credentials

### Requirement: Remote mutations are disabled by default

When the web server binds a non-loopback address, the plugin SHALL keep authenticated status reads available and SHALL refuse sync and doctor mutations unless the Host explicitly enables remote mutations.

#### Scenario: Remote deployments keep reads but not writes by default

- **WHEN** the web server binds a non-loopback address and remote mutations are not explicitly enabled
- **THEN** status reads remain available to authenticated clients
- **AND** sync and doctor mutations are refused

### Requirement: The page remains usable when CLI or profiles are unavailable

The eedsh page SHALL keep the read-only status available when the configured eedsh command cannot be found, while disabling sync and doctor with an actionable explanation. A failed or unreachable Host SHALL be shown as a failure, not as a successful or stale status.

#### Scenario: CLI missing

- **WHEN** the configured command cannot be found
- **THEN** published profiles and generations remain visible
- **AND** sync and doctor controls are disabled with install or configuration guidance

#### Scenario: Host request fails

- **WHEN** the status request fails or the connection drops
- **THEN** the page shows the failure state
- **AND** it does not present the last snapshot as a confirmed current result

### Requirement: The page is localized and accessible

The eedsh page SHALL provide complete Chinese and English copy for user-visible strings, SHALL be operable by keyboard, and SHALL NOT encode status by color alone. Buttons and status regions SHALL have accessible names and announced state changes.

#### Scenario: Language changes

- **WHEN** the web client language is Chinese or English
- **THEN** all eedsh-owned labels, states, and failure messages use that language

#### Scenario: Keyboard-only operation

- **WHEN** the user navigates the page with a keyboard
- **THEN** every action is reachable and operable
- **AND** status text is announced without relying on color

### Requirement: The plugin loads in supported DSH web profiles

The built client bundle SHALL load in DSH `0.2.1-rc.2` and `0.2.2-alpha.3` web profiles. A missing or invalid client artifact SHALL fail activation with a build instruction rather than rendering a blank page.

#### Scenario: Supported version matrix

- **WHEN** the bundle is built and loaded in a supported DSH web profile
- **THEN** the eedsh section renders and its status request succeeds

#### Scenario: Unsupported client artifact

- **WHEN** the built client artifact is absent or does not register the package id
- **THEN** activation reports the artifact problem
- **AND** the failure names the build step
