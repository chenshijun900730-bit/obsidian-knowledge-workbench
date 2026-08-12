# Real-vault read-only acceptance runbook

Preparation is not authorization. Stop before installation until the user gives fresh, explicit authorization for real-vault access and the exact action to be taken.

This procedure promises zero plugin-initiated vault-content writes and zero plugin-initiated network requests. Obsidian configuration and cache files may change. Derived index data may be written to the plugin data file.

This document defines the only supported real-vault installation path for the read-only acceptance build. It does not itself authorize installation, opening, reading, scanning, testing, or cleanup. Building, testing, or reading it grants no authority to continue past either human stop gate.

## Artifact and version preflight

1. Record only the approved commit, plugin version, and Obsidian version.
2. Prepare the acceptance artifact with `npm run build:acceptance`, the only executable preparation command in this runbook:

```bash
npm run build:acceptance
```

3. Confirm the prepared directory contains exactly `main.js`, `manifest.json`, `styles.css`, and `acceptance-build.json`.
4. Confirm the manifest name is exactly `Knowledge Workbench (Read-only acceptance)`.
5. Confirm the compiled artifact binding is exactly `knowledge-workbench@<version>:read-only-acceptance`, using the same plugin version as the manifest, and that the metadata reports content writes and network as blocked.
6. Do not combine files from normal and acceptance builds. A partial or cross-mixed set is invalid even if individual files appear correct.
7. Require the later authorization to include this emergency stop action explicitly: disable the plugin and fully quit Obsidian if any stop condition occurs. Do not start the pass without that emergency authorization.
8. Stop here unless the user has given fresh, explicit authorization for real-vault access and each later action.

## Human authorization stop: installation

Stop after preflight. Installation requires fresh, explicit human authorization naming the exact absolute vault path and the exact action `INSTALL_READ_ONLY_ACCEPTANCE_IN_THIS_VAULT`. The human must separately confirm that the plugin is disabled and Obsidian is fully quit. Never hot-overwrite a loaded plugin. Do not manually copy, mix, repair, or replace artifact files.

Require the later authorization to include this emergency stop action explicitly: disable the plugin and fully quit Obsidian if any stop condition occurs. Installation authorization covers only the transaction described below; it does not authorize opening the vault, enabling the plugin, scanning notes, restarting Obsidian, collecting evidence, or cleanup.

## Supported transactional installer

After the installation stop gate is explicitly cleared, run the single supported installer interactively:

```bash
npm run install:acceptance:real
```

Paste exactly one private JSON request into its standard input, replace only the placeholder with the authorized absolute vault path, and then send end-of-input. Do not pass the path as an argument or environment override, automate the prompt, echo the request, or save it in evidence.

```json
{
  "action": "INSTALL_READ_ONLY_ACCEPTANCE_IN_THIS_VAULT",
  "vaultPath": "<explicit authorized absolute vault path>"
}
```

The installer validates the canonical vault, configuration, plugin directory, frozen disabled-plugin state, exact artifact identity, and stopped Obsidian host before mutation. It rechecks the host immediately before publication, publishes the complete directory transactionally under one exclusive lease, and leaves uncertain objects untouched for recovery.

Its inspection is confined to the required configuration chain, `community-plugins.json`, and the exact plugin target files. It does not traverse Markdown files or attachments. When replacing a valid normal build, an optional regular singly linked `data.json` is preserved as opaque bytes without parsing. The installer does not start Obsidian, does not enable the plugin, and does not modify `community-plugins.json`.

Success is reported only with this fixed sentence:

Installed the bound read-only acceptance build into the authorized real vault; Obsidian was not started.

## Post-install human authorization stop

Stop again after the fixed success sentence. Success proves only that the bound artifact was transactionally published while the observed plugin state was disabled and Obsidian was stopped. It does not authorize starting Obsidian, opening the exact vault, enabling the plugin, scanning, restarting, collecting evidence, disabling after a pass, quitting, or cleanup. Each later action must be covered by fresh, explicit human authorization before it occurs.

