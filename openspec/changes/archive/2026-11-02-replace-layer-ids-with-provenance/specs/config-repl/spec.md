## MODIFIED Requirements

### Requirement: Saving the config re-evaluates it and reports the change
The session SHALL watch the config directory, debounce bursts of edits, and after each save re-evaluate the config. On success it SHALL print a diff against the previous evaluation covering profile, generated patch group, patch, and package changes, plus a composition summary with the composed row count and preflight warnings. A generated patch group SHALL be identified in the diff by its patch content rather than its position, so that inserting or removing a group does not report every later group as changed. On failure it SHALL print the failure and keep the previous evaluation available.

#### Scenario: A patch is added
- **WHEN** the author saves a config that adds an inserted row
- **THEN** the session prints the added row and the new composed row count

#### Scenario: A group is inserted in the middle
- **WHEN** the author saves a config that inserts a generated patch group between two existing groups
- **THEN** the diff reports the new group and does not report the later groups as changed

#### Scenario: An invalid save
- **WHEN** the author saves a config whose plan fails validation
- **THEN** the session prints the attributed failure and keeps the previous plan

#### Scenario: Errors do not end the session
- **WHEN** an evaluation fails
- **THEN** the prompt remains usable and `.reload` retries the evaluation

## ADDED Requirements

### Requirement: The composition view reports where a row came from
The composition summary SHALL report, for every composed row, the source that last touched it: the authoring site of the generated patch that wrote the row when that site is known, otherwise the generated patch group by position, or the contributing bundle by name.

#### Scenario: A generated row reports its site
- **WHEN** a composed row was inserted by a generated patch whose authoring site is known
- **THEN** the composition view reports the row together with that file and line

#### Scenario: A bundle row reports its bundle
- **WHEN** a composed row comes from a bundle layer
- **THEN** the composition view reports the row together with the bundle name
