## Context

See `proposal.md` for motivation. The design is constrained by the existing eedsh and DSH boundaries:

- `eedsh repl` evaluates the config project's `config.ts` under its own tsconfig and `@eedsh/config`, keeps bindings across entries, exposes typed view objects, prints plan diffs and preflight warnings, and publishes through the existing materializer. It is a `node:readline` loop over a hidden `node:repl` evaluator started with `tsx/patch-repl`; output is `util.inspect` text.
- The REPL process installs a TypeScript loader, mutates `EEDSH_DSH_ANCHOR` / `EEDSH_CONFIG_DIR`, and owns a hidden REPL context. Running it inside the DSH Host would couple two long-lived runtimes and two module copies.
- eedsh accepts one XDG config (`$XDG_CONFIG_HOME/eedsh/config.ts`, with `--config` as an explicit override) and publishes to `$DSH_HOME/profiles/<name>`. Both locations are outside an agent's workspace.
- DSH `^0.2.1-rc.2` provides `defineTool` / `ctx.tools.register`, `ctx.sandboxPolicy.resolve`, `ctx.sandbox.confine`, and `ctx.approval.request`. Agent presets (“modes”) are verified in the installed `0.2.2-alpha.3` packages; the `0.2.1-rc.2` web profile does not contain the preset packages, so the exact floor is a decision, not an assumption.
- `profileContext.installAnchor` is the running DSH application's `package.json`; `--dsh` accepts a package directory or its `package.json`.
- DSH's action-card creation flow is a separate, experimental feature; it is not needed for this change.

## Goals / Non-Goals

**Goals:**

- A machine contract for evaluating the config and reading plan, diff, warning, and error facts without parsing human text.
- A persistent session that keeps bindings and a selected profile across tool calls, with one isolated session per agent.
- An optional DSH bundle that turns that contract into `eedsh_eval`, `eedsh_inspect`, and `eedsh_sync`, plus an `eedsh` mode that owns the tools and the authoring skill.
- Evaluation confined by the session's sandbox; publication behind an explicit one-shot approval; paths and command fixed by the Host.
- Ship the CLI machine interface first (it is useful with only a skill) and the DSH bundle second, without changing existing REPL text behavior.

**Non-Goals:**

- Editing `config.ts` through a creation card, Host-applied staging, or automatic profile creation. That is a follow-up change.
- Changing the plan format, plan schema, generation record, materializer, profile layout, or existing `--eval` text behavior.
- Running model-written TypeScript inside the DSH Host process.
- Making the tools part of the standard or PTC presets, or installing the bundle by default.
- Adding a network listener; `--stdio` uses stdin/stdout only.
- Providing a mid-evaluation cancel protocol in v1; a timeout closes and restarts the child.

## Decisions

### 1. A child-process protocol, not an in-host library

The tool talks to `eedsh repl` through a child process. This keeps the TypeScript loader, hidden REPL, environment changes, and eedsh package resolution out of the DSH Host, and it gives the Host a process boundary for timeout, crash recovery, and sandbox confinement. The eedsh CLI remains the only writer of profile artifacts.

**Alternatives:** import `ReplSession` into the Host plugin (lifecycle and environment coupling, two `@eedsh/config` copies, no clean sandbox); wrap only the terminal tools (text parsing, no structured facts, unreliable completion detection); reimplement plan/doctor in the plugin (a second source of truth).

### 2. Two machine surfaces: one-shot and persistent

`--json` extends `--eval` with a single-envelope response. `--eval-file` (and stdin) removes shell quoting for multi-line code. `--stdio` provides a persistent NDJSON session for cross-call bindings. The one-shot form is enough for a skill-driven P0 and for Host-side validation; the persistent form is the basis of the tools.

The protocol is line-delimited JSON: a `hello` first, then one request and one response per line, with request ids and a serialized queue. stdout carries only protocol frames; session text goes to stderr or response fields. A caller that does not understand the protocol version fails explicitly.

**Alternatives:** a single long-lived `--eval` process per call (loses bindings, pays reload cost); a Unix socket or HTTP server (more surface and lifecycle, not needed for a local tool); parsing the human prompt (fragile and token-heavy).

### 3. Structure values and failures instead of reusing `inspect`

The envelope returns plain JSON values directly, documented view projections where they exist, structured tags for errors and Effect results, and a bounded rendered fallback for everything else. It also returns a structured diff list (operation, kind, subject) and warnings. eedsh's existing error codes are preserved; a new `repl.eval_failed` code is added for raw evaluation exceptions. Success and failure are both one document; failure exits non-zero.

