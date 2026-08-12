# Real-vault normal catalog installation runbook

This runbook is the only supported path for installing the network-capable normal build into a real Vault. Reading or testing it is not authorization. Installation, enabling, local TXT import, Baidu authorization, each cloud verification, and GitHub publication remain separate user-authorized actions.

## Installation boundary

Before installation:

1. Select the intended Vault locally without recording its name or path.
2. Disable `knowledge-workbench` in that Vault.
3. Fully quit Obsidian and verify that neither the main process nor its helpers remain.
4. Require a canonical Vault, `.obsidian`, `plugins`, and `community-plugins.json`; reject symlinks and malformed state.
5. Keep all tracked repository files and the Git index clean. Unrelated untracked files may remain only when every non-dependency bundle input is proven tracked and unchanged.

Run the installer interactively:

```bash
npm run install:normal:real
```

Paste exactly one private JSON request into standard input, replace only the placeholder locally, and send end-of-input. Never pass or echo the path as an argument, environment variable, log field, report, or chat message.

```json
{
  "action": "INSTALL_NORMAL_BUILD_IN_THIS_VAULT",
  "vaultPath": "<locally selected canonical absolute Vault path>"
}
```

The installer builds the normal bundle twice in memory under one artifact lease, requires deterministic output and frozen inputs, publishes the exact `main.js`, `manifest.json`, and `styles.css` set under one destination lease, preserves an existing regular singly linked `data.json` as opaque bytes, and leaves `community-plugins.json` unchanged. It does not read Markdown or attachments, launch Obsidian, enable the plugin, contact Baidu, import TXT, or download PDFs.

The only success sentence is:

```text
Installed the bound normal build into the authorized real vault; Obsidian was not started and the plugin remains disabled.
```

Any sanitized failure category is a stop. Do not retry or delete retained objects after `rollback-incomplete`, `cleanup-incomplete`, `concurrent-operation`, or `host-state-unknown` without a separate recovery review.

## Post-install boundary

After installation, recheck that:

- Obsidian remains stopped;
- the plugin remains absent from the enabled plugin list;
- the three destination hashes match the frozen normal artifact;
- `data.json`, if present before installation, is byte-identical;
- no transaction, backup, quarantine, or temporary residue remains; and
- no Markdown inventory metadata changed during the installer window.

Only after those checks may a separately authorized session open the selected Vault and enable the plugin. Local TXT import must use the plugin's session-only file picker and explicit preview/confirm flow. Baidu verification must use credentials and paths entered only in the plugin, with one explicitly selected category, metadata listing only, no PDF download, and no Vault-content write.
