# Hard Read-Only Acceptance Mode Design

Date: 2026-07-14
Status: approved; implementation covered by the linked plan

Implementation plan: [2026-07-14 read-only acceptance mode](../plans/2026-07-14-read-only-acceptance-mode.md)

## 1. Problem

The automated release gates and dedicated synthetic-vault acceptance pass, but the MVP release boundary still requires a separately authorized read-only acceptance pass on the real vault.

The normal runtime is not a sufficiently strong boundary for that pass:

- `writeEnabled: false` locks organization plans, but Quick Capture can still create a Markdown note after its own confirmation.
- A same-schema historical `data.json` can retain `writeEnabled: true` or `aiEnabled: true`.
- The main Workbench does not make the current write boundary continuously visible.
- A procedural checklist alone cannot prevent an accidental content-write or network action.

The next deliverable is therefore a separately built acceptance artifact whose content-write and network prohibitions are compiled into the bundle. This task prepares and tests that artifact only. It does not install into, read, scan, or otherwise access a real vault.

## 2. Goals

1. Produce a visibly distinct `read-only-acceptance` build without changing the behavior of the normal build.
2. Make Markdown creation, mutation, movement, rename, deletion, frontmatter mutation, transaction execution, and Undo unavailable in that build.
3. Make all AI and network actions unavailable, regardless of persisted settings or credentials.
4. Keep local indexing, Today, the focused map, folder-rule review, suggestion inspection, and non-executing previews available.
5. Allow only disclosed plugin-local state writes needed for the derived index and ordinary local UI state.
6. Provide a separate real-vault read-only runbook with explicit authorization, allowed-action, forbidden-action, stop, cleanup, and evidence rules.

## 3. Non-goals

- Do not install or enable any build in a real vault in this task.
- Do not add an installer that accepts arbitrary or real-vault paths.
- Do not enable normal writes, execute a single-file plan, test real-vault Undo, or raise operation limits.
- Do not use a real endpoint, credential, model, or network request.
- Do not redesign projection or introduce a Worker/chunked projector.
- Do not promise zero filesystem writes: Obsidian and the plugin may update their own configuration, cache, and plugin `data.json`; the promise is zero vault-content writes and zero plugin-initiated network requests.

## 4. Approaches considered

### A. Compile-time acceptance build — selected

Build a separate artifact with an immutable runtime safety policy. The UI cannot turn the policy off, and persisted settings cannot override it. This gives the strongest boundary and makes the artifact visibly distinguishable from the normal build.

### B. Persisted runtime setting

Add an `acceptanceReadOnly` setting to `data.json`. This is easier to toggle but weaker: stale or malformed state, a failed save, or an accidental setting change can undermine the acceptance boundary.

### C. Runbook only

Document which buttons not to press. This is useful as a second layer but insufficient because Quick Capture is a separate content-write path and historical settings may already enable writes or AI.

## 5. Build and artifact boundary

Add a dedicated `npm run build:acceptance` path. It must:

- compile a literal `read-only-acceptance` policy into `main.js`;
- write only to `dist/read-only-acceptance/`;
- leave the normal root `main.js`, `manifest.json`, and `styles.css` untouched;
- copy `styles.css`;
- emit a manifest with ID `knowledge-workbench`, exact display name `Knowledge Workbench (Read-only acceptance)`, and the normal manifest version; the normal artifact keeps exact display name `Knowledge Workbench`;
- emit `acceptance-build.json` with exactly this object and no additional keys:

```json
{
  "schemaVersion": 1,
  "pluginVersion": "0.1.0",
  "buildMode": "read-only-acceptance",
  "artifactBinding": "knowledge-workbench@0.1.0:read-only-acceptance",
  "contentWrites": "blocked",
  "network": "blocked"
}
```

- derive `pluginVersion` and the version segment of `artifactBinding` from the validated manifest while requiring the remaining key names, types, and values exactly as shown;
- never include a vault path, note identifier, endpoint, model, secret, plugin state, or journal data.

The builder writes into a unique temporary sibling directory, validates the exact four-file set and all bindings, then publishes the completed directory with a same-filesystem rename plus rollback-safe replacement. A failed build never leaves a partially updated acceptance directory.

The acceptance entry point embeds the expected mode, plugin version, manifest display name, and `artifactBinding`. Before registering any view, command, ribbon action, setting tab, listener, or adapter with mutation/network capability, it must verify:

- the host manifest ID, version, and acceptance display name exactly match the compiled expectations;
- `acceptance-build.json` exists, has the exact six-key schema above, and matches the compiled binding;
- all four artifact files are present in the plugin directory.

The normal entry point similarly requires the normal manifest display name and refuses to load if an acceptance metadata file is present. Pairing a normal main with an acceptance manifest/metadata, or an acceptance main with a normal manifest/missing metadata, therefore fails closed before host registration. CSS is not an enforcement boundary, but it remains part of the indivisible four-file artifact set.

