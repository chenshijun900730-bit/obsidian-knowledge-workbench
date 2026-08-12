import { describe, expect, it, vi } from "vitest";
import { BaiduOAuthAdapter } from "../../../src/adapters/baidu-oauth-adapter";
import type {
  BaiduOAuthRequest,
  BaiduOAuthResponse,
  CatalogAuthorizationBrowserPort,
  CatalogCredentialPort,
} from "../../../src/catalog/catalog-ports";
import type { BaiduCredentialBundle } from "../../../src/catalog/catalog-types";

const applicationSecret = "oauth-secret-sentinel";
const submittedCode = "one-time-code-sentinel";

class MemoryCredentials implements CatalogCredentialPort {
  current: BaiduCredentialBundle | null = {
    schemaVersion: 1,
    profileId: "primary",
    appKey: "app-key-sentinel",
    secretKey: applicationSecret,
  };
  readonly replacements: BaiduCredentialBundle[] = [];
  readError: Error | null = null;
  replaceError: Error | null = null;
  replaceGate: Promise<void> | null = null;
  replaceAttempts = 0;
  revokeCalls = 0;
  revokeError: Error | null = null;

  async read(): Promise<BaiduCredentialBundle | null> {
    if (this.readError !== null) throw this.readError;
    return this.current === null ? null : { ...this.current };
  }

  async replace(value: BaiduCredentialBundle): Promise<void> {
    if (this.replaceError !== null) throw this.replaceError;
    this.replaceAttempts += 1;
    this.current = { ...value };
    this.replacements.push({ ...value });
    if (this.replaceGate !== null) await this.replaceGate;
  }

  async replaceIfCurrent(
    value: BaiduCredentialBundle,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    if (this.replaceError !== null) throw this.replaceError;
    this.replaceAttempts += 1;
    if (this.replaceGate !== null) await this.replaceGate;
    if (!isCurrent()) return false;
    this.current = { ...value };
    this.replacements.push({ ...value });
    return true;
  }

  async revoke(): Promise<void> {
    this.revokeCalls += 1;
    if (this.revokeError !== null) throw this.revokeError;
    this.current = null;
  }
}

class MemoryBrowser implements CatalogAuthorizationBrowserPort {
  readonly urls: string[] = [];
  error: Error | null = null;

  async openAuthorizationPage(url: string): Promise<void> {
    if (this.error !== null) throw this.error;
    this.urls.push(url);
  }
}

class ScriptedRequest {
  readonly calls: BaiduOAuthRequest[] = [];
  responses: BaiduOAuthResponse[] = [];
  pending: Promise<BaiduOAuthResponse> | null = null;
  error: Error | null = null;

  readonly send = async (request: BaiduOAuthRequest): Promise<BaiduOAuthResponse> => {
    this.calls.push(request);
    if (this.error !== null) throw this.error;
    if (this.pending !== null) return this.pending;
    const response = this.responses.shift();
    if (response === undefined) throw new Error("missing-test-response");
    return response;
  };
}

const tokenResponse = (
  accessToken = "access-token-sentinel",
  refreshToken = "refresh-token-sentinel",
): BaiduOAuthResponse => ({
  status: 200,
  text: JSON.stringify({
    access_token: accessToken,
    expires_in: 2_592_000,
    refresh_token: refreshToken,
    scope: "basic netdisk",
  }),
});

const fixture = () => {
  const credentials = new MemoryCredentials();
  const browser = new MemoryBrowser();
  const requests = new ScriptedRequest();
  let now = 1_000;
  const adapter = new BaiduOAuthAdapter({
    credentials,
    browser,
    request: requests.send,
    now: () => now,
  });
  return {
    adapter,
    browser,
    credentials,
    requests,
    setNow(value: number): void {
      now = value;
    },
  };
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
};

