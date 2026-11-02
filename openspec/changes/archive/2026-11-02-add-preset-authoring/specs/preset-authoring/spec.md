## Purpose

Lets authors derive, edit, and select DSH agent preset definitions without manually cloning frozen query data or restating the preset registry configuration.

## ADDED Requirements

### Requirement: Preset definitions are authored with explicit identity and metadata

The authoring surface SHALL provide a preset-definition builder identified by a preset id and an optional Loader row id. It SHALL accept a display name, description, and order. When no row id is supplied, the row id SHALL be the literal prefix `preset-` followed by the preset id.

#### Scenario: Identity and metadata are explicit

- **WHEN** an author creates a preset definition with a preset id, name, description, and order
- **THEN** the resulting row carries that identity and metadata

#### Scenario: The row id defaults from the preset id

- **WHEN** an author does not supply a Loader row id
- **THEN** the definition derives a row id from the preset id

### Requirement: Preset definitions copy an installed child list

Copying from an installed preset SHALL take only its child list. It SHALL NOT copy the source preset's identity or metadata, SHALL leave the installed handle unchanged, and SHALL NOT alias its mutable data.

#### Scenario: An installed preset is adapted

- **WHEN** an author derives a new preset from an installed PTC preset, assigns new identity and metadata, and disables two of its children
- **THEN** the resulting definition has the new identity, metadata, and child list
- **AND** the installed preset remains unchanged

### Requirement: Preset definitions normalize to ordinary rows

A preset definition SHALL normalize to an ordinary inserted `@deepseek-ai/dsh-agent-preset` row. It SHALL NOT introduce a new plan concept or plan version.

#### Scenario: A preset definition becomes an ordinary row

- **WHEN** a preset definition is inserted into a generated layer
- **THEN** the plan contains an ordinary `@deepseek-ai/dsh-agent-preset` entry
- **AND** the plan validates under the existing plan schema and version

### Requirement: Preset children are edited through a nested scope

A preset definition SHALL expose a callback-scoped child editor. The callback return value SHALL be ignored, and the scope SHALL return the preset definition.

#### Scenario: Child handles stay in their scope

- **WHEN** a child edit completes and the author continues configuring the preset
- **THEN** the preset definition is the value returned by the child scope
- **AND** no implicit transition from the child handle to the parent is required

### Requirement: Preset child operations target one child or anchor

The child editor SHALL look up one child by id and SHALL support disabling, enabling, removing, and replacing that child. It SHALL also support appending one entry, prepending one entry, and inserting one entry before or after one named anchor. Each operation SHALL name one child or anchor and SHALL accept at most one entry.

#### Scenario: Two children are disabled and one is appended

- **WHEN** the child editor is called with `tool-todo`, then `tool-web`, and then an append entry
- **THEN** both named children are disabled and the entry is appended once

#### Scenario: A child is replaced in place

- **WHEN** the child editor replaces one named child with one entry
- **THEN** the entry occupies that child's position
- **AND** no other child moves

### Requirement: Preset child lookup failures are structured

A missing or ambiguous child lookup or insertion anchor SHALL fail with a tagged authoring failure that carries a stable code, the preset id, the Loader row id, and the child id. The builder SHALL NOT mutate the child list before the lookup succeeds. The failures SHALL be preserved through config evaluation and reported with their identities rather than as generic import failures.

#### Scenario: A missing child is reported

- **WHEN** an author asks the child editor for a child that the preset does not declare
- **THEN** the operation fails with a structured child-not-found failure naming the preset, row, and child
- **AND** no child is modified

#### Scenario: Duplicate child ids are ambiguous

- **WHEN** the child list declares more than one child with the requested id
- **THEN** the operation fails with a structured ambiguous-child failure
- **AND** no child is modified

### Requirement: Preset selection accepts preset references

A layer SHALL provide a preset-selection operation that accepts a selected preset reference and an options object with a required deployment-default preset reference. Each reference SHALL be an installed preset or an authored preset definition and SHALL resolve to that preset's id.

#### Scenario: Selected preset differs from the deployment default

- **WHEN** the author selects the adapted preset with the existing standard preset as the deployment default
- **THEN** the layer writes `default: standard` and `selectedDefault: ptc-fresh`

#### Scenario: Selected preset is also the deployment default

- **WHEN** the author passes the adapted preset as both the selected preset and the deployment default
- **THEN** both registry fields name the adapted preset

### Requirement: Preset selection writes the complete registry config

The selection operation SHALL write the complete preset-registry config with the supplied deployment default and the selected preset as the selected default. It SHALL NOT infer the deployment default from the registry row and SHALL NOT merge a partial registry config.

#### Scenario: Missing registry row

- **WHEN** the selected preset targets a profile whose composition has no preset-registry row
- **THEN** preflight reports the unmatched registry target under its existing warning, attribution, and strict behavior