The generated `dist/` directory remains ignored. The normal `npm run build` compiles the normal policy explicitly rather than relying on an undefined global.

The existing guarded development installer remains restricted to generated `.dev-vault` locations. This task does not extend it to a real vault.

## 6. Runtime safety policy

Introduce one immutable policy value with two modes:

- `normal`
- `read-only-acceptance`

The policy is created at the composition root and injected into the narrow components that need it. Components must not infer acceptance mode from persisted settings, paths, vault names, or UI state.

In `read-only-acceptance` mode the following invariants hold:

1. The organization-write predicate always returns false, even if stored acknowledgement and write settings are true.
2. `TransactionService` receives a rejecting `VaultWritePort`, so every execution attempt fails before reaching the Obsidian adapter. `UndoService` remains read-only and is not asked to preview from the acceptance controller.
3. The acceptance entry point does not import or construct the normal Quick Capture adapter; it injects a rejecting port, so `vault.create()` is unreachable from the Workbench.
4. Change-plan previews remain available, but the modal is preview-only and cannot return a confirmed plan.
5. History may show aggregate status, but Undo, clear, export, and recovery-detail controls are disabled. Controller-level requests for those actions fail closed. This prevents content writes, plugin-state mutation, and path-bearing exports.
6. The Settings surface replaces the sample-review action and write toggle with a fixed acceptance-mode notice. Controller calls to `previewSampleChange()` and `setWriteEnabled()` fail closed without opening a presenter or saving settings.
7. The acceptance entry point does not import or construct the normal AI dependency graph: no `requestUrl`, `SecretComponent`, `ObsidianAiClient`, secret getter, client factory, or network-capable callback is supplied. AI settings are replaced with a fixed unavailable notice, AI action controls are disabled or omitted, and every public AI controller method checks the compiled policy before inspecting inputs or dependencies. Calls to `saveAiSettings()` and `setSessionAiSecret()` fail closed without saving or retaining input.
8. Before registering any host surface, startup durably persists `writeEnabled: false` and `aiEnabled: false` while retaining the remaining decoded settings, then reloads and verifies both values are false. Effective settings are also fail-closed in memory, so historical true values never grant capability to the acceptance bundle. If save or verification fails, plugin load stops before registering views, commands, ribbons, settings, listeners, or normal-mode adapters. After successful normalization, blocked settings/controller methods perform no further policy-related store writes. A later normal build therefore starts with writes and AI disabled.
9. A visible, non-color-only banner identifies the acceptance build and states that Quick Capture, organization writes, Undo, and AI are unavailable.

Defense in depth is required. UI disabling is explanatory, not the enforcement boundary; controller and injected-port checks remain authoritative.

## 7. Allowed behavior

The acceptance build may:

- read Markdown through the existing indexing and metadata paths;
- persist the derived index, scan checkpoints, pins, dismissals, last-opened state, and other plugin-local data in the plugin's own `data.json`;
- display and filter Today items;
- search, focus, cancel, and inspect the knowledge map;
- display folder-rule proposals and existing exclusions;
- display organization suggestions and open a preview that cannot be confirmed;
- display aggregate operation-history status without exporting paths or journal data;
- restart and restore the local derived index.

Folder-rule and exclusion changes affect plugin-local classification/index scope rather than Markdown. The real-vault runbook nevertheless treats the first pass as review-only and does not instruct the operator to apply them.

## 8. User interface

### Workbench banner

Place a persistent banner immediately after the tab row:

> Read-only acceptance build. Quick Capture, organization writes, Undo, and AI are unavailable. Derived index data is stored in the plugin's data file.

The banner uses text plus shape/border, has an accessible status description, and does not depend on color.

### Disabled actions

- Replace the Quick Capture action with a disabled control whose accessible description says that it creates Markdown and is unavailable in acceptance mode.
- Keep plan-preview entry points, but label the modal as preview-only and remove/disable confirmation.
- Keep aggregate History status visible, but disable Undo, clear, export, and recovery-detail controls with an explicit acceptance-mode reason.
- Replace sample review, write toggle, AI inputs, and session-secret input with fixed unavailable notices. Programmatic controller calls to these settings actions remain blocked even if the UI is bypassed.
- Omit or disable AI actions in the Workbench.
- Do not expose a control that exits acceptance mode. Returning to normal mode requires installing a separately built normal artifact after a later explicit decision.

## 9. Real-vault read-only runbook

Create `docs/runbooks/real-vault-read-only-acceptance.md`. It must state that preparation is not authorization and must stop before installation until the user explicitly authorizes real-vault access.

The runbook contains:

