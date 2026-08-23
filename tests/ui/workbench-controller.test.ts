import { describe, expect, it } from "vitest";
import {
  FakeCloudCatalogConnectionRuntime,
  FakeCloudCatalogRuntime,
  FakeHybridCatalogRuntime,
} from "../fakes/fake-cloud-catalog-runtime";
import { controllerFixture } from "../helpers/ui-fixtures";
import { HybridCatalogError } from "../../src/catalog/hybrid-catalog-types";
import type { CloudDirectoryDiscoveryRuntime } from "../../src/catalog/cloud-directory-discovery-service";
import type { CloudDirectoryLocatorRuntime } from "../../src/catalog/cloud-directory-locator";
import type {
  CloudDirectoryPickerPresenter,
  CloudDirectoryPickerRequest,
} from "../../src/ui/cloud-directory-picker";

describe("WorkbenchController cloud catalog filters", () => {
  it("opens the picker with a blank initial path and still rejects invalid nonblank paths", async () => {
    const searchQueries: string[] = [];
    const discoverCalls: string[] = [];
    const pickerCalls: Array<string | null> = [];
    const discovery: CloudDirectoryDiscoveryRuntime = {
      searchCached(query) { searchQueries.push(query); return []; },
      snapshotCached: () => [],
      async discoverMore(rootPath) {
        discoverCalls.push(rootPath);
        return {
          status: "complete",
          stopReason: "complete",
          rootPath,
          directoryCount: 0,
          listRequestCount: 1,
          elapsedMs: 1,
        };
      },
      clear: () => undefined,
      dispose: () => undefined,
    };
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, undefined, discovery),
    });
    const internals = fixture.controller as unknown as {
      readonly dependencies: {
        catalogDirectoryPicker?: CloudDirectoryPickerPresenter;
      };
    };
    internals.dependencies.catalogDirectoryPicker = {
      async request(input) {
        pickerCalls.push(input.initialPath);
        return "/Synthetic/Chosen";
      },
    };

    await expect(fixture.controller.chooseCatalogRoot("   "))
      .resolves.toBe("/Synthetic/Chosen");
    for (const invalid of ["/", "Synthetic", "/Synthetic//Child"]) {
      await expect(fixture.controller.chooseCatalogRoot(invalid))
        .rejects.toThrow("invalid-scan-root");
    }
    await expect(fixture.controller.chooseCatalogRoot("/Synthetic/e\u0301"))
      .resolves.toBe("/Synthetic/Chosen");

    expect(pickerCalls).toEqual([null, "/Synthetic/é"]);
    expect(searchQueries).toEqual([]);
    expect(discoverCalls).toEqual([]);
    fixture.controller.dispose();
  });

  it("builds one dynamic local candidate runtime and persists only recent paths atomically", async () => {
    const discovery: CloudDirectoryDiscoveryRuntime = {
      searchCached: () => [],
      snapshotCached: () => [{
        fsId: "cached-1",
        path: "/Cached/Science",
        filename: "Science",
      }],
      discoverMore: async (rootPath) => ({
        status: "complete",
        stopReason: "complete",
        rootPath,
        directoryCount: 0,
        listRequestCount: 1,
        elapsedMs: 1,
      }),
      clear: () => undefined,
      dispose: () => undefined,
    };
    const hybrid = new FakeHybridCatalogRuntime({
      status: "ready",
      active: {
        importedAt: 1,
        pdfCount: 1,
        unverifiedCount: 1,
        verifiedCount: 0,
        differenceCount: 0,
        cloudMissingCount: 0,
        groupCount: 1,
        verifiedGroupCount: 0,
        groups: [{
          groupKey: "group:science",
          label: "Science",
          pdfCount: 1,
          mode: "recursive",
          verificationStatus: "unverified",
        }],
      },
    });
    const locator = {
      locateByName: async () => { throw new Error("must-not-locate"); },
      cancel: () => undefined,
      dispose: () => undefined,
    } satisfies CloudDirectoryLocatorRuntime;
    const catalog = new FakeCloudCatalogRuntime({}, undefined, hybrid, discovery, locator);
    const fixture = controllerFixture({ catalog });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      recentCloudDirectories: {
        schemaVersion: 1,
        items: [{
          path: "/Recent/Literature",
          filename: "Literature",
          lastUsedAt: "1970-01-01T00:00:00.001Z",
        }],
      },
    });
    let request: CloudDirectoryPickerRequest | undefined;
    const internals = fixture.controller as unknown as {
      readonly dependencies: { catalogDirectoryPicker?: CloudDirectoryPickerPresenter };
    };
    internals.dependencies.catalogDirectoryPicker = {
      request: async (input) => { request = input; return "/Recent/Literature"; },
    };

    await fixture.controller.chooseCatalogRoot("");
    expect(request?.locator).toBe(locator);
    expect(request?.candidates.snapshot()).toEqual([
      expect.objectContaining({ source: "recent", path: "/Recent/Literature" }),
      expect.objectContaining({ source: "session-cache", path: "/Cached/Science" }),
      expect.objectContaining({ source: "txt-group", filename: "Science" }),
    ]);

    const journalBefore = [fixture.journal.listCalls, fixture.journal.clearCalls];
    await request?.candidates.remember("/Recent/New");
    expect(fixture.store.settings().recentCloudDirectories.items[0]).toEqual({
      path: "/Recent/New",
      filename: "New",
      lastUsedAt: "1970-01-01T00:00:00.100Z",
    });
    expect([fixture.journal.listCalls, fixture.journal.clearCalls]).toEqual(journalBefore);
    expect(fixture.store.settings()).toMatchObject({
      locale: "zh-CN",
      secretId: "",
    });

    await request?.candidates.clearRecent();
    expect(fixture.store.settings().recentCloudDirectories.items).toEqual([]);
    expect(request?.candidates.snapshot()).toEqual([
      expect.objectContaining({ source: "session-cache", path: "/Cached/Science" }),
      expect.objectContaining({ source: "txt-group", filename: "Science" }),
    ]);
    fixture.controller.dispose();
  });

  it("cancels lookup and clears session discovery before replacing or revoking credentials", async () => {
    const events: string[] = [];
    const connection = new FakeCloudCatalogConnectionRuntime();
    connection.saveApplicationCredentials = async (input) => {
      events.push("save");
      connection.savedCredentials.push(structuredClone(input));
    };
    connection.beginAuthorization = async () => {
      events.push("authorize");
      return { expiresAt: 1 };
    };
    connection.revoke = async () => { events.push("revoke"); };
    const discovery = {
      searchCached: () => [],
      snapshotCached: () => [],
      discoverMore: async () => { throw new Error("must-not-discover"); },
      clear: () => { events.push("clear"); },
      dispose: () => undefined,
    } satisfies CloudDirectoryDiscoveryRuntime;
    const locator = {
      locateByName: async () => { throw new Error("must-not-locate"); },
      cancel: () => { events.push("cancel"); },
      dispose: () => undefined,
    } satisfies CloudDirectoryLocatorRuntime;
    const catalog = new FakeCloudCatalogRuntime({}, connection, undefined, discovery, locator);
    const fixture = controllerFixture({ catalog });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      recentCloudDirectories: {
        schemaVersion: 1,
        items: [{
          path: "/Recent/Kept",
          filename: "Kept",
          lastUsedAt: "1970-01-01T00:00:00.001Z",
        }],
      },
    });

    await fixture.controller.connectCatalog({ appKey: "app", secretKey: "secret" });
    await fixture.controller.revokeCatalog();

    expect(events).toEqual([
      "cancel", "clear", "save", "authorize",
      "cancel", "clear", "revoke",
    ]);
    expect(fixture.store.settings().recentCloudDirectories.items).toHaveLength(1);
    fixture.controller.dispose();
  });

  it("keeps a local picker usable without discovery or locator and causes no cloud action", async () => {
    const connection = new FakeCloudCatalogConnectionRuntime();
    const hybrid = new FakeHybridCatalogRuntime({ status: "empty" });
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, connection, hybrid),
    });
    let request: CloudDirectoryPickerRequest | undefined;
    const internals = fixture.controller as unknown as {
      readonly dependencies: { catalogDirectoryPicker?: CloudDirectoryPickerPresenter };
    };
    internals.dependencies.catalogDirectoryPicker = {
      request: async (input) => { request = input; return "/Manual/Choice"; },
    };

    await expect(fixture.controller.chooseCatalogRoot(""))
      .resolves.toBe("/Manual/Choice");

    expect(request).not.toHaveProperty("locator");
    expect(request?.candidates.snapshot()).toEqual([]);
    expect(connection.startScanCalls).toEqual([]);
    expect(connection.beginAuthorizationCalls).toBe(0);
    expect(hybrid.startInputs).toEqual([]);
    expect(hybrid.resumeRoots).toEqual([]);
    fixture.controller.dispose();
  });

  it("keeps selection local across matching emissions and clears it before a record disappears", () => {
    const selected = {
      catalogId: "baidu:1",
      filename: "Selected.pdf",
      pathLabel: "Science/Selected.pdf",
      cloudPathAvailable: true,
      verificationStatus: "verified" as const,
      differenceKinds: [],
      hierarchyTags: ["folder/Science"],
    };
    const catalog = new FakeCloudCatalogRuntime({
      status: "ready",
      source: "unified",
      total: 1,
      items: [selected],
    });
    const fixture = controllerFixture({ catalog });

    fixture.controller.selectCatalogRecord(selected.catalogId);
    fixture.controller.setCatalogFiltersExpanded(true);
    expect(fixture.controller.snapshot()).toMatchObject({
      selectedCatalogId: selected.catalogId,
      catalogFiltersExpanded: true,
    });

    catalog.setSnapshot({ ...catalog.snapshot(), query: "Selected", items: [selected] });
    expect(fixture.controller.snapshot().selectedCatalogId).toBe(selected.catalogId);

    let selectedAtEmit: string | null | undefined;
    const unsubscribe = fixture.controller.subscribe(() => {
      selectedAtEmit = fixture.controller.snapshot().selectedCatalogId;
    });
    catalog.setSnapshot({ ...catalog.snapshot(), total: 0, items: [] });
    expect(selectedAtEmit).toBeNull();
    expect(fixture.controller.snapshot().selectedCatalogId).toBeNull();
    expect(catalog.snapshot()).not.toHaveProperty("selectedCatalogId");

    unsubscribe();
    fixture.controller.dispose();
  });

  it("delegates unified catalog filters and catalog IDs without changing local projections", async () => {
    const catalog = new FakeCloudCatalogRuntime({
      status: "ready",
      source: "unified",
      verificationStatuses: ["unverified"],
      differenceKinds: ["moved"],
    });
    const fixture = controllerFixture({ catalog });
    const before = fixture.controller.snapshot();

    fixture.controller.toggleCatalogStatus("unverified");
    fixture.controller.toggleCatalogStatus("verified");
    fixture.controller.toggleCatalogDifference("moved");
    fixture.controller.toggleCatalogDifference("renamed");
    fixture.controller.filterCatalogGroup("group:science");
    fixture.controller.filterCatalogTag("folder/Science");
    fixture.controller.toggleCatalogCloudMissing(true);
    await fixture.controller.copyCatalogFilename("txt:candidate");
    await fixture.controller.copyCatalogPath("baidu:verified");

    expect(catalog.verificationStatuses).toEqual([
      [],
      ["unverified", "verified"],
    ]);
    expect(catalog.differenceKinds).toEqual([
      [],
      ["moved", "renamed"],
    ]);
    expect(catalog.topLevelGroupIds).toEqual(["group:science"]);
    expect(catalog.hierarchyTagValues).toEqual(["folder/Science"]);
    expect(catalog.includeCloudMissingValues).toEqual([true]);
    expect(catalog.copiedFilenames).toEqual(["txt:candidate"]);
    expect(catalog.copiedPaths).toEqual(["baidu:verified"]);
    expect(fixture.controller.snapshot().today).toEqual(before.today);
    expect(fixture.controller.snapshot().map).toEqual(before.map);

    fixture.controller.dispose();
  });
});

