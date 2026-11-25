# config-evaluation-inputs Specification

## Purpose
Defines how a config module receives the values its invocation resolved — the selected DSH version and the bundle contents it queries — as plain inputs, so authoring performs no IO and nothing reaches for ambient state.

## Requirements

### Requirement: A config module exports a factory that receives its invocation inputs

A config module SHALL export a synchronous function as its default export. The function SHALL receive one input object carrying the exact version of the DSH installation selected for the invocation and the absolute directory of the config file, and SHALL return a `ConfigBuilder`. The function SHALL be invoked once per evaluation, before any profile is selected, and SHALL be given no means to perform IO: no path, handle, or capability passed to it SHALL read the filesystem, spawn a process, or reach an ambient installation store.

#### Scenario: The selected version is available as a plain value

- **WHEN** `--dsh` selects `0.2.1-rc.5` and the config factory reads its input version
- **THEN** the factory receives `0.2.1-rc.5` as a string
- **AND** the factory MAY branch on that value while composing the profile

#### Scenario: Evaluation needs no ambient state

- **WHEN** a config factory and every builder call it makes run in a process where no installation state was installed
- **THEN** evaluation completes and produces a builder
- **AND** no call reads an installation, a package manifest, or a patch file

#### Scenario: Invocation inputs never enter the plan

- **WHEN** a built config is published from an evaluation that read the version and the config directory
- **THEN** neither value appears in the plan, the generated manifest, or the generation record

### Requirement: Authoring records queries instead of resolving them

A query handle SHALL record what it asks for — the bundle name, the optional resolution root, and the requested row or preset — as a descriptor. No authoring call SHALL read the filesystem, spawn a process, or otherwise perform IO while the module is evaluated. A descriptor SHALL be usable as a patch target and as an insertion input, and SHALL become resolved data only in the invocation's build phase.

#### Scenario: Module evaluation performs no IO

- **WHEN** a config declares bundle selections, patch layers, insertions, and query-backed patch targets
- **THEN** module evaluation completes without reading any package manifest or patch file

#### Scenario: A descriptor carries its facts

- **WHEN** an author roots a handle and requests a row by id
- **THEN** the descriptor records the bundle name, the root, and the row id
- **AND** the descriptor resolves deterministically once the invocation resolution supplies that bundle

#### Scenario: A descriptor is usable before it is resolved

- **WHEN** a descriptor for an existing row is passed to `disable` or `insert`
- **THEN** the build phase produces the same plan patch it would produce from the resolved row

### Requirement: The invocation resolves every recorded query before building

The command SHALL resolve every query descriptor recorded by the evaluated builder in one phase that runs after evaluation and before building. A bundle and root pair SHALL be resolved at most once per invocation. A resolution failure SHALL stop the invocation before any profile is built or published, and SHALL carry the bundle name, the root, and the underlying cause.

#### Scenario: A resolution failure stops publication

- **WHEN** a recorded query names a bundle the selected installation does not ship
- **THEN** the invocation fails with a structured resolution failure naming the bundle and the installation
- **AND** no profile is built, no generation is committed, and the message is printed once

#### Scenario: A repeated query resolves once

- **WHEN** two layers query the same bundle from the same root
- **THEN** the invocation reads that bundle once
- **AND** both queries observe identical rows

#### Scenario: Resolution runs before build

- **WHEN** a recorded query cannot be resolved
- **THEN** the build phase does not run
- **AND** no partial config is produced

### Requirement: The build phase is pure and total over the invocation resolution

The terminal `build()` SHALL normalize typed authoring objects and recorded descriptors to plain config data, resolve them from the invocation resolution, validate the config and every profile, and return `Result<EedshConfig, Schema.SchemaError>`. The invocation SHALL resolve every descriptor the builder reports, so `build()` SHALL receive a total resolution. `build()` SHALL perform no IO, SHALL NOT throw on invalid input, and SHALL NOT return a partial config in place of a failure. An absent resolution entry SHALL be an impossible state and SHALL be reported as a defect rather than as a user-facing failure.

#### Scenario: Build performs no IO

- **WHEN** `build()` runs with a complete invocation resolution
- **THEN** it reads no file, spawns no process, and requires no running runtime

#### Scenario: A missing resolution is a defect

- **WHEN** `build()` receives a descriptor the resolution does not contain
- **THEN** it reports an impossible state as a defect naming the descriptor
- **AND** it returns no config value and no schema failure

#### Scenario: Invalid input returns the native schema failure

- **WHEN** the normalized config violates the config or plan contract
- **THEN** `build()` returns a failure Result carrying the native schema error
- **AND** no exception is thrown
