## 1. Feasibility and package skeleton

- [ ] 1.1 Build a minimal `@eedsh/ui` package with a `dsh.client` declaration, a `./client` factory wrapper, and a Host stub; load it in a real `dsh web` profile on DSH 0.2.1-rc.2 and 0.2.2-alpha.3 and record the exact commands and result. Verification: both profiles render a minimal eedsh settings section without a client-module error.
- [ ] 1.2 If 1.1 cannot reproduce the DSH client-bundle format, stop and report the concrete gap to the maintainer instead of shipping a prebuilt `lib/client.js`; otherwise add `packages/ui/package.json`, `cordis.patch.yml`, `tsdown.config.ts`, locale files, and `src/` entries. Verification: `pnpm build` emits `lib/index.js`, `lib/client.js`, and the bundle metadata.
- [ ] 1.3 Register the single `@eedsh/ui` Loader row and verify a profile that selects the bundle loads the Host plugin while a profile that does not select it registers no route and no settings section.
- [ ] 1.4 Immediately use git to commit the scaffolding excluding OpenSpec artifacts.

## 2. Status reader and status route

- [ ] 2.1 Add failing unit tests for the read-only status reader covering a published generation, a missing generation, a malformed generation record, the current-profile marker, publish mtime, and an unreadable profile directory. Verification: `pnpm vitest run packages/ui/test/status-reader.test.ts` fails for the expected reasons.
- [ ] 2.2 Implement the status reader against `package.json`, `.eedsh/plan.json`, and `.eedsh/generated/package.json`; verify 2.1 passes and the reader never reads `config.ts`.
- [ ] 2.3 Add failing tests for `GET /eedsh/status`: connection rejection is honored, the response shape is stable, invalid profiles are reported without failing the whole read, and no config or environment content appears. Verification: the route tests fail before implementation.
- [ ] 2.4 Implement the status route with `ctx.effect` ownership; verify 2.3 passes and a missing `connection` service prevents route registration.
- [ ] 2.5 Immediately use git to commit the status reader and route excluding OpenSpec artifacts.

## 3. Settings page

- [ ] 3.1 Add failing component tests for loading, empty, published, unpublished, invalid, and request-failure states, including keyboard reachability and status text not relying on color. Verification: the component suite fails before implementation.
- [ ] 3.2 Implement the `settings.section` registration, document-relative status fetch, profile cards, details, and error/empty states; verify 3.1 passes.
- [ ] 3.3 Add Chinese and English dictionaries and a language-switch test; verify every user-visible eedsh string resolves from the dictionary.
- [ ] 3.4 Immediately use git to commit the browser surface excluding OpenSpec artifacts.

## 4. Sync and doctor jobs

- [ ] 4.1 Add failing tests for the job table: one sync per profile, sync-all mutual exclusion, duplicate request rejection, bounded output, exit-code mapping, cancellation, and TTL cleanup. Verification: the job tests fail before implementation.
- [ ] 4.2 Implement the job table and the fixed-argv `eedsh` child-process runner with no shell, closed stdin, and bounded stdout/stderr; verify 4.1 passes.
- [ ] 4.3 Add failing tests for `POST /eedsh/sync` and `POST /eedsh/doctor`: safe profile names, JSON-only bodies, 64 KiB ceiling, method rejection, CLI-missing behavior, and no browser-supplied argv or paths. Verification: the route tests fail before implementation.
- [ ] 4.4 Implement the sync and doctor routes and the job read/cancel routes; verify 4.3 passes and duplicate syncs return the existing job reference.
- [ ] 4.5 Immediately use git to commit the action jobs excluding OpenSpec artifacts.

## 5. Security and policy

- [ ] 5.1 Add tests proving every `/eedsh` route calls `connection.requestRejection` and that a rejected request performs no profile read for a write action and starts no process. Verification: the security suite passes for all routes.
- [ ] 5.2 Add tests for non-loopback mutation defaults and the explicit Host opt-in; verify reads remain available while sync and doctor are refused by default.
- [ ] 5.3 Add tests that request bodies cannot add CLI flags, file paths, or config paths, and that job output never contains config contents or environment values. Verification: the constraint suite passes.
- [ ] 5.4 Immediately use git to commit the security behavior excluding OpenSpec artifacts.

## 6. Integration, acceptance, and documentation

- [ ] 6.1 Run a real `dsh web` integration: select `@eedsh/ui`, open Settings, read a published profile, run a sync against a temporary profile, and verify the page shows the new generation; repeat for a failed sync and a cancelled job. Verification: recorded commands and observed output are attached to the handoff.
- [ ] 6.2 Verify HMR-available and HMR-unavailable profiles show the correct "will apply" versus "restart required" wording, and that a headless profile without the bundle registers no UI route. Verification: manual acceptance notes cover both states.
- [ ] 6.3 Document the opt-in `config.ts` example, `configPath`/`command` row config, and the v1 limitation that only directory-backed profiles are listed. Verification: the README/UI documentation renders the example and names the limitation.
- [ ] 6.4 Run the repository checks (`pnpm verify`) and the DSH matrix for 0.2.1-rc.2 and 0.2.2-alpha.3; fix actionable failures. Verification: checks pass on the supported matrix.
- [ ] 6.5 Immediately use git to commit the documentation and final fixes excluding OpenSpec artifacts.
- [ ] 6.6 Mark the OpenSpec tasks complete and archive `add-ui-plugin` only after 6.1–6.5 pass.
