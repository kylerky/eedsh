## Why

The profile `package.json` is a foreign JSON document that eedsh rewrites, but four CLI modules parse and interpret it independently. `readJsonFile` returns an untyped `Record<string, unknown>`, so roughly a dozen helpers exist only to navigate it, and the same document is read twice per `eedsh doctor` run. Worse, a manifest that exists but is not a JSON object is indistinguishable from a missing one: `eedsh sync` treats it as a first run and silently replaces it, while `eedsh doctor` reports it as unreadable. The landed `effect-native-refactor` gave the repository one failure vocabulary and one effect boundary; the profile manifest is the remaining foreign document that never received a classified reader, even though the generation record beside it already has one.

## What Changes

- Add one classified reader for `<profile>/package.json` that returns `missing`, `invalid` (with a stable reason and detail), or `valid`. `invalid` covers both unparseable JSON and a document that is not a JSON object; file-system failures stay a distinct failure.
- Replace `Option<Record<string, unknown>>` at every consumer with a typed view that computes the managed bundle list, the three install-relevant dependency sections, and the conflict sections in one pass, and names every entry it cannot interpret. The original document is preserved for rewriting, including fields eedsh does not manage and their order.
- **Behavior change:** an invalid manifest blocks materialization with a diagnostic naming the path and reason instead of being treated as a first run and overwritten. `missing` still means a first run.
- **Behavior change:** an unreadable dependency entry no longer makes its whole section unreconcilable. Readable managed entries are still removed, unreadable entries are preserved verbatim, and each unreadable entry is reported.
- **Behavior change:** a `dependencies` section that is not a JSON object is rebuilt from the managed specifications and the replacement is reported, because the profile must declare what eedsh manages.
- Fold doctor's two parses into one read shared by its checks, and have the REPL surface the same classification instead of rendering an unreadable manifest as absent.
- Delete the helpers that exist only to navigate the untyped record.

## Capabilities

### New Capabilities

- `profile-manifest-reading`: how the profile manifest is read, classified, and interpreted once, what is preserved for rewriting, that invalid documents are reported rather than replaced, and that reading performs no writes.

### Modified Capabilities

- `generated-profile-materialization`: the "Profile dependencies are reconciled" requirement gains entry-level handling for unreadable dependency entries and the rule for a `dependencies` section that is not a JSON object.

## Impact

- **`@eedsh/cli`**: a new `materialize/profile-manifest.ts`; changes to `materialize/manifest.ts`, `materialize/program.ts`, `materialize/publish.ts`, `doctor.ts`, `repl/views.ts`, `repl/session.ts`, `internal/schema-readers.ts`, `internal/effect/errors.ts`, and `command/report.ts`.
- **Dependencies**: none added; the reader uses the pinned Effect 4 schemas and the existing `FileSystem` service.
- **Tests**: profile reader and reconciliation suites, doctor and REPL views, publish fixtures, and the platform-parse-error contract test change or move.
- **Users**: `eedsh sync` refuses a malformed profile manifest instead of replacing it, and `eedsh doctor` reports unreadable dependency entries by package name rather than by section.
