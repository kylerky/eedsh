## Purpose

Makes the build-time bundle-patch API available as a versioned, standalone npm package that plugin repositories can install without depending on the eedsh CLI, runtime, or private workspace packages.

## ADDED Requirements

### Requirement: The package is installable and self-contained

The package SHALL be published as `@eedsh/bundle` under an available npm scope, as an ESM package with TypeScript declarations and a root export. It SHALL declare `engines.node` compatible with the plugin ecosystem, at least `>=22.19`. Its `files` SHALL include its built JavaScript, declarations, README, and license.

#### Scenario: Packed contents are complete

- **WHEN** the package is packed with `pnpm pack`
- **THEN** the tarball contains the built entry, declarations, README, and license
- **AND** the tarball does not contain tests, sources, or private eedsh packages

### Requirement: Public dependencies are isolated

The package's runtime dependencies SHALL be limited to `js-yaml`, or none. Its public declarations SHALL NOT reference `@deepseek-ai/*`, private `@eedsh/*` packages, Effect, or undeclared types.

#### Scenario: A plugin repository installs and typechecks the package

- **WHEN** a clean project with no DSH or eedsh installation installs the packed package and imports `defineBundlePatch`, `group`, `js`, and `emitBundlePatch`
- **THEN** the import resolves, the public declarations typecheck, and emission runs without a DSH installation

#### Scenario: The dependency graph names only allowed packages

- **WHEN** the packed package's manifest and declaration files are inspected
- **THEN** no DSH or private eedsh package appears in runtime dependencies or declaration imports
- **AND** only `js-yaml` is declared for runtime use

### Requirement: The package is not a runtime bundle

The package manifest SHALL NOT declare `dsh.bundle` or otherwise advertise itself as a DSH bundle. Installing it SHALL NOT cause a profile to select a bundle or load a Cordis plugin.

#### Scenario: A profile dependency on the package adds no Loader row

- **WHEN** a profile declares the package as an ordinary dependency
- **THEN** no bundle patch is loaded and no row is added by the package

### Requirement: The release is versioned and independent of the eedsh CLI

The package SHALL be released from this repository under its own semantic version, beginning at `0.1.0`, with `publishConfig.access` set to `public` and a license compatible with redistribution. The emitted YAML SHALL NOT embed the package version, so upgrading the package SHALL NOT change output unless the definition or emitter behavior changes.

#### Scenario: A patch release leaves an unchanged definition byte-identical

- **WHEN** a definition is emitted before and after a package patch release
- **THEN** the two outputs are byte-identical

#### Scenario: Publishing requires an authenticated scope owner

- **WHEN** the release job cannot authenticate to npm as an owner of the package scope
- **THEN** the release stops before publishing and names the missing credential or scope