**Why:** the model can reason about `{ op, kind, id }` and a code, but not about colorized or multi-line `util.inspect` text. Bounding the fallback prevents a large object from consuming the tool result budget.

### 4. An optional bundle with an agent mode, not a global tool

`@eedsh/repl` is a separate optional package. Its Host row owns the session service; a `/tools` row registers the three tools only inside the `eedsh` preset; the preset also mounts the filesystem skill provider and the `eedsh-authoring` skill. Selecting the bundle adds the mode; not selecting it registers nothing. Standard and PTC do not gain the tools.

**Alternatives:** add the tools to `dsh-base` (every session gets code execution and publication capability); add only a skill that shells out to `eedsh repl --json` (useful as P0, but no persistent state, structured output, or approval semantics); put the service in `@eedsh/runtime` (every eedsh profile, including headless, would carry it).

The Host row and the tool row are separate because a Host service registration is process-wide, while tool visibility belongs to the preset's scope. This follows the existing `dsh-tool-cordis` split between its Host provider and the preset tools.

### 5. Three tools with a small surface

- `eedsh_eval({ code, profile? })` evaluates one code unit in the persistent session. It switches the profile when requested and returns the envelope.
- `eedsh_inspect({ what, profile? })` performs curated read-only operations (profiles, one profile, plan, rows, entries, packages, published, doctor) without accepting arbitrary code.
- `eedsh_sync({ profile?, justification? })` publishes through the approved Host path.

The tool descriptions carry the minimum binding list and two examples; the skill carries the full authoring workflow. A single generic `repl` tool with an operation enum would save schema lines but lose the clear distinction between read-only inspection and publication.

### 6. Evaluation is confined by the session sandbox

The Host resolves the session's policy with `ctx.sandboxPolicy.resolve({ session })` and obtains the confined execution form with `ctx.sandbox.confine(argv, policy, signal)`. It spawns the eedsh child with that form. Under `read-only`, evaluation can read the config and inspect plans but cannot write files. Under `workspace-write`, writes stay in the session workspace; the config directory and `$DSH_HOME/profiles` remain outside. Writing the config file is not a new exception: the user must widen the policy or add the directory to `additionalWritableRoots`, exactly as for other confined tools.

**Consequence:** in a typical `workspace-write` session the agent can inspect and evaluate but cannot edit `config.ts` through the filesystem tools. That is intentional for this change; the creation-card follow-up exists because the Host, not the Creator, should apply config changes.

`eedsh_eval` is still arbitrary code execution, not a read-only query. File effects are sandboxed; network and subprocesses are not restricted by the file sandbox, the same as the bash tool. The tool description and skill must say this.

### 7. Publication is approval-gated and Host-owned

`eedsh_sync` asks `ctx.approval.request({ agent, toolName, callId, reason, signal })` with a fixed reason naming the profile and its target directory. On approval the Host runs `eedsh sync --profile <name> --config <fixed> --dsh <fixed>` with `shell: false` and no model-supplied arguments. On denial, cancellation, or a missing approval service it returns a structured failure and starts nothing.

The REPL child cannot perform this write itself under `workspace-write`: its sync would be confined to the workspace and fail on `$DSH_HOME/profiles`. A separate Host process is also easier to audit and avoids making the confined child privileged. The cost is a second config evaluation during sync; if the caller wants to publish exactly the evaluated plan, it must sync immediately after the last edit.

**Alternatives:** let the child sync after a tool-level approval (the child was already spawned with a fixed policy; changing it would require a second child); run sync without approval (unacceptable); add the profile directory to `additionalWritableRoots` globally (too broad).

### 8. Paths, command, and DSH selection are Host facts

`configPath`, `dshPath`, and `command` come from the plugin's Host configuration or from `profileContext.installAnchor`. The model has no path, command, or flag fields. The config path defaults to eedsh's XDG path when omitted; a non-default config needs explicit Host configuration. The profile name is validated against eedsh's safe-name rule before it becomes an argument. Protocol version and DSH version are checked at handshake; a mismatch fails with an upgrade message instead of parsing older text.

### 9. One session per agent, serialized and disposable

The Host lazily starts one child per agent and serializes requests for that agent. Sessions are not shared across agents. A timeout, crash, `exit`, or plugin/agent disposal closes the child; the next call starts a new one and tells the model that prior state was lost. No request is replayed automatically, because a replay could publish twice. Approval is never cached across calls.

