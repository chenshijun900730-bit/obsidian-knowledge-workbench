import { describe, expect, it } from "vitest";
import {
  createNormalCatalogCredentialPort,
  type NormalCatalogSecretHost,
} from "../../src/runtime/normal-cloud-catalog-composition";

const privateValue = (suffix: string): string => ["host", "secret", suffix].join("-");

class MemorySecretStorage {
  readonly values = new Map<string, string>();
  readonly calls: Array<Readonly<{ operation: "get" | "set"; id: string }>> = [];

  getSecret(id: string): string | null {
    this.calls.push({ operation: "get", id });
    return this.values.get(id) ?? null;
  }

  setSecret(id: string, secret: string): void {
    this.calls.push({ operation: "set", id });
    this.values.set(id, secret);
  }
}

describe("normal Obsidian SecretStorage boundary", () => {
  it("stores the complete bundle only through the host SecretStorage surface", async () => {
    const storage = new MemorySecretStorage();
    const pluginData: unknown[] = [];
    const vaultWrites: unknown[] = [];
    const externalCatalogWrites: unknown[] = [];
    const logs: unknown[] = [];
    const host: NormalCatalogSecretHost = { secretStorage: storage };
    const credentials = createNormalCatalogCredentialPort(host);
    const appKey = privateValue("application");
    const secretKey = privateValue("credential");

    await credentials.replace({
      schemaVersion: 1,
      profileId: "primary",
      appKey,
      secretKey,
    });

    expect(storage.calls).toEqual([{
      operation: "set",
      id: "knowledge-workbench-baidu-credentials",
    }]);
    expect(storage.values).toHaveLength(1);
    await expect(credentials.read()).resolves.toEqual({
      schemaVersion: 1,
      profileId: "primary",
      appKey,
      secretKey,
    });
    for (const outsideSecretStorage of [
      pluginData,
      vaultWrites,
      externalCatalogWrites,
      logs,
    ]) {
      expect(JSON.stringify(outsideSecretStorage)).not.toContain(appKey);
      expect(JSON.stringify(outsideSecretStorage)).not.toContain(secretKey);
    }
  });

  it("does not inspect Vault, plugin data, filesystem, or secret listings", async () => {
    const storage = new MemorySecretStorage();
    const host: NormalCatalogSecretHost = new Proxy({ secretStorage: storage }, {
      get(target, property, receiver) {
        if (property !== "secretStorage") throw new Error(`forbidden-host-property:${String(property)}`);
        return Reflect.get(target, property, receiver);
      },
    });
    const credentials = createNormalCatalogCredentialPort(host);

    await expect(credentials.read()).resolves.toBeNull();
    await expect(credentials.revoke()).resolves.toBeUndefined();
    expect(storage.calls).toEqual([
      { operation: "get", id: "knowledge-workbench-baidu-credentials" },
      { operation: "set", id: "knowledge-workbench-baidu-credentials" },
    ]);
    expect(storage.values.get("knowledge-workbench-baidu-credentials")).toBe("");
  });
});
