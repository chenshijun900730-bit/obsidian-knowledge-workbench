# Real-vault read-only transactional installer design

Date: 2026-07-17

Status: approved for implementation by explicit user authorization

Implementation plan: [2026-07-17 real-vault read-only transactional installer](../plans/2026-07-17-real-vault-read-only-transactional-installer.md)

## Problem

The repository can build a bound four-file read-only acceptance artifact, but its guarded installer is intentionally fixed to a deterministic synthetic vault. The real-vault acceptance runbook forbids manual copying, hot overwrites, guessed locations, and partial replacement. A separately authorized real-vault pass therefore has no supported installation entry point.

## Goals

1. Add a distinct installer for the bound read-only acceptance artifact without weakening either existing synthetic installer.
2. Require one explicitly supplied absolute vault path and an exact conscious-action phrase over bounded private stdin. Never infer a vault from Obsidian state, recent-vault configuration, argv, or environment variables.
3. Fail closed unless the Obsidian host is observed stopped and the plugin is absent from the frozen community-plugin enablement list.
4. Read only fixed configuration and plugin paths beneath `.obsidian`; never enumerate, hash, or read vault content.
5. Publish a complete validated acceptance directory through same-device staging and directory rename. Never overwrite a live target file by file.
6. Preserve an existing regular `data.json` in the staged target while replacing only managed code artifacts.
7. Roll back to the original target on publication failure. If exact restoration cannot be proven, retain the last proven owned objects and classify `rollback-incomplete`; classify post-commit cleanup failure as `cleanup-incomplete`, without leaking paths or raw errors.
8. Keep Obsidian launch, plugin enablement, real-vault scanning, restart, and cleanup outside the installer and under separate human control.

## Non-goals

- Do not open or launch Obsidian.
- Do not enable the plugin.
- Do not scan or inspect Markdown, attachments, workspace state, note identifiers, titles, or content.
- Do not install the normal build or restore a prior build.
- Do not delete any retained recovery object after a failed or incomplete transaction.
- Do not claim that a process probe can mathematically guarantee the host will remain stopped; uncertain state is a hard failure.

## Public contract

The package entry point is `install:acceptance:real`. It accepts no command-line arguments and rejects project-specific path or mode environment overrides. It reads exactly one bounded JSON object from stdin:

```json
{
  "vaultPath": "<explicit absolute path>",
  "action": "INSTALL_READ_ONLY_ACCEPTANCE_IN_THIS_VAULT"
}
```

The CLI never echoes the input. Success output is constant. Failure output contains only one allowlisted category.

## Preflight

The installer:

1. resolves one canonical clean Git worktree and freezes the existing built acceptance artifact under its artifact lease;
2. validates the exact four-file set, manifest identity, version binding, content-write block, and network block;
3. validates the explicitly supplied vault, `.obsidian`, and plugins parent as canonical non-symlink directories;
4. observes the Obsidian host stopped before destination work and again immediately before namespace mutation;
5. freezes `community-plugins.json` and requires `knowledge-workbench` to be disabled;
6. accepts an absent target or a non-symlink target containing only managed normal/acceptance files and optional regular `data.json`; and
7. rejects reserved transaction residue or concurrent namespace changes.

## Transaction

Within an exclusive destination lock, the installer creates a mode-0700 stage on the plugins-parent device, writes the four frozen acceptance files exclusively, optionally copies the frozen plugin-local `data.json`, and revalidates every boundary. If a target exists it is renamed whole to a unique backup. The complete stage is then renamed whole to the target and revalidated by identity and bytes.

If publication or validation fails, the new target is quarantined and the backup is renamed back. The installer rebinds the canonical `.obsidian` and plugins-parent identities before every rollback namespace mutation. If it cannot prove exact restoration, it stops with `rollback-incomplete` and leaves the last proven owned objects untouched.

After the complete target has been revalidated, publication is committed before obsolete-backup cleanup begins. Cleanup first renames the proven owned tree to a randomized sibling claim, revalidates its identity and bytes, and deletes only that claimed object. Any cleanup failure is `cleanup-incomplete`; a partial residue is never described as a complete or restorable retained backup.

The supported threat boundary assumes no malicious same-UID process can continuously race the randomized private cleanup claim. Node exposes no descriptor-relative conditional unlink primitive equivalent to `unlinkat` for atomically binding the final deletion to a prior identity check. Cooperative concurrent replacement is detected and fails closed; the randomized claim, private mode-0700 transaction root, and repeated identity checks materially narrow but do not eliminate that operating-system race.

## Privacy and evidence

No successful result or sanitized failure contains a vault path, plugin path, file name from the vault, note identifier, content, configuration value, raw error, endpoint, model, or secret. Tests use only temporary synthetic filesystem fixtures and never access a real vault.