Tool results are bounded (for example 64 KiB) with an explicit truncation marker. The integration does not dump `process.env` by default; a model that explicitly evaluates `process.env` can still read it, and the documentation states that `eedsh_eval` is equivalent to the bash tool's code-execution authority inside the same sandbox.

## Architecture

```
Agent (eedsh mode)
  eedsh_eval / eedsh_inspect / eedsh_sync
        │  typed tool call
        ▼
@eedsh/repl Host service
  ├─ per-agent session table, serialized queue
  ├─ ctx.sandboxPolicy.resolve + ctx.sandbox.confine
  ├─ ctx.approval.request (sync only)
  └─ NDJSON client ──► eedsh repl --stdio (child)
                         eval / profile / reload / sync / close
        │
        └─ sync path: approved `eedsh sync` child (fixed argv, no shell)
```

### One-shot envelope

```jsonc
{
  "protocol": 1,
  "ok": true,
  "value": { "kind": "json", "data": 4 },
  "rendered": "4",
  "profile": "web",
  "profiles": ["web", "work"],
  "planDigest": "sha256-…",
  "diff": [],
  "warnings": [],
  "traces": [{ "bundle": "@deepseek-ai/dsh-base", "origin": "active", "version": "0.2.2-alpha.3" }],
  "error": null
}
```

A failure uses the same envelope with `ok: false`, `value: null`, and an `error` carrying `code`, `message`, and optional `lines`. `planDigest` is a digest of canonical plan JSON, not a new persisted format.

### NDJSON session

```
eedsh repl --config <path> [--profile <name>] --stdio
```

```jsonc
// server → client
{"type":"hello","protocol":1,"eedsh":"…","dsh":"0.2.2-alpha.3","config":"/home/me/.config/eedsh/config.ts","profiles":["web","work"],"selected":"web"}

// client → server
{"id":1,"op":"eval","code":"selectedProfile.published().exists"}
{"id":2,"op":"profile","name":"work"}
{"id":3,"op":"reload"}
{"id":4,"op":"sync"}
{"id":5,"op":"close"}

// server → client
{"id":1,"ok":true,"value":{"kind":"json","data":true}}
{"id":4,"ok":true,"changed":true,"generationId":"…","restartRequired":false,"warnings":[]}
```

Before each evaluation the session checks the config mtime, re-evaluates when it changed, and includes the diff. A failed reload keeps the previous evaluation and returns the failure. The protocol has no prompt, colors, or readline output; logs go to stderr.

### Package shape

```
packages/repl/
  package.json          main; exports "." and "./tools"; dsh.bundle.patch
  cordis.patch.yml      Host row + eedsh agent-preset row
  src/index.ts          Host session service
  src/protocol.ts       wire types shared or validated against the CLI
  src/tools.ts          the three tool definitions
  skills/eedsh-authoring/SKILL.md
  test/...
```

The bundle patch inserts the Host row and the preset. The preset is a complete child plugin list copied from the standard preset's common rows (persona, instructions, time context, skill registry, executor, compaction, filesystem/bash/todo tools), with the eedsh tool row added. The skill directory is mounted through the filesystem skill provider using the same `!!js` package-relative expression the shipped `cordis` preset uses.

### Opt-in configuration

```ts
import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .profile('work', (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-base')
      .bundle('@deepseek-ai/dsh-web-app')
      .package('@eedsh/repl', '^0.1.0') // version follows the eedsh release
      .bundle('@eedsh/repl')
      .generated()
      .layer((layer) => {
        layer.override('eedsh-repl', {
          configPath: '/home/me/.config/eedsh/config.ts',
          command: 'eedsh',
        })
      })
  })
  .build()
```

`configPath` is needed only for a non-default XDG config; `command` names the executable when it is not on `PATH`. Both are Host configuration and cannot be supplied by the model or the browser. The bundle is not selected by `@eedsh/runtime`.

### Minimal workflow

```
User: add tool-web to the work profile.

Agent:
  1. eedsh_inspect { what: "plan", profile: "work" }
     → bundles, layers, rows, preflight warnings
  2. read/edit config.ts with the filesystem tools, within the granted write scope
  3. eedsh_eval { code: "...", profile: "work" }
     → auto reload, structured diff, warnings
  4. eedsh_sync { profile: "work", justification: "add tool-web" }
     → approval; then generation / restartRequired
```

