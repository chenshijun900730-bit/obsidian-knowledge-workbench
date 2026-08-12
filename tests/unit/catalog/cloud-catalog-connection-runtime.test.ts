import { describe, expect, it, vi } from "vitest";
import { CloudCatalogConnectionRuntimeService } from "../../../src/catalog/cloud-catalog-connection-runtime";
import type {
  BaiduOAuthPort,
  CatalogCredentialPort,
} from "../../../src/catalog/catalog-ports";
import type {
  BaiduCredentialBundle,
  CatalogScanProgress,
  CatalogScanResult,
} from "../../../src/catalog/catalog-types";
import { SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET } from "../../../src/catalog/catalog-types";

const scanProgress = (
  status: CatalogScanProgress["status"],
  stopReason?: CatalogScanProgress["stopReason"],
): CatalogScanProgress => ({
  status,
  directoryCount: 2,
  completedDirectoryCount: 1,
  pdfCount: 12,
  ignoredFileCount: 4,
  pendingDirectoryCount: 1,
  listRequestCount: 3,
  elapsedMs: 4_000,
  budget: SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET,
  ...(stopReason === undefined ? {} : { stopReason }),
});

const scanResult = (
  status: CatalogScanResult["status"],
  stopReason: CatalogScanResult["stopReason"],
  errorCode?: CatalogScanResult["errorCode"],
  progress: CatalogScanProgress = scanProgress(status, stopReason),
): CatalogScanResult => ({
  status,
  stopReason,
  progress,
  ...(errorCode === undefined ? {} : { errorCode }),
});

class MemoryCredentials implements CatalogCredentialPort {
  current: BaiduCredentialBundle | null = null;
  readonly replacements: BaiduCredentialBundle[] = [];
  replaceError: Error | null = null;
  revokeCalls = 0;
  revokeError: Error | null = null;

  async read(): Promise<BaiduCredentialBundle | null> {
    return this.current === null ? null : structuredClone(this.current);
  }

  async replace(value: BaiduCredentialBundle): Promise<void> {
    if (this.replaceError !== null) throw this.replaceError;
    this.current = structuredClone(value);
    this.replacements.push(structuredClone(value));
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
    this.revokeCalls += 1;
    if (this.revokeError !== null) throw this.revokeError;
    this.current = null;
  }
}

class ScriptedOAuth implements BaiduOAuthPort {
  beginCalls = 0;
  readonly submittedCodes: string[] = [];
  cancelCalls = 0;
  refreshCalls = 0;
  disposeCalls = 0;
  submitPromise: Promise<void> | null = null;

  constructor(private readonly credentials: MemoryCredentials) {}

  async beginAuthorization(): Promise<Readonly<{ expiresAt: number }>> {
    this.beginCalls += 1;
    return { expiresAt: 601_000 };
  }

  async submitAuthorizationCode(code: string): Promise<void> {
    this.submittedCodes.push(code);
    if (this.submitPromise !== null) await this.submitPromise;
    if (this.credentials.current === null) throw new Error("missing-test-credentials");
    this.credentials.current = {
      ...this.credentials.current,
      accessToken: "access-token-sentinel",
      refreshToken: "refresh-token-sentinel",
      accessTokenExpiresAt: 1_000_000,
    };
  }

  cancelAuthorization(): void { this.cancelCalls += 1; }
  async refresh(): Promise<void> { this.refreshCalls += 1; }
  dispose(): void { this.disposeCalls += 1; }
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
};

class ScriptedScanner {
  readonly calls: Array<Readonly<{ scanId: string; rootPath: string }>> = [];
  result: CatalogScanResult = scanResult("complete", "complete");
  resultPromise: Promise<CatalogScanResult> | undefined;
  signal: AbortSignal | undefined;
  onProgress: ((progress: CatalogScanProgress) => void) | undefined;

  async scan(input: Readonly<{
    scanId: string;
    rootPath: string;
    signal?: AbortSignal;
    onProgress?: (progress: CatalogScanProgress) => void;
  }>): Promise<CatalogScanResult> {
    this.calls.push({ scanId: input.scanId, rootPath: input.rootPath });
    this.signal = input.signal;
    this.onProgress = input.onProgress;
    if (this.resultPromise !== undefined) return this.resultPromise;
    return this.result;
  }

  emitProgress(progress: CatalogScanProgress): void {
    this.onProgress?.(structuredClone(progress));
  }
}