1. Artifact and version preflight.
2. Confirmation that the read-only banner is present.
3. Disclosure that plugin-local `data.json` and Obsidian configuration may change.
4. Allowed actions: scan, rule review, Today validation, map validation, suggestion preview followed by cancel, restart/recovery observation.
5. Forbidden actions: Quick Capture, plan confirmation, transaction execution, Undo, History clear/export/recovery detail, AI configuration or requests, Markdown edits, screenshots containing note content, and evidence containing identifiers.
6. Stop conditions: any Markdown inventory/hash change attributable to the plugin, any available write/Undo/AI control, missing banner, unexpected network activity, `Recovery required`, or an unexplained error.
7. Cleanup: disable the plugin and stop; removal or replacement remains a separately authorized action.
8. Evidence allowlist: commit, plugin/Obsidian versions, aggregate note count, aggregate timings, boolean pass/fail checks, and sanitized error categories only.

Installation/replacement safety is explicit: first disable the existing plugin and fully quit Obsidian; never hot-overwrite a loaded plugin; replace the complete four-file acceptance artifact as one prepared set; restart; make the banner and build binding the first checks before any vault interaction. A missing banner, binding failure, partial file set, or startup-normalization error is an immediate stop. Replacing the acceptance artifact with a normal build is forbidden until durable `writeEnabled: false` and `aiEnabled: false` have been verified and a separate replacement action has been authorized.

The runbook never records or embeds an absolute vault path, file name, note title, body, frontmatter, screenshot, endpoint, model, secret identifier/value, plugin data, or journal payload.

## 10. Error handling

- If the acceptance policy cannot be constructed, the acceptance build must fail closed before registering content-write or AI actions.
- If fail-closed persisted-setting normalization cannot be saved and reloaded as false, abort plugin load before host registration. The runbook treats this as a stop condition and forbids switching to a normal artifact until durable safe state is confirmed.
- Attempts to invoke a blocked controller action return a fixed safe status and do not call the underlying port.
- Preview-only modal errors close or remain non-confirmable; they never fall back to a normal confirmation path.
- The normal build must not inherit acceptance-only disabled states.

## 11. Testing

Follow RED/GREEN TDD with focused tests before implementation.

### Policy and composition tests

- Normal and acceptance policies are immutable and exact.
- Acceptance composition supplies rejecting content-write and Quick Capture ports.
- Historical `writeEnabled: true` and `aiEnabled: true` do not grant effective capability.
- After startup normalization, acceptance-mode calls to `previewSampleChange`, `setWriteEnabled`, `saveAiSettings`, and `setSessionAiSecret` make zero presenter, persistence, secret-read, and secret-retention calls.
- A startup-normalization save or reload failure registers zero views, commands, ribbon actions, settings, listeners, write adapters, Quick Capture adapters, or AI dependencies.
- The acceptance composition contains no `requestUrl`, `SecretComponent`, `ObsidianAiClient`, secret getter, client factory, or network callback; public AI methods remain fail-closed under direct programmatic invocation.
- The normal policy preserves existing behavior.

### Controller and UI tests

- Quick Capture, transaction execution, Undo, and AI client construction are unreachable in acceptance mode.
- Plan previews open in preview-only mode and cannot produce a confirmed plan.
- The acceptance banner is present, accessible, and textually explicit.
- Disabled actions retain visible labels and keyboard-safe semantics.
- Normal-mode controls and existing behavior remain unchanged.

### Packaging tests

- `build:acceptance` writes the exact four allowlisted files into its isolated directory.
- Its manifest is visibly marked while retaining the correct plugin ID.
- Its metadata equals the exact six-key JSON object in section 5 and contains no environment or vault data.
- Clean and failed builds prove that temporary staging cannot publish a partial directory.
- Cross-mix tests pair normal main/manifest with acceptance metadata and acceptance main with normal/missing metadata; every mixed set fails before host registration.
- A bundle dependency scan confirms the acceptance entry point does not retain executable Quick Capture, secret-storage, AI-client, or `requestUrl` composition.
- The normal build output is not overwritten.

Run the focused policy, UI, packaging, and offline suites, followed by `npm run verify`. Do not run the 75 MiB performance suite because this design does not change indexing, projection, map scoring, or persistence performance.

## 12. Acceptance criteria

This task is complete when:

- the separate artifact builds deterministically;
- all focused tests and `npm run verify` pass;
- an automated synthetic test proves zero calls to Markdown write ports, Quick Capture creation, Undo execution, secret reads, AI client creation, and network requests in acceptance mode;
- the banner and preview-only states are visible in the synthetic UI;
- the real-vault runbook passes privacy and placeholder scans;
- Graphify is refreshed after documentation changes;
- no real vault, endpoint, credential, publication, or deployment is used.

Completion of this task prepares the real-vault acceptance pass. It does not authorize or complete that pass.