The value is not “the agent can run eedsh”; it is steps 1 and 3 returning structured facts and step 4 having an explicit approval boundary.

## Risks / Trade-offs

- **Arbitrary code execution** → The child runs under the session sandbox, and publication needs approval. The file sandbox does not restrict network or subprocesses; the tool and skill say so. Do not describe `eedsh_eval` as read-only.
- **Protocol drift between CLI and plugin** → Version the handshake and fail explicitly on an unknown version. Keep the wire types in one place or validate them with a shared test. Do not parse human text as a fallback.
- **Config and profile directories are outside the workspace** → Evaluation can read them; writing `config.ts` needs a user grant; publication is Host-owned. This is why the creation-card follow-up cannot be folded into this change.
- **A second evaluation during sync** → Sync re-evaluates the current file, not the exact in-memory value. Document the “sync immediately after edit” rule and return the generation outcome. It must not claim to publish a stale snapshot.
- **Long-lived children** → One per agent, lazy, serialized, idle-closed, crash-reset. No replay of a potentially publishing request.
- **Output size** → Bound values and rendered text, mark truncation, and keep large plan documents out of the tool result. A 64 KiB cap is a starting point, not a contract for the model's context.
- **DSH version floor** → The tools/sandbox/approval path is verified in the `0.2.1-rc.2` web profile; the agent-preset mode is verified in `0.2.2-alpha.3`. The implementation must confirm the lowest supported preset release and either raise the documented floor or mount the tools only at profile level on older releases.
- **Model does not use the tool well** → The skill carries the authoring procedure and examples; the tool descriptions stay short. The P0 `--json` + skill path tests whether the concept is useful before the bundle exists.
- **Windows and path handling** → Spawn with argv (no shell), use absolute paths, and test the protocol on Windows in the DSH matrix.

## Follow-up: creation card (out of scope)

The original discussion also asked whether this can become a new creation mode. That is a separate change. Its key constraints are already clear and should shape the follow-up:

- `config.ts` and published profiles are outside the workspace. The Host, not the Creator, must apply a staged config after validation; a Creator with `danger-full-access` could otherwise bypass the boundary, so the write scope is a prerequisite, not a tool-visibility detail.
- The eedsh config is one TypeScript module. A first version should only add a new profile and reject an existing name; it should compare every other profile's canonical plan against a snapshot and reject unrelated changes.
- The Host should snapshot the config, run the Creator in a workspace staging directory, validate the staged file next to the real config (where imports and `@eedsh/config` resolve), show the diff and plan summary, re-check the config hash, apply atomically with a backup, sync the new profile, and record an undo receipt.
- Undo restoring `config.ts` does not remove a published profile directory; the existing eedsh semantic is that removing a profile from config does not delete its profile directory. The card must state that limitation.
- The card kind depends on `@deepseek-ai/dsh-action-cards` and the Creator inherits the parent's sandbox mode. Both need explicit handling before the follow-up can be called ready.

## Migration Plan

1. Ship the CLI machine surfaces first (`--json`, `--eval-file`, `--stdio`) behind new flags; existing `--eval` text output is unchanged. This can be used with a skill before any DSH bundle exists.
2. Add `@eedsh/repl` as an optional package and bundle. No existing profile changes until the user adds `.package()` and `.bundle()`.
3. Land the Host service and read-only tools first; review the sandbox boundary and the protocol before exposing `eedsh_sync`.
4. Add `eedsh_sync` behind the approval service; verify denial, cancellation, missing approval service, held lock, and restart-required paths.
5. Keep the change active until every task is complete; archive only after the DSH matrix and a real session accept the workflow.

Rollback is removing the bundle selection and dependency; the CLI flags remain compatible and no profile data is migrated.

## Open Questions

- Whether P0 (`--json` + skill) should ship as its own change before the bundle, or both phases land in one change. The tasks are grouped so P0 can be reviewed independently.
- Whether the first creation-mode target is a new profile composition, a plugin bundle declared through eedsh, or an agent preset. This change only builds the tool/mode enabler; the follow-up must choose.
- The lowest DSH release that ships the agent-preset mechanism; the current evidence is the installed `0.2.2-alpha.3` packages, while `0.2.1-rc.2` provides tools, sandbox, and approval.
- The final package name (`@eedsh/repl` versus `@eedsh/agent` or `@eedsh/harness`) and the mode's display name.
- Whether `eedsh_eval` should be available in a read-only preset at all, or only in the `eedsh` mode with an explicit sandbox policy.