describe("BaiduOAuthAdapter", () => {
  it("opens only the exact OOB authorization endpoint for ten minutes", async () => {
    const { adapter, browser } = fixture();

    await expect(adapter.beginAuthorization()).resolves.toEqual({ expiresAt: 601_000 });

    expect(browser.urls).toHaveLength(1);
    const url = new URL(browser.urls[0]!);
    expect(url.origin).toBe("https://openapi.baidu.com");
    expect(url.pathname).toBe("/oauth/2.0/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("app-key-sentinel");
    expect(url.searchParams.get("redirect_uri")).toBe("oob");
    expect(url.searchParams.get("scope")).toBe("basic,netdisk");
    expect(url.searchParams.has("state")).toBe(false);
    expect(url.hostname).not.toBe("localhost");
  });

  it("expires, cancels, and disposes one active attempt without requests", async () => {
    const expired = fixture();
    await expired.adapter.beginAuthorization();
    expired.setNow(601_001);
    await expect(expired.adapter.submitAuthorizationCode(submittedCode)).rejects.toMatchObject({
      code: "authorization-attempt-expired",
    });
    expect(expired.requests.calls).toEqual([]);

    const canceled = fixture();
    await canceled.adapter.beginAuthorization();
    canceled.adapter.cancelAuthorization();
    await expect(canceled.adapter.submitAuthorizationCode(submittedCode)).rejects.toMatchObject({
      code: "authorization-attempt-unavailable",
    });

    const disposed = fixture();
    await disposed.adapter.beginAuthorization();
    disposed.adapter.dispose();
    await expect(disposed.adapter.submitAuthorizationCode(submittedCode)).rejects.toMatchObject({
      code: "authorization-attempt-unavailable",
    });
  });

  it.each(["", "contains whitespace", "line\nbreak", "x".repeat(513)])(
    "rejects and consumes an invalid code without a request: %j",
    async (code) => {
      const { adapter, requests } = fixture();
      await adapter.beginAuthorization();

      await expect(adapter.submitAuthorizationCode(code)).rejects.toMatchObject({
        code: "authorization-code-invalid",
      });
      await expect(adapter.submitAuthorizationCode(submittedCode)).rejects.toMatchObject({
        code: "authorization-attempt-unavailable",
      });
      expect(requests.calls).toEqual([]);
    },
  );

  it("consumes a valid code before one exact GET exchange and atomically stores tokens", async () => {
    const { adapter, credentials, requests } = fixture();
    requests.responses.push(tokenResponse());
    await adapter.beginAuthorization();

    await adapter.submitAuthorizationCode(submittedCode);

    expect(requests.calls).toHaveLength(1);
    expect(requests.calls[0]?.method).toBe("GET");
    expect(requests.calls[0]?.body).toBeUndefined();
    const url = new URL(requests.calls[0]!.url);
    expect(url.origin).toBe("https://openapi.baidu.com");
    expect(url.pathname).toBe("/oauth/2.0/token");
    expect(url.searchParams.get("grant_type")).toBe("authorization_code");
    expect(url.searchParams.get("code")).toBe(submittedCode);
    expect(url.searchParams.get("client_id")).toBe("app-key-sentinel");
    expect(url.searchParams.get("client_secret")).toBe(applicationSecret);
    expect(url.searchParams.get("redirect_uri")).toBe("oob");
    expect(credentials.replacements).toEqual([{
      schemaVersion: 1,
      profileId: "primary",
      appKey: "app-key-sentinel",
      secretKey: applicationSecret,
      accessToken: "access-token-sentinel",
      refreshToken: "refresh-token-sentinel",
      accessTokenExpiresAt: 2_592_001_000,
    }]);
    await expect(adapter.submitAuthorizationCode(submittedCode)).rejects.toMatchObject({
      code: "authorization-attempt-unavailable",
    });
    expect(requests.calls).toHaveLength(1);
  });

  it("replaces both tokens with one exact refresh request", async () => {
    const { adapter, credentials, requests } = fixture();
    credentials.current = {
      ...credentials.current!,
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      accessTokenExpiresAt: 900,
    };
    requests.responses.push(tokenResponse("new-access-token", "new-refresh-token"));

    await adapter.refresh();

    expect(requests.calls).toHaveLength(1);
    const url = new URL(requests.calls[0]!.url);
    expect(requests.calls[0]?.method).toBe("GET");
    expect(url.origin).toBe("https://openapi.baidu.com");
    expect(url.pathname).toBe("/oauth/2.0/token");
    expect(url.searchParams.get("grant_type")).toBe("refresh_token");
    expect(url.searchParams.get("refresh_token")).toBe("old-refresh-token");
    expect(url.searchParams.get("client_id")).toBe("app-key-sentinel");
    expect(url.searchParams.get("client_secret")).toBe(applicationSecret);
    expect(url.searchParams.has("redirect_uri")).toBe(false);
    expect(credentials.current).toMatchObject({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      accessTokenExpiresAt: 2_592_001_000,
    });
  });

  it.each(["cancel", "dispose"] as const)(
    "does not restore exchanged authorization tokens after %s",
    async (action) => {
      const { adapter, credentials, requests } = fixture();
      const response = deferred<BaiduOAuthResponse>();
      requests.pending = response.promise;
      await adapter.beginAuthorization();

      const submitting = adapter.submitAuthorizationCode(submittedCode);
      await vi.waitFor(() => { expect(requests.calls).toHaveLength(1); });
      if (action === "cancel") adapter.cancelAuthorization();
      else adapter.dispose();
      await credentials.revoke();
      response.resolve(tokenResponse());

      await expect(submitting).rejects.toMatchObject({ code: "authorization-canceled" });
      expect(credentials.current).toBeNull();
      expect(credentials.replacements).toEqual([]);
    },
  );

  it.each(["cancel", "dispose"] as const)(
    "does not commit tokens when a conditional credential write loses its epoch to %s",
    async (action) => {
      const { adapter, credentials, requests } = fixture();
      const original = structuredClone(credentials.current);
      const writeGate = deferred<void>();
      credentials.replaceGate = writeGate.promise;
      requests.responses.push(tokenResponse());
      await adapter.beginAuthorization();

      const submitting = adapter.submitAuthorizationCode(submittedCode);
      await vi.waitFor(() => { expect(credentials.replaceAttempts).toBe(1); });
      if (action === "cancel") adapter.cancelAuthorization();
      else adapter.dispose();
      credentials.revokeError = new Error("secret-storage-cleanup-failed");
      writeGate.resolve();

      await expect(submitting).rejects.toMatchObject({ code: "authorization-canceled" });
      expect(credentials.current).toEqual(original);
      expect(credentials.replacements).toEqual([]);
      expect(credentials.revokeCalls).toBe(0);
    },
  );

  it.each(["cancel", "dispose"] as const)(
    "does not restore refreshed tokens after %s",
    async (action) => {
      const { adapter, credentials, requests } = fixture();
      credentials.current = {
        ...credentials.current!,
        accessToken: "old-access-token",
        refreshToken: "old-refresh-token",
        accessTokenExpiresAt: 900,
      };
      const response = deferred<BaiduOAuthResponse>();
      requests.pending = response.promise;

      const refreshing = adapter.refresh();
      await vi.waitFor(() => { expect(requests.calls).toHaveLength(1); });
      if (action === "cancel") adapter.cancelAuthorization();
      else adapter.dispose();
      await credentials.revoke();
      response.resolve(tokenResponse("new-access-token", "new-refresh-token"));

      await expect(refreshing).rejects.toMatchObject({ code: "authorization-canceled" });
      expect(credentials.current).toBeNull();
      expect(credentials.replacements).toEqual([]);
    },
  );

  it("sanitizes browser, request, and response failures without retaining credentials", async () => {
    const browserFailure = fixture();
    browserFailure.browser.error = new Error(applicationSecret);
    await expect(browserFailure.adapter.beginAuthorization()).rejects.toMatchObject({
      code: "authorization-canceled",
    });
    await expect(browserFailure.adapter.submitAuthorizationCode(submittedCode)).rejects.toMatchObject({
      code: "authorization-attempt-unavailable",
    });

    const requestFailure = fixture();
    requestFailure.requests.error = new Error(submittedCode);
    await requestFailure.adapter.beginAuthorization();
    const error = await requestFailure.adapter
      .submitAuthorizationCode(submittedCode)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "authorization-exchange-failed" });
    expect(JSON.stringify(error)).not.toContain(submittedCode);
    expect(JSON.stringify(error)).not.toContain(applicationSecret);
    expect(JSON.stringify(requestFailure.adapter)).not.toContain(applicationSecret);

    const invalidResponse = fixture();
    invalidResponse.requests.responses.push({ status: 200, text: `{"error":"${submittedCode}"}` });
    await invalidResponse.adapter.beginAuthorization();
    const responseError = await invalidResponse.adapter
      .submitAuthorizationCode(submittedCode)
      .catch((caught: unknown) => caught);
    expect(responseError).toMatchObject({ code: "authorization-exchange-failed" });
    expect(JSON.stringify(responseError)).not.toContain(submittedCode);
  });

  it("uses only one refresh request and requires reauthorization after failure", async () => {
    const { adapter, credentials, requests } = fixture();
    credentials.current = {
      ...credentials.current!,
      refreshToken: "old-refresh-token",
    };
    requests.responses.push({ status: 400, text: "{}" });

    await expect(adapter.refresh()).rejects.toMatchObject({
      code: "authorization-exchange-failed",
    });
    expect(requests.calls).toHaveLength(1);
  });

  it("sanitizes credential read and replacement failures", async () => {
    const readFailure = fixture();
    readFailure.credentials.readError = new Error(applicationSecret);
    const readError = await readFailure.adapter
      .beginAuthorization()
      .catch((caught: unknown) => caught);
    expect(readError).toMatchObject({ code: "credentials-unavailable" });
    expect(JSON.stringify(readError)).not.toContain(applicationSecret);

    const replaceFailure = fixture();
    replaceFailure.credentials.replaceError = new Error("access-token-sentinel");
    replaceFailure.requests.responses.push(tokenResponse());
    await replaceFailure.adapter.beginAuthorization();
    const replaceError = await replaceFailure.adapter
      .submitAuthorizationCode(submittedCode)
      .catch((caught: unknown) => caught);
    expect(replaceError).toMatchObject({ code: "credentials-unavailable" });
    expect(JSON.stringify(replaceError)).not.toContain("access-token-sentinel");
  });
});