describe("WorkbenchController locale", () => {
  it("persists English, emits once, and retains the current workbench state", async () => {
    const fixture = controllerFixture();
    fixture.controller.selectTab("cloud-catalog");
    fixture.controller.searchCatalog("climate");
    await fixture.controller.selectCenter({ kind: "document", id: "a" });
    const before = fixture.controller.snapshot();
    let emits = 0;
    const unsubscribe = fixture.controller.subscribe(() => { emits += 1; });

    await fixture.controller.setLocale("en");

    expect(fixture.store.settings().locale).toBe("en");
    expect(fixture.controller.snapshot().locale).toBe("en");
    expect(emits).toBe(1);
    expect(fixture.controller.snapshot().catalog.query).toBe(before.catalog.query);
    expect(fixture.controller.snapshot().activeTab).toBe(before.activeTab);
    expect(fixture.controller.snapshot().map.selected).toEqual(before.map.selected);

    unsubscribe();
    fixture.controller.dispose();
  });
});

describe("WorkbenchController start section", () => {
  it("switches Start locally without touching the catalog or Vault projections", () => {
    const fixture = controllerFixture();
    const before = fixture.controller.snapshot();
    let emits = 0;
    const unsubscribe = fixture.controller.subscribe(() => { emits += 1; });

    fixture.controller.selectStartSection("suggestions");

    expect(fixture.controller.snapshot().startSection).toBe("suggestions");
    expect(fixture.controller.snapshot().catalog).toEqual(before.catalog);
    expect(fixture.controller.snapshot().today).toEqual(before.today);
    expect(emits).toBe(1);

    unsubscribe();
    fixture.controller.dispose();
  });
});

