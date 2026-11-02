## ADDED Requirements

### Requirement: Empty generated layers are warned

Preflight SHALL emit one warning for each generated layer that contains no patches. The warning SHALL identify the layer and SHALL NOT change the plan, composition, or generated layer set. It SHALL use the existing raw, attributed, and strict preflight behavior.

#### Scenario: Raw empty-layer warning

- **WHEN** `eedsh sync` composes a generated layer with no patches and `--explain` is absent
- **THEN** the CLI reports a raw warning naming the empty layer
- **AND** publication proceeds in non-strict mode with exit status 0

#### Scenario: Attributed empty-layer warning

- **WHEN** `eedsh sync --explain` composes a generated layer with no patches
- **THEN** the reported warning identifies the source layer in the attributed form

#### Scenario: Strict empty-layer warning

- **WHEN** `eedsh sync --strict` encounters an empty generated layer
- **THEN** the command exits with the failure status 1
- **AND** the diagnostics are raw messages without layer prefixes unless `--explain` is also present
- **AND** no generation is committed
