## Purpose

Turns the config REPL into a self-exploring session with typed domain bindings, chain-aware Tab completion, and read-only views over profiles, bundles, packages, rows, and published state.

## ADDED Requirements

### Requirement: The session exposes typed domain bindings

The session SHALL bind `config` as a config view, `selectedProfile` as the selected profile view, and `plan` as the selected profile's validated plan. The bindings SHALL persist between entries. The legacy `profile` string binding and the raw `profiles` result map SHALL NOT be bound; profile collection access SHALL be available through the config view.

#### Scenario: The selected profile is inspectable

- **WHEN** the author evaluates `selectedProfile.name` and `selectedProfile.bundles()`
- **THEN** the output names the selected profile and lists its bundles

#### Scenario: Bindings persist

- **WHEN** the author declares a value in one entry and uses it in the next
- **THEN** the second entry sees the value

#### Scenario: The legacy binding is gone

- **WHEN** the author evaluates the old `profile` string binding
- **THEN** it is no longer defined and the session reports the missing binding without ending

### Requirement: The session switches profiles through a shell command

`.profile <name>` SHALL switch the selected profile using the already loaded config, without re-importing the config or writing profile files. An unknown name SHALL report the failure, list the declared profiles, and keep the current selection. `.resolve` and `.sync` SHALL act on the selected profile after a switch.

#### Scenario: Switching profiles

- **WHEN** the author runs `.profile home`
- **THEN** `selectedProfile` and `plan` reflect `home` and later `.resolve` and `.sync` use it

#### Scenario: Unknown profile

- **WHEN** the author runs `.profile missing`
- **THEN** the session reports the unknown name, lists the declared profiles, and keeps the current selection

#### Scenario: No re-import

- **WHEN** the profile switches
- **THEN** the config is not re-imported and no profile file is written

### Requirement: Tab completion follows the domain grammar

The session SHALL provide Tab completion for shell commands and their arguments, for valid typed-object methods at the current chain step, and for domain names used as arguments: profile names, bundle names, row ids, preset ids, package names, and the `on|off` values of `.sync`. Completion SHALL offer only operations valid for the current chain state.

#### Scenario: Commands complete

- **WHEN** the author types `.he<TAB>` or `.sync o<TAB>`
- **THEN** `.help` or `on` is offered

#### Scenario: Methods complete per chain step

- **WHEN** the author types `bundle('@deepseek-ai/dsh-web-app').<TAB>`
- **THEN** row, preset, resolution-root, provenance, and patch methods are offered

#### Scenario: Argument names complete

- **WHEN** the author types `bundle('...').fromProfile('<TAB>` or `bundle('...').row('<TAB>`
- **THEN** declared profile names or the resolved bundle's row ids are offered

#### Scenario: Invalid next steps are not offered

- **WHEN** a chain is already rooted
- **THEN** a second root method is not offered

### Requirement: Completion and exploration are read-only and non-fatal

Tab completion, `.profile`, reload, and exploration views SHALL NOT write profile files or publish. A completion error SHALL NOT end the session or change the current evaluation, and the prompt SHALL remain usable.

#### Scenario: Completion does not publish

- **WHEN** the author completes bundle and row names repeatedly
- **THEN** no profile file is written and no generation is published

#### Scenario: A failed completion is contained

- **WHEN** completion resolves a missing bundle or malformed patch
- **THEN** the session reports no fatal error and the previous evaluation remains active

### Requirement: Exploration views expose profiles, bundles, packages, and objects

The config view SHALL list declared profiles and return one profile view by name. The profile view SHALL expose the validated plan, ordered bundles, layers, packages, composed rows or entries, and a published-state view. The bundle view SHALL expose rows, presets, and provenance. The published view SHALL expose the profile manifest, generation record, and doctor findings without changing them.

#### Scenario: Profiles are listed

- **WHEN** the author evaluates the config view's profile collection
- **THEN** every declared profile is listed with whether its plan is valid

#### Scenario: Bundle objects are inspectable

- **WHEN** the author navigates from a profile to a bundle
- **THEN** rows, presets, package version, and origin are available

#### Scenario: Packages are inspectable

- **WHEN** the author evaluates the selected profile's packages
- **THEN** declared, managed, and installed package information is available

#### Scenario: Composed rows are inspectable

- **WHEN** the author evaluates the selected profile's composed rows
- **THEN** each row exposes its id, data, and source layer or bundle

#### Scenario: Published state is inspectable

- **WHEN** the author evaluates the published view
- **THEN** the manifest, generation record, and doctor findings are available

### Requirement: Exploration never publishes

Only `.sync` or explicitly enabled continuous sync SHALL publish. `.profile`, completion, typed views, reload, and `.resolve` SHALL never write profile files or publish a generation.

#### Scenario: Inspection leaves the profile untouched

- **WHEN** the author explores every view and completes names
- **THEN** no file under the DSH profile directory is written

#### Scenario: Publishing stays explicit

- **WHEN** the author runs `.sync`
- **THEN** the selected profile is materialized and the outcome is reported

### Requirement: The session guides discovery

The session banner and `.help` SHALL list the typed bindings, the `.profile` command, and the Tab-completion hint. `.help` SHALL describe the exploration commands and how to reach profiles, bundles, packages, rows, and published state. A failed lookup SHALL list the valid alternatives when they are cheaply available.

#### Scenario: Help lists bindings and commands

- **WHEN** the author runs `.help`
- **THEN** `config`, `selectedProfile`, `plan`, `.profile`, `.resolve`, and `.sync` are described

#### Scenario: An unknown name suggests alternatives

- **WHEN** the author asks for an unknown profile or row
- **THEN** the failure lists the available names

### Requirement: Existing session behavior is preserved

The typed bindings and completion SHALL NOT change save-triggered re-evaluation, plan diffing, preview resolution, in-session sync, continuous sync, `--eval`, or error containment. The session SHALL continue to keep the last good evaluation after a failed save.

#### Scenario: Reload still diffs

- **WHEN** the config changes and is re-evaluated
- **THEN** the diff and composition summary are printed as before

#### Scenario: Preview still resolves

- **WHEN** the author prepares a preview
- **THEN** the printed override and evaluation remain available

#### Scenario: Eval still works

- **WHEN** `--eval` runs a typed-binding expression
- **THEN** the value is printed and the command exits without a prompt

#### Scenario: A bad save keeps the last plan

- **WHEN** an evaluation fails
- **THEN** the prompt remains usable and the last good plan remains active
