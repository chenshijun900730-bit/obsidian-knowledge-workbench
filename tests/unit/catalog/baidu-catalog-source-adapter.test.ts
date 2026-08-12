import { describe, expect, it } from "vitest";
import { BaiduCatalogSourceAdapter } from "../../../src/adapters/baidu-catalog-source-adapter";
import type {
  BaiduCatalogListRequest,
  BaiduCatalogListResponse,
  BaiduOAuthPort,
  CatalogCredentialPort,
} from "../../../src/catalog/catalog-ports";
import type { BaiduCredentialBundle } from "../../../src/catalog/catalog-types";

const firstAccessToken = "catalog-access-token-one";
const secondAccessToken = "catalog-access-token-two";
const privateCloudPath = "/private-library/e\u0301ditions";

class MemoryCredentials implements CatalogCredentialPort {
  current: BaiduCredentialBundle | null = {
    schemaVersion: 1,
    profileId: "primary",
    appKey: "app-key-sentinel",
    secretKey: "secret-key-sentinel",
    accessToken: firstAccessToken,
    refreshToken: "refresh-token-sentinel",
  };
  readError: Error | null = null;

  async read(): Promise<BaiduCredentialBundle | null> {
    if (this.readError !== null) throw this.readError;
    return this.current === null ? null : { ...this.current };
  }

  async replace(value: BaiduCredentialBundle): Promise<void> {
    this.current = { ...value };
  }

  async replaceIfCurrent(
    value: BaiduCredentialBundle,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    if (!isCurrent()) return false;
    await this.replace(value);
    return true;
  }

  async revoke(): Promise<void> {
    this.current = null;
  }
}

class RefreshingOAuth implements BaiduOAuthPort {
  refreshCalls = 0;
  refreshError: Error | null = null;

  constructor(private readonly credentials: MemoryCredentials) {}

  async beginAuthorization(): Promise<Readonly<{ expiresAt: number }>> {
    throw new Error("not-used");
  }

  async submitAuthorizationCode(): Promise<void> {
    throw new Error("not-used");
  }

  cancelAuthorization(): void {}

  async refresh(): Promise<void> {
    this.refreshCalls += 1;
    if (this.refreshError !== null) throw this.refreshError;
    if (this.credentials.current === null) throw new Error("missing-credentials");
    this.credentials.current = {
      ...this.credentials.current,
      accessToken: secondAccessToken,
    };
  }

  dispose(): void {}
}

class ScriptedListRequest {
  readonly calls: BaiduCatalogListRequest[] = [];
  responses: BaiduCatalogListResponse[] = [];
  error: Error | null = null;
  beforeSend: (() => void) | undefined;

  readonly send = async (
    request: BaiduCatalogListRequest,
  ): Promise<BaiduCatalogListResponse> => {
    this.beforeSend?.();
    this.calls.push(request);
    if (this.error !== null) throw this.error;
    const response = this.responses.shift();
    if (response === undefined) throw new Error("missing-test-response");
    return response;
  };
}

const successfulResponse = (): BaiduCatalogListResponse => ({
  status: 200,
  text: "{\"errno\":0,\"list\":[{\"fs_id\":9007199254740993,\"path\":\"/private-library/éditions/book.pdf\",\"server_filename\":\"book.pdf\",\"size\":7,\"server_mtime\":11,\"isdir\":0,\"dlink\":\"must-not-escape\"}]}",
});

const fixture = () => {
  const credentials = new MemoryCredentials();
  const oauth = new RefreshingOAuth(credentials);
  const requests = new ScriptedListRequest();
  const adapter = new BaiduCatalogSourceAdapter({
    credentials,
    oauth,
    request: requests.send,
  });
  return { adapter, credentials, oauth, requests };
};