Before any separately authorized vault interaction, confirm the read-only banner and artifact binding. A missing banner, binding error, partial file set, or startup-normalization error is an immediate stop.

## Allowed actions after authorization

Only actions covered by the later, explicit authorization are allowed:

- complete an index scan and record aggregate count and timing only;
- review folder-rule proposals without applying them;
- validate Today using boolean checks and aggregate counts only;
- search, focus, cancel, and inspect the map without recording note identifiers;
- open an organization suggestion preview and close or cancel it; and
- restart once and observe whether the derived index restores, only when restart is explicitly included.

## Forbidden actions

- Do not use Quick Capture or create, edit, move, rename, or delete Markdown.
- Do not confirm or execute a plan and do not use Undo.
- Do not clear or export History and do not open recovery details.
- Do not configure AI, enter an endpoint, model, secret identifier, or secret value, and do not make an AI request.
- Do not change folder rules or exclusions during the first pass.
- Do not take screenshots containing note content.
- Do not record identifiers, content, configuration, private state, or raw errors.
- Do not substitute a normal artifact or repair an acceptance artifact one file at a time.

## Stop conditions

Use only the preauthorized emergency stop action—disable the plugin and fully quit Obsidian—then stop if any of these occurs:

- any Markdown inventory or hash changes in a way attributable to the plugin;
- any write, Quick Capture, Undo, History detail, History export, History mutation, or AI control is available;
- the read-only banner is missing or artifact binding fails;
- unexpected plugin-initiated network activity appears;
- `Recovery required` appears;
- startup normalization fails; or
- an error cannot be explained without inspecting private content.

Do not switch to a normal artifact after a stop. Verifying durable `writeEnabled: false` and `aiEnabled: false` is a separately authorized diagnostic action.

## Rollback and troubleshooting

- A failed build or failed preflight is not permission to install. Use no temporary, partial, or unverified directory.
- Every installer failure is a stop. In particular, `rollback-incomplete`, `cleanup-incomplete`, `concurrent-operation`, and `host-state-unknown` require separate diagnosis or recovery authorization. The legacy description `rollback incomplete` corresponds to `rollback-incomplete`.
- `rollback-incomplete` means the installer could not prove exact restoration of the original target. Stop without retrying or deleting any retained owned object until a separate diagnostic and recovery action is authorized.
- `cleanup-incomplete` may occur after publication has already committed. Its residue may be a randomized cleanup claim or a partially removed obsolete backup. Do not assume cleanup residue is a complete or restorable backup, and do not retry or delete it without separate recovery authorization.
- If the banner, manifest identity, artifact binding, metadata, or exact four-file set is wrong, do not repair the set by replacing individual files.
- If startup normalization or binding fails after launch, disable the plugin, fully quit Obsidian, and stop without inspecting plugin data or private content.
- Sanitized error categories may be recorded; raw errors and identifiers may not.
- A normal artifact requires a separate replacement authorization after durable safe settings have been verified under separate authorization.

## Cleanup

The emergency stop authorization applies only when a stop condition occurs; it authorizes no other cleanup. Routine cleanup requires fresh, explicit authorization and is not implied by completing the pass. If that later cleanup action includes disabling and quitting, disable the plugin and fully quit Obsidian, then stop. Removing the acceptance artifact, restoring another build, inspecting or changing plugin data, and reopening Obsidian are separate actions requiring fresh authorization. A normal artifact requires a separate replacement authorization.

## Evidence allowlist

Evidence may contain only:

- approved commit;
- plugin and Obsidian versions;
- aggregate note count;
- aggregate timings;
- boolean pass or fail checks;
- sanitized error categories that contain no identifiers or content.

Evidence must never include paths, file names, note titles, note content, bodies, frontmatter, screenshots, plugin data, journal payloads, endpoints, models, secret identifiers, or secret values. Review every field against the allowlist before sharing or saving it. If a field is not listed, omit it.

This document intentionally contains no real vault location, note example, endpoint value, model value, credential, screenshot, plugin-state sample, or journal sample. Completion of preparation does not authorize or complete a real-vault acceptance pass.
