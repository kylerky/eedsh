# authoring-objects Specification

## Purpose
Gives eedsh authors a synchronous, typed object model for composing profiles and querying bundle contents, while keeping the persisted plan strict plain JSON.

## Requirements

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

### Requirement: Profiles are composed through typed methods

A `ProfileBuilder` SHALL add ordered bundles, at most one generated marker, ordered patch layers, and profile-local package specifications through methods. It SHALL preserve authored order, and a layer callback SHALL receive a layer builder scoped to that layer.

#### Scenario: Bundles and the generated marker keep their order

- **WHEN** a profile adds bundle A, the generated marker, and bundle B
- **THEN** the built plan records A, generated, and B in that order

#### Scenario: A layer is scoped to its callback

- **WHEN** a profile declares two layers, each with patches
- **THEN** each layer keeps only the patches added in its own callback and the layers retain authored order

#### Scenario: Package specifications are profile-local

- **WHEN** a profile declares a package with a specifier
- **THEN** that package appears in the built profile's package map and not in another profile's map

### Requirement: Layers expose patch operations as methods

A `LayerBuilder` SHALL provide insert, disable, enable, override, and raw patch operations. An override SHALL replace the target's whole config; disable and enable SHALL target an existing row; raw SHALL preserve a Loader patch entry. Targets SHALL be accepted as row ids or as resolved row or preset handles.

#### Scenario: Insert and disable in one layer

- **WHEN** a layer inserts a row and disables an existing row id
- **THEN** the built layer carries an insert patch followed by a disable patch

#### Scenario: Override replaces the whole config

- **WHEN** a layer overrides an existing row with a config object
- **THEN** the patch carries the supplied object and no fields from the earlier config are merged in

#### Scenario: A resolved preset can be the target

- **WHEN** a preset handle is passed to disable
- **THEN** the patch targets the preset's Loader row id

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

### Requirement: Typed authoring objects normalize to plain plan data

Typed authoring and query objects SHALL NOT be plan data. `defineConfig().build()` SHALL normalize them to plain JSON-compatible values before validating the plan and SHALL reject a value that cannot be normalized. The `@eedsh/plan` schema SHALL continue to reject functions, class instances, and other non-JSON values. A `.toJSON()` result SHALL be valid as an ordinary plan value.

#### Scenario: Methods never reach the plan

- **WHEN** a built config contains a bundle, layer, row, or preset authored as a typed object
- **THEN** the validated plan contains only plain JSON data

#### Scenario: Method-bearing data is rejected outside the builder

- **WHEN** a config value contains an enumerable function or a class instance in a plan position
- **THEN** plan validation rejects it and names the location

#### Scenario: Round-trip is stable

- **WHEN** a validated plan is serialized and parsed as JSON
- **THEN** it remains valid and semantically identical

### Requirement: The typed surface replaces the free-function API

The public authoring surface SHALL be methods on typed objects. The legacy free helpers for querying rows, presets, and one row, and for defining profiles, layers, and patches, SHALL NOT be exported. `bundle(name)` SHALL remain the factory for a bundle selection and query handle.

#### Scenario: Legacy query helpers are absent

- **WHEN** a consumer imports the package's public entry points
- **THEN** the standalone row, preset, query, profile, and patch helpers are not exported

#### Scenario: The typed factory remains

- **WHEN** an author needs a bundle selection or query
- **THEN** `bundle(name)` returns the typed handle used by both

### Requirement: Query failures are structured

A failed resolution, missing row, missing preset, or invalid root SHALL be reported as a tagged failure carrying a stable code, the bundle name where applicable, and a human-readable message. A query SHALL NOT return partial or empty data in place of a failure.

#### Scenario: Failure carries the facts

- **WHEN** a bundle cannot be resolved
- **THEN** the failure exposes a code, the bundle name, and a message naming the cause

#### Scenario: No silent fallback

- **WHEN** a bundle's patch files cannot be parsed
- **THEN** the query fails rather than returning the rows it managed to read
