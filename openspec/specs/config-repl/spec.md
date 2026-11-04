# config-repl Specification

## Purpose
Gives authors an interactive TypeScript session over the loaded config with save-triggered re-evaluation, session-local preview resolution for custom bundles, and optional in-session sync, so the composed profile can be inspected and published without leaving the prompt.

## Requirements

### Requirement: The session evaluates TypeScript expressions against the loaded config

`eedsh repl` SHALL start an interactive session that evaluates TypeScript expressions, including type annotations and top-level await, and SHALL expose the loaded config and selected profile as typed views (`config` and `selectedProfile`) and the selected profile's plan as `plan`. It SHALL bind only the curated authoring factories from the config project's authoring package, and SHALL NOT bind the legacy `profile` string or the raw `profiles` result map. Bindings SHALL persist between evaluations.

#### Scenario: An annotated expression is evaluated

- **WHEN** the author enters an expression with a type annotation
- **THEN** the session prints its value

#### Scenario: A binding persists

- **WHEN** the author declares a value in one entry and uses it in the next
- **THEN** the second entry sees the value

#### Scenario: An awaited expression resolves

- **WHEN** the author enters an expression that awaits a promise
- **THEN** the session prints the resolved value

#### Scenario: The typed views are bound

- **WHEN** the author evaluates `selectedProfile.name` or `plan.profile.name`
- **THEN** the output names the selected profile

### Requirement: Session bindings use the config project's authoring package

The session SHALL load the authoring package installed for the selected config project and SHALL bind only its curated authoring factories (`bundle`, `defineConfig`, `group`, `js`, and `dshVersion`) alongside the typed views, so a factory entered at the prompt runs the same code as the same call in `config.ts`. An authoring export that collides with a reserved view binding SHALL fail the session loudly instead of silently shadowing it.

#### Scenario: Prompt and file agree

- **WHEN** the author calls a bundle factory at the prompt and the same call in `config.ts`
- **THEN** both return the same rows

#### Scenario: The running version is available at the prompt

- **WHEN** the author evaluates `dshVersion()` at the prompt
- **THEN** it returns the exact version of the selected installation

#### Scenario: The config project lacks the authoring package

- **WHEN** the selected config project has not installed its authoring package
- **THEN** the session fails with a structured message that names the missing package

#### Scenario: An authoring export collides with a binding

- **WHEN** the config project's authoring package exports `config`, `selectedProfile`, or `plan`
- **THEN** the session fails with a structured binding-collision failure

### Requirement: The session reports resolution provenance

For every query it evaluates, the session SHALL print the resolved package path, its version, and whether it came from the active DSH installation, a profile, a package directory, or the session preview. Completion SHALL resolve names for suggestions without printing provenance.

#### Scenario: Provenance for a pinned query

- **WHEN** the author queries an in-box bundle
- **THEN** the output names the active installation's path and version

#### Scenario: Provenance for a preview query

- **WHEN** the author queries a bundle through the session preview
- **THEN** the output says the rows came from the preview and names its path

#### Scenario: Completion stays silent

- **WHEN** Tab completion resolves a bundle or row name
- **THEN** no provenance line is printed

### Requirement: The session selects a profile like the other commands

The session SHALL select its profile with `--profile`, then the config's default profile, then the sole profile, and SHALL report an ambiguous or unknown selection rather than guessing. `.resolve` and `.sync` SHALL act on the selected profile.

#### Scenario: The default profile is selected

- **WHEN** the config declares a default profile and no profile flag is given
- **THEN** the session opens on that profile

#### Scenario: Selection is ambiguous

- **WHEN** the config declares several profiles with no default and no profile flag is given
- **THEN** the session reports the ambiguity and lists the profiles

### Requirement: Saving the config re-evaluates it and reports the change
The session SHALL watch the config directory, debounce bursts of edits, and after each save re-evaluate the config. On success it SHALL print a diff against the previous evaluation covering profile, generated patch group, patch, and package changes, plus a composition summary with the composed row count and preflight warnings. A generated patch group SHALL be identified in the diff by its patch content rather than its position, so that inserting or removing a group does not report every later group as changed. On failure it SHALL print the failure and keep the previous evaluation available.

#### Scenario: A patch is added
- **WHEN** the author saves a config that adds an inserted row
- **THEN** the session prints the added row and the new composed row count

#### Scenario: A group is inserted in the middle
- **WHEN** the author saves a config that inserts a generated patch group between two existing groups
- **THEN** the diff reports the new group and does not report the later groups as changed

#### Scenario: An invalid save
- **WHEN** the author saves a config whose plan fails validation
- **THEN** the session prints the attributed failure and keeps the previous plan

#### Scenario: Errors do not end the session
- **WHEN** an evaluation fails
- **THEN** the prompt remains usable and `.reload` retries the evaluation

### Requirement: The composition view reports where a row came from
The composition summary SHALL report, for every composed row, the source that last touched it: the authoring site of the generated patch that wrote the row when that site is known, otherwise the generated patch group by position, or the contributing bundle by name.

#### Scenario: A generated row reports its site
- **WHEN** a composed row was inserted by a generated patch whose authoring site is known
- **THEN** the composition view reports the row together with that file and line

#### Scenario: A bundle row reports its bundle
- **WHEN** a composed row comes from a bundle layer
- **THEN** the composition view reports the row together with the bundle name

### Requirement: Preview resolution is session-local

On request, the session SHALL copy the selected profile's manifest, workspace file, and lockfile into a cache directory keyed by those inputs and the requested specs, install the exact specs there, and serialize concurrent installs for the same key. The preview SHALL NOT be part of the profile, and `config.ts` SHALL NOT reference the preview path.

