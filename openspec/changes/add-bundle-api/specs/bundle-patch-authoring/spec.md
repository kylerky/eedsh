## Purpose

Lets a plugin author declare its bundle's Cordis Loader patch in TypeScript at build time and emit the `cordis.patch.yml` file the published plugin ships.

## ADDED Requirements

### Requirement: Patch authoring is build-time and independent of a DSH installation

The package SHALL expose a synchronous definition API that builds one ordered Loader patch list from `insert`, `override`, `disable`, `enable`, and `raw` operations, with `group` for a group entry and `js` for a `!!js` expression. Defining a patch SHALL NOT require a running DSH, a profile, a DSH installation, network access, or the eedsh capability bridge. The definition SHALL normalize to plain JSON-compatible data.

#### Scenario: Define rows, a group, and an expression without DSH

- **WHEN** a caller defines inserted rows, a group with ordered children, a targeted override, and a `js` expression outside eedsh and without a DSH installation
- **THEN** the definition completes synchronously and exposes the patch list and expression as plain data

#### Scenario: Profile-only concepts are not available

- **WHEN** a caller uses the public package to author a bundle patch
- **THEN** the API does not expose profile selection, the generated-layer marker, package/source declarations, bundle queries, or preset selection

### Requirement: Emission produces DSH-native YAML

The emitter SHALL serialize a patch definition as a top-level YAML array of Loader patch entries. It SHALL represent `js` expressions as DSH's `!!js` scalars, preserve authored order, emit groups and `isolate` maps, and contain no `$eedsh` expression nodes. Emission SHALL be deterministic: repeated emission of the same definition SHALL produce identical bytes, with no timestamp, absolute path, or generator version.

#### Scenario: Expressions and groups round-trip through the DSH dialect

- **WHEN** a definition contains a group with `isolate` and children whose `disabled` values are `js` expressions
- **THEN** the emitted YAML contains `!!js` scalars and the group/isolate structure
- **AND** parsing the emitted YAML with DSH's entry-list schema yields the original patch data

#### Scenario: Repeated emission is byte-identical

- **WHEN** the same definition is emitted twice
- **THEN** both outputs are byte-identical and end with one newline

### Requirement: Generated artifacts can be written and checked

The package SHALL provide a write operation that writes exactly the emitted bytes to a package-relative path and a check operation that compares the definition with an existing file without modifying it. A mismatch SHALL report a failure that names the file and shows actionable difference information. A check SHALL succeed only when the existing file equals the emitted bytes.

#### Scenario: Write then check succeeds

- **WHEN** a definition is written to `cordis.patch.yml` and then checked
- **THEN** the check succeeds and reports no drift

#### Scenario: A stale file fails the check

- **WHEN** the definition changes but `cordis.patch.yml` is not regenerated
- **THEN** the check fails with a nonzero result and does not modify the file

### Requirement: Invalid patch data fails before writing

The package SHALL reject invalid patch shapes with an actionable diagnostic: a non-array `insert`, an inserted entry without a `name` or `group: true`, a targeted patch without a non-empty `id`, a non-string `name`, a `group`/`disabled` value that is neither boolean nor null, or a malformed expression node. It SHALL NOT attempt composition or semantic validation that requires a bundle stack or a running DSH.

#### Scenario: Invalid insert is rejected

- **WHEN** a definition inserts an entry with neither a `name` nor `group: true`
- **THEN** definition or emission fails with a diagnostic naming the invalid entry
- **AND** no file is written

#### Scenario: Composition is not guessed

- **WHEN** a definition targets an id that no selected bundle provides
- **THEN** authoring and emission still succeed because target resolution belongs to DSH composition
