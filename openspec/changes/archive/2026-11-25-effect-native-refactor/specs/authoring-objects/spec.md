# authoring-objects Specification

## MODIFIED Requirements

### Requirement: Bundle handles resolve rows from one explicit root

`bundle(name)` SHALL return a typed `Bundle` that can be used as a plan selection and as a query handle. A handle SHALL record its root as data and SHALL be resolved by the invocation that evaluates the config, never by IO at the call site. With no root, the recorded root SHALL be the installation selected for that invocation. `.fromProfile()` SHALL name a profile's installed copy, and `.fromPackageDir()` SHALL name a directory; a relative directory SHALL resolve against the config file's directory. A rooted handle SHALL be query-only and SHALL NOT be accepted as a plan selection.

#### Scenario: The pinned installation is the default

- **WHEN** a bundle handle with no root queries its rows
- **THEN** the rows come from the installation selected for the current invocation

#### Scenario: A profile root

- **WHEN** a profile-rooted handle queries a bundle installed in that profile
- **THEN** the rows come from that profile's installed copy

#### Scenario: A relative package directory

- **WHEN** a package-directory root is relative
- **THEN** it resolves against the directory containing the config file

#### Scenario: A rooted handle cannot become a plan selection

- **WHEN** a rooted handle is passed to `ProfileBuilder.bundle()`
- **THEN** authoring rejects it and does not silently drop the root

#### Scenario: The handle performs no IO when it is created

- **WHEN** a config calls `bundle(name)` and roots it while the module is evaluated
- **THEN** the call records the name and the root without reading a package manifest

## REMOVED Requirements

### Requirement: The authoring API exposes the active DSH version

**Reason**: An ambient `dshVersion()` cannot be pure; the selected version is now an evaluation input, per the `config-evaluation-inputs` capability, so the version stays available in authoring control flow without reading ambient state.

**Migration**: A config factory reads `input.dshVersion` instead of calling `dshVersion()`. The value is still the exact selected version and is still never written into the plan or the generated manifest.
