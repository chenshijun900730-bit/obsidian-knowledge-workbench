import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalHybridCatalogAdapter,
  type HybridAtomicRenamePort,
} from "../../../src/adapters/local-hybrid-catalog-adapter";
import type { CandidateImportWriter } from "../../../src/catalog/hybrid-catalog-ports";
import {
  HybridCatalogError,
  type CatalogDifferenceRecordV1,
  type CatalogReconciliationResult,
  type CatalogTxtImportSummary,
  type TxtCandidateRecordV1,
  type UnifiedCatalogRecordV1,
} from "../../../src/catalog/hybrid-catalog-types";

const roots: string[] = [];
const HASH_A = "a".repeat(64);

const temporaryRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "knowledge-workbench-hybrid-")));
  roots.push(root);
  return root;
};

const candidate = (name = "A.pdf"): TxtCandidateRecordV1 => ({
  schemaVersion: 1,
  source: "txt-candidate",
  candidateId: `txt:${(name === "A.pdf" ? "a" : "b").repeat(64)}`,
  relativePath: `Synthetic/${name}`,
  parentRelativePath: "Synthetic",
  filename: name,
  title: name.slice(0, -4),
  isbnCandidates: [],
  topLevelGroupId: `group:${"c".repeat(64)}`,
  hierarchyTags: ["folder/Synthetic"],
});

const summary = (pdfCount = 1, sourceSha256 = HASH_A): CatalogTxtImportSummary => ({
  sourceSha256,
  byteSize: 100,
  nonEmptyLineCount: pdfCount + 1,
  pdfCount,
  directoryCount: 1,
  ignoredLeafCount: 0,
  normalizedWhitespaceCount: 0,
  maxDepth: 2,
});

const verifiedRecord = (base = candidate(), fsId = "1"): UnifiedCatalogRecordV1 => ({
  schemaVersion: 1,
  catalogId: `baidu:${fsId}`,
  candidateId: base.candidateId,
  fsId,
  relativePath: base.relativePath,
  cloudPath: `/Library/${base.relativePath}`,
  filename: base.filename,
  title: base.title,
  isbnCandidates: [],
  sizeBytes: 7,
  serverModifiedAt: 11,
  topLevelGroupId: base.topLevelGroupId,
  hierarchyTags: base.hierarchyTags,
  verificationStatus: "verified",
  differenceKinds: [],
  visibleByDefault: true,
});

const overlayInput = (
  records: readonly UnifiedCatalogRecordV1[],
  differences: readonly CatalogDifferenceRecordV1[] = [],
  completedAt = 200,
): CatalogReconciliationResult => ({
  sourceImportSha256: HASH_A,
  topLevelGroupId: candidate().topLevelGroupId,
  completedAt,
  records,
  differences,
  supersededCatalogIds: [],
});

const commit = async (
  adapter: LocalHybridCatalogAdapter,
  importId: string,
  records: readonly TxtCandidateRecordV1[] = [candidate()],
  sourceSha256 = HASH_A,
): Promise<Awaited<ReturnType<CandidateImportWriter["commit"]>>> => {
  const writer = await adapter.createCandidateImport(importId);
  for (const record of records) await writer.append(record);
  return writer.commit({ summary: summary(records.length, sourceSha256), importedAt: 100 });
};

class ScriptedRenamePort implements HybridAtomicRenamePort {
  suffix: string | null = null;
  abortSuffix: string | null = null;
  abortController: AbortController | null = null;

  failNextDestination(suffix: string): void { this.suffix = suffix; }
  abortAfterDestination(suffix: string, controller: AbortController): void {
    this.abortSuffix = suffix;
    this.abortController = controller;
  }