#### Scenario: Preparing a preview

- **WHEN** the author runs `.resolve '@acme/x@1.2.3'`
- **THEN** the session prepares the preview and evaluates the config against it

#### Scenario: The config text does not change

- **WHEN** the preview is active
- **THEN** `config.ts` still names `{ profile: 'work' }` and never the preview path

#### Scenario: Concurrent sessions

- **WHEN** two sessions prepare the same preview key at the same time
- **THEN** one waits for the other and both end with the same installed preview

### Requirement: Preview evaluation uses a printed profile-root override

While a preview is active, the session SHALL evaluate the config with a profile-root override mapping the selected profile to the preview directory, SHALL print that override, and SHALL keep it scoped to the session. A failed preview install SHALL leave the previous evaluation in place and report that the preview is not ready.

#### Scenario: The override is printed

- **WHEN** the session evaluates with an active preview
- **THEN** it prints the profile-to-directory mapping it used

#### Scenario: A failed preview install

- **WHEN** the exact spec cannot be installed
- **THEN** the session reports the install failure, keeps the previous evaluation, and reports that the preview is not ready

### Requirement: The session can publish the selected profile

`.sync` SHALL materialize the selected profile in the session. It SHALL print a one-line outcome on success, the full diagnostics on failure, and SHALL report profile-lock contention instead of blocking the prompt. It SHALL report restart-required changes when the published bundle or package set changed.

#### Scenario: Nothing changed

- **WHEN** `.sync` runs and the generation is unchanged
- **THEN** the session reports the profile is up to date without writing

#### Scenario: A layer changed

- **WHEN** `.sync` runs after a patch-only change
- **THEN** the session publishes the new generation and reports it

#### Scenario: Another sync holds the lock

- **WHEN** `.sync` finds the profile lock held
- **THEN** the session reports the contention and leaves the prompt usable

#### Scenario: Restart required

- **WHEN** `.sync` changes the bundle or package set
- **THEN** the session reports that a running profile requires a restart

### Requirement: Continuous sync is opt-in

`--sync` or `.sync on` SHALL enable sync after each successful debounced evaluation. The mode SHALL be shown in the session banner, SHALL be skipped when the config is invalid, and SHALL pause after a failed sync until the next changed save. `.sync off` SHALL return the session to inspection only.

#### Scenario: A save syncs

- **WHEN** continuous sync is on and the author saves a valid change
- **THEN** the session evaluates, syncs, and prints one outcome line

#### Scenario: A failing save does not spam

- **WHEN** a sync fails and the author saves without changing anything effective
- **THEN** the session does not retry the sync

#### Scenario: Turning it off

- **WHEN** the author runs `.sync off`
- **THEN** later saves are evaluated but not published

### Requirement: A preview-baked publish is verified immediately

When the session publishes a plan that was evaluated with the preview override, it SHALL immediately re-evaluate the config against the real profile and compare the resulting plan. If the plans are identical it SHALL delete the preview and report the bootstrap complete. If they differ it SHALL report the divergence, keep the preview, and leave the real evaluation available for the next `.sync`.

#### Scenario: The real install reproduces the plan

- **WHEN** the preview spec matches the installed bundle and the re-evaluated plan is identical
- **THEN** the session deletes the preview and reports the bootstrap complete

#### Scenario: The plans diverge

- **WHEN** the re-evaluated plan differs from the published one
- **THEN** the session reports the divergence, keeps the preview, and does not delete it

### Requirement: The session writes only when publishing

Inspection, `.reload`, and `.resolve` SHALL NOT write profile files. Publishing SHALL happen only through `.sync` or explicitly enabled continuous sync.

#### Scenario: Inspection leaves the profile untouched

- **WHEN** the author evaluates, reloads, and prepares a preview
- **THEN** no file under the DSH profile directory is written

### Requirement: Session commands stay at the shell level

Session commands SHALL be invoked with a leading dot: `.help` lists commands with their descriptions, `.profile <name>` switches the selected profile from the already loaded config without re-importing it, `.reload` re-evaluates the config, `.resolve` prepares the preview, `.sync` publishes or toggles continuous sync, `.exit` ends the session, and an unrecognized dot command SHALL report an invalid command instead of being evaluated. Tab completion SHALL follow the typed domain grammar. Domain queries are methods on typed objects rather than free functions.

#### Scenario: Help lists the commands

- **WHEN** the author runs `.help`
- **THEN** the output lists the built-in and session commands with their descriptions

#### Scenario: An unknown dot command

- **WHEN** the author enters a dot word that is not a command
- **THEN** the session reports an invalid command and evaluates nothing

#### Scenario: Switching profiles

- **WHEN** the author runs `.profile home`
- **THEN** `selectedProfile` and `plan` reflect `home` without re-importing the config

#### Scenario: Tab completes the domain grammar

- **WHEN** the author types `.` and presses Tab, or completes a typed chain method
- **THEN** only commands or methods valid for the current chain state are offered

### Requirement: One-shot evaluation is available

`eedsh repl --eval <expression>` SHALL evaluate one expression against the loaded config, print its value, and exit without starting an interactive prompt, with a non-zero status when evaluation fails.

#### Scenario: One-shot success

- **WHEN** the author runs `--eval` with an expression that evaluates successfully
- **THEN** the value is printed and the command exits successfully

#### Scenario: One-shot failure

- **WHEN** the expression fails or the config is invalid
- **THEN** the failure is printed and the command exits non-zero