describe("WorkbenchController verification page state", () => {
  const groupKey = `group:${"b".repeat(64)}`;
  const group = {
    groupKey,
    label: "Literature",
    pdfCount: 12,
    mode: "recursive" as const,
    verificationStatus: "unverified" as const,
  };

  it("keeps detached runtime snapshots and drops selections no longer in the active catalog", () => {
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    const hybrid = new FakeHybridCatalogRuntime({
      status: "ready",
      active: {
        importedAt: 1,
        pdfCount: 12,
        unverifiedCount: 12,
        verifiedCount: 0,
        differenceCount: 0,
        cloudMissingCount: 0,
        groupCount: 1,
        verifiedGroupCount: 0,
        groups: [group],
      },
    });
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, connection, hybrid),
    });

    fixture.controller.setVerificationRoot("/Synthetic");
    fixture.controller.toggleVerificationGroup(groupKey);
    const first = fixture.controller.snapshot();
    expect(first).toMatchObject({
      catalogConnection: { status: "authorized" },
      hybridCatalog: { status: "ready" },
      verificationRoot: "/Synthetic",
      selectedVerificationGroupKeys: [groupKey],
    });

    (first.selectedVerificationGroupKeys as string[]).length = 0;
    (first.hybridCatalog!.active!.groups as unknown as Array<{ label: string }>)[0]!.label = "mutated";
    expect(fixture.controller.snapshot().selectedVerificationGroupKeys).toEqual([groupKey]);
    expect(fixture.controller.snapshot().hybridCatalog?.active?.groups[0]?.label).toBe("Literature");

    hybrid.setSnapshot({
      status: "ready",
      active: {
        importedAt: 2,
        pdfCount: 0,
        unverifiedCount: 0,
        verifiedCount: 0,
        differenceCount: 0,
        cloudMissingCount: 0,
        groupCount: 0,
        verifiedGroupCount: 0,
        groups: [],
      },
    });
    expect(fixture.controller.snapshot().selectedVerificationGroupKeys).toEqual([]);

    fixture.controller.dispose();
  });

  it("delegates start, resume, and cancel through the existing confirmation boundary", async () => {
    const hybrid = new FakeHybridCatalogRuntime({
      status: "paused",
      active: {
        importedAt: 1,
        pdfCount: 12,
        unverifiedCount: 12,
        verifiedCount: 0,
        differenceCount: 0,
        cloudMissingCount: 0,
        groupCount: 1,
        verifiedGroupCount: 0,
        groups: [group],
      },
      batch: {
        batchId: "batch-fresh-resume",
        status: "paused",
        stopReason: "user-canceled",
        resumeAvailable: true,
        runOrdinal: 1,
        remainingGroupCount: 1,
        pdfCount: 0,
        directoryCount: 0,
        ignoredFileCount: 0,
        listRequestCount: 0,
        cumulativeListRequestCount: 0,
      },
    });
    const confirmations: unknown[] = [];
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
      catalogLargeScanConfirmation: {
        request: async (input) => { confirmations.push(structuredClone(input)); return true; },
      },
    });
    fixture.controller.setVerificationRoot("/Synthetic");
    fixture.controller.toggleVerificationGroup(groupKey);

    await fixture.controller.startSelectedVerification();
    expect(fixture.controller.snapshot().verificationRootLocked).toBe(true);
    fixture.controller.setVerificationRoot("/Changed-after-start");
    expect(fixture.controller.snapshot().verificationRoot).toBe("/Synthetic");
    await fixture.controller.resumeSelectedVerification();
    fixture.controller.cancelSelectedVerification();

    expect(confirmations).toHaveLength(2);
    expect(hybrid.startInputs).toEqual([{ cloudRoot: "/Synthetic", groupKeys: [groupKey] }]);
    expect(hybrid.resumeRoots).toEqual(["/Synthetic"]);
    expect(hybrid.cancelCalls).toBe(1);
    fixture.controller.dispose();
  });

  it("accepts one fresh resume candidate and unlocks it when the checkpoint guard rejects it", async () => {
    const hybrid = new FakeHybridCatalogRuntime({
      status: "paused",
      active: {
        importedAt: 1,
        pdfCount: 12,
        unverifiedCount: 12,
        verifiedCount: 0,
        differenceCount: 0,
        cloudMissingCount: 0,
        groupCount: 1,
        verifiedGroupCount: 0,
        groups: [group],
      },
      batch: {
        batchId: "batch-generic-error",
        status: "paused",
        stopReason: "time-limit",
        resumeAvailable: true,
        runOrdinal: 1,
        remainingGroupCount: 1,
        pdfCount: 0,
        directoryCount: 0,
        ignoredFileCount: 0,
        listRequestCount: 1,
        cumulativeListRequestCount: 1,
      },
    });
    hybrid.beforeResume = () => { throw new HybridCatalogError("hybrid-cloud-root-mismatch"); };
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
      catalogLargeScanConfirmation: { request: async () => true },
    });
    expect(fixture.controller.snapshot().verificationRootLocked).toBe(false);
    fixture.controller.setVerificationRoot("/Wrong-candidate");

    await expect(fixture.controller.resumeSelectedVerification())
      .rejects.toThrow("hybrid-cloud-root-mismatch");
    expect(fixture.controller.snapshot()).toMatchObject({
      verificationRoot: "/Wrong-candidate",
      verificationRootLocked: false,
      verificationActionMessageCode: "hybrid-cloud-root-mismatch",
    });

    hybrid.beforeResume = undefined;
    fixture.controller.setVerificationRoot("/Synthetic");
    expect(fixture.controller.snapshot().verificationActionMessageCode).toBeUndefined();
    await fixture.controller.resumeSelectedVerification();
    expect(hybrid.resumeRoots).toEqual(["/Synthetic"]);
    expect(fixture.controller.snapshot().verificationRootLocked).toBe(true);
    expect(fixture.controller.snapshot().verificationActionMessageCode).toBeUndefined();
    fixture.controller.dispose();
  });

  it("keeps corrupt batch failures generic and clears a root mismatch when capability disappears", async () => {
    const hybrid = new FakeHybridCatalogRuntime({
      status: "paused",
      active: {
        importedAt: 1,
        pdfCount: 12,
        unverifiedCount: 12,
        verifiedCount: 0,
        differenceCount: 0,
        cloudMissingCount: 0,
        groupCount: 1,
        verifiedGroupCount: 0,
        groups: [group],
      },
      batch: {
        batchId: "batch-old-checkpoint",
        status: "paused",
        stopReason: "time-limit",
        resumeAvailable: true,
        runOrdinal: 1,
        remainingGroupCount: 1,
        pdfCount: 0,
        directoryCount: 0,
        ignoredFileCount: 0,
        listRequestCount: 1,
        cumulativeListRequestCount: 1,
      },
    });
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
      catalogLargeScanConfirmation: { request: async () => true },
    });
    fixture.controller.setVerificationRoot("/Candidate");
    hybrid.beforeResume = () => { throw new HybridCatalogError("hybrid-batch-invalid"); };
    await expect(fixture.controller.resumeSelectedVerification())
      .rejects.toThrow("hybrid-batch-invalid");
    expect(fixture.controller.snapshot().verificationActionMessageCode).toBeUndefined();

    hybrid.beforeResume = () => { throw new HybridCatalogError("hybrid-cloud-root-mismatch"); };
    await expect(fixture.controller.resumeSelectedVerification())
      .rejects.toThrow("hybrid-cloud-root-mismatch");
    expect(fixture.controller.snapshot().verificationActionMessageCode)
      .toBe("hybrid-cloud-root-mismatch");

    hybrid.beforeResume = undefined;
    await fixture.controller.resumeSelectedVerification();
    expect(fixture.controller.snapshot().verificationActionMessageCode).toBeUndefined();

    hybrid.beforeResume = () => { throw new HybridCatalogError("hybrid-cloud-root-mismatch"); };
    await expect(fixture.controller.resumeSelectedVerification())
      .rejects.toThrow("hybrid-cloud-root-mismatch");
    expect(fixture.controller.snapshot().verificationActionMessageCode)
      .toBe("hybrid-cloud-root-mismatch");
    hybrid.setSnapshot({ status: "unavailable" });
    expect(fixture.controller.snapshot().verificationActionMessageCode).toBeUndefined();
    fixture.controller.dispose();
  });

  it("unlocks a failed new start even when an older checkpoint remains resumable", async () => {
    const hybrid = new FakeHybridCatalogRuntime({
      status: "paused",
      active: {
        importedAt: 1,
        pdfCount: 12,
        unverifiedCount: 12,
        verifiedCount: 0,
        differenceCount: 0,
        cloudMissingCount: 0,
        groupCount: 1,
        verifiedGroupCount: 0,
        groups: [group],
      },
      batch: {
        batchId: "batch-unchanged-old",
        status: "paused",
        stopReason: "time-limit",
        resumeAvailable: true,
        runOrdinal: 1,
        remainingGroupCount: 1,
        pdfCount: 0,
        directoryCount: 0,
        ignoredFileCount: 0,
        listRequestCount: 1,
        cumulativeListRequestCount: 1,
      },
    });
    hybrid.beforeStart = () => { throw new Error("baidu-access-unavailable"); };
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
      catalogLargeScanConfirmation: { request: async () => true },
    });
    fixture.controller.setVerificationRoot("/New-root");
    fixture.controller.toggleVerificationGroup(groupKey);

    await expect(fixture.controller.startSelectedVerification())
      .rejects.toThrow("baidu-access-unavailable");
    expect(fixture.controller.snapshot().verificationRootLocked).toBe(false);

    hybrid.beforeStart = undefined;
    fixture.controller.setVerificationRoot("/Old-checkpoint-root");
    await fixture.controller.resumeSelectedVerification();
    expect(hybrid.resumeRoots).toEqual(["/Old-checkpoint-root"]);
    expect(fixture.controller.snapshot().verificationRootLocked).toBe(true);
    fixture.controller.dispose();
  });

  it("does not retain a newly locked root when start never reaches a resumable runtime state", async () => {
    const hybrid = new FakeHybridCatalogRuntime({
      status: "ready",
      active: {
        importedAt: 1,
        pdfCount: 12,
        unverifiedCount: 12,
        verifiedCount: 0,
        differenceCount: 0,
        cloudMissingCount: 0,
        groupCount: 1,
        verifiedGroupCount: 0,
        groups: [group],
      },
    });
    hybrid.beforeStart = () => { throw new Error("hybrid-batch-unavailable"); };
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
      catalogLargeScanConfirmation: { request: async () => true },
    });
    fixture.controller.setVerificationRoot("/Synthetic");
    fixture.controller.toggleVerificationGroup(groupKey);

    await expect(fixture.controller.startSelectedVerification())
      .rejects.toThrow("hybrid-batch-unavailable");
    expect(fixture.controller.snapshot().verificationRootLocked).toBe(false);
    fixture.controller.setVerificationRoot("/Correctable");
    expect(fixture.controller.snapshot().verificationRoot).toBe("/Correctable");
    fixture.controller.dispose();
  });

  it("keeps the new root locked when projection refresh fails after a new paused batch", async () => {
    const previousBatch = {
      batchId: "batch-old",
      status: "paused" as const,
      stopReason: "time-limit" as const,
      resumeAvailable: true,
      runOrdinal: 1,
      remainingGroupCount: 1,
      pdfCount: 0,
      directoryCount: 0,
      ignoredFileCount: 0,
      listRequestCount: 1,
      cumulativeListRequestCount: 1,
    };
    const hybrid = new FakeHybridCatalogRuntime({
      status: "paused",
      active: {
        importedAt: 1,
        pdfCount: 12,
        unverifiedCount: 12,
        verifiedCount: 0,
        differenceCount: 0,
        cloudMissingCount: 0,
        groupCount: 1,
        verifiedGroupCount: 0,
        groups: [group],
      },
      batch: previousBatch,
    });
    hybrid.beforeStart = () => hybrid.setSnapshot({
      ...hybrid.snapshot(),
      status: "paused",
      batch: {
        ...previousBatch,
        batchId: "batch-new",
      },
    });
    class ProjectionFailingCatalog extends FakeCloudCatalogRuntime {
      override async initialize(): Promise<void> { throw new Error("projection failed"); }
    }
    const fixture = controllerFixture({
      catalog: new ProjectionFailingCatalog({}, undefined, hybrid),
      catalogLargeScanConfirmation: { request: async () => true },
    });
    fixture.controller.setVerificationRoot("/New-root");
    fixture.controller.toggleVerificationGroup(groupKey);

    await expect(fixture.controller.startSelectedVerification())
      .rejects.toThrow("catalog-unavailable");
    expect(fixture.controller.snapshot()).toMatchObject({
      verificationRoot: "/New-root",
      verificationRootLocked: true,
      hybridCatalog: { batch: { batchId: "batch-new", runOrdinal: 1 } },
    });
    fixture.controller.dispose();
  });

  it("rejects an empty selection and a category leaf before verification starts", async () => {
    const hybrid = new FakeHybridCatalogRuntime({
      status: "ready",
      active: {
        importedAt: 1,
        pdfCount: 12,
        unverifiedCount: 12,
        verifiedCount: 0,
        differenceCount: 0,
        cloudMissingCount: 0,
        groupCount: 1,
        verifiedGroupCount: 0,
        groups: [group],
      },
    });
    let confirmationCalls = 0;
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
      catalogLargeScanConfirmation: {
        request: async () => { confirmationCalls += 1; return true; },
      },
    });

    fixture.controller.setVerificationRoot("/Synthetic");
    await expect(fixture.controller.startSelectedVerification())
      .rejects.toThrow("verification-group-required");

    fixture.controller.toggleVerificationGroup(groupKey);
    fixture.controller.setVerificationRoot("/Synthetic/Literature");
    await expect(fixture.controller.startSelectedVerification())
      .rejects.toThrow("invalid-large-catalog-root");
    expect(fixture.controller.snapshot().verificationActionMessageCode)
      .toBe("invalid-large-catalog-root");

    expect(confirmationCalls).toBe(0);
    expect(hybrid.startInputs).toEqual([]);
    fixture.controller.dispose();
  });
});
