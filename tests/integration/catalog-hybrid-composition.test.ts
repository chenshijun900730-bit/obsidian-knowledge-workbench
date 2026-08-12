import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNormalCloudCatalogRuntime,
  resolveCatalogRoot,
  type NormalCatalogEnvironment,
} from "../../src/runtime/normal-cloud-catalog-composition";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MemorySecretStorage {
  readonly values = new Map<string, string>();
  getSecret(id: string): string | null { return this.values.get(id) ?? null; }
  setSecret(id: string, secret: string): void { this.values.set(id, secret); }
}

const environment = (homeDirectory: string): NormalCatalogEnvironment => ({
  platform: "darwin",
  homeDirectory,
});

describe("normal hybrid catalog composition", () => {
  it("keeps imported candidates isolated between explicitly scoped catalog roots", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "knowledge-workbench-hybrid-isolation-")));
    roots.push(home);
    const inventoryDirectory = join(home, "synthetic-input");
    await mkdir(inventoryDirectory);
    const inventoryPath = join(inventoryDirectory, "private-tree.txt");
    await writeFile(inventoryPath, "├── Science\n│   └── Alpha.pdf\n", "utf8");
    const requests: unknown[] = [];
    const createRuntime = (catalogRoot: string) => createNormalCloudCatalogRuntime({
      catalogRoot,
      host: {
        secretStorage: new MemorySecretStorage(),
        openAuthorizationPage: async () => undefined,
        request: async (request) => {
          requests.push(request);
          throw new Error("unexpected-host-request");
        },
        copyText: async () => undefined,
        openBaidu: async () => undefined,
      },
      createImportId: () => "import-isolation-synthetic",
      createUnifiedSnapshotId: () => "unified-isolation-synthetic",
      now: () => 100,
    });

    const first = createRuntime(join(home, "catalog-one"));
    await first.initialize();
    await first.hybrid?.previewTxt(inventoryPath);
    await first.hybrid?.importTxt(inventoryPath);
    await first.initialize();

    const second = createRuntime(join(home, "catalog-two"));
    await second.initialize();

    expect(first.hybrid?.snapshot()).toMatchObject({
      status: "ready",
      active: { pdfCount: 1, unverifiedCount: 1 },
    });
    expect(second.hybrid?.snapshot()).toEqual({ status: "empty" });
    expect(requests).toEqual([]);

    first.dispose();
    second.dispose();
  });

  it("initializes local hybrid state and imports candidates without a Baidu request", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "knowledge-workbench-hybrid-home-")));
    roots.push(home);
    const inventoryDirectory = join(home, "synthetic-input");
    await mkdir(inventoryDirectory);
    const inventoryPath = join(inventoryDirectory, "private-tree.txt");
    await writeFile(
      inventoryPath,
      "├── Science\n│   ├── Alpha.pdf\n│   └── Beta.pdf\n",
      "utf8",
    );
    const requests: unknown[] = [];
    const catalogRoot = resolveCatalogRoot(environment(home));
    const runtime = createNormalCloudCatalogRuntime({
      catalogRoot,
      host: {
        secretStorage: new MemorySecretStorage(),
        openAuthorizationPage: async () => undefined,
        request: async (request) => {
          requests.push(request);
          throw new Error("unexpected-host-request");
        },
        copyText: async () => undefined,
        openBaidu: async () => undefined,
      },
      createScanId: () => "scan-synthetic",
      createImportId: () => "import-synthetic",
      createUnifiedSnapshotId: () => "unified-synthetic",
      createBatchId: () => "batch-synthetic",
      now: () => 100,
    });

    expect(runtime.hybrid).toBeDefined();
    await runtime.initialize();
    expect(requests).toEqual([]);
    expect(runtime.hybrid?.snapshot()).toEqual({ status: "empty" });
    expect(runtime.snapshot()).toMatchObject({ status: "no-snapshot", source: "none" });

    await runtime.hybrid?.previewTxt(inventoryPath);
    expect(runtime.hybrid?.snapshot()).toMatchObject({
      status: "previewed",
      candidate: { pdfCount: 2, directoryCount: 1 },
    });
    await runtime.hybrid?.importTxt(inventoryPath);
    await runtime.initialize();

    expect(requests).toEqual([]);
    expect(runtime.hybrid?.snapshot()).toMatchObject({
      status: "ready",
      active: { pdfCount: 2, unverifiedCount: 2 },
    });
    expect(runtime.snapshot()).toMatchObject({
      status: "ready",
      source: "unified",
      pdfCount: 2,
      total: 2,
    });
    const serialized = JSON.stringify(runtime.snapshot());
    expect(serialized).not.toContain(inventoryPath);
    expect(serialized).not.toContain(catalogRoot);
    expect((await stat(join(catalogRoot, "hybrid"))).isDirectory())
      .toBe(true);
    expect(await readFile(inventoryPath, "utf8")).toContain("Alpha.pdf");

    runtime.dispose();
  });
});
