import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BaiduCatalogListRequest,
  BaiduCatalogListResponse,
  BaiduOAuthRequest,
} from "../../src/catalog/catalog-ports";
import { LocalCatalogSnapshotAdapter } from "../../src/adapters/local-catalog-snapshot-adapter";
import {
  createNormalCloudCatalogRuntime,
  resolveCatalogRoot,
  type NormalCatalogEnvironment,
} from "../../src/runtime/normal-cloud-catalog-composition";
import type { CatalogScanConfirmationPresenter } from "../../src/ui/catalog-scan-confirmation-modal";
import { controllerFixture } from "../helpers/ui-fixtures";

const temporaryHomes: string[] = [];

class MemorySecretStorage {
  readonly values = new Map<string, string>();
  getSecret(id: string): string | null { return this.values.get(id) ?? null; }
  setSecret(id: string, secret: string): void { this.values.set(id, secret); }
}

class ScriptedConfirmation implements CatalogScanConfirmationPresenter {
  readonly requests: string[] = [];
  readonly results: boolean[] = [];

  async request(rootPath: string): Promise<boolean> {
    this.requests.push(rootPath);
    return this.results.shift() ?? false;
  }
}

const environment = (homeDirectory: string): NormalCatalogEnvironment => ({
  platform: "darwin",
  homeDirectory,
});

const createFixture = async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "catalog-preflight-home-")));
  temporaryHomes.push(home);
  const authorizationUrls: string[] = [];
  const requests: Array<BaiduOAuthRequest | BaiduCatalogListRequest> = [];
  const responses: BaiduCatalogListResponse[] = [];
  const confirmation = new ScriptedConfirmation();
  const catalogRoot = resolveCatalogRoot(environment(home));
  const runtime = createNormalCloudCatalogRuntime({
    catalogRoot,
    host: {
      secretStorage: new MemorySecretStorage(),
      openAuthorizationPage: async (url) => { authorizationUrls.push(url); },
      request: async (request) => {
        requests.push(request);
        const response = responses.shift();
        if (response === undefined) throw new Error("missing-synthetic-response");
        return response;
      },
      copyText: async () => undefined,
      openBaidu: async () => undefined,
    },
    createScanId: () => "scan-small-folder-synthetic",
  });
  await runtime.initialize();
  const controller = controllerFixture({ catalog: runtime, catalogConfirmation: confirmation }).controller;
  return {
    authorizationUrls,
    catalogRoot,
    confirmation,
    controller,
    home,
    requests,
    responses,
    runtime,
  };
};

const authorize = async (fixture: Awaited<ReturnType<typeof createFixture>>): Promise<void> => {
  await fixture.controller.connectCatalog({
    appKey: "app-key-sentinel",
    secretKey: "secret-key-sentinel",
  });
  fixture.responses.push({
    status: 200,
    text: JSON.stringify({
      access_token: "access-token-sentinel",
      refresh_token: "refresh-token-sentinel",
      expires_in: 3600,
    }),
  });
  await fixture.controller.submitCatalogAuthorizationCode("one-time-code-sentinel");
};

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe("small-folder catalog preflight", () => {
  it("requires final confirmation and performs only one synthetic read-only list request", async () => {
    const fixture = await createFixture();

    await fixture.controller.connectCatalog({
      appKey: "app-key-sentinel",
      secretKey: "secret-key-sentinel",
    });
    expect(fixture.authorizationUrls).toHaveLength(1);
    expect(fixture.requests).toEqual([]);
    const authorization = new URL(fixture.authorizationUrls[0]!);
    expect(authorization.searchParams.get("redirect_uri")).toBe("oob");
    expect(authorization.searchParams.get("scope")).toBe("basic,netdisk");

    fixture.responses.push({
      status: 200,
      text: JSON.stringify({
        access_token: "access-token-sentinel",
        refresh_token: "refresh-token-sentinel",
        expires_in: 3600,
      }),
    });
    await fixture.controller.submitCatalogAuthorizationCode("one-time-code-sentinel");
    expect(fixture.requests).toHaveLength(1);
    expect(new URL(fixture.requests[0]!.url).pathname).toBe("/oauth/2.0/token");

    fixture.confirmation.results.push(false);
    await fixture.controller.requestCatalogScan("/synthetic-small-folder");
    expect(fixture.requests).toHaveLength(1);

    fixture.confirmation.results.push(true);
    fixture.responses.push({
      status: 200,
      text: JSON.stringify({
        errno: 0,
        list: [{
          fs_id: "9007199254740993",
          path: "/synthetic-small-folder/sample.pdf",
          server_filename: "sample.pdf",
          size: 7,
          server_mtime: 11,
          isdir: 0,
        }],
      }),
    });
    await fixture.controller.requestCatalogScan("/synthetic-small-folder");

    expect(fixture.confirmation.requests).toEqual([
      "/synthetic-small-folder",
      "/synthetic-small-folder",
    ]);
    expect(fixture.requests).toHaveLength(2);
    const listRequest = fixture.requests[1]!;
    const listUrl = new URL(listRequest.url);
    expect(listRequest.method).toBe("GET");
    expect(listRequest.body).toBeUndefined();
    expect(listUrl.origin).toBe("https://pan.baidu.com");
    expect(listUrl.pathname).toBe("/rest/2.0/xpan/file");
    expect(listUrl.searchParams.get("method")).toBe("list");
    expect(listUrl.searchParams.get("dir")).toBe("/synthetic-small-folder");
    const listRequests = fixture.requests.filter((request) =>
      new URL(request.url).pathname === "/rest/2.0/xpan/file");
    expect(listRequests).toHaveLength(1);
    expect(listRequests.every((request) => request.method === "GET")).toBe(true);
    expect(listRequests.every((request) => request.body === undefined)).toBe(true);
    expect(listRequests.every((request) => new URL(request.url).searchParams.get("method") === "list"))
      .toBe(true);
    expect(fixture.requests.filter((request) => /download|dlink|filemanager/iu.test(request.url)))
      .toEqual([]);
    expect(fixture.runtime.snapshot()).toMatchObject({
      status: "ready",
      pdfCount: 1,
      total: 1,
    });
    const receipt = await new LocalCatalogSnapshotAdapter(fixture.catalogRoot)
      .loadReceipt("scan-small-folder-synthetic");
    expect(receipt).toMatchObject({
      schemaVersion: 2,
      status: "complete",
      stopReason: "complete",
      budget: {
        maxPdfCount: 1_000,
        maxDirectoryCount: 20,
        maxListRequestCount: 25,
        maxDurationMs: 120_000,
      },
      listRequestCount: 1,
      directoryCount: 0,
      pdfCount: 1,
      ignoredFileCount: 0,
      downloadedPdfBytes: 0,
    });
    expect((await readdir(fixture.home, { recursive: true }))
      .filter((path) => path.toLocaleLowerCase("en-US").endsWith(".pdf"))).toEqual([]);

    fixture.controller.dispose();
    fixture.runtime.dispose();
  });

  it("rejects the cloud root before confirmation or list traffic at both public scan gates", async () => {
    const fixture = await createFixture();
    await authorize(fixture);
    fixture.confirmation.results.push(true);

    await expect(fixture.controller.requestCatalogScan("/")).rejects.toMatchObject({
      code: "invalid-scan-root",
    });
    expect(fixture.confirmation.requests).toEqual([]);
    await expect(fixture.runtime.connection?.startScan("/")).rejects.toMatchObject({
      code: "invalid-scan-root",
    });
    expect(fixture.requests).toHaveLength(1);

    fixture.controller.dispose();
    fixture.runtime.dispose();
  });
});