  async rename(source: string, destination: string): Promise<void> {
    if (this.suffix !== null && destination.endsWith(this.suffix)) {
      this.suffix = null;
      throw new Error("injected-rename-failure");
    }
    await rename(source, destination);
    if (this.abortSuffix !== null && destination.endsWith(this.abortSuffix)) {
      this.abortSuffix = null;
      this.abortController?.abort();
      this.abortController = null;
    }
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LocalHybridCatalogAdapter", () => {
  it("persists one complete import with private permissions and no source path", async () => {
    const root = await temporaryRoot();
    const adapter = new LocalHybridCatalogAdapter(root);
    const descriptor = await commit(adapter, "import-1");
    const active = await adapter.loadActiveCandidates();

    expect(active).toEqual({ descriptor, records: [candidate()] });
    (active?.records[0]?.hierarchyTags as string[]).push("folder/Changed");
    expect((await adapter.loadActiveCandidates())?.records[0]?.hierarchyTags)
      .toEqual(["folder/Synthetic"]);

    const hybrid = join(root, "hybrid");
    const importDirectory = join(hybrid, "imports", "import-1");
    expect((await stat(hybrid)).mode & 0o777).toBe(0o700);
    expect((await stat(importDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(importDirectory, "candidates.ndjson"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(importDirectory, "receipt.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(hybrid, "candidate-active.json"))).mode & 0o777).toBe(0o600);
    const persisted = [
      await readFile(join(importDirectory, "receipt.json"), "utf8"),
      await readFile(join(hybrid, "candidate-active.json"), "utf8"),
    ].join("\n");
    expect(persisted).not.toContain("sourcePath");
    expect(persisted).not.toContain("/private/");
  });

  it("loads only selected candidate groups while preserving full-file integrity", async () => {
    const root = await temporaryRoot();
    const adapter = new LocalHybridCatalogAdapter(root);
    const first = candidate();
    const second: TxtCandidateRecordV1 = {
      ...candidate("B.pdf"),
      relativePath: "Other/B.pdf",
      parentRelativePath: "Other",
      topLevelGroupId: `group:${"d".repeat(64)}`,
      hierarchyTags: ["folder/Other"],
    };
    const descriptor = await commit(adapter, "import-selected", [first, second]);

    await expect(adapter.loadActiveCandidateDescriptor()).resolves.toEqual(descriptor);
    await expect(adapter.loadActiveCandidateGroups([first.topLevelGroupId])).resolves.toEqual({
      descriptor,
      records: [first],
    });
    await expect(adapter.loadActiveCandidateGroups([second.topLevelGroupId])).resolves.toEqual({
      descriptor,
      records: [second],
    });
  });

  it("makes commit idempotent and rejects append after completion", async () => {
    const adapter = new LocalHybridCatalogAdapter(await temporaryRoot());
    const writer = await adapter.createCandidateImport("import-1");
    await writer.append(candidate());
    const first = await writer.commit({ summary: summary(), importedAt: 100 });
    await expect(writer.commit({ summary: summary(), importedAt: 100 })).resolves.toEqual(first);
    await expect(writer.append(candidate("B.pdf"))).rejects.toEqual(
      new HybridCatalogError("hybrid-snapshot-corrupt"),
    );
  });

  it("aborts incomplete staging without replacing the active import", async () => {
    const root = await temporaryRoot();
    const adapter = new LocalHybridCatalogAdapter(root);
    await commit(adapter, "import-1");
    const writer = await adapter.createCandidateImport("import-2");
    await writer.append(candidate("B.pdf"));
    await writer.abort();

    expect((await adapter.loadActiveCandidates())?.descriptor.importId).toBe("import-1");
    expect(await readdir(join(root, "hybrid", "imports"))).toEqual(["import-1"]);
  });

  it("preserves the prior active import when commit is canceled", async () => {
    const root = await temporaryRoot();
    const adapter = new LocalHybridCatalogAdapter(root);
    await commit(adapter, "import-1");
    const writer = await adapter.createCandidateImport("import-2");
    await writer.append(candidate("B.pdf"));
    const controller = new AbortController();
    controller.abort();

    await expect(writer.commit({
      summary: summary(),
      importedAt: 200,
      signal: controller.signal,
    })).rejects.toEqual(new HybridCatalogError("hybrid-snapshot-corrupt"));
    await writer.abort();

    expect((await adapter.loadActiveCandidates())?.descriptor.importId).toBe("import-1");
    expect(await readdir(join(root, "hybrid", "imports"))).toEqual(["import-1"]);
  });

  it("rolls back candidate activation when cancellation wins the final atomic write", async () => {
    const root = await temporaryRoot();
    const renames = new ScriptedRenamePort();
    const adapter = new LocalHybridCatalogAdapter(root, renames);
    await commit(adapter, "import-1");
    const writer = await adapter.createCandidateImport("import-2");
    await writer.append(candidate("B.pdf"));
    const controller = new AbortController();
    renames.abortAfterDestination("candidate-active.json", controller);

    await expect(writer.commit({
      summary: summary(),
      importedAt: 200,
      signal: controller.signal,
    })).rejects.toEqual(new HybridCatalogError("hybrid-snapshot-corrupt"));

    expect((await adapter.loadActiveCandidates())?.descriptor.importId).toBe("import-1");
    expect(await readdir(join(root, "hybrid", "imports"))).toEqual(["import-1"]);
  });

  it.each([
    "candidates.ndjson",
    "receipt.json",
    "import-2",
    "candidate-active.json",
  ])("preserves the prior active import when atomic replacement of %s fails", async (suffix) => {
    const root = await temporaryRoot();
    const renames = new ScriptedRenamePort();
    const adapter = new LocalHybridCatalogAdapter(root, renames);
    await commit(adapter, "import-1");
    renames.failNextDestination(suffix);
    const writer = await adapter.createCandidateImport("import-2");
    await writer.append(candidate("B.pdf"));

    await expect(writer.commit({ summary: summary(), importedAt: 200 })).rejects.toEqual(
      new HybridCatalogError("hybrid-snapshot-corrupt"),
    );
    await writer.abort();
    expect((await adapter.loadActiveCandidates())?.descriptor.importId).toBe("import-1");
    const importEntries = await readdir(join(root, "hybrid", "imports"));
    expect(importEntries).not.toContain(".staging-import-2");
    expect(importEntries).not.toContain("import-2");
  });

  it("rejects corrupt NDJSON, unknown receipt keys, broad permissions, and symlinks", async () => {
    const corruptions = [
      async (root: string) => writeFile(
        join(root, "hybrid", "imports", "import-1", "candidates.ndjson"),
        "not-json\n",
        "utf8",
      ),
      async (root: string) => {
        const receiptPath = join(root, "hybrid", "imports", "import-1", "receipt.json");
        const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
        receipt.sourcePath = "/private/source.txt";
        await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");
      },
      async (root: string) => chmod(
        join(root, "hybrid", "imports", "import-1", "candidates.ndjson"),
        0o644,
      ),
      async (root: string) => rm(
        join(root, "hybrid", "imports", "import-1", "receipt.json"),
      ),
      async (root: string) => {
        const path = join(root, "hybrid", "imports", "import-1", "candidates.ndjson");
        const target = join(root, "target.ndjson");
        await writeFile(target, `${JSON.stringify(candidate())}\n`, "utf8");
        await rm(path);
        await symlink(target, path);
      },
    ];

    for (const corrupt of corruptions) {
      const root = await temporaryRoot();
      const adapter = new LocalHybridCatalogAdapter(root);
      await commit(adapter, "import-1");
      await corrupt(root);
      await expect(adapter.loadActiveCandidates()).rejects.toEqual(
        new HybridCatalogError("hybrid-snapshot-corrupt"),
      );
    }
  });

  it("rejects invalid IDs, duplicate candidates, and summary count mismatches", async () => {
    const adapter = new LocalHybridCatalogAdapter(await temporaryRoot());
    expect(() => new LocalHybridCatalogAdapter("/")).toThrow("hybrid-snapshot-corrupt");
    await expect(adapter.createCandidateImport("../escape")).rejects.toEqual(
      new HybridCatalogError("hybrid-snapshot-corrupt"),
    );
    const duplicate = await adapter.createCandidateImport("import-1");
    await duplicate.append(candidate());
    await expect(duplicate.append(candidate())).rejects.toEqual(
      new HybridCatalogError("hybrid-snapshot-corrupt"),
    );
    await duplicate.abort();

    const mismatch = await adapter.createCandidateImport("import-2");
    await mismatch.append(candidate());
    await expect(mismatch.commit({ summary: summary(2), importedAt: 100 })).rejects.toEqual(
      new HybridCatalogError("hybrid-snapshot-corrupt"),
    );
    await mismatch.abort();
  });

  it("rejects a symlinked import directory even when its files are valid", async () => {
    const root = await temporaryRoot();
    const adapter = new LocalHybridCatalogAdapter(root);
    await commit(adapter, "import-1");
    const importPath = join(root, "hybrid", "imports", "import-1");
    const moved = join(root, "moved-import");
    await rename(importPath, moved);
    await symlink(moved, importPath);
    expect((await lstat(importPath)).isSymbolicLink()).toBe(true);

    await expect(adapter.loadActiveCandidates()).rejects.toEqual(
      new HybridCatalogError("hybrid-snapshot-corrupt"),
    );
  });

  it("writes and reloads one strict unified snapshot", async () => {
    const root = await temporaryRoot();
    const adapter = new LocalHybridCatalogAdapter(root, undefined, () => "unified-1");
    await commit(adapter, "import-1");
    const base = candidate();
    const unified: UnifiedCatalogRecordV1 = {
      schemaVersion: 1,
      catalogId: base.candidateId,
      candidateId: base.candidateId,
      fsId: null,
      relativePath: base.relativePath,
      cloudPath: null,
      filename: base.filename,
      title: base.title,
      isbnCandidates: [],
      sizeBytes: null,
      serverModifiedAt: null,
      topLevelGroupId: base.topLevelGroupId,
      hierarchyTags: base.hierarchyTags,
      verificationStatus: "unverified",
      differenceKinds: [],
      visibleByDefault: true,
    };
    const differences: CatalogDifferenceRecordV1[] = [];
    const descriptor = await adapter.writeUnifiedSnapshot({
      sourceImportSha256: HASH_A,
      records: [unified],
      differences,
      completedAt: 200,
    });

    expect(await adapter.loadActiveUnified()).toEqual({
      descriptor,
      records: [unified],
      differences: [],
    });
    const activePath = join(root, "hybrid", "unified-active.json");
    const active = JSON.parse(await readFile(activePath, "utf8")) as Record<string, unknown>;
    expect(active).toMatchObject({
      schemaVersion: 2,
      candidateImportId: "import-1",
      sourceImportSha256: HASH_A,
    });
    delete active.candidateImportId;
    active.schemaVersion = 1;
    await writeFile(activePath, `${JSON.stringify(active)}\n`, "utf8");
    expect((await adapter.loadActiveUnified())?.descriptor).toEqual(descriptor);
    expect(await adapter.loadActiveOverlays()).toEqual([]);
    const directory = join(root, "hybrid", "unified", "unified-1");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "catalog.ndjson"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "differences.ndjson"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "descriptor.json"))).mode & 0o777).toBe(0o600);
  });

  it("keeps the prior unified snapshot active when final manifest replacement fails", async () => {
    const root = await temporaryRoot();
    const renames = new ScriptedRenamePort();
    let ordinal = 0;
    const adapter = new LocalHybridCatalogAdapter(root, renames, () => `unified-${++ordinal}`);
    await commit(adapter, "import-1");
    const base = candidate();
    const unified = {
      schemaVersion: 1,
      catalogId: base.candidateId,
      candidateId: base.candidateId,
      fsId: null,
      relativePath: base.relativePath,
      cloudPath: null,
      filename: base.filename,
      title: base.title,
      isbnCandidates: [],
      sizeBytes: null,
      serverModifiedAt: null,
      topLevelGroupId: base.topLevelGroupId,
      hierarchyTags: base.hierarchyTags,
      verificationStatus: "unverified",
      differenceKinds: [],
      visibleByDefault: true,
    } as const satisfies UnifiedCatalogRecordV1;
    await adapter.writeUnifiedSnapshot({
      sourceImportSha256: HASH_A,
      records: [unified],
      differences: [],
      completedAt: 200,
    });
    renames.failNextDestination("unified-active.json");
    await expect(adapter.writeUnifiedSnapshot({
      sourceImportSha256: HASH_A,
      records: [],
      differences: [],
      completedAt: 300,
    })).rejects.toEqual(new HybridCatalogError("hybrid-snapshot-corrupt"));
    expect((await adapter.loadActiveUnified())?.descriptor.snapshotId).toBe("unified-1");
    expect(await readdir(join(root, "hybrid", "unified"))).toEqual(["unified-1"]);
  });

  it("restores one prior candidate and unified activation pair", async () => {
    const root = await temporaryRoot();
    let ordinal = 0;
    const adapter = new LocalHybridCatalogAdapter(
      root,
      undefined,
      () => `unified-${++ordinal}`,
    );
    const firstCandidate = await commit(adapter, "import-1", [candidate()]);
    const firstRecord = verifiedRecord(candidate());
    const firstUnified = await adapter.writeUnifiedSnapshot({
      sourceImportSha256: HASH_A,
      records: [firstRecord],
      differences: [],
      completedAt: 200,
    });

    await commit(adapter, "import-2", [candidate("B.pdf")]);
    await adapter.writeUnifiedSnapshot({
      sourceImportSha256: HASH_A,
      records: [verifiedRecord(candidate("B.pdf"), "2")],
      differences: [],
      completedAt: 300,
    });
    expect((await adapter.loadActiveCandidates())?.descriptor.importId).toBe("import-2");
    expect((await adapter.loadActiveUnified())?.descriptor.snapshotId).toBe("unified-2");

    await adapter.restoreCatalogActivation({
      candidate: firstCandidate,
      unified: firstUnified,
    });

    expect((await adapter.loadActiveCandidates())?.descriptor.importId).toBe("import-1");
    expect((await adapter.loadActiveUnified())?.descriptor.snapshotId).toBe("unified-1");
  });

  it("fails closed on a partial activation restore and permits an exact retry", async () => {
    const root = await temporaryRoot();
    const renames = new ScriptedRenamePort();
    let ordinal = 0;
    const adapter = new LocalHybridCatalogAdapter(root, renames, () => `unified-${++ordinal}`);
    const firstCandidate = await commit(adapter, "import-1", [candidate()], HASH_A);
    const firstUnified = await adapter.writeUnifiedSnapshot({
      sourceImportSha256: HASH_A,
      records: [verifiedRecord(candidate())],
      differences: [],
      completedAt: 200,
    });
    await commit(adapter, "import-2", [candidate("B.pdf")], HASH_A);
    await adapter.writeUnifiedSnapshot({
      sourceImportSha256: HASH_A,
      records: [verifiedRecord(candidate("B.pdf"), "2")],
      differences: [],
      completedAt: 300,
    });
    renames.failNextDestination("unified-active.json");

    await expect(adapter.restoreCatalogActivation({
      candidate: firstCandidate,
      unified: firstUnified,
    })).rejects.toEqual(new HybridCatalogError("hybrid-snapshot-corrupt"));
    expect((await adapter.loadActiveCandidates())?.descriptor.importId).toBe("import-1");
    expect(await adapter.loadActiveUnified()).toBeNull();

    await expect(adapter.restoreCatalogActivation({
      candidate: firstCandidate,
      unified: firstUnified,
    })).resolves.toBeUndefined();
    expect((await adapter.loadActiveCandidates())?.descriptor.importId).toBe("import-1");
    expect((await adapter.loadActiveUnified())?.descriptor.snapshotId).toBe("unified-1");
  });

  it("keeps the prior unified activation when cancellation wins before publication", async () => {
    const root = await temporaryRoot();
    const renames = new ScriptedRenamePort();
    let ordinal = 0;
    const adapter = new LocalHybridCatalogAdapter(root, renames, () => `unified-${++ordinal}`);
    await commit(adapter, "import-1");
    const base = candidate();
    const record = verifiedRecord(base);
    await adapter.writeUnifiedSnapshot({
      sourceImportSha256: HASH_A,
      records: [record],
      differences: [],
      completedAt: 200,
    });
    const controller = new AbortController();
    renames.abortAfterDestination("unified-active.json", controller);

    await expect(adapter.writeUnifiedSnapshot({
      sourceImportSha256: HASH_A,
      records: [record],
      differences: [],
      completedAt: 300,
      signal: controller.signal,
    })).rejects.toEqual(new HybridCatalogError("hybrid-snapshot-corrupt"));

    expect((await adapter.loadActiveUnified())?.descriptor.snapshotId).toBe("unified-1");
    expect(await readdir(join(root, "hybrid", "unified"))).toEqual(["unified-1"]);
  });

  it("writes and reloads one immutable active group overlay", async () => {
    const root = await temporaryRoot();
    const adapter = new LocalHybridCatalogAdapter(
      root,
      undefined,
      undefined,
      () => "overlay-1",
    );
    await commit(adapter, "import-1");
    const record = verifiedRecord();
    const descriptor = await adapter.writeCatalogOverlay(overlayInput([record]));

    expect(await adapter.loadActiveOverlays()).toEqual([{
      descriptor,
      records: [record],
      differences: [],
      supersededCatalogIds: [],
    }]);
    const directory = join(root, "hybrid", "overlays", "overlay-1");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "records.ndjson"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "differences.ndjson"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "superseded.ndjson"))).mode & 0o777).toBe(0o600);
  });

  it("keeps the prior group overlay active when manifest replacement fails", async () => {
    const root = await temporaryRoot();
    const renames = new ScriptedRenamePort();
    let ordinal = 0;
    const adapter = new LocalHybridCatalogAdapter(
      root,
      renames,
      undefined,
      () => `overlay-${++ordinal}`,
    );
    await commit(adapter, "import-1");
    await adapter.writeCatalogOverlay(overlayInput([verifiedRecord()]));
    renames.failNextDestination("overlays-active.json");

    const archived: CatalogDifferenceRecordV1 = {
      schemaVersion: 1,
      catalogId: candidate().candidateId,
      topLevelGroupId: candidate().topLevelGroupId,
      kind: "cloud-missing",
      acknowledgedAt: 300,
    };
    await expect(adapter.writeCatalogOverlay(overlayInput([], [archived], 300)))
      .rejects.toEqual(new HybridCatalogError("hybrid-snapshot-corrupt"));
    expect((await adapter.loadActiveOverlays())[0]?.descriptor.overlayId).toBe("overlay-1");
  });

  it("rejects an older overlay without replacing the active group", async () => {
    const root = await temporaryRoot();
    let ordinal = 0;
    const adapter = new LocalHybridCatalogAdapter(
      root,
      undefined,
      undefined,
      () => `overlay-${++ordinal}`,
    );
    await commit(adapter, "import-1");
    await adapter.writeCatalogOverlay(overlayInput([verifiedRecord()], [], 200));

    await expect(adapter.writeCatalogOverlay(overlayInput([verifiedRecord()], [], 199)))
      .rejects.toEqual(new HybridCatalogError("hybrid-snapshot-corrupt"));
    expect((await adapter.loadActiveOverlays())[0]?.descriptor.overlayId).toBe("overlay-1");
  });
});
