## Why

eedsh has no visual surface in the DeepSeek Harness (DSH) Web GUI. Users must leave the GUI, find the config project, run `eedsh sync`, and read profile and doctor state in a terminal. The repository requires changes to be aligned through OpenSpec (`spec-driven-atomic-commit`), so this change defines the proposal, behavior contract, design, and implementation checklist for an optional DSH plugin UI.

## What Changes

- Add an optional `@eedsh/ui` DSH bundle. One Cordis Loader row provides both a Host plugin and a browser half (`dsh.client` + `./client`).
- Add a **Settings → eedsh** section that shows the current and published profiles, generation facts, bundle and layer counts, HMR availability, and doctor output.
- Add authenticated same-origin Host routes for status, sync, doctor, job polling, and cancellation. The Host reads published profile artifacts; it never evaluates `config.ts`.
- Run sync and doctor through the existing `eedsh` CLI with fixed argv in a child process. The CLI remains the only writer of profile artifacts; no materializer or doctor logic is duplicated.
- Put every route behind DSH's `connection.requestRejection`; make mutations POST-only, validate profile names, bound request bodies and job output, and take command/argv/path values only from Host configuration.
- Keep the UI opt-in: a profile that does not select the bundle loads no UI code and keeps its current behavior.
- Out of scope: editing `config.ts` in the browser, adding new eedsh CLI commands, a sidebar page, and any change to DSH core.

## Capabilities

### New Capabilities
- `ui-plugin`: optional DSH Web UI for eedsh profile status, sync, and doctor.

### Modified Capabilities
(none)

## Impact

- New `packages/ui` package and build output (`lib/index.js`, `lib/client.js`, `cordis.patch.yml`, locale files).
- New optional package and bundle selection in a user `config.ts`; the plan format, generated layer, CLI command surface, and DSH profile layout do not change.
- New Host routes under `/eedsh/`; the composition must provide `webServer` and `connection`.
- New frontend dependencies for the plugin package only; DSH core and `@eedsh/runtime` are unchanged.
- Verification targets DSH `^0.2.1-rc.2` and `0.2.2-alpha.3`; the external client-bundle build format is the main feasibility risk.