describe("BaiduCatalogSourceAdapter", () => {
  it("obtains a permit immediately before the initial list transport", async () => {
    const { adapter, requests } = fixture();
    const events: string[] = [];
    requests.responses.push(successfulResponse());
    requests.beforeSend = () => { events.push("transport"); };

    await adapter.listDirectory({
      path: privateCloudPath,
      start: 0,
      limit: 1000,
      beforeRequest: async () => { events.push("permit"); },
    });

    expect(events).toEqual(["permit", "transport"]);
    expect(requests.calls).toHaveLength(1);
  });

  it("counts initial and refresh replay separately and preserves a blocked permit", async () => {
    const { adapter, oauth, requests } = fixture();
    const events: string[] = [];
    const blocked = new Error("synthetic-permit-blocked");
    let permits = 0;
    requests.responses.push({ status: 200, text: JSON.stringify({ errno: -6, list: [] }) });
    requests.beforeSend = () => { events.push("transport"); };

    const error = await adapter.listDirectory({
      path: "/safe",
      start: 0,
      limit: 1000,
      beforeRequest: async () => {
        permits += 1;
        events.push("permit");
        if (permits === 2) throw blocked;
      },
    }).catch((value: unknown) => value);

    expect(error).toBe(blocked);
    expect(events).toEqual(["permit", "transport", "permit"]);
    expect(oauth.refreshCalls).toBe(1);
    expect(requests.calls).toHaveLength(1);
  });

  it("uses one exact read-only list request and returns only decoded metadata", async () => {
    const { adapter, requests } = fixture();
    requests.responses.push(successfulResponse());

    await expect(adapter.listDirectory({
      path: privateCloudPath,
      start: 2_000,
      limit: 1000,
      beforeRequest: async () => undefined,
    })).resolves.toEqual({
      entries: [{
        fsId: "9007199254740993",
        path: "/private-library/éditions/book.pdf",
        filename: "book.pdf",
        sizeBytes: 7,
        serverModifiedAt: 11,
        isDirectory: false,
      }],
    });

    expect(requests.calls).toHaveLength(1);
    expect(requests.calls[0]?.method).toBe("GET");
    expect(requests.calls[0]?.body).toBeUndefined();
    const url = new URL(requests.calls[0]!.url);
    expect(url.origin).toBe("https://pan.baidu.com");
    expect(url.pathname).toBe("/rest/2.0/xpan/file");
    expect([...url.searchParams.keys()].sort()).toEqual([
      "access_token",
      "desc",
      "dir",
      "folder",
      "limit",
      "method",
      "order",
      "start",
    ]);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      method: "list",
      access_token: firstAccessToken,
      dir: "/private-library/éditions",
      order: "name",
      desc: "0",
      start: "2000",
      limit: "1000",
      folder: "0",
    });
    expect(Object.getOwnPropertyNames(BaiduCatalogSourceAdapter.prototype).sort())
      .toEqual(["constructor", "listDirectory"]);
  });

  it.each([
    { path: "relative", start: 0, limit: 1000 },
    { path: "/safe", start: -1, limit: 1000 },
    { path: "/safe", start: 1.5, limit: 1000 },
    { path: "/safe", start: Number.MAX_SAFE_INTEGER + 1, limit: 1000 },
    { path: "/safe", start: 0, limit: 999 },
  ])("rejects an unsafe list input before any network request: %j", async (input) => {
    const { adapter, requests } = fixture();

    await expect(adapter.listDirectory({
      ...input,
      beforeRequest: async () => undefined,
    } as Readonly<{
      path: string;
      start: number;
      limit: 1000;
      beforeRequest: () => Promise<void>;
    }>)).rejects.toMatchObject({ code: "invalid-scan-root" });
    expect(requests.calls).toEqual([]);
  });

  it.each([
    [-7, "baidu-permission-denied", false],
    [-9, "baidu-not-found", false],
    [20012, "baidu-rate-limited", true],
    [20011, "baidu-access-unavailable", false],
  ] as const)("preserves sanitized errno mapping for %s", async (errno, code, retryable) => {
    const { adapter, requests } = fixture();
    requests.responses.push({
      status: 200,
      text: JSON.stringify({ errno, list: [], privateCloudPath }),
    });

    const error = await adapter.listDirectory({
      path: "/safe",
      start: 0,
      limit: 1000,
      beforeRequest: async () => undefined,
    })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code, retryable });
    expect(JSON.stringify(error)).not.toContain(privateCloudPath);
  });

  it("refreshes once after token expiry and repeats only the same list operation", async () => {
    const { adapter, oauth, requests } = fixture();
    requests.responses.push(
      { status: 200, text: JSON.stringify({ errno: -6, list: [] }) },
      successfulResponse(),
    );

    await adapter.listDirectory({
      path: "/private-library/éditions",
      start: 0,
      limit: 1000,
      beforeRequest: async () => undefined,
    });

    expect(oauth.refreshCalls).toBe(1);
    expect(requests.calls).toHaveLength(2);
    const first = new URL(requests.calls[0]!.url);
    const second = new URL(requests.calls[1]!.url);
    expect(first.searchParams.get("access_token")).toBe(firstAccessToken);
    expect(second.searchParams.get("access_token")).toBe(secondAccessToken);
    first.searchParams.delete("access_token");
    second.searchParams.delete("access_token");
    expect(second.toString()).toBe(first.toString());
  });

  it("never refreshes or lists more than once again after an expired token", async () => {
    const { adapter, oauth, requests } = fixture();
    requests.responses.push(
      { status: 200, text: JSON.stringify({ errno: 31045, list: [] }) },
      { status: 200, text: JSON.stringify({ errno: -6, list: [] }) },
    );

    await expect(adapter.listDirectory({
      path: "/safe",
      start: 0,
      limit: 1000,
      beforeRequest: async () => undefined,
    }))
      .rejects.toMatchObject({ code: "baidu-token-expired" });
    expect(oauth.refreshCalls).toBe(1);
    expect(requests.calls).toHaveLength(2);
  });

  it("sanitizes credential, refresh, transport, and HTTP failures", async () => {
    const credentialFailure = fixture();
    credentialFailure.credentials.readError = new Error(firstAccessToken);
    const credentialError = await credentialFailure.adapter
      .listDirectory({
        path: privateCloudPath,
        start: 0,
        limit: 1000,
        beforeRequest: async () => undefined,
      })
      .catch((caught: unknown) => caught);
    expect(credentialError).toMatchObject({ code: "credentials-unavailable" });

    const transportFailure = fixture();
    transportFailure.requests.error = new Error(`${firstAccessToken}:${privateCloudPath}`);
    const transportError = await transportFailure.adapter
      .listDirectory({
        path: privateCloudPath,
        start: 0,
        limit: 1000,
        beforeRequest: async () => undefined,
      })
      .catch((caught: unknown) => caught);
    expect(transportError).toMatchObject({ code: "baidu-access-unavailable" });

    const refreshFailure = fixture();
    refreshFailure.requests.responses.push({
      status: 200,
      text: JSON.stringify({ errno: -6, list: [] }),
    });
    refreshFailure.oauth.refreshError = new Error(`${firstAccessToken}:${privateCloudPath}`);
    const refreshError = await refreshFailure.adapter
      .listDirectory({
        path: privateCloudPath,
        start: 0,
        limit: 1000,
        beforeRequest: async () => undefined,
      })
      .catch((caught: unknown) => caught);
    expect(refreshError).toMatchObject({ code: "baidu-access-unavailable" });
    expect(refreshFailure.requests.calls).toHaveLength(1);

    const httpFailure = fixture();
    httpFailure.requests.responses.push({
      status: 503,
      text: `${firstAccessToken}:${privateCloudPath}`,
    });
    const httpError = await httpFailure.adapter
      .listDirectory({
        path: privateCloudPath,
        start: 0,
        limit: 1000,
        beforeRequest: async () => undefined,
      })
      .catch((caught: unknown) => caught);
    expect(httpError).toMatchObject({ code: "baidu-access-unavailable" });

    for (const error of [credentialError, transportError, refreshError, httpError]) {
      expect(JSON.stringify(error)).not.toContain(firstAccessToken);
      expect(JSON.stringify(error)).not.toContain(privateCloudPath);
    }
  });

  it("requires a stored access token without making a request", async () => {
    const { adapter, credentials, requests } = fixture();
    credentials.current = {
      schemaVersion: 1,
      profileId: "primary",
      appKey: "app-key-sentinel",
      secretKey: "secret-key-sentinel",
    };

    await expect(adapter.listDirectory({
      path: "/safe",
      start: 0,
      limit: 1000,
      beforeRequest: async () => undefined,
    }))
      .rejects.toMatchObject({ code: "credentials-unavailable" });
    expect(requests.calls).toEqual([]);
  });
});
