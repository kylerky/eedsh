## MODIFIED Requirements

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

### Requirement: Session bindings use the config project's authoring package

The session SHALL load the authoring package installed for the selected config project and SHALL bind only its curated authoring factories (`bundle`, `defineConfig`, `group`, `js`, and `dshVersion`) alongside the typed views, so a factory entered at the prompt runs the same code as the same call in `config.ts`. An authoring export that collides with a reserved view binding SHALL fail the session loudly instead of silently shadowing it.

#### Scenario: Prompt and file agree

- **WHEN** the author calls a bundle factory at the prompt and the same call in `config.ts`
- **THEN** both return the same rows

#### Scenario: The running version is available at the prompt

- **WHEN** the author evaluates `dshVersion()` at the prompt
- **THEN** it returns the exact version of the selected installation

#### Scenario: An authoring export collides with a binding

- **WHEN** the config project's authoring package exports `config`, `selectedProfile`, or `plan`
- **THEN** the session fails with a structured binding-collision failure

#### Scenario: The config project lacks the authoring package

- **WHEN** the selected config project has not installed its authoring package
- **THEN** the session fails with a structured message that names the missing package
