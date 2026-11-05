## Why

eedsh's REPL already evaluates the typed config, queries installed bundles, prints plan diffs and preflight warnings, and publishes profiles. It is built for a human at a terminal: one prompt line at a time, `util.inspect` output, and no request/response contract. An agent can already drive it through the terminal tools, but it has to parse prompts and human text, cannot get structured plan and diff facts, and has no per-agent session or approval boundary around publication.

A first-class machine interface plus an optional DSH tool can make configuration work reliable and auditable. The repository aligns changes through OpenSpec (`spec-driven-atomic-commit`), so this change records the proposal, behavior contract, design, and implementation checklist for that interface and the optional tool/mode. An action-card creation flow is a follow-up change.

## What Changes

- Add `--json` to `eedsh repl --eval`: one JSON envelope per evaluation with JSON-safe values, a rendered fallback, structured plan diffs and warnings, profile facts, and stable error codes. Existing text output is unchanged when `--json` is absent.
- Add `--eval-file` (and stdin input) so callers can pass multi-line TypeScript without shell quoting.
- Add `--stdio`: a persistent NDJSON session (`hello`, `eval`, `profile`, `reload`, `sync`, `close`) with request ids, one response per request, auto-reload on config change, and stdout reserved for protocol frames.
- Add an optional `@eedsh/repl` DSH bundle: a Host session service, `eedsh_eval` / `eedsh_inspect` / `eedsh_sync` tools, and an `eedsh` agent preset (a mode in the Web preset selector) plus the `eedsh-authoring` skill. The bundle is opt-in; standard and PTC profiles do not gain the tools.
- Run evaluation in a child process confined by the session's sandbox policy. Publication is an explicit, one-shot approval with a Host-owned `eedsh sync` process; the model cannot supply the config path, DSH path, command, or argv.
- No changes to the existing REPL text behavior, plan format, materializer, generated profile, or DSH core.
- Out of scope: the action-card creation flow (`create_eedsh_profile`), Host-applied `config.ts` staging, and any automatic publication. Those are a follow-up change.

## Capabilities

### New Capabilities

- `repl-machine-protocol`: machine-readable evaluation of the config REPL in one-shot and persistent NDJSON forms.
- `harness-repl-tool`: the optional DSH bundle, tools, agent mode, and the sandbox/approval boundary around them.

### Modified Capabilities

(none)

## Impact

- `packages/cli`: new `repl` flags, protocol loop, value serializer, structured diff projection, error envelopes, and tests. The existing text prompt, `--eval`, `--sync`, `--config`, `--profile`, and `--dsh` behavior stays intact.
- New `packages/repl`: DSH bundle patch, Host session service, tool definitions, skill, and preset. It is not part of `@eedsh/runtime` and is not installed by default.
- New optional dependency surface for DSH `^0.2.1-rc.2`: tools, sandbox policy, sandbox service, approval. The agent-preset “mode” is verified against `0.2.2-alpha.3`; the exact minimum version is an open decision.
- README/package documentation, protocol tests, and the DSH version matrix. No profile format, plan schema, or generation format changes.
