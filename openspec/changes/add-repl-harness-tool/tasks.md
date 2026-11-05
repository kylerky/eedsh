## 1. Machine-readable one-shot evaluation (P0)

- [ ] 1.1 Add failing tests for a `--json` envelope on `eedsh repl --eval`: success, thrown expression, invalid config, missing authoring package, and the unchanged text output without `--json`. Verification: the new tests fail for the expected reasons.
- [ ] 1.2 Implement the envelope and the JSON-safe value projection: plain JSON, documented view projections, tagged errors and Effect results, and a bounded rendered fallback with cycle and depth protection. Verification: value-shape tests pass and no case hangs or throws from serialization.
- [ ] 1.3 Add a structured diff projection for plan changes and return composition and preflight warnings in the envelope; preserve the existing text diff for the interactive prompt. Verification: a changed config produces the expected operation/kind/subject entries.
- [ ] 1.4 Add `--eval-file` and stdin input with the same envelope, including missing, empty, and unreadable input failures. Verification: a multi-line file evaluates as one unit without shell quoting.
- [ ] 1.5 Add stable error codes for config, authoring-package, evaluation, DSH-discovery, and publication failures; keep existing tagged failures rather than collapsing them into one message. Verification: each failure class is distinguishable from the code alone.
- [ ] 1.6 Immediately use git to commit the one-shot machine surface excluding OpenSpec artifacts; verify the commit does not include `openspec/`.

## 2. Persistent NDJSON session (P1)

- [ ] 2.1 Add failing framing tests for `--stdio`: hello first, request ids, one response per request, serialized execution, unknown protocol, unknown operation, close, and EOF. Verification: the framing suite fails before implementation.
- [ ] 2.2 Implement the NDJSON loop over the existing session, with stdout reserved for protocol frames and session text directed to stderr or response fields; disable prompt, color, and readline output. Verification: a strict line parser sees only JSON frames.
- [ ] 2.3 Implement `eval`, `profile`, `reload`, `sync`, and `close` operations. Verify profile switching persists, `reload` reports a diff, and `sync` reports the generation, warnings, and restart requirement.
- [ ] 2.4 Implement the config-mtime check before evaluation: a changed file re-evaluates and returns the diff; a failed reload keeps the previous evaluation and returns the failure. Verification: both paths are covered by tests.
- [ ] 2.5 Add a read-only test that walks evaluation, views, diffs, and reload and asserts no file under the DSH profile directory changes; verify only an explicit `sync` writes.
- [ ] 2.6 Immediately use git to commit the persistent session excluding OpenSpec artifacts; verify the commit does not include `openspec/`.

## 3. Optional DSH bundle and Host session service

- [ ] 3.1 Add `packages/repl` with a `dsh.bundle.patch`, a Host row, a `/tools` export, and a package-relative skill directory; verify an unselected profile registers nothing and a selected profile loads the Host row without unresolved services.
- [ ] 3.2 Implement the per-agent session service: lazy child start, serialized calls, idle close, disposal, crash and timeout reset, and explicit “state was reset” reporting. Verification: two agents do not share bindings or profile selection.
- [ ] 3.3 Implement the protocol client: handshake and version check, request ids, bounded responses, and an explicit incompatibility error. Verification: a CLI without `--stdio` fails with an upgrade message and no text-parsing fallback.
- [ ] 3.4 Confine the child with `ctx.sandboxPolicy.resolve` and `ctx.sandbox.confine`; verify read-only evaluation can read the config while a write is denied, and workspace-write stays inside the workspace. Verification: the confinement tests pass on the supported platform matrix.
- [ ] 3.5 Add tests that the model cannot supply `configPath`, `dshPath`, `command`, or extra argv, and that a profile name is validated before it becomes an argument. Verification: extra fields are ignored and invalid names start no process.
- [ ] 3.6 Immediately use git to commit the Host service excluding OpenSpec artifacts; verify the commit does not include `openspec/`.

## 4. Tools, mode, and authoring skill

- [ ] 4.1 Add failing tests for the three tool schemas and canonical outputs: `eedsh_eval` (code, optional profile), `eedsh_inspect` (curated operations), and `eedsh_sync` (profile, justification). Verification: invalid arguments become normal tool errors and do not end the turn.
- [ ] 4.2 Implement the tools over the Host service. Verify evaluation failures are structured, inspect never accepts arbitrary code, and profile switching persists only for the calling agent.
- [ ] 4.3 Implement `eedsh_sync` with `ctx.approval.request`, a fixed reason naming the profile and target directory, fixed argv, no shell, and no cached approval. Verification: allowed publishes; denied, cancelled, unavailable, and held-lock paths start no privileged work and return structured failures.
- [ ] 4.4 Add the `eedsh` agent preset and the `eedsh-authoring` skill; copy the standard preset's common rows and add the eedsh tool row. Verify the mode is selectable, the tools appear only there, and standard/PTC do not see them.
- [ ] 4.5 Bound tool results, mark truncation, and ensure the tool output does not dump environment values, package-manager tokens, or registry credentials. Verification: an oversized value is truncated and a secret-shaped value is not included unless explicitly evaluated.
- [ ] 4.6 Document the opt-in `config.ts` example, `configPath`/`command`/`dshPath` row config, the sandbox and approval behavior, and the fact that `eedsh_eval` is code execution equivalent to bash inside the same sandbox. Verification: the README example renders and the limitations are named.
- [ ] 4.7 Immediately use git to commit the tools, mode, and documentation excluding OpenSpec artifacts; verify the commit does not include `openspec/`.

## 5. End-to-end acceptance and archive

- [ ] 5.1 Run the real workflow in an `eedsh` mode session: inspect a profile, edit the config within a granted write scope, evaluate the diff, approve a sync, and observe the new generation. Verification: recorded commands and observed output are attached to the handoff.
- [ ] 5.2 Verify two agents in the same process have isolated sessions, that a crashed child resets without replay, and that a denied sync leaves the previous generation published.
- [ ] 5.3 Run `pnpm verify` and the DSH matrix (`0.2.1-rc.2`, `0.2.1-rc.5`, `0.2.2-alpha.2`) and fix actionable failures; record the lowest release that supports the mode.
- [ ] 5.4 Reconcile the documented DSH floor: if agent presets are unavailable in a supported release, either raise the floor or provide the tools at profile level there; do not leave the mode claim untested.
- [ ] 5.5 Immediately use git to commit the acceptance notes and final documentation fixes excluding OpenSpec artifacts; verify the commit does not include `openspec/`.
- [ ] 5.6 Mark the OpenSpec tasks complete and archive `add-repl-harness-tool` only after 5.1–5.5 pass and the follow-up creation-card decision is recorded.