const fixture = () => {
  const credentials = new MemoryCredentials();
  const oauth = new ScriptedOAuth(credentials);
  const scanner = new ScriptedScanner();
  let snapshotChanges = 0;
  const connection = new CloudCatalogConnectionRuntimeService({
    credentials,
    oauth,
    scanner,
    createScanId: () => "scan-synthetic",
    onSnapshotChanged: async () => { snapshotChanges += 1; },
  });
  return {
    connection,
    credentials,
    oauth,
    scanner,
    snapshotChanges: () => snapshotChanges,
  };
};

describe("CloudCatalogConnectionRuntimeService", () => {
  it("initializes from detached credential state without making OAuth or scan calls", async () => {
    const empty = fixture();
    await empty.connection.initialize();
    expect(empty.connection.snapshot()).toEqual({ status: "unconfigured" });
    expect(empty.oauth.beginCalls).toBe(0);
    expect(empty.scanner.calls).toEqual([]);

    const configured = fixture();
    configured.credentials.current = {
      schemaVersion: 1,
      profileId: "primary",
      appKey: "app-key-sentinel",
      secretKey: "secret-key-sentinel",
    };
    await configured.connection.initialize();
    expect(configured.connection.snapshot()).toEqual({ status: "configured" });

    const authorized = fixture();
    authorized.credentials.current = {
      schemaVersion: 1,
      profileId: "primary",
      appKey: "app-key-sentinel",
      secretKey: "secret-key-sentinel",
      accessToken: "access-token-sentinel",
      refreshToken: "refresh-token-sentinel",
    };
    await authorized.connection.initialize();
    expect(authorized.connection.snapshot()).toEqual({ status: "authorized" });
  });

  it("replaces application credentials without preserving old tokens", async () => {
    const { connection, credentials } = fixture();
    credentials.current = {
      schemaVersion: 1,
      profileId: "primary",
      appKey: "old-app-key",
      secretKey: "old-secret-key",
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
    };

    await connection.saveApplicationCredentials({
      appKey: "new-app-key",
      secretKey: "new-secret-key",
    });

    expect(credentials.current).toEqual({
      schemaVersion: 1,
      profileId: "primary",
      appKey: "new-app-key",
      secretKey: "new-secret-key",
    });
    expect(connection.snapshot()).toEqual({ status: "configured" });
  });

  it("separates opening OOB, submitting one code, and every list operation", async () => {
    const { connection, credentials, oauth, scanner } = fixture();
    await connection.saveApplicationCredentials({
      appKey: "app-key-sentinel",
      secretKey: "secret-key-sentinel",
    });

    await expect(connection.beginAuthorization()).resolves.toEqual({ expiresAt: 601_000 });
    expect(connection.snapshot()).toEqual({
      status: "authorizing",
      authorizationExpiresAt: 601_000,
    });
    expect(oauth.beginCalls).toBe(1);
    expect(oauth.submittedCodes).toEqual([]);
    expect(scanner.calls).toEqual([]);

    await connection.submitAuthorizationCode("one-time-code-sentinel");
    expect(oauth.submittedCodes).toEqual(["one-time-code-sentinel"]);
    expect(credentials.current).toMatchObject({ accessToken: "access-token-sentinel" });
    expect(connection.snapshot()).toEqual({ status: "authorized" });
    expect(scanner.calls).toEqual([]);
  });

  it("cancels an OOB attempt without changing a previously authorized session", async () => {
    const { connection, credentials, oauth } = fixture();
    credentials.current = {
      schemaVersion: 1,
      profileId: "primary",
      appKey: "app-key-sentinel",
      secretKey: "secret-key-sentinel",
      accessToken: "access-token-sentinel",
      refreshToken: "refresh-token-sentinel",
    };
    await connection.initialize();
    await connection.beginAuthorization();

    connection.cancelAuthorization();

    expect(oauth.cancelCalls).toBe(1);
    expect(connection.snapshot()).toEqual({ status: "authorized" });
  });

  it("starts only one confirmed scan, refreshes the snapshot, and preserves fixed outcomes", async () => {
    const { connection, credentials, scanner, snapshotChanges } = fixture();
    credentials.current = {
      schemaVersion: 1,
      profileId: "primary",
      appKey: "app-key-sentinel",
      secretKey: "secret-key-sentinel",
      accessToken: "access-token-sentinel",
      refreshToken: "refresh-token-sentinel",
    };
    await connection.initialize();

    await connection.startScan("/synthetic-small-folder");

    expect(scanner.calls).toEqual([{
      scanId: "scan-synthetic",
      rootPath: "/synthetic-small-folder",
    }]);
    expect(snapshotChanges()).toBe(1);
    expect(connection.snapshot()).toEqual({
      status: "authorized",
      scanProgress: scanProgress("complete", "complete"),
    });

    scanner.result = scanResult("paused", "baidu-rate-limited", "baidu-rate-limited");
    await connection.startScan("/synthetic-small-folder");
    expect(connection.snapshot()).toEqual({
      status: "paused",
      messageCode: "baidu-rate-limited",
      scanProgress: scanProgress("paused", "baidu-rate-limited"),
    });
    expect(snapshotChanges()).toBe(1);

    scanner.result = scanResult("complete", "complete");
    await connection.startScan("/synthetic-small-folder");
    expect(scanner.calls).toHaveLength(3);
    expect(snapshotChanges()).toBe(2);
    expect(connection.snapshot()).toEqual({
      status: "authorized",
      scanProgress: scanProgress("complete", "complete"),
    });
  });

  it("publishes aggregate progress and retains its terminal pause reason", async () => {
    const { connection, credentials, scanner } = fixture();
    credentials.current = {
      schemaVersion: 1,
      profileId: "primary",
      appKey: "app-key-sentinel",
      secretKey: "secret-key-sentinel",
      accessToken: "access-token-sentinel",
      refreshToken: "refresh-token-sentinel",
    };
    await connection.initialize();
    let finishScan: ((result: CatalogScanResult) => void) | undefined;
    scanner.resultPromise = new Promise((resolve) => { finishScan = resolve; });
    let notifications = 0;
    const unsubscribe = connection.subscribe(() => { notifications += 1; });

    const running = connection.startScan("/synthetic-private-folder");
    const beforeProgress = notifications;
    const scanning = scanProgress("scanning");
    scanner.emitProgress(scanning);

    expect(notifications).toBeGreaterThan(beforeProgress);
    expect(connection.snapshot()).toMatchObject({
      status: "scanning",
      scanProgress: scanning,
    });
    expect(JSON.stringify(connection.snapshot())).not.toContain("synthetic-private-folder");
    expect(JSON.stringify(connection.snapshot())).not.toContain("private.pdf");

    const paused = scanProgress("paused", "pdf-limit");
    finishScan?.(scanResult("paused", "pdf-limit", undefined, paused));
    await running;

    expect(connection.snapshot()).toMatchObject({
      status: "paused",
      scanProgress: paused,
    });
    unsubscribe();
  });

  it("blocks scanning before authorization and revokes every active capability", async () => {
    const { connection, credentials, oauth, scanner } = fixture();
    await connection.initialize();
    await expect(connection.startScan("/synthetic-small-folder")).rejects.toMatchObject({
      code: "credentials-unavailable",
    });
    expect(scanner.calls).toEqual([]);

    await connection.saveApplicationCredentials({
      appKey: "app-key-sentinel",
      secretKey: "secret-key-sentinel",
    });
    await connection.beginAuthorization();
    await connection.revoke();

    expect(credentials.revokeCalls).toBe(1);
    expect(oauth.cancelCalls).toBe(2);
    expect(connection.snapshot()).toEqual({ status: "unconfigured" });
    connection.dispose();
    expect(oauth.disposeCalls).toBe(1);
  });

  it("keeps scan capability revoked when credential deletion fails", async () => {
    const { connection, credentials, scanner } = fixture();
    credentials.current = {
      schemaVersion: 1,
      profileId: "primary",
      appKey: "app-key-sentinel",
      secretKey: "secret-key-sentinel",
      accessToken: "access-token-sentinel",
      refreshToken: "refresh-token-sentinel",
    };
    await connection.initialize();
    credentials.revokeError = new Error("secret-storage-write-failed");

    await expect(connection.revoke()).rejects.toMatchObject({ code: "credentials-unavailable" });
    expect(connection.snapshot()).toEqual({
      status: "unconfigured",
      messageCode: "credentials-unavailable",
    });
    await expect(connection.startScan("/synthetic-small-folder")).rejects.toMatchObject({
      code: "credentials-unavailable",
    });
    expect(scanner.calls).toEqual([]);
  });

  it("keeps scan capability disabled when replacing application credentials fails", async () => {
    const { connection, credentials, scanner } = fixture();
    credentials.current = {
      schemaVersion: 1,
      profileId: "primary",
      appKey: "app-key-sentinel",
      secretKey: "secret-key-sentinel",
      accessToken: "access-token-sentinel",
      refreshToken: "refresh-token-sentinel",
    };
    await connection.initialize();
    credentials.replaceError = new Error("secret-storage-write-failed");

    await expect(connection.saveApplicationCredentials({
      appKey: "replacement-app-key",
      secretKey: "replacement-secret-key",
    })).rejects.toMatchObject({ code: "credentials-unavailable" });

    await expect(connection.startScan("/synthetic-small-folder")).rejects.toMatchObject({
      code: "credentials-unavailable",
    });
    expect(scanner.calls).toEqual([]);
  });

  it("ignores progress and completion from a scan that resolves after revoke", async () => {
    const { connection, credentials, scanner, snapshotChanges } = fixture();
    credentials.current = {
      schemaVersion: 1,
      profileId: "primary",
      appKey: "app-key-sentinel",
      secretKey: "secret-key-sentinel",
      accessToken: "access-token-sentinel",
      refreshToken: "refresh-token-sentinel",
    };
    await connection.initialize();
    let finishScan: ((result: CatalogScanResult) => void) | undefined;
    scanner.resultPromise = new Promise((resolve) => { finishScan = resolve; });

    const running = connection.startScan("/synthetic-small-folder");
    await vi.waitFor(() => { expect(scanner.calls).toHaveLength(1); });
    await connection.revoke();
    scanner.emitProgress(scanProgress("scanning"));
    finishScan?.(scanResult("complete", "complete"));
    await running;

    expect(scanner.signal?.aborted).toBe(true);
    expect(snapshotChanges()).toBe(0);
    expect(connection.snapshot()).toEqual({ status: "unconfigured" });
  });

  it("does not return to authorized when a stale code exchange resolves after revoke", async () => {
    const { connection, credentials, oauth } = fixture();
    await connection.saveApplicationCredentials({
      appKey: "app-key-sentinel",
      secretKey: "secret-key-sentinel",
    });
    await connection.beginAuthorization();
    const exchange = deferred();
    oauth.submitPromise = exchange.promise;

    const submitting = connection.submitAuthorizationCode("one-time-code-sentinel");
    await vi.waitFor(() => { expect(oauth.submittedCodes).toHaveLength(1); });
    await connection.revoke();
    exchange.resolve();

    await expect(submitting).rejects.toMatchObject({ code: "authorization-canceled" });
    expect(connection.snapshot()).toEqual({ status: "unconfigured" });
    expect(credentials.revokeCalls).toBe(1);
  });

  it("does not begin a new authorization attempt while a scan is active", async () => {
    const { connection, credentials, oauth, scanner } = fixture();
    credentials.current = {
      schemaVersion: 1,
      profileId: "primary",
      appKey: "app-key-sentinel",
      secretKey: "secret-key-sentinel",
      accessToken: "access-token-sentinel",
      refreshToken: "refresh-token-sentinel",
    };
    await connection.initialize();
    let finishScan: ((result: CatalogScanResult) => void) | undefined;
    scanner.resultPromise = new Promise((resolve) => { finishScan = resolve; });

    const running = connection.startScan("/synthetic-small-folder");
    await expect(connection.beginAuthorization()).rejects.toMatchObject({
      code: "baidu-access-unavailable",
    });

    expect(oauth.beginCalls).toBe(0);
    finishScan?.(scanResult("complete", "complete"));
    await running;
  });

  it("aborts an active scan without starting a second operation", async () => {
    const { connection, credentials, scanner } = fixture();
    credentials.current = {
      schemaVersion: 1,
      profileId: "primary",
      appKey: "app-key-sentinel",
      secretKey: "secret-key-sentinel",
      accessToken: "access-token-sentinel",
      refreshToken: "refresh-token-sentinel",
    };
    await connection.initialize();
    scanner.result = scanResult("paused", "user-canceled");

    const running = connection.startScan("/synthetic-small-folder");
    connection.cancelScan();
    await running;

    expect(scanner.calls).toHaveLength(1);
    expect(scanner.signal?.aborted).toBe(true);
  });
});
