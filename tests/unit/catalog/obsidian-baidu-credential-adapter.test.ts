import { describe, expect, it } from "vitest";
import { ObsidianBaiduCredentialAdapter } from "../../../src/adapters/obsidian-baidu-credential-adapter";
import type { BaiduCredentialBundle } from "../../../src/catalog/catalog-types";

class MemorySecretStorage {
  readonly writes: Array<Readonly<{ id: string; value: string }>> = [];
  value: string | null = null;
  getError: Error | null = null;
  setError: Error | null = null;

  getSecret(_id: string): string | null {
    if (this.getError !== null) throw this.getError;
    return this.value;
  }

  setSecret(id: string, value: string): void {
    if (this.setError !== null) throw this.setError;
    this.writes.push({ id, value });
    this.value = value;
  }
}

const applicationSecret = "app-secret-sentinel";
const accessToken = "access-token-sentinel";
const refreshToken = "refresh-token-sentinel";

const bundle = (): BaiduCredentialBundle => ({
  schemaVersion: 1,
  profileId: "primary",
  appKey: "app-key-sentinel",
  secretKey: applicationSecret,
  accessToken,
  refreshToken,
  accessTokenExpiresAt: 123_456,
});

describe("ObsidianBaiduCredentialAdapter", () => {
  it("returns null for missing or revoked credentials", async () => {
    const storage = new MemorySecretStorage();
    const adapter = new ObsidianBaiduCredentialAdapter(storage);

    await expect(adapter.read()).resolves.toBeNull();
    await adapter.replace(bundle());
    await adapter.revoke();

    expect(storage.writes.at(-1)).toEqual({
      id: "knowledge-workbench-baidu-credentials",
      value: "",
    });
    await expect(adapter.read()).resolves.toBeNull();
  });

  it("replaces the complete versioned bundle and returns detached values", async () => {
    const storage = new MemorySecretStorage();
    const adapter = new ObsidianBaiduCredentialAdapter(storage);
    const input = bundle();

    await adapter.replace(input);
    const first = await adapter.read();
    expect(first).toEqual(input);
    expect(first).not.toBe(input);

    const rotated: BaiduCredentialBundle = {
      ...input,
      accessToken: "rotated-access-token",
      refreshToken: "rotated-refresh-token",
      accessTokenExpiresAt: 654_321,
    };
    await adapter.replace(rotated);
    expect(await adapter.read()).toEqual(rotated);
    expect(storage.writes).toHaveLength(2);
  });

  it("commits a conditional replacement only while its generation is current", async () => {
    const storage = new MemorySecretStorage();
    const adapter = new ObsidianBaiduCredentialAdapter(storage);

    await expect(adapter.replaceIfCurrent(bundle(), () => false)).resolves.toBe(false);
    expect(storage.writes).toEqual([]);

    await expect(adapter.replaceIfCurrent(bundle(), () => true)).resolves.toBe(true);
    expect(storage.writes).toHaveLength(1);
    await expect(adapter.read()).resolves.toEqual(bundle());
  });

  it.each([
    "not-json",
    "{}",
    JSON.stringify({ ...bundle(), schemaVersion: 2 }),
    JSON.stringify({ ...bundle(), unexpected: true }),
    JSON.stringify({ ...bundle(), accessTokenExpiresAt: Number.NaN }),
  ])("rejects malformed stored data without exposing it: %s", async (stored) => {
    const storage = new MemorySecretStorage();
    storage.value = stored;
    const adapter = new ObsidianBaiduCredentialAdapter(storage);

    const error = await adapter.read().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "credentials-unavailable" });
    expect(JSON.stringify(error)).not.toContain(stored);
  });

  it("sanitizes storage failures and never serializes credential values", async () => {
    const storage = new MemorySecretStorage();
    storage.getError = new Error(`${applicationSecret}:${accessToken}`);
    const adapter = new ObsidianBaiduCredentialAdapter(storage);

    const readError = await adapter.read().catch((caught: unknown) => caught);
    expect(readError).toMatchObject({ code: "credentials-unavailable" });
    expect(JSON.stringify(readError)).not.toContain(applicationSecret);
    expect(JSON.stringify(readError)).not.toContain(accessToken);

    storage.getError = null;
    storage.setError = new Error(refreshToken);
    const writeError = await adapter.replace(bundle()).catch((caught: unknown) => caught);
    expect(writeError).toMatchObject({ code: "credentials-unavailable" });
    expect(JSON.stringify(writeError)).not.toContain(refreshToken);
    expect(JSON.stringify(adapter)).not.toContain(applicationSecret);
  });

  it("rejects invalid replacement values before writing", async () => {
    const storage = new MemorySecretStorage();
    const adapter = new ObsidianBaiduCredentialAdapter(storage);
    const invalid = { ...bundle(), secretKey: "contains whitespace" };

    await expect(adapter.replace(invalid)).rejects.toMatchObject({
      code: "credentials-unavailable",
    });
    expect(storage.writes).toEqual([]);
  });
});
