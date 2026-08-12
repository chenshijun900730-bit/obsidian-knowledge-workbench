import type { QuickCapturePort, VaultWritePort } from "../core/ports";

const contentWriteBlocked = (): Error => new Error(
  "Read-only acceptance mode blocks vault content writes",
);

export const READ_ONLY_VAULT_WRITE_PORT: VaultWritePort = Object.freeze({
  renameFile: async () => { throw contentWriteBlocked(); },
  setOwnedField: async () => { throw contentWriteBlocked(); },
});

export const READ_ONLY_QUICK_CAPTURE_PORT: QuickCapturePort = Object.freeze({
  capture: async () => null,
});
