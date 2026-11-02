## MODIFIED Requirements

### Requirement: Query results are plain, frozen plan data

Every returned value SHALL be plain JSON-compatible data that validates as an ordinary plan patch entry. Every runtime expression parsed from DSH patch data SHALL be represented by the plan's expression node shape, not by a DSH-internal marker. Returned values SHALL be frozen so a query result cannot be mutated into a different plan.

#### Scenario: Results are inert data

- **WHEN** an author passes a query result to a patch helper
- **THEN** the helper accepts it as an ordinary row entry and the plan validates

#### Scenario: Runtime expressions are plan-shaped

- **WHEN** an author queries a preset whose children contain runtime expressions and inserts that preset into a generated layer
- **THEN** the plan validates without a user-written conversion helper
- **AND** the generated patch preserves the expressions as `!!js` scalars

#### Scenario: Query data cannot be mutated

- **WHEN** an author attempts to mutate a returned query result or its nested data
- **THEN** the mutation fails or does not affect the resolved data
