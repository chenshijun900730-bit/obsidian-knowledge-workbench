# Synthetic read-only acceptance rehearsal

This runbook is limited to the fixed ignored synthetic vault at `.dev-vault/read-only-acceptance-vault`.

No real vault may be selected or opened.

No real-vault window may be active.

The product boundary is zero Markdown/content writes and zero plugin-initiated network requests. Obsidian may still write configuration, cache, and derived plugin-local data.

## Automated preparation

Preparation and installation operate only on the fixed ignored synthetic vault. The plugin remains disabled, the automation never launches Obsidian, it never uses the network or credentials, and the report remains absent while the phase is pending.

Before preparation, require a clean committed HEAD. Sync and every external mutator must be inactive. Confirm `.dev-vault/acceptance.json` remains unchanged. No path, mode, or artifact environment override is allowed.

Run the fixed preparation command:

```bash
npm run prepare:acceptance:synthetic
```

After preparation and before installation, confirm the exact preparation state, the empty community-plugin list, an absent report, and a pending phase. The plugin must remain disabled and Obsidian must not have been launched.

Run the fixed installation command only after preparation succeeds:

```bash
npm run install:acceptance:dev
```

After installation, recheck the clean committed HEAD, the exact preparation state, installation receipt, and run anchor, the empty community-plugin list, inactive Sync and external mutators, unchanged `.dev-vault/acceptance.json`, an absent report, and a pending phase. The plugin must still be disabled and Obsidian must not have been launched.

## STOP before host control

Automation stops here. It must not start or control Obsidian, enable the plugin, invoke the recorder, invent a host observation, or create a pending report.

## Human-only host isolation

Fully quit Obsidian before any host rehearsal starts.

Use only a vault-switcher-only human entry supplied by the installed Obsidian UI that does not restore or open a vault first. A bare application launch is forbidden. If that chooser-only state cannot be reached safely, do not launch or enable anything; record `hostIsolation: inconclusive`, keep both timings at `0`, and keep every unperformed host gate inconclusive.

If a non-target vault appears unexpectedly, do not enable the plugin; fully quit Obsidian immediately and record the stop condition.

In the switcher, visibly confirm the exact locally displayed canonical fixed path before enablement and after restart. Name-only, duplicate, hidden, or ambiguous selections make `hostIsolation` inconclusive. Manually enable the plugin only in that confirmed vault.

## Host rehearsal checklist

Follow this order without skipping or reinterpreting a gate:

1. The manifest display name is exactly `Knowledge Workbench (Read-only acceptance)`.
2. A persistent non-color-only read-only banner is visible.
3. Confirm startup normalization completes before any host surface appears.
4. Quick Capture is blocked.
5. The plan confirmation and execution are blocked.
6. The sample unlock is blocked.
7. The write toggle is blocked.
8. Undo is blocked.
9. Seeded History remains aggregate-only, and History clear, export, and path-bearing controls are blocked.
10. The endpoint, model, and secret inputs and AI actions are absent.
11. The non-confirming preview remains usable.
12. The scan, Today, search, map, folder-rule review, and suggestion preview remain usable.
13. The derived index restores after restart.
14. Recovery required is absent.
15. The aggregate corpus remains unchanged.
16. The static acceptance-bundle scan is primary network evidence.
17. The host observation is supplementary.
18. Any unattributable traffic is inconclusive.

Do not place any endpoint, model, secret, or credential value in the rehearsal or evidence. Do not add configuration or input instructions for those controls.

## Stop conditions and mandatory terminal stop

On both success and failure, manually disable the plugin, fully quit Obsidian, and only then record the terminal observation. If the full stop cannot be confirmed after the stop attempt, set `finalHostStopped: inconclusive`.

Content drift, an exposed capability, a binding or normalization failure, unexplained traffic, or recovery requires the same action: disable the plugin, fully quit Obsidian, and stop. Do not repair, switch builds, inspect private data, retry, or clean retained objects.

Cooperative locks have an explicit serialization limitation against hostile same-user interference. Local evidence cannot prove every Obsidian process or window is stopped or attribute all host network traffic. Uncertainty remains inconclusive.

## Exact HostObservation input

Use this safe all-unperformed form when no host gate was completed. Replace only the timestamp, Obsidian version, two measured timings, and truthful observed statuses after the terminal stop. Keep `0` for an unperformed timing and `"inconclusive"` for every unperformed status.

```json
{
  "recordedAt": "2026-07-14T12:00:00.000Z",
  "obsidianVersion": "1.12.7",
  "scanElapsedMs": 0,
  "restartRestoreElapsedMs": 0,
  "hostIsolation": "inconclusive",
  "banner": "inconclusive",
  "startupNormalization": "inconclusive",
  "quickCaptureBlocked": "inconclusive",
  "organizationWritesBlocked": "inconclusive",
  "undoBlocked": "inconclusive",
  "historySensitiveActionsBlocked": "inconclusive",
  "aiBlocked": "inconclusive",
  "readSurfaces": "inconclusive",
  "restartRestore": "inconclusive",
  "networkBoundary": "inconclusive",
  "recoveryAbsent": "inconclusive",
  "finalHostStopped": "inconclusive"
}
```

Do not add a derived field, path, free text, run ID, commit, digest, binding, category, or local-evidence claim. Never add a note identifier, content excerpt, raw log, or explanation to the input.

## Terminal evidence after the human stop

Only after the human rehearsal or stop attempt has ended, and the terminal observation is truthful and exact, run the one-time recorder:

```bash
npm run record:read-only-acceptance
```

The recorder reads exactly one JSON object from standard input. Paste only the bounded object above, then send EOF once; do not send any other text.

Then independently validate the terminal report:

```bash
npm run validate:read-only-acceptance
```

The recorder creates one terminal report and never a pending report. A passed, failed, or inconclusive result is final evidence for this run. An existing report is a hard stop; do not overwrite it, retry automatically, or clean retained objects.
