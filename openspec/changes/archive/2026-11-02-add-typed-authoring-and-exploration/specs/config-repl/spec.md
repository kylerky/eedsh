## MODIFIED Requirements

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

The session SHALL load the authoring package installed for the selected config project and SHALL bind only its curated authoring factories (`bundle`, `defineConfig`, `group`, and `js`) alongside the typed views, so a factory entered at the prompt runs the same code as the same call in `config.ts`. An authoring export that collides with a reserved view binding SHALL fail the session loudly instead of silently shadowing it.

#### Scenario: Prompt and file agree

- **WHEN** the author calls a bundle factory at the prompt and the same call in `config.ts`
- **THEN** both return the same rows

#### Scenario: The config project lacks the authoring package

- **WHEN** the selected config project has not installed its authoring package
- **THEN** the session fails with a structured message that names the missing package

#### Scenario: An authoring export collides with a binding

- **WHEN** the config project's authoring package exports `config`, `selectedProfile`, or `plan`
- **THEN** the session fails with a structured binding-collision failure

### Requirement: The session reports resolution provenance

For every query it evaluates, the session SHALL print the resolved package path, its version, and whether it came from the pinned installation, a profile, a package directory, or the session preview. Completion SHALL resolve names for suggestions without printing provenance.

#### Scenario: Provenance for a pinned query

- **WHEN** the author queries an in-box bundle
- **THEN** the output names the pinned installation's path and version

#### Scenario: Provenance for a preview query

- **WHEN** the author queries a bundle through the session preview
- **THEN** the output says the rows came from the preview and names its path

#### Scenario: Completion stays silent

- **WHEN** Tab completion resolves a bundle or row name
- **THEN** no provenance line is printed

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
