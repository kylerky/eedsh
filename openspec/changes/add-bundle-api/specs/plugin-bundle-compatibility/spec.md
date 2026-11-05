## Purpose

Keeps a plugin generated with the build-time API a standard DeepSeek Harness bundle, so profiles started by a plain DSH installation can use it without eedsh.

## ADDED Requirements

### Requirement: The generated plugin remains a standard DSH bundle

The plugin package SHALL keep the standard `dsh.bundle.patch` declaration pointing at the committed `cordis.patch.yml` and SHALL include that file in its published `files`. It SHALL NOT add eedsh-only manifest fields, SHALL NOT require an eedsh runtime package, and SHALL NOT import eedsh from its runtime entry.

#### Scenario: Plain DSH composes the generated bundle

- **WHEN** a DSH installation that eedsh did not start selects the plugin package in `dsh.profile.bundles`
- **THEN** DSH reads the generated `cordis.patch.yml` and loads the plugin's rows
- **AND** the plugin's runtime entry loads without importing eedsh

#### Scenario: The tarball contains the generated patch

- **WHEN** the plugin package is packed for publication
- **THEN** the tarball contains the current `cordis.patch.yml`
- **AND** `dsh.bundle.patch` resolves to it

### Requirement: The generated patch is free of eedsh runtime coupling

The plugin's runtime `dependencies` and `peerDependencies` SHALL NOT include `@eedsh/*` packages. The API package SHALL be a development dependency only. The generated YAML SHALL be a DSH Loader patch array in the DSH dialect and SHALL NOT contain `$eedsh` nodes, eedsh-generated bundle names, or an eedsh version requirement.

#### Scenario: Runtime dependency check

- **WHEN** the plugin's manifest and generated YAML are inspected
- **THEN** no eedsh package appears in runtime dependencies or peer dependencies
- **AND** the YAML contains no `$eedsh` expression node or eedsh runtime field

### Requirement: The artifact is committed and checked for drift

The generated `cordis.patch.yml` SHALL be committed to the plugin repository. The plugin's checks SHALL fail when the committed file differs from the definition's current emission. A prepack check SHALL fail when the published tarball would not contain the current artifact.

#### Scenario: Editing the definition without regenerating fails CI

- **WHEN** the TypeScript definition changes and the plugin's check runs without regenerating the YAML
- **THEN** the check fails and names the stale artifact

#### Scenario: Regenerating restores the check

- **WHEN** the artifact is regenerated after the definition change
- **THEN** the check passes and the packed tarball contains the new bytes
