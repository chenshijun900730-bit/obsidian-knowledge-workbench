import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCatalogSnapshotAdapter } from "../../src/adapters/local-catalog-snapshot-adapter";
import type {
  CloudCatalogConnectionRuntime,
  CloudCatalogRuntime,
} from "../../src/catalog/cloud-catalog-runtime";
import type {
  BaiduCatalogListRequest,
  BaiduCatalogListResponse,
} from "../../src/catalog/catalog-ports";
import {
  createNormalCloudCatalogRuntime,
  resolveCatalogRoot,
  type NormalCatalogEnvironment,
  type NormalCloudCatalogOptions,
} from "../../src/runtime/normal-cloud-catalog-composition";
import {
  refreshCatalogProjection,
  startCatalogInitialization,
} from "../../src/runtime/catalog-runtime-lifecycle";
import { createOfflineCloudCatalogRuntime } from "../../src/catalog/offline-cloud-catalog-runtime";
import { DISABLED_CLOUD_CATALOG_RUNTIME } from "../../src/catalog/disabled-cloud-catalog-runtime";

const temporaryHomes: string[] = [];
const obsidianConfigDirectory = [".", "obsidian"].join("");

afterEach(async () => {
  for (const path of temporaryHomes.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

const environment = (
  platform: string,
  homeDirectory = "/Users/example",
): NormalCatalogEnvironment => ({
  platform,
  homeDirectory,
});

class MemorySecretStorage {
  readonly values = new Map<string, string>();
  getSecret(id: string): string | null { return this.values.get(id) ?? null; }
  setSecret(id: string, secret: string): void { this.values.set(id, secret); }
}

type NormalOptionsExcludeBudget = "budget" extends keyof NormalCloudCatalogOptions
  ? false
  : true;
type StartScanHasOneArgument = Parameters<CloudCatalogConnectionRuntime["startScan"]>["length"] extends 1 ? true : false;

describe("normal cloud catalog composition", () => {
  it("keeps offline and acceptance-safe runtimes without hybrid capabilities", () => {
    const offline = createOfflineCloudCatalogRuntime();
    expect(offline.hybrid).toBeUndefined();
    expect(offline.directoryDiscovery).toBeUndefined();
    expect(offline.directoryLocator).toBeUndefined();
    expect(DISABLED_CLOUD_CATALOG_RUNTIME.hybrid).toBeUndefined();
    expect(DISABLED_CLOUD_CATALOG_RUNTIME.directoryDiscovery).toBeUndefined();
    expect(DISABLED_CLOUD_CATALOG_RUNTIME.directoryLocator).toBeUndefined();
    offline.dispose();
  });

  it("keeps directory discovery out of offline and disabled object graphs", async () => {
    const sources = await Promise.all([
      "src/catalog/offline-cloud-catalog-runtime.ts",
      "src/catalog/disabled-cloud-catalog-runtime.ts",
    ].map((path) => readFile(path, "utf8")));

    for (const source of sources) {
      expect(source).not.toContain("cloud-directory-discovery-service");
      expect(source).not.toContain("cloud-directory-locator");
      expect(source).not.toContain("baidu-catalog-source-adapter");
    }
  });

  it("keeps hybrid value contracts independent of filesystem, credentials, and Baidu adapters", async () => {
    const sources = await Promise.all([
      "src/catalog/hybrid-catalog-types.ts",
      "src/catalog/hybrid-catalog-codec.ts",
    ].map((path) => readFile(path, "utf8")));

    for (const source of sources) {
      expect(source).not.toContain("node:fs");
      expect(source).not.toContain("SecretStorage");
      expect(source).not.toContain("baidu-catalog-source-adapter");
    }
  });

  it("resolves the fixed external Application Support catalog root on macOS", () => {
    const value = resolveCatalogRoot(environment("darwin"));
    expect(value).toBe(
      "/Users/example/Library/Application Support/Knowledge Workbench/baidu-catalog",
    );
    expect(value).not.toContain("Example Vault");
    expect(value).not.toContain(obsidianConfigDirectory);
    expect(value).not.toContain(process.cwd());
    expect(() => resolveCatalogRoot(environment("linux")))
      .toThrow("unsupported-catalog-platform");
    expect(() => resolveCatalogRoot(environment("darwin", "/")))
      .toThrow("invalid-catalog-home-root");
  });

  it("composes OOB and list capabilities without enumerating after authorization", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "knowledge-workbench-home-")));
    temporaryHomes.push(home);
    const storage = new MemorySecretStorage();
    const authorizationUrls: string[] = [];
    const requests: BaiduCatalogListRequest[] = [];
    const responses: BaiduCatalogListResponse[] = [];
    const catalogRoot = resolveCatalogRoot(environment("darwin", home));
    const runtime = createNormalCloudCatalogRuntime({
      catalogRoot,
      host: {
        secretStorage: storage,
        openAuthorizationPage: async (url) => { authorizationUrls.push(url); },
        request: async (request) => {
          requests.push(request);
          const response = responses.shift();
          if (response === undefined) throw new Error("missing-test-response");
          return response;
        },
        copyText: async () => undefined,
        openBaidu: async () => undefined,
      },
      createScanId: () => "scan-synthetic",
    });

    await runtime.initialize();
    expect(runtime.directoryDiscovery).toBeDefined();
    expect(runtime.directoryLocator).toBeDefined();
    expect(runtime.directoryDiscovery?.searchCached("synthetic")).toEqual([]);
    expect(runtime.connection?.snapshot()).toEqual({ status: "unconfigured" });
    expect(runtime.snapshot()).toMatchObject({ status: "no-snapshot", total: 0 });

    await runtime.connection?.saveApplicationCredentials({
      appKey: "app-key-sentinel",
      secretKey: "secret-key-sentinel",
    });
    await runtime.connection?.beginAuthorization();
    expect(authorizationUrls).toHaveLength(1);
    expect(requests).toEqual([]);

    responses.push({
      status: 200,
      text: JSON.stringify({
        access_token: "access-token-sentinel",
        refresh_token: "refresh-token-sentinel",
        expires_in: 3600,
      }),
    });
    await runtime.connection?.submitAuthorizationCode("one-time-code-sentinel");
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe("/oauth/2.0/token");

    await expect(runtime.connection?.startScan("/")).rejects.toMatchObject({
      code: "invalid-scan-root",
    });
    expect(requests).toHaveLength(1);

    responses.push({ status: 200, text: JSON.stringify({ errno: 0, list: [] }) });
    await runtime.connection?.startScan("/synthetic-small-folder");
    expect(requests).toHaveLength(2);
    const listUrl = new URL(requests[1]!.url);
    expect(listUrl.pathname).toBe("/rest/2.0/xpan/file");
    expect(listUrl.searchParams.get("method")).toBe("list");
    expect(runtime.snapshot()).toMatchObject({ status: "ready", total: 0 });

    responses.push({ status: 200, text: JSON.stringify({ errno: 0, list: [] }) });
    await expect(runtime.directoryDiscovery?.discoverMore("/synthetic-small-folder"))
      .resolves.toMatchObject({
        status: "complete",
        stopReason: "complete",
        listRequestCount: 1,
      });
    expect(requests).toHaveLength(3);
    const discoveryUrl = new URL(requests[2]!.url);
    expect(discoveryUrl.searchParams.get("method")).toBe("list");
    expect(discoveryUrl.searchParams.get("dir")).toBe("/synthetic-small-folder");

    responses.push({ status: 200, text: JSON.stringify({ errno: 0, list: [] }) });
    await expect(runtime.directoryLocator?.locateByName("synthetic"))
      .resolves.toMatchObject({
        status: "complete",
        stopReason: "complete",
        listRequestCount: 1,
      });
    expect(requests).toHaveLength(4);
    const locatorUrl = new URL(requests[3]!.url);
    expect(locatorUrl.searchParams.get("method")).toBe("list");
    expect(locatorUrl.searchParams.get("dir")).toBe("/");
    expect(requests.filter((request) => {
      const url = new URL(request.url);
      return url.pathname === "/rest/2.0/xpan/file" && url.searchParams.get("dir") === "/";
    })).toHaveLength(1);

    expect((await stat(catalogRoot)).isDirectory()).toBe(true);
    runtime.dispose();
  });

  it("enforces the fixed production directory budget without a public override", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "knowledge-workbench-budget-")));
    temporaryHomes.push(home);
    const storage = new MemorySecretStorage();
    const requests: BaiduCatalogListRequest[] = [];
    const responses: BaiduCatalogListResponse[] = [];
    const options: NormalCloudCatalogOptions = {
      catalogRoot: resolveCatalogRoot(environment("darwin", home)),
      host: {
        secretStorage: storage,
        openAuthorizationPage: async () => undefined,
        request: async (request) => {
          requests.push(request);
          const response = responses.shift();
          if (response === undefined) throw new Error("missing-test-response");
          return response;
        },
        copyText: async () => undefined,
        openBaidu: async () => undefined,
      },
      createScanId: () => "scan-synthetic-budget",
    };
    const normalOptionsExcludeBudget: NormalOptionsExcludeBudget = true;
    const startScanHasOneArgument: StartScanHasOneArgument = true;
    const runtime = createNormalCloudCatalogRuntime(options);
    await runtime.initialize();
    await runtime.connection?.saveApplicationCredentials({
      appKey: "app-key-sentinel",
      secretKey: "secret-key-sentinel",
    });
    await runtime.connection?.beginAuthorization();
    responses.push({
      status: 200,
      text: JSON.stringify({
        access_token: "access-token-sentinel",
        refresh_token: "refresh-token-sentinel",
        expires_in: 3600,
      }),
    });
    await runtime.connection?.submitAuthorizationCode("one-time-code-sentinel");
    responses.push({
      status: 200,
      text: JSON.stringify({
        errno: 0,
        list: Array.from({ length: 21 }, (_, index) => ({
          fs_id: String(index + 1),
          path: `/synthetic-budget/dir-${String(index + 1).padStart(2, "0")}`,
          server_filename: `dir-${String(index + 1).padStart(2, "0")}`,
          size: 0,
          server_mtime: 11,
          isdir: 1,
        })),
      }),
    });

    await runtime.connection?.startScan("/synthetic-budget");

    const listRequests = requests.filter((request) =>
      new URL(request.url).pathname === "/rest/2.0/xpan/file");
    expect(normalOptionsExcludeBudget).toBe(true);
    expect(startScanHasOneArgument).toBe(true);
    expect(runtime.connection?.startScan.length).toBe(1);
    expect(listRequests).toHaveLength(1);
    expect(runtime.connection?.snapshot()).toMatchObject({
      status: "paused",
      scanProgress: { status: "paused", stopReason: "directory-limit" },
    });
    const snapshots = new LocalCatalogSnapshotAdapter(options.catalogRoot);
    expect(await snapshots.loadActive()).toBeNull();
    expect(await snapshots.loadReceipt("scan-synthetic-budget")).toMatchObject({
      schemaVersion: 2,
      status: "paused",
      stopReason: "directory-limit",
      budget: {
        maxPdfCount: 1_000,
        maxDirectoryCount: 20,
        maxListRequestCount: 25,
        maxDurationMs: 120_000,
      },
      listRequestCount: 1,
      directoryCount: 0,
      downloadedPdfBytes: 0,
    });
    runtime.dispose();
  });

  it("starts catalog initialization detached and reports only fixed failure codes", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const initialize = vi.fn(() => pending);
    const runtime = { initialize } as unknown as CloudCatalogRuntime;
    const reports: string[] = [];

    startCatalogInitialization(runtime, (code) => reports.push(code));

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(reports).toEqual([]);
    release();
    await pending;

    const failing = {
      initialize: vi.fn(async () => { throw new Error("private external path detail"); }),
    } as unknown as CloudCatalogRuntime;
    startCatalogInitialization(failing, (code) => reports.push(code));
    await Promise.resolve();
    await Promise.resolve();
    expect(reports).toEqual(["catalog-unavailable"]);
    expect(JSON.stringify(reports)).not.toContain("private");

    await expect(refreshCatalogProjection(failing)).rejects.toThrow("catalog-unavailable");
  });
});
