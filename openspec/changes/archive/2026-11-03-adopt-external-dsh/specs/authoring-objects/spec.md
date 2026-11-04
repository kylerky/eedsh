## REMOVED Requirements

### Requirement: Config authoring is a synchronous fluent builder

**Reason**: The config no longer declares a DSH value, so `.dsh()` is removed from the builder.

**Migration**: Delete `.dsh(...)`. The builder no longer needs a replacement call.

## MODIFIED Requirements

### Requirement: Bundle handles resolve rows from one explicit root

`bundle(name)` SHALL return a typed `Bundle` that can be used as a plan selection and as a query handle. With no root, queries SHALL resolve from the active discovered DSH installation. `.fromProfile()` SHALL resolve a named profile's installed copy, and `.fromPackageDir()` SHALL resolve a directory; a relative directory SHALL resolve against the config file's directory. A rooted handle SHALL be query-only and SHALL NOT be accepted as a plan selection.

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

### Requirement: Bundle handles expose typed resolution data

A `Bundle` or `BundleQuery` SHALL expose the resolved package version, directory, origin, every declared row, compact preset summaries, one row by Loader id, and one preset by preset id. Returned rows and presets SHALL be typed and immutable, and SHALL expose their plain plan data. A missing row or preset SHALL fail rather than return partial data.

#### Scenario: Rows and presets are inspectable

- **WHEN** an author lists a bundle's rows and presets
- **THEN** each result exposes its id and data and can be converted to plain plan data

#### Scenario: A missing row fails

- **WHEN** an author asks for a row id the bundle does not declare
- **THEN** the query reports a structured failure naming the bundle and the id

#### Scenario: Provenance is visible

- **WHEN** a bundle is resolved from the active installation, a profile, a package directory, or a preview
- **THEN** the handle reports that origin, the version, and the package directory

## ADDED Requirements

### Requirement: Config authoring is a synchronous fluent builder without a DSH declaration

`defineConfig()` SHALL return a `ConfigBuilder` synchronously. The builder SHALL accept an optional default profile and one or more named profiles through chainable methods, and SHALL produce a validated config only at its terminal `build()`. Methods SHALL return typed builders, and authoring SHALL NOT write files or execute the config. The builder SHALL NOT accept or require a DSH value.

#### Scenario: A minimal fluent config builds

- **WHEN** an author writes `defineConfig().profile('work', (profile) => profile.bundle('@deepseek-ai/dsh-base')).build()`
- **THEN** `build()` returns a success Result carrying a config with the `work` profile

#### Scenario: Missing profiles fail at build

- **WHEN** a builder declares no profiles
- **THEN** `build()` returns a failure Result carrying the native schema error

#### Scenario: Authoring is synchronous and side-effect free

- **WHEN** a config is built
- **THEN** no profile directory is written and no installation or publication runs

### Requirement: The authoring API exposes the active DSH version

`@eedsh/config` SHALL export a synchronous `dshVersion(): string` returning the exact version of the selected DSH installation. It SHALL read the active bridge, not the plan or a bundled default, and SHALL NOT select or install DSH. Without a bridge it SHALL throw a tagged `resolution.bridge_missing` failure naming `eedsh sync`, `eedsh run`, and `--dsh`. It SHALL NOT write a DSH field or engine into the plan or generated manifest.

#### Scenario: The selected version is returned

- **WHEN** `--dsh` selects `0.2.1-rc.5` and the config calls `dshVersion()`
- **THEN** the call returns `'0.2.1-rc.5'`

#### Scenario: The config value does not change the result

- **WHEN** the selected installation is `0.2.2-alpha.2`
- **THEN** `dshVersion()` returns `'0.2.2-alpha.2'` regardless of the plan version or profile data

#### Scenario: The running version is observable but not pinnable

- **WHEN** an author uses `dshVersion()` in a layer expression or log message
- **THEN** the value is the exact running version
- **AND** no DSH value is written into the plan or generated manifest

#### Scenario: No bridge fails loudly

- **WHEN** a config calls `dshVersion()` outside eedsh, with no bridge installed
- **THEN** the call throws the tagged `resolution.bridge_missing` failure
- **AND** it never returns `undefined` or a stale version

#### Scenario: Synchronous and side-effect free

- **WHEN** an author calls `dshVersion()`
- **THEN** it returns synchronously
- **AND** it writes no files and installs nothing
