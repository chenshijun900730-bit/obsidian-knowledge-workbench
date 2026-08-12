import { describe, expect, it } from "vitest";
import {
  ClassificationService,
  classifyRecords,
  createIndexPathPolicy,
  isExcluded,
  suggestFolderRules,
} from "../../../src/classification/classification-service";
import { classificationIndexFixture } from "../../helpers/classification-fixtures";

describe("ClassificationService", () => {
  const service = new ClassificationService();

  it("uses explicit kind before the first matching folder rule", () => {
    const record = { path: "导入/mine.md", ownedFields: { "knowledge-workbench-kind": "note" } } as never;
    const settings = { folderRules: [{ prefix: "导入", kind: "reference" }], excludedPrefixes: [] } as never;
    expect(service.classify(record, settings)).toEqual({ kind: "note", reason: "explicit-property" });
  });

  it("normalizes Unicode and evaluates ordered folder rules", () => {
    const record = { path: "资料库/AI/说明.md", ownedFields: {} } as never;
    const settings = {
      folderRules: [
        { prefix: "资料库/AI", kind: "reference" },
        { prefix: "资料库", kind: "note" },
      ],
      excludedPrefixes: [],
    } as never;
    expect(service.classify(record, settings)).toEqual({ kind: "reference", reason: "folder-rule:资料库/AI" });
  });

  it("normalizes composed Unicode and slash forms while preserving the original rule reason", () => {
    const decomposedPrefix = "Cafe\u0301\\AI/";
    expect(decomposedPrefix).not.toBe("Café/AI/");
    const record = { path: "Café/AI/说明.md", ownedFields: {} } as never;
    const settings = { folderRules: [{ prefix: decomposedPrefix, kind: "reference" }] } as never;
    expect(service.classify(record, settings)).toEqual({
      kind: "reference",
      reason: `folder-rule:${decomposedPrefix}`,
    });
  });

  it("matches folder rules only at a segment boundary", () => {
    const record = { path: "资料库-other/说明.md", ownedFields: {} } as never;
    const settings = { folderRules: [{ prefix: "资料库", kind: "reference" }] } as never;
    expect(service.classify(record, settings)).toEqual({ kind: "unclassified", reason: "no-rule" });
  });

  it("ignores invalid explicit kinds before applying folder rules", () => {
    const record = {
      path: "资料/说明.md",
      ownedFields: { "knowledge-workbench-kind": "unclassified" },
    } as never;
    const settings = { folderRules: [{ prefix: "资料", kind: "reference" }] } as never;
    expect(service.classify(record, settings)).toEqual({ kind: "reference", reason: "folder-rule:资料" });
  });

  it.each([".config-dir/plugins/readme.md", ".hidden/note.md", "排除/secret.md"])(
    "keeps excluded path %s out of initial and incremental indexes",
    async (path) => {
      const fixture = await classificationIndexFixture(["allowed.md", path], { excludedPrefixes: ["排除"] });
      expect(fixture.index.activeRecords().map((record) => record.path)).toEqual(["allowed.md"]);
      fixture.vault.applyEvent("create", path);
      await fixture.index.applyEvents([{ kind: "create", path }]);
      expect(fixture.index.activeRecords().map((record) => record.path)).toEqual(["allowed.md"]);
    },
  );

  it("normalizes exclusion prefixes and respects exact segment boundaries", () => {
    const settings = { excludedPrefixes: ["", "Cafe\u0301\\Private\\", "排除/"] } as never;
    expect(isExcluded("Café/Private/secret.md", settings)).toBe(true);
    expect(isExcluded("排除", settings)).toBe(true);
    expect(isExcluded("排除-other/secret.md", settings)).toBe(false);
    expect(isExcluded("visible/.cache/secret.md", settings)).toBe(true);
  });

  it("keeps a leading dot segment visible while normalizing backslashes", () => {
    expect(isExcluded(".\\config\\secret.md", { excludedPrefixes: [] })).toBe(true);
  });

  it("uses a canonical policy key and reads current settings for every inclusion check", () => {
    let settings = { excludedPrefixes: ["Z/", "Cafe\u0301\\", "", "Z"] };
    const policy = createIndexPathPolicy(() => settings);
    const canonicalKey = JSON.stringify(["Café", "Z"]);
    expect(policy.key()).toBe(canonicalKey);
    expect(policy.includes("later/visible.md")).toBe(true);

    settings = { excludedPrefixes: ["Café/", "Z\\", "Café"] };
    expect(policy.key()).toBe(canonicalKey);

    settings = { excludedPrefixes: ["Z\\", "Café/", "later"] };
    expect(policy.key()).not.toBe(canonicalKey);
    expect(policy.includes("later/visible.md")).toBe(false);
  });

  it("canonicalizes descendant and fixed hidden exclusions without widening boundaries", () => {
    const parentOnly = createIndexPathPolicy(() => ({ excludedPrefixes: ["foo"] }));
    const redundantDescendants = createIndexPathPolicy(() => ({
      excludedPrefixes: ["foo/bar/deep", "foo", "foo/bar"],
    }));
    const noUserExclusions = createIndexPathPolicy(() => ({ excludedPrefixes: [] }));
    const fixedHiddenExclusions = createIndexPathPolicy(() => ({
      excludedPrefixes: [".hidden", "a/.private"],
    }));

    expect(redundantDescendants.key()).toBe(parentOnly.key());
    expect(fixedHiddenExclusions.key()).toBe(noUserExclusions.key());
    expect(parentOnly.includes("foo")).toBe(false);
    expect(parentOnly.includes("foo/bar/note.md")).toBe(false);
    expect(parentOnly.includes("foo-other/note.md")).toBe(true);
    expect(parentOnly.includes("foobar/note.md")).toBe(true);
  });

  it("projects only kind without mutating input records or persisted extracted data", async () => {
    const fixture = await classificationIndexFixture(["资料/说明.md"]);
    const input = fixture.index.activeRecords();
    const original = input[0];
    const snapshot = structuredClone(input);
    const settings = { folderRules: [{ prefix: "资料", kind: "reference" }] } as never;

    const projection = classifyRecords(input, service, settings);

    expect(input).toEqual(snapshot);
    expect(projection.records[0]).toEqual({ ...original, kind: "reference" });
    expect(projection.records[0]).not.toBe(original);
    expect(projection.resultsById[original?.id ?? "missing"]).toEqual({
      kind: "reference",
      reason: "folder-rule:资料",
    });
    expect(fixture.store.activeIndex()?.records[0]?.kind).toBe("unclassified");
  });

  it("suggests only stable top and second-level reference rules at the 8-of-10 threshold", async () => {
    const accepted = Array.from({ length: 10 }, (_, index) => `alpha/topic/deep/note-${index}.md`);
    const rejected = Array.from({ length: 10 }, (_, index) => `beta/topic/note-${index}.md`);
    const tooSmall = Array.from({ length: 9 }, (_, index) => `small/topic/note-${index}.md`);
    const fixture = await classificationIndexFixture([...accepted, ...rejected, ...tooSmall]);
    const records = fixture.index.activeRecords().map((record) => {
      const leaf = Number(record.path.match(/(\d+)\.md$/u)?.[1] ?? -1);
      if (record.path.startsWith("alpha/")) return { ...record, kind: leaf < 8 ? "unclassified" as const : "note" as const };
      if (record.path.startsWith("beta/")) return { ...record, kind: leaf < 7 ? "unclassified" as const : "note" as const };
      return record;
    });
    const snapshot = structuredClone(records);

    const proposals = suggestFolderRules([...records].reverse());

    expect(proposals).toEqual([
      {
        prefix: "alpha",
        kind: "reference",
        noteCount: 10,
        unclassifiedCount: 8,
        samplePaths: [
          "alpha/topic/deep/note-0.md",
          "alpha/topic/deep/note-1.md",
          "alpha/topic/deep/note-2.md",
        ],
      },
      {
        prefix: "alpha/topic",
        kind: "reference",
        noteCount: 10,
        unclassifiedCount: 8,
        samplePaths: [
          "alpha/topic/deep/note-0.md",
          "alpha/topic/deep/note-1.md",
          "alpha/topic/deep/note-2.md",
        ],
      },
    ]);
    expect(records).toEqual(snapshot);
  });

  it("removes newly excluded active data before a new scan replaces stale staging", async () => {
    const paths = [
      "blocked/secret.md",
      ...Array.from({ length: 250 }, (_, index) => `notes/note-${String(index).padStart(3, "0")}.md`),
    ];
    const fixture = await classificationIndexFixture(paths);
    const oldScan = new AbortController();
    await expect(fixture.index.buildInitial(oldScan.signal, ({ completed }) => {
      if (completed === paths.length) oldScan.abort();
    })).rejects.toMatchObject({ name: "AbortError" });
    const stale = fixture.store.staging();
    expect(stale?.records.some((record) => record.path === "blocked/secret.md")).toBe(true);

    await fixture.store.saveSettings({ ...fixture.store.settings(), excludedPrefixes: ["blocked"] });
    await fixture.index.reconcilePathPolicy();
    expect(fixture.index.activeRecords().some((record) => record.path === "blocked/secret.md")).toBe(false);
    expect(fixture.store.activeIndex()?.records.some((record) => record.path === "blocked/secret.md")).toBe(false);

    const savesBeforeNewScan = fixture.port.saveCalls.length;
    await fixture.index.buildInitial(new AbortController().signal, () => undefined);
    const replacementScanIds = fixture.port.saveCalls.slice(savesBeforeNewScan).flatMap((call) => {
      const staging = (call as { readonly staging?: { readonly scanId?: unknown } | null }).staging;
      return typeof staging?.scanId === "string" ? [staging.scanId] : [];
    });
    expect(replacementScanIds.length).toBeGreaterThan(0);
    expect(new Set(replacementScanIds)).toHaveLength(1);
    expect(replacementScanIds[0]).not.toBe(stale?.scanId);
    expect(fixture.index.activeRecords().some((record) => record.path === "blocked/secret.md")).toBe(false);
    expect(fixture.store.staging()).toBeNull();
  });

  it("changes scan ID for a real policy change without changing the filtered inventory", async () => {
    const paths = Array.from({ length: 251 }, (_, index) => `notes/note-${String(index).padStart(3, "0")}.md`);
    const fixture = await classificationIndexFixture(paths);
    const filteredPaths = async (): Promise<readonly string[]> => (await fixture.vault.listMarkdownFiles())
      .filter((file) => fixture.pathPolicy.includes(file.path))
      .map((file) => file.path);
    const cancelWithCheckpoint = async (): Promise<string> => {
      const controller = new AbortController();
      await expect(fixture.index.buildInitial(controller.signal, ({ completed }) => {
        if (completed === paths.length) controller.abort();
      })).rejects.toMatchObject({ name: "AbortError" });
      const scanId = fixture.store.staging()?.scanId;
      expect(scanId).toEqual(expect.any(String));
      return scanId ?? "missing-scan-id";
    };

    const inventoryBefore = await filteredPaths();
    const oldScanId = await cancelWithCheckpoint();
    await fixture.store.saveSettings({ ...fixture.store.settings(), excludedPrefixes: ["currently-absent"] });
    expect(await filteredPaths()).toEqual(inventoryBefore);

    const newScanId = await cancelWithCheckpoint();
    expect(newScanId).not.toBe(oldScanId);
    await expect(fixture.store.promoteStaging(oldScanId, 200)).rejects.toThrow("Staging scan ID does not match");
    expect(fixture.store.staging()?.scanId).toBe(newScanId);
  });
});
