import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  FakeCloudCatalogConnectionRuntime,
  FakeCloudCatalogRuntime,
  FakeHybridCatalogRuntime,
} from "../fakes/fake-cloud-catalog-runtime";
import { controllerFixture } from "../helpers/ui-fixtures";
import {
  HybridCatalogError,
  LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
} from "../../src/catalog/hybrid-catalog-types";
import type { CloudDirectoryDiscoveryRuntime } from "../../src/catalog/cloud-directory-discovery-service";
import type { CloudDirectoryBrowserRuntime } from "../../src/catalog/cloud-directory-browser";
import type { CloudDirectoryLocatorRuntime } from "../../src/catalog/cloud-directory-locator";
import type {
  CloudDirectoryPickerPurpose,
  CloudDirectorySelection,
} from "../../src/catalog/cloud-directory-selection";
import type {
  CloudDirectoryPickerPresenter,
  CloudDirectoryPickerRequest,
} from "../../src/ui/cloud-directory-picker";
import { deriveCloudVerificationScope } from "../../src/catalog/cloud-verification-scope";
import type {
  CloudDirectoryCandidate,
  CloudDirectoryCandidateRuntime,
} from "../../src/catalog/cloud-directory-candidates";
import { createCloudDirectoryPickerSession } from "../../src/ui/cloud-directory-picker-session";
import type {
  FolderSelectionSessionDriver,
  FolderSelectionSessionFactoryPort,
} from "../../src/ui/folder-selection-host";
import type { LegacyVerificationAdoptionV1 } from "../../src/storage/legacy-verification-adoption";

const SOURCE_HASH = "a".repeat(64);
const TXT_PREVIEW_HASH = "b".repeat(64);
const hashVerificationRoot = (normalizedRoot: string): string => (
  createHash("sha256").update(normalizedRoot, "utf8").digest("hex")
);

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

class TestFolderSelectionFactory implements FolderSelectionSessionFactoryPort {
  readonly available = true;
  readonly creates: Array<Readonly<{
    purpose: CloudDirectoryPickerPurpose;
    initialPath: string | null;
  }>> = [];
  readonly sessions: FolderSelectionSessionDriver[] = [];
  readonly rememberCalls: string[] = [];
  beforeRemember: (() => Promise<void>) | null = null;
  rememberFailure: Error | null = null;
  failCreateAt: number | null = null;
  failSubscribeAt: number | null = null;

  constructor(readonly candidates: readonly CloudDirectoryCandidate[]) {}

  create(input: Readonly<{
    purpose: CloudDirectoryPickerPurpose;
    initialPath: string | null;
  }>): FolderSelectionSessionDriver {
    this.creates.push(structuredClone(input));
    const createOrdinal = this.creates.length;
    if (this.failCreateAt === createOrdinal) {
      throw new Error("folder-selection-create-failed");
    }
    const candidateRuntime: CloudDirectoryCandidateRuntime = {
      snapshot: () => structuredClone(this.candidates),
      remember: async (path) => {
        this.rememberCalls.push(path);
        await this.beforeRemember?.();
        if (this.rememberFailure !== null) throw this.rememberFailure;
      },
      clearRecent: async () => undefined,
    };
    const session = createCloudDirectoryPickerSession({
      ...structuredClone(input),
      candidates: candidateRuntime,
    });
    const exposed = this.failSubscribeAt === createOrdinal
      ? new Proxy(session, {
          get(target, property) {
            if (property === "subscribe") {
              return () => { throw new Error("folder-selection-subscribe-failed"); };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) as unknown : value;
          },
        })
      : session;
    this.sessions.push(exposed);
    return exposed;
  }
}

const folderCandidate = (path: string): CloudDirectoryCandidate => ({
  kind: "exact",
  path,
  filename: path.split("/").at(-1)!,
  source: "recent",
  pathState: "previously-used",
});

describe("WorkbenchController catalog authority bootstrap", () => {
  it("installs a detached scoped authority before catalog initialization", async () => {
    const hybrid = new FakeHybridCatalogRuntime();
    const catalog = new FakeCloudCatalogRuntime({}, undefined, hybrid);
    const fixture = controllerFixture({ catalog });
    const binding = {
      schemaVersion: 1 as const,
      path: "/Synthetic Library",
      sourceImportSha256: SOURCE_HASH,
      verificationGeneration: 3,
    };
    const scope = deriveCloudVerificationScope(binding, hashVerificationRoot)!;
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      boundCloudLibrary: binding,
      cloudVerificationGeneration: 3,
      legacyVerificationAdoption: {
        schemaVersion: 1,
        state: "adopted",
        verificationGeneration: 3,
        sourceImportSha256: SOURCE_HASH,
        cloudRootSha256: scope.cloudRootSha256,
        candidate: {
          importId: "import-1",
          manifestSha256: "b".repeat(64),
          descriptorSha256: "c".repeat(64),
        },
        overlays: [],
        unified: null,
        resumableBatch: null,
      },
    });

    await fixture.controller.initializeCatalog();

    expect(catalog.verificationAuthorities).toEqual([{
      kind: "scoped",
      scope,
      legacyAllowlist: {
        candidate: {
          importId: "import-1",
          manifestSha256: "b".repeat(64),
          descriptorSha256: "c".repeat(64),
        },
        overlays: [],
        unified: null,
        resumableBatch: null,
      },
    }]);
    expect(hybrid.prepareLegacyLocalAuthorityCalls).toBe(0);
    expect(catalog.initializeCalls).toBe(1);

    const replacementBinding = {
      ...binding,
      path: "/Replacement Library",
      verificationGeneration: 4,
    };
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      boundCloudLibrary: replacementBinding,
      cloudVerificationGeneration: 4,
    });
    await fixture.controller.initializeCatalog();
    expect(catalog.verificationAuthorities.at(-1)).toEqual({
      kind: "scoped",
      scope: deriveCloudVerificationScope(replacementBinding, hashVerificationRoot),
      legacyAllowlist: null,
    });
    expect(hybrid.prepareLegacyLocalAuthorityCalls).toBe(0);
    fixture.controller.dispose();
  });

  it.each([
    ["generation", { verificationGeneration: 2 }],
    ["source", { sourceImportSha256: "9".repeat(64) }],
    ["root", { cloudRootSha256: "8".repeat(64) }],
  ] as const)("keeps an adopted %s mismatch history-only", async (_label, mismatch) => {
    const hybrid = new FakeHybridCatalogRuntime();
    const catalog = new FakeCloudCatalogRuntime({}, undefined, hybrid);
    const fixture = controllerFixture({ catalog });
    const binding = {
      schemaVersion: 1 as const,
      path: "/Synthetic Library",
      sourceImportSha256: SOURCE_HASH,
      verificationGeneration: 3,
    };
    const scope = deriveCloudVerificationScope(binding, hashVerificationRoot)!;
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      boundCloudLibrary: binding,
      cloudVerificationGeneration: 3,
      legacyVerificationAdoption: {
        schemaVersion: 1,
        state: "adopted",
        verificationGeneration: 3,
        sourceImportSha256: SOURCE_HASH,
        cloudRootSha256: scope.cloudRootSha256,
        candidate: {
          importId: "import-1",
          manifestSha256: "b".repeat(64),
          descriptorSha256: "c".repeat(64),
        },
        overlays: [],
        unified: null,
        resumableBatch: null,
        ...mismatch,
      },
    });

    await fixture.controller.initializeCatalog();

    const expectedAuthority = {
      kind: "scoped" as const,
      scope,
      legacyAllowlist: null,
    };
    expect(catalog.verificationAuthorities).toEqual([expectedAuthority]);
    expect(hybrid.verificationAuthorities).toEqual([expectedAuthority]);
    expect(hybrid.prepareLegacyLocalAuthorityCalls).toBe(0);
    expect(catalog.initializeCalls).toBe(1);
    fixture.controller.dispose();
  });

  it("awaits validated legacy-local authority before initialization and otherwise installs null", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    class DeferredLegacyHybrid extends FakeHybridCatalogRuntime {
      override async prepareLegacyLocalVerificationAuthority() {
        this.prepareLegacyLocalAuthorityCalls += 1;
        await gate;
        return {
          kind: "legacy-local-only" as const,
          sourceImportSha256: SOURCE_HASH,
          activeManifestSha256: "d".repeat(64),
        };
      }
    }
    const hybrid = new DeferredLegacyHybrid();
    const catalog = new FakeCloudCatalogRuntime({}, undefined, hybrid);
    const fixture = controllerFixture({ catalog });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      legacyVerificationAdoption: { schemaVersion: 1, state: "pending" },
    });

    const initializing = fixture.controller.initializeCatalog();
    expect(hybrid.prepareLegacyLocalAuthorityCalls).toBe(1);
    expect(catalog.initializeCalls).toBe(0);
    release();
    await initializing;

    expect(catalog.verificationAuthorities).toEqual([{
      kind: "legacy-local-only",
      sourceImportSha256: SOURCE_HASH,
      activeManifestSha256: "d".repeat(64),
    }]);
    expect(catalog.initializeCalls).toBe(1);

    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      legacyVerificationAdoption: { schemaVersion: 1, state: "none" },
    });
    await fixture.controller.initializeCatalog();
    expect(catalog.verificationAuthorities.at(-1)).toBeNull();
    expect(catalog.initializeCalls).toBe(2);
    fixture.controller.dispose();
  });

  it("never installs a stale local authority when settings change during bootstrap", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    class DeferredLegacyHybrid extends FakeHybridCatalogRuntime {
      override async prepareLegacyLocalVerificationAuthority() {
        await gate;
        return {
          kind: "legacy-local-only" as const,
          sourceImportSha256: SOURCE_HASH,
          activeManifestSha256: "d".repeat(64),
        };
      }
    }
    const hybrid = new DeferredLegacyHybrid();
    const catalog = new FakeCloudCatalogRuntime({}, undefined, hybrid);
    const fixture = controllerFixture({ catalog });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      legacyVerificationAdoption: { schemaVersion: 1, state: "pending" },
    });

    const initializing = fixture.controller.initializeCatalog();
    const binding = {
      schemaVersion: 1 as const,
      path: "/Replacement Library",
      sourceImportSha256: SOURCE_HASH,
      verificationGeneration: 1,
    };
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      boundCloudLibrary: binding,
      cloudVerificationGeneration: 1,
      legacyVerificationAdoption: { schemaVersion: 1, state: "none" },
    });
    release();
    await initializing;

    expect(catalog.verificationAuthorities).toEqual([{
      kind: "scoped",
      scope: deriveCloudVerificationScope(binding, hashVerificationRoot),
      legacyAllowlist: null,
    }]);
    expect(catalog.initializeCalls).toBe(1);
    fixture.controller.dispose();
  });
});

describe("WorkbenchController task TXT and cloud authority operations", () => {
  const taskGroupKey = `group:${"7".repeat(64)}`;
  const taskGroup = {
    groupKey: taskGroupKey,
    rootRelativePath: "Literature",
    label: "Literature",
    pdfCount: 8,
    mode: "recursive" as const,
    verificationStatus: "unverified" as const,
  };
  const active = (sourceImportSha256 = SOURCE_HASH) => ({
    sourceImportSha256,
    importedAt: 1,
    pdfCount: 8,
    unverifiedCount: 8,
    verifiedCount: 0,
    differenceCount: 0,
    cloudMissingCount: 0,
    groupCount: 1,
    verifiedGroupCount: 0,
    coveredCandidatePdfCount: 0,
    groups: [taskGroup],
  });

  it("rejects a stale TXT task before reading and retains only a successful detached preview", async () => {
    const hybrid = new FakeHybridCatalogRuntime({ status: "empty" });
    hybrid.previewSummary = { ...hybrid.previewSummary, sourceSha256: TXT_PREVIEW_HASH };
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
    });
    const revision = fixture.controller.snapshot().taskActionRevision;

    await expect(fixture.controller.previewTaskCatalogTxt("/Synthetic/stale.txt", revision + 1))
      .rejects.toThrow("task-action-stale");
    expect(hybrid.previewPaths).toEqual([]);

    await fixture.controller.previewTaskCatalogTxt("/Synthetic/catalog.txt", revision);
    expect(fixture.controller.snapshot()).toMatchObject({
      pendingCatalogTxt: {
        path: "/Synthetic/catalog.txt",
        sourceSha256: TXT_PREVIEW_HASH,
      },
      taskActionPending: false,
      workflow: { kind: "confirm-txt-import" },
    });
    expect(fixture.controller.snapshot().taskActionRevision).toBe(revision + 1);
    fixture.controller.dispose();
  });

  it("fails fast instead of allowing overlapping TXT previews to race", async () => {
    const gate = deferred();
    const hybrid = new FakeHybridCatalogRuntime({ status: "empty" });
    hybrid.beforePreview = async (path) => {
      if (path.endsWith("first.txt")) await gate.promise;
    };
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
    });
    const revision = fixture.controller.snapshot().taskActionRevision;
    const first = fixture.controller.previewTaskCatalogTxt("/Synthetic/first.txt", revision);
    await Promise.resolve();

    await expect(fixture.controller.previewTaskCatalogTxt("/Synthetic/second.txt", revision))
      .rejects.toThrow("task-action-busy");
    expect(hybrid.previewPaths).toEqual(["/Synthetic/first.txt"]);
    gate.resolve();
    await first;
    expect(fixture.controller.snapshot().pendingCatalogTxt?.path).toBe("/Synthetic/first.txt");
    fixture.controller.dispose();
  });

  it("keeps preview A usable when a later preview B fails before replacing the candidate", async () => {
    const hybrid = new FakeHybridCatalogRuntime({ status: "empty" });
    hybrid.previewSummary = { ...hybrid.previewSummary, sourceSha256: TXT_PREVIEW_HASH };
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
    });

    await fixture.controller.previewTaskCatalogTxt(
      "/Synthetic/a.txt",
      fixture.controller.snapshot().taskActionRevision,
    );
    hybrid.beforePreview = (path) => {
      if (path.endsWith("b.txt")) throw new Error("preview-b-failed");
    };

    await expect(fixture.controller.previewTaskCatalogTxt(
      "/Synthetic/b.txt",
      fixture.controller.snapshot().taskActionRevision,
    )).rejects.toThrow("preview-b-failed");
    expect(fixture.controller.snapshot().pendingCatalogTxt).toEqual({
      path: "/Synthetic/a.txt",
      sourceSha256: TXT_PREVIEW_HASH,
    });
    expect(hybrid.snapshot().candidate?.sourceSha256).toBe(TXT_PREVIEW_HASH);
    fixture.controller.dispose();
  });

  it("keeps a preview draft and authority unchanged when import confirmation is canceled", async () => {
    const hybrid = new FakeHybridCatalogRuntime({ status: "ready", active: active() });
    hybrid.previewSummary = { ...hybrid.previewSummary, sourceSha256: TXT_PREVIEW_HASH };
    const catalog = new FakeCloudCatalogRuntime({}, undefined, hybrid);
    const fixture = controllerFixture({
      catalog,
      catalogTxtImportConfirmation: { request: async () => false },
    });
    const binding = {
      schemaVersion: 1 as const,
      path: "/Synthetic",
      sourceImportSha256: SOURCE_HASH,
      verificationGeneration: 1,
    };
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      boundCloudLibrary: binding,
      cloudVerificationGeneration: 1,
    });
    await fixture.controller.previewTaskCatalogTxt(
      "/Synthetic/catalog.txt",
      fixture.controller.snapshot().taskActionRevision,
    );

    await fixture.controller.importPreviewedTaskCatalogTxt();

    expect(fixture.controller.snapshot().pendingCatalogTxt).toEqual({
      path: "/Synthetic/catalog.txt",
      sourceSha256: TXT_PREVIEW_HASH,
    });
    expect(hybrid.consumeTxtPreviewInputs).toEqual([]);
    expect(fixture.store.settings().boundCloudLibrary).toEqual(binding);
    expect(catalog.verificationAuthorities).toEqual([]);
    fixture.controller.dispose();
  });

  it("drops a stale TXT draft before attempting an import with a different candidate hash", async () => {
    const hybrid = new FakeHybridCatalogRuntime({ status: "empty" });
    hybrid.previewSummary = { ...hybrid.previewSummary, sourceSha256: TXT_PREVIEW_HASH };
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
      catalogTxtImportConfirmation: { request: async () => true },
    });
    await fixture.controller.previewTaskCatalogTxt(
      "/Synthetic/catalog.txt",
      fixture.controller.snapshot().taskActionRevision,
    );
    hybrid.setSnapshot({
      status: "previewed",
      candidate: { ...hybrid.previewSummary, sourceSha256: "c".repeat(64) },
    });

    await expect(fixture.controller.importPreviewedTaskCatalogTxt())
      .rejects.toThrow("txt-source-invalid");
    expect(fixture.controller.snapshot().pendingCatalogTxt).toBeNull();
    expect(hybrid.consumeTxtPreviewInputs).toEqual([]);
    fixture.controller.dispose();
  });

  it("consumes an unchanged TXT preview without clearing the current binding", async () => {
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    const hybrid = new FakeHybridCatalogRuntime({ status: "ready", active: active(TXT_PREVIEW_HASH) });
    hybrid.previewSummary = { ...hybrid.previewSummary, sourceSha256: TXT_PREVIEW_HASH };
    hybrid.consumeTxtPreviewResult = { kind: "unchanged", sourceSha256: TXT_PREVIEW_HASH };
    const catalog = new FakeCloudCatalogRuntime({}, connection, hybrid);
    const fixture = controllerFixture({
      catalog,
      catalogTxtImportConfirmation: { request: async () => true },
    });
    const binding = {
      schemaVersion: 1 as const,
      path: "/Synthetic",
      sourceImportSha256: TXT_PREVIEW_HASH,
      verificationGeneration: 1,
    };
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      boundCloudLibrary: binding,
      cloudVerificationGeneration: 1,
    });

    await fixture.controller.previewTaskCatalogTxt(
      "/Synthetic/catalog.txt",
      fixture.controller.snapshot().taskActionRevision,
    );
    await fixture.controller.importPreviewedTaskCatalogTxt();

    expect(hybrid.consumeTxtPreviewInputs).toEqual([{
      path: "/Synthetic/catalog.txt",
      expectedSourceSha256: TXT_PREVIEW_HASH,
    }]);
    expect(fixture.controller.snapshot().pendingCatalogTxt).toBeNull();
    expect(fixture.controller.snapshot().statusMessage).toBe("task.txtContentUnchanged");
    expect(fixture.store.settings().boundCloudLibrary).toEqual(binding);
    expect(fixture.store.cloudVerificationSettingsCalls).toEqual([]);
    expect(catalog.initializeCalls).toBe(0);
    fixture.controller.dispose();
  });

  it("consumes a changed TXT before clearing authority and rebuilding candidate-only", async () => {
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    const hybrid = new FakeHybridCatalogRuntime({ status: "ready", active: active() });
    hybrid.previewSummary = { ...hybrid.previewSummary, sourceSha256: TXT_PREVIEW_HASH };
    hybrid.consumeTxtPreviewResult = { kind: "activated", sourceSha256: TXT_PREVIEW_HASH };
    const catalog = new FakeCloudCatalogRuntime({}, connection, hybrid);
    const fixture = controllerFixture({
      catalog,
      catalogTxtImportConfirmation: { request: async () => true },
    });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      recentCloudDirectories: {
        schemaVersion: 1,
        items: [{ path: "/Recent/Kept", filename: "Kept", lastUsedAt: "1970-01-01T00:00:00.001Z" }],
      },
      boundCloudLibrary: {
        schemaVersion: 1,
        path: "/Synthetic",
        sourceImportSha256: SOURCE_HASH,
        verificationGeneration: 1,
      },
      cloudVerificationGeneration: 1,
    });

    await fixture.controller.previewTaskCatalogTxt(
      "/Synthetic/catalog.txt",
      fixture.controller.snapshot().taskActionRevision,
    );
    await fixture.controller.importPreviewedTaskCatalogTxt();

    expect(fixture.controller.snapshot().pendingCatalogTxt).toBeNull();
    expect(fixture.store.cloudVerificationSettingsCalls).toHaveLength(1);
    expect(fixture.store.cloudVerificationSettingsCalls[0]).toMatchObject({
      settings: { boundCloudLibrary: null, cloudVerificationGeneration: 1 },
      transition: { kind: "txt-source-replacement", currentWorkflowBatchId: null },
    });
    expect(fixture.store.settings().recentCloudDirectories.items).toHaveLength(1);
    expect(catalog.verificationAuthorities.at(-1)).toBeNull();
    expect(hybrid.rebuildVerificationProjectionCalls).toBe(1);
    expect(catalog.initializeCalls).toBe(1);
    expect(fixture.controller.snapshot().workflow.kind).toBe("needs-library");
    fixture.controller.dispose();
  });

  it("stays fail-closed after TXT activation when authority cleanup persistence fails", async () => {
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    const hybrid = new FakeHybridCatalogRuntime({ status: "ready", active: active() });
    hybrid.previewSummary = { ...hybrid.previewSummary, sourceSha256: TXT_PREVIEW_HASH };
    hybrid.consumeTxtPreviewResult = { kind: "activated", sourceSha256: TXT_PREVIEW_HASH };
    const catalog = new FakeCloudCatalogRuntime({}, connection, hybrid);
    const fixture = controllerFixture({
      catalog,
      catalogTxtImportConfirmation: { request: async () => true },
    });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      boundCloudLibrary: {
        schemaVersion: 1,
        path: "/Synthetic",
        sourceImportSha256: SOURCE_HASH,
        verificationGeneration: 1,
      },
      cloudVerificationGeneration: 1,
    });
    await fixture.controller.previewTaskCatalogTxt(
      "/Synthetic/catalog.txt",
      fixture.controller.snapshot().taskActionRevision,
    );
    fixture.store.failNext = new Error("cleanup-failed");

    await expect(fixture.controller.importPreviewedTaskCatalogTxt())
      .rejects.toThrow("cleanup-failed");
    expect(hybrid.snapshot()).toMatchObject({
      status: "ready",
      active: { sourceImportSha256: TXT_PREVIEW_HASH },
    });
    expect(hybrid.snapshot().candidate).toBeUndefined();
    expect(fixture.controller.snapshot().pendingCatalogTxt).toBeNull();
    expect(catalog.verificationAuthorities.at(-1)).toBeNull();
    expect(hybrid.rebuildVerificationProjectionCalls).toBe(0);
    expect(fixture.controller.snapshot().workflow.kind).toBe("needs-library");
    fixture.controller.dispose();
  });

  it("keeps the cleared binding authoritative when candidate-only rebuild fails", async () => {
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    const hybrid = new FakeHybridCatalogRuntime({ status: "ready", active: active() });
    hybrid.previewSummary = { ...hybrid.previewSummary, sourceSha256: TXT_PREVIEW_HASH };
    hybrid.consumeTxtPreviewResult = { kind: "activated", sourceSha256: TXT_PREVIEW_HASH };
    hybrid.beforeRebuildVerificationProjection = () => { throw new Error("rebuild-failed"); };
    const catalog = new FakeCloudCatalogRuntime({}, connection, hybrid);
    const fixture = controllerFixture({
      catalog,
      catalogTxtImportConfirmation: { request: async () => true },
    });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      boundCloudLibrary: {
        schemaVersion: 1,
        path: "/Synthetic",
        sourceImportSha256: SOURCE_HASH,
        verificationGeneration: 1,
      },
      cloudVerificationGeneration: 1,
    });
    await fixture.controller.previewTaskCatalogTxt(
      "/Synthetic/catalog.txt",
      fixture.controller.snapshot().taskActionRevision,
    );

    await expect(fixture.controller.importPreviewedTaskCatalogTxt())
      .rejects.toThrow("rebuild-failed");
    expect(fixture.store.settings().boundCloudLibrary).toBeNull();
    expect(fixture.controller.snapshot().pendingCatalogTxt).toBeNull();
    expect(catalog.verificationAuthorities.at(-1)).toBeNull();
    expect(catalog.initializeCalls).toBe(0);
    expect(fixture.controller.snapshot().workflow.kind).toBe("needs-library");
    fixture.controller.dispose();
  });

  it("keeps the cleared binding authoritative when the final catalog refresh fails", async () => {
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    const hybrid = new FakeHybridCatalogRuntime({ status: "ready", active: active() });
    hybrid.previewSummary = { ...hybrid.previewSummary, sourceSha256: TXT_PREVIEW_HASH };
    hybrid.consumeTxtPreviewResult = { kind: "activated", sourceSha256: TXT_PREVIEW_HASH };
    class RefreshFailingCatalog extends FakeCloudCatalogRuntime {
      override async initialize(): Promise<void> {
        this.initializeCalls += 1;
        throw new Error("refresh-failed");
      }
    }
    const catalog = new RefreshFailingCatalog({}, connection, hybrid);
    const fixture = controllerFixture({
      catalog,
      catalogTxtImportConfirmation: { request: async () => true },
    });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      boundCloudLibrary: {
        schemaVersion: 1,
        path: "/Synthetic",
        sourceImportSha256: SOURCE_HASH,
        verificationGeneration: 1,
      },
      cloudVerificationGeneration: 1,
    });
    await fixture.controller.previewTaskCatalogTxt(
      "/Synthetic/catalog.txt",
      fixture.controller.snapshot().taskActionRevision,
    );

    await expect(fixture.controller.importPreviewedTaskCatalogTxt())
      .rejects.toThrow("catalog-unavailable");
    expect(fixture.store.settings().boundCloudLibrary).toBeNull();
    expect(fixture.controller.snapshot().pendingCatalogTxt).toBeNull();
    expect(catalog.verificationAuthorities.at(-1)).toBeNull();
    expect(hybrid.rebuildVerificationProjectionCalls).toBe(1);
    expect(catalog.initializeCalls).toBe(1);
    expect(fixture.controller.snapshot().workflow.kind).toBe("needs-library");
    fixture.controller.dispose();
  });

  it("does not advance the task revision for count-only refreshes and separates runtime messages", () => {
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    const hybrid = new FakeHybridCatalogRuntime({ status: "ready", active: active() });
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, connection, hybrid),
    });
    const initialRevision = fixture.controller.snapshot().taskActionRevision;

    hybrid.setSnapshot({
      status: "ready",
      active: { ...active(), pdfCount: 9, unverifiedCount: 9 },
    });
    expect(fixture.controller.snapshot().taskActionRevision).toBe(initialRevision);

    hybrid.setSnapshot({
      status: "ready",
      active: { ...active(), pdfCount: 9, unverifiedCount: 9 },
      messageCode: "catalog-unavailable",
    });
    const hybridMessageRevision = fixture.controller.snapshot().taskActionRevision;
    expect(hybridMessageRevision).toBe(initialRevision + 1);

    connection.setSnapshot({ status: "authorized", messageCode: "catalog-unavailable" });
    expect(fixture.controller.snapshot().taskActionRevision).toBe(hybridMessageRevision + 1);
    connection.setSnapshot({ status: "authorized", messageCode: "catalog-unavailable" });
    expect(fixture.controller.snapshot().taskActionRevision).toBe(hybridMessageRevision + 1);
    fixture.controller.dispose();
  });

  it("clears first-configuration directory sessions before saving credentials", async () => {
    const order: string[] = [];
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "unconfigured" });
    connection.beforeSaveApplicationCredentials = () => { order.push("save"); };
    const discovery = {
      clear: () => { order.push("discovery"); },
    } as unknown as CloudDirectoryDiscoveryRuntime;
    const browser = {
      clear: () => { order.push("browser"); },
    } as unknown as CloudDirectoryBrowserRuntime;
    const locator = {
      cancel: () => { order.push("locator"); },
    } as unknown as CloudDirectoryLocatorRuntime;
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime(
        {},
        connection,
        undefined,
        discovery,
        browser,
        locator,
      ),
    });

    await fixture.controller.connectCatalog(
      { appKey: "initial-app", secretKey: "initial-secret" },
      "repair-same-account",
    );

    expect(order).toEqual(["locator", "discovery", "browser", "save"]);
    expect(connection.savedCredentials).toEqual([{
      appKey: "initial-app",
      secretKey: "initial-secret",
    }]);
    fixture.controller.dispose();
  });

  it("reports live scan guidance before generic permit busy and lets cancel bypass the permit", async () => {
    const entered = deferred();
    const gate = deferred();
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    connection.beforeStartScan = async () => {
      connection.setSnapshot({ status: "scanning" });
      entered.resolve();
      await gate.promise;
    };
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, connection),
      catalogConfirmation: { request: async () => true },
    });

    const scanning = fixture.controller.requestCatalogScan("/Synthetic");
    await entered.promise;
    await expect(fixture.controller.connectCatalog(
      { appKey: "same-app", secretKey: "same-secret" },
      "repair-same-account",
    )).rejects.toThrow("scan-must-cancel");
    expect(fixture.controller.snapshot().statusMessage).toBe("scan-must-cancel");
    fixture.controller.cancelCatalogScan();
    expect(connection.cancelScanCalls).toBe(1);
    gate.resolve();
    await scanning;
    fixture.controller.dispose();
  });

  it("reports live verification guidance before generic permit busy and lets cancel bypass", async () => {
    const entered = deferred();
    const gate = deferred();
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    const hybrid = new FakeHybridCatalogRuntime({ status: "ready", active: active() });
    hybrid.beforeStart = async () => {
      hybrid.setSnapshot({ status: "scanning", executionActive: true, active: active() });
      entered.resolve();
      await gate.promise;
    };
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, connection, hybrid),
      catalogLargeScanConfirmation: { request: async () => true },
    });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      boundCloudLibrary: {
        schemaVersion: 1,
        path: "/Synthetic",
        sourceImportSha256: SOURCE_HASH,
        verificationGeneration: 1,
      },
      cloudVerificationGeneration: 1,
    });

    const verification = fixture.controller.requestLargeCatalogVerification(
      "/Synthetic",
      [taskGroupKey],
    );
    await entered.promise;
    await expect(fixture.controller.connectCatalog(
      { appKey: "same-app", secretKey: "same-secret" },
      "repair-same-account",
    )).rejects.toThrow("verification-must-pause");
    expect(fixture.controller.snapshot().statusMessage).toBe("verification-must-pause");
    fixture.controller.cancelSelectedVerification();
    expect(hybrid.cancelCalls).toBe(1);
    gate.resolve();
    await verification;
    fixture.controller.dispose();
  });

  it("serializes TXT binding and identity replacement in both directions", async () => {
    const confirmationEntered = deferred();
    const confirmationGate = deferred<boolean>();
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    const hybrid = new FakeHybridCatalogRuntime({ status: "ready", active: active() });
    hybrid.previewSummary = { ...hybrid.previewSummary, sourceSha256: TXT_PREVIEW_HASH };
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, connection, hybrid),
      catalogTxtImportConfirmation: {
        request: () => {
          confirmationEntered.resolve();
          return confirmationGate.promise;
        },
      },
    });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      boundCloudLibrary: {
        schemaVersion: 1,
        path: "/Synthetic",
        sourceImportSha256: SOURCE_HASH,
        verificationGeneration: 1,
      },
      cloudVerificationGeneration: 1,
    });
    await fixture.controller.previewTaskCatalogTxt(
      "/Synthetic/catalog.txt",
      fixture.controller.snapshot().taskActionRevision,
    );

    const importing = fixture.controller.importPreviewedTaskCatalogTxt();
    await confirmationEntered.promise;
    await expect(fixture.controller.connectCatalog(
      { appKey: "new-app", secretKey: "new-secret" },
      "replace-identity",
    )).rejects.toThrow("cloud-authority-operation-busy");
    confirmationGate.resolve(false);
    await importing;

    fixture.store.pauseNextCloudVerificationUpdate();
    const replacing = fixture.controller.connectCatalog(
      { appKey: "new-app", secretKey: "new-secret" },
      "replace-identity",
    );
    await Promise.resolve();
    await expect(fixture.controller.importPreviewedTaskCatalogTxt())
      .rejects.toThrow("cloud-authority-operation-busy");
    fixture.store.resumeCloudVerificationUpdate();
    await replacing;
    fixture.controller.dispose();
  });

  it("does not mutate credentials or authority when identity generation overflows", async () => {
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    const hybrid = new FakeHybridCatalogRuntime({ status: "ready", active: active() });
    const catalog = new FakeCloudCatalogRuntime({}, connection, hybrid);
    const fixture = controllerFixture({ catalog });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      cloudVerificationGeneration: Number.MAX_SAFE_INTEGER,
    });

    await expect(fixture.controller.connectCatalog(
      { appKey: "new-app", secretKey: "new-secret" },
      "replace-identity",
    )).rejects.toThrow("cloud-verification-generation-overflow");
    expect(fixture.store.cloudVerificationSettingsCalls).toEqual([]);
    expect(connection.savedCredentials).toEqual([]);
    expect(catalog.verificationAuthorities).toEqual([]);
    expect(hybrid.rebuildVerificationProjectionCalls).toBe(0);
    fixture.controller.dispose();
  });

  it("does not mutate credentials or authority when identity CAS persistence fails", async () => {
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    const hybrid = new FakeHybridCatalogRuntime({ status: "ready", active: active() });
    const catalog = new FakeCloudCatalogRuntime({}, connection, hybrid);
    const fixture = controllerFixture({ catalog });
    fixture.store.failNext = new Error("identity-write-failed");

    await expect(fixture.controller.connectCatalog(
      { appKey: "new-app", secretKey: "new-secret" },
      "replace-identity",
    )).rejects.toThrow("identity-write-failed");
    expect(connection.savedCredentials).toEqual([]);
    expect(catalog.verificationAuthorities).toEqual([]);
    expect(hybrid.rebuildVerificationProjectionCalls).toBe(0);
    fixture.controller.dispose();
  });

  it("does not save replacement credentials when candidate-only identity rebuild fails", async () => {
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    const hybrid = new FakeHybridCatalogRuntime({ status: "ready", active: active() });
    hybrid.beforeRebuildVerificationProjection = () => { throw new Error("identity-rebuild-failed"); };
    const catalog = new FakeCloudCatalogRuntime({}, connection, hybrid);
    const fixture = controllerFixture({ catalog });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      boundCloudLibrary: {
        schemaVersion: 1,
        path: "/Synthetic",
        sourceImportSha256: SOURCE_HASH,
        verificationGeneration: 1,
      },
      cloudVerificationGeneration: 1,
    });

    await expect(fixture.controller.connectCatalog(
      { appKey: "new-app", secretKey: "new-secret" },
      "replace-identity",
    )).rejects.toThrow("identity-rebuild-failed");
    expect(fixture.store.settings()).toMatchObject({
      boundCloudLibrary: null,
      cloudVerificationGeneration: 2,
    });
    expect(catalog.verificationAuthorities.at(-1)).toBeNull();
    expect(connection.savedCredentials).toEqual([]);
    expect(connection.beginAuthorizationCalls).toBe(0);
    fixture.controller.dispose();
  });

  it("rotates authority and tombstones a resumable batch before revoking credentials", async () => {
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    const hybrid = new FakeHybridCatalogRuntime({
      status: "paused",
      active: active(),
      batch: {
        batchId: "batch-revoke",
        status: "paused",
        resumeAvailable: true,
      },
    });
    const catalog = new FakeCloudCatalogRuntime({}, connection, hybrid);
    const fixture = controllerFixture({ catalog });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      boundCloudLibrary: {
        schemaVersion: 1,
        path: "/Synthetic",
        sourceImportSha256: SOURCE_HASH,
        verificationGeneration: 1,
      },
      cloudVerificationGeneration: 1,
    });

    await fixture.controller.revokeCatalog();

    expect(fixture.store.settings()).toMatchObject({
      boundCloudLibrary: null,
      cloudVerificationGeneration: 2,
      verificationBatchTombstones: {
        state: "valid",
        batchIds: ["batch-revoke"],
      },
    });
    expect(catalog.verificationAuthorities.at(-1)).toBeNull();
    expect(hybrid.rebuildVerificationProjectionCalls).toBe(1);
    expect(connection.revokeCalls).toBe(1);
    fixture.controller.dispose();
  });

  it("rejects an authorization code if the prepared generation changed", async () => {
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "configured" });
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, connection),
    });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      cloudVerificationGeneration: 1,
    });
    await fixture.controller.connectCatalog(
      { appKey: "ignored", secretKey: "ignored" },
      "repair-same-account",
    );
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      cloudVerificationGeneration: 2,
    });

    await expect(fixture.controller.submitCatalogAuthorizationCode(
      "stale-code",
      "repair-same-account",
    )).rejects.toThrow("authorization-attempt-unavailable");
    expect(connection.submittedAuthorizationCodes).toEqual([]);
    expect(connection.savedCredentials).toEqual([]);
    fixture.controller.dispose();
  });

  it("serializes verification launch and identity replacement in both directions", async () => {
    const presenterGate = deferred<boolean>();
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    const hybrid = new FakeHybridCatalogRuntime({ status: "ready", active: active() });
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, connection, hybrid),
      catalogLargeScanConfirmation: { request: () => presenterGate.promise },
      pauseCloudVerificationUpdate: true,
    });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      boundCloudLibrary: {
        schemaVersion: 1,
        path: "/Synthetic",
        sourceImportSha256: SOURCE_HASH,
        verificationGeneration: 1,
      },
      cloudVerificationGeneration: 1,
    });

    const launch = fixture.controller.requestLargeCatalogVerification(
      "/Synthetic",
      [taskGroupKey],
    );
    await Promise.resolve();
    await expect(fixture.controller.connectCatalog(
      { appKey: "new-app", secretKey: "new-secret" },
      "replace-identity",
    )).rejects.toThrow("cloud-authority-operation-busy");
    expect(fixture.store.cloudVerificationSettingsCalls).toEqual([]);
    presenterGate.resolve(false);
    await launch;

    const replacement = fixture.controller.connectCatalog(
      { appKey: "new-app", secretKey: "new-secret" },
      "replace-identity",
    );
    await Promise.resolve();
    expect(fixture.store.cloudVerificationSettingsCalls).toHaveLength(1);
    let secondPresenterCalls = 0;
    const internals = fixture.controller as unknown as {
      readonly dependencies: { catalogLargeScanConfirmation?: { request(): Promise<boolean> } };
    };
    internals.dependencies.catalogLargeScanConfirmation = {
      request: async () => { secondPresenterCalls += 1; return true; },
    };
    await expect(fixture.controller.requestLargeCatalogVerification(
      "/Synthetic",
      [taskGroupKey],
    )).rejects.toThrow("cloud-authority-operation-busy");
    expect(secondPresenterCalls).toBe(0);
    fixture.store.resumeCloudVerificationUpdate();
    await replacement;
    expect(connection.savedCredentials).toEqual([{ appKey: "new-app", secretKey: "new-secret" }]);
    expect(hybrid.startInputs).toEqual([]);
    fixture.controller.dispose();
  });

  it("keeps same-account repair separate and fails closed for live work", async () => {
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    const hybrid = new FakeHybridCatalogRuntime({
      status: "scanning",
      executionActive: true,
      active: active(),
    });
    const fixture = controllerFixture({ catalog: new FakeCloudCatalogRuntime({}, connection, hybrid) });

    await expect(fixture.controller.connectCatalog(
      { appKey: "same-app", secretKey: "same-secret" },
      "repair-same-account",
    )).rejects.toThrow("verification-must-pause");
    expect(connection.savedCredentials).toEqual([]);
    expect(fixture.store.cloudVerificationSettingsCalls).toEqual([]);

    hybrid.setSnapshot({ status: "ready", executionActive: false, active: active() });
    await fixture.controller.connectCatalog(
      { appKey: "same-app", secretKey: "same-secret" },
      "repair-same-account",
    );
    await expect(fixture.controller.submitCatalogAuthorizationCode("code", "replace-identity"))
      .rejects.toThrow("authorization-attempt-unavailable");
    await fixture.controller.submitCatalogAuthorizationCode("code", "repair-same-account");
    expect(connection.submittedAuthorizationCodes).toEqual(["code"]);
    expect(connection.savedCredentials).toEqual([]);
    expect(fixture.store.cloudVerificationSettingsCalls).toEqual([]);
    fixture.controller.dispose();
  });
});

const INACTIVE_AUTO_RESUME = {
  autoResumeState: "inactive" as const,
  autoSegmentIndex: 0,
  autoSegmentLimit: LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
};

const directorySelection = (path: string): CloudDirectorySelection => ({
  kind: "directory",
  selectedPath: path,
  effectiveRoot: path,
});

const scanPurpose: CloudDirectoryPickerPurpose = { kind: "scan" };

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
        return directorySelection("/Synthetic/Chosen");
      },
    };

    await expect(fixture.controller.chooseCatalogRoot({ initialRoot: "   ", purpose: scanPurpose }))
      .resolves.toEqual(directorySelection("/Synthetic/Chosen"));
    for (const invalid of ["/", "Synthetic", "/Synthetic//Child"]) {
      await expect(fixture.controller.chooseCatalogRoot({ initialRoot: invalid, purpose: scanPurpose }))
        .rejects.toThrow("invalid-scan-root");
    }
    await expect(fixture.controller.chooseCatalogRoot({
      initialRoot: "/Synthetic/e\u0301",
      purpose: scanPurpose,
    })).resolves.toEqual(directorySelection("/Synthetic/Chosen"));

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
        coveredCandidatePdfCount: 0,
        groups: [{
          groupKey: "group:science",
          rootRelativePath: "Science",
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
    const catalog = new FakeCloudCatalogRuntime(
      {},
      undefined,
      hybrid,
      discovery,
      undefined,
      locator,
    );
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
      request: async (input) => { request = input; return directorySelection("/Recent/Literature"); },
    };

    await fixture.controller.chooseCatalogRoot({ initialRoot: "", purpose: scanPurpose });
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

  it("clears every directory identity cache before replacing or revoking credentials", async () => {
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
      clear: () => { events.push("discovery-clear"); },
      dispose: () => undefined,
    } satisfies CloudDirectoryDiscoveryRuntime;
    let browserRootAccessGranted = true;
    let browserHasSnapshot = true;
    const browser = {
      rootAccessGranted: () => browserRootAccessGranted,
      grantRootAccess: () => { browserRootAccessGranted = true; },
      loadLayer: async () => { throw new Error("must-not-browse"); },
      snapshot: (_path: string) => browserHasSnapshot ? {
        path: "/",
        directories: [],
        nextStart: 0,
        complete: false,
        cumulativeCheckedEntryCount: 0,
        cumulativeListRequestCount: 0,
        lastStopReason: null,
      } : null,
      subscribe: () => () => undefined,
      clear: () => {
        events.push("browser-clear");
        browserRootAccessGranted = false;
        browserHasSnapshot = false;
      },
      dispose: () => undefined,
    } satisfies CloudDirectoryBrowserRuntime;
    const locator = {
      locateByName: async () => { throw new Error("must-not-locate"); },
      cancel: () => { events.push("cancel"); },
      dispose: () => undefined,
    } satisfies CloudDirectoryLocatorRuntime;
    const catalog = new FakeCloudCatalogRuntime(
      {},
      connection,
      undefined,
      discovery,
      browser,
      locator,
    );
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
      "cancel", "discovery-clear", "browser-clear", "save", "authorize",
      "cancel", "discovery-clear", "browser-clear", "revoke",
    ]);
    expect(browser.rootAccessGranted()).toBe(false);
    expect(browser.snapshot("/")).toBeNull();
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
      request: async (input) => { request = input; return directorySelection("/Manual/Choice"); },
    };

    await expect(fixture.controller.chooseCatalogRoot({ initialRoot: "", purpose: scanPurpose }))
      .resolves.toEqual(directorySelection("/Manual/Choice"));

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

describe("WorkbenchController inline folder selection binding", () => {
  const groupKey = `group:${"f".repeat(64)}`;
  const group = {
    groupKey,
    rootRelativePath: "Literature",
    label: "Literature",
    pdfCount: 12,
    mode: "recursive" as const,
    verificationStatus: "unverified" as const,
  };
  const activeHybrid = (input: Readonly<{
    sourceImportSha256?: string;
    legacyArtifactSetSha256?: string | null;
  }> = {}): FakeHybridCatalogRuntime => new FakeHybridCatalogRuntime({
    status: "ready",
    active: {
      sourceImportSha256: input.sourceImportSha256 ?? SOURCE_HASH,
      legacyArtifactSetSha256: input.legacyArtifactSetSha256 ?? null,
      importedAt: 1,
      pdfCount: 12,
      unverifiedCount: 12,
      verifiedCount: 0,
      differenceCount: 0,
      cloudMissingCount: 0,
      groupCount: 1,
      verifiedGroupCount: 0,
      coveredCandidatePdfCount: 0,
      groups: [group],
    },
  });
  const pausedBatch = (batchId: string) => ({
    ...INACTIVE_AUTO_RESUME,
    batchId,
    verificationScope: null,
    legacyPromotionRequired: false,
    status: "paused" as const,
    stopReason: "user-canceled" as const,
    resumeAvailable: true,
    runOrdinal: 1,
    remainingGroupCount: 1,
    pdfCount: 0,
    directoryCount: 0,
    ignoredFileCount: 0,
    listRequestCount: 0,
    cumulativeListRequestCount: 0,
    selectedGroupCount: 1,
    selectedGroupKeys: [groupKey],
    completedGroupCount: 0,
    currentGroupIndex: 0,
    currentGroupKey: groupKey,
    committedPdfCount: 0,
    committedPageCount: 0,
    completedDirectoryCount: 0,
    pendingDirectoryCount: 1,
  });

  it("cleans up a failed initial session subscription before retry", () => {
    const hybrid = activeHybrid();
    const factory = new TestFolderSelectionFactory([folderCandidate("/Synthetic")]);
    factory.failSubscribeAt = 1;
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
      folderSelectionSessionFactory: factory,
    });

    expect(() => fixture.controller.openVerificationFolderSelection())
      .toThrow("folder-selection-subscribe-failed");
    expect(fixture.controller.snapshot().folderSelection).toBeUndefined();
    expect(factory.sessions[0]?.snapshot().phase).toBe("closed");

    factory.failSubscribeAt = null;
    fixture.controller.openVerificationFolderSelection();
    expect(fixture.controller.snapshot().folderSelection).toBeDefined();
    fixture.controller.dispose();
  });

  it("publishes detached state and makes actions from an old render revision inert", async () => {
    const hybrid = activeHybrid();
    const factory = new TestFolderSelectionFactory([
      folderCandidate("/Synthetic/Literature"),
    ]);
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
      folderSelectionSessionFactory: factory,
    });

    fixture.controller.openVerificationFolderSelection();

    const opened = fixture.controller.snapshot().folderSelection!;
    expect(() => structuredClone(opened)).not.toThrow();
    expect(opened).toMatchObject({
      locale: "zh-CN",
      returnLabel: "云端核验",
      legacyProgressMode: "none",
      state: { phase: "local", draftSelection: null },
    });
    expect(factory.creates).toEqual([{
      initialPath: null,
      purpose: {
        kind: "verification",
        groups: [{
          groupKey,
          rootRelativePath: "Literature",
          label: "Literature",
        }],
      },
    }]);

    const staleActions = fixture.controller.folderSelectionActions(opened.revision);
    await fixture.controller.setLocale("en");
    const localized = fixture.controller.snapshot().folderSelection!;
    expect(localized).toMatchObject({
      locale: "en",
      returnLabel: "Cloud verification",
    });
    expect(localized.revision).not.toBe(opened.revision);
    staleActions.onSelectCandidate("/Synthetic/Literature");
    expect(fixture.controller.snapshot().folderSelection?.state.draftSelection).toBeNull();

    const selectionActions = fixture.controller.folderSelectionActions(localized.revision);
    selectionActions.onSelectCandidate("/Synthetic/Literature");
    expect(fixture.controller.snapshot().folderSelection?.state.draftSelection).toEqual({
      kind: "category",
      selectedPath: "/Synthetic/Literature",
      effectiveRoot: "/Synthetic",
      groupKey,
    });
    await selectionActions.onUse();
    selectionActions.onBack();

    expect(fixture.store.cloudVerificationSettingsCalls).toEqual([]);
    expect(hybrid.preparedAdoptionScopes).toEqual([]);
    expect(fixture.controller.snapshot().folderSelection).toBeDefined();
    expect(fixture.controller.snapshot().verificationRoot).toBe("");

    fixture.controller.folderSelectionActions(
      fixture.controller.snapshot().folderSelection!.revision,
    ).onBack();
    expect(fixture.controller.snapshot().folderSelection).toBeUndefined();
    expect(factory.sessions[0]?.snapshot().phase).toBe("closed");
    fixture.controller.dispose();
  });

  it("commits one category binding with the parent effective root and exact group", async () => {
    const hybrid = activeHybrid({ legacyArtifactSetSha256: "d".repeat(64) });
    const proposedBinding = {
      schemaVersion: 1 as const,
      path: "/Synthetic",
      sourceImportSha256: SOURCE_HASH,
      verificationGeneration: 1,
    };
    const scope = deriveCloudVerificationScope(proposedBinding, hashVerificationRoot)!;
    const adopted = {
      schemaVersion: 1 as const,
      state: "adopted" as const,
      verificationGeneration: 1,
      sourceImportSha256: SOURCE_HASH,
      cloudRootSha256: scope.cloudRootSha256,
      candidate: {
        importId: "import-1",
        manifestSha256: "1".repeat(64),
        descriptorSha256: "2".repeat(64),
      },
      overlays: [],
      unified: null,
      resumableBatch: null,
    };
    hybrid.preparedAdoption = adopted;
    const factory = new TestFolderSelectionFactory([
      folderCandidate("/Synthetic/Literature"),
    ]);
    const catalog = new FakeCloudCatalogRuntime({}, undefined, hybrid);
    const fixture = controllerFixture({
      catalog,
      folderSelectionSessionFactory: factory,
    });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      legacyVerificationAdoption: { schemaVersion: 1, state: "pending" },
      verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] },
    });

    fixture.controller.openVerificationFolderSelection();
    let rendered = fixture.controller.snapshot().folderSelection!;
    fixture.controller.folderSelectionActions(rendered.revision)
      .onSelectCandidate("/Synthetic/Literature");
    rendered = fixture.controller.snapshot().folderSelection!;
    expect(rendered.legacyProgressMode).toBe("will-preserve");

    await fixture.controller.folderSelectionActions(rendered.revision).onUse();

    expect(factory.rememberCalls).toEqual(["/Synthetic/Literature"]);
    expect(hybrid.preparedAdoptionScopes).toEqual([scope]);
    expect(hybrid.revalidatedAdoptions).toEqual([adopted]);
    expect(fixture.store.cloudVerificationSettingsCalls).toEqual([{
      settings: {
        boundCloudLibrary: proposedBinding,
        cloudVerificationGeneration: 1,
        verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] },
        legacyVerificationAdoption: adopted,
      },
      transition: { kind: "library-binding", currentWorkflowBatchId: null },
    }]);
    expect(fixture.controller.snapshot()).toMatchObject({
      status: "ready",
      statusMessage: "folder-selection-preserved",
      verificationRoot: "/Synthetic",
      verificationDirectorySelection: {
        kind: "category",
        selectedPath: "/Synthetic/Literature",
        effectiveRoot: "/Synthetic",
        groupKey,
      },
      selectedVerificationGroupKeys: [groupKey],
    });
    expect(fixture.controller.snapshot().folderSelection).toBeUndefined();
    expect(hybrid.rebuildVerificationProjectionCalls).toBe(1);
    expect(hybrid.startInputs).toEqual([]);
    expect(hybrid.resumeInputs).toEqual([]);
    fixture.controller.dispose();
  });

  it("preserves an authorized resumable V3 batch during first legacy adoption", async () => {
    const proposedBinding = {
      schemaVersion: 1 as const,
      path: "/Synthetic",
      sourceImportSha256: SOURCE_HASH,
      verificationGeneration: 1,
    };
    const scope = deriveCloudVerificationScope(proposedBinding, hashVerificationRoot)!;
    const adopted = {
      schemaVersion: 1 as const,
      state: "adopted" as const,
      verificationGeneration: 1,
      sourceImportSha256: SOURCE_HASH,
      cloudRootSha256: scope.cloudRootSha256,
      candidate: {
        importId: "legacy-import-v3",
        manifestSha256: "1".repeat(64),
        descriptorSha256: "2".repeat(64),
      },
      overlays: [],
      unified: null,
      resumableBatch: {
        batchId: "legacy-resumable-v3",
        checkpointSha256: "3".repeat(64),
        sourceImportSha256: SOURCE_HASH,
        cloudRootSha256: scope.cloudRootSha256,
      },
    };
    const hybrid = activeHybrid({ legacyArtifactSetSha256: "e".repeat(64) });
    hybrid.preparedAdoption = adopted;
    hybrid.setSnapshot({
      ...hybrid.snapshot(),
      status: "paused",
      batch: {
        ...pausedBatch("legacy-resumable-v3"),
        legacyPromotionRequired: true,
      },
    });
    hybrid.beforeRebuildVerificationProjection = () => {
      const snapshot = hybrid.snapshot();
      hybrid.setSnapshot({
        ...snapshot,
        batch: {
          ...snapshot.batch!,
          verificationScope: scope,
          legacyPromotionRequired: true,
        },
      });
    };
    const factory = new TestFolderSelectionFactory([
      folderCandidate("/Synthetic/Literature"),
    ]);
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime(
        {},
        new FakeCloudCatalogConnectionRuntime({ status: "authorized" }),
        hybrid,
      ),
      folderSelectionSessionFactory: factory,
    });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      legacyVerificationAdoption: { schemaVersion: 1, state: "pending" },
    });
    hybrid.setSnapshot(hybrid.snapshot());
    fixture.controller.openVerificationFolderSelection();
    let rendered = fixture.controller.snapshot().folderSelection!;
    fixture.controller.folderSelectionActions(rendered.revision)
      .onSelectCandidate("/Synthetic/Literature");
    rendered = fixture.controller.snapshot().folderSelection!;

    await fixture.controller.folderSelectionActions(rendered.revision).onUse();

    expect(fixture.store.cloudVerificationSettingsCalls).toEqual([{
      settings: {
        boundCloudLibrary: proposedBinding,
        cloudVerificationGeneration: 1,
        verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] },
        legacyVerificationAdoption: adopted,
      },
      transition: { kind: "library-binding", currentWorkflowBatchId: null },
    }]);
    expect(fixture.controller.snapshot()).toMatchObject({
      status: "ready",
      statusMessage: "folder-selection-preserved",
      verificationRoot: "/Synthetic",
    });
    fixture.controller.dispose();
  });

  it("holds the library-binding permit while the session remembers the selection", async () => {
    const hybrid = activeHybrid();
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    const factory = new TestFolderSelectionFactory([folderCandidate("/Synthetic")]);
    const enteredRemember = deferred();
    const releaseRemember = deferred();
    factory.beforeRemember = async () => {
      enteredRemember.resolve();
      await releaseRemember.promise;
    };
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, connection, hybrid),
      folderSelectionSessionFactory: factory,
    });
    fixture.controller.openVerificationFolderSelection();
    let rendered = fixture.controller.snapshot().folderSelection!;
    fixture.controller.folderSelectionActions(rendered.revision).onSelectCandidate("/Synthetic");
    rendered = fixture.controller.snapshot().folderSelection!;

    const binding = Promise.resolve(
      fixture.controller.folderSelectionActions(rendered.revision).onUse(),
    );
    await enteredRemember.promise;
    await expect(fixture.controller.connectCatalog(
      { appKey: "replacement-app", secretKey: "replacement-secret" },
      "replace-identity",
    )).rejects.toThrow("cloud-authority-operation-busy");
    await expect(fixture.controller.requestLargeCatalogVerification(
      "/Synthetic",
      [groupKey],
    )).rejects.toThrow("cloud-authority-operation-busy");
    expect(connection.savedCredentials).toEqual([]);
    expect(fixture.store.cloudVerificationSettingsCalls).toEqual([]);

    releaseRemember.resolve();
    await binding;
    expect(fixture.store.cloudVerificationSettingsCalls).toHaveLength(1);
    expect(fixture.controller.snapshot().statusMessage).toBeUndefined();
    fixture.controller.dispose();
  });

  it("rebuilds the same selection session after a stale binding CAS", async () => {
    const hybrid = activeHybrid();
    const factory = new TestFolderSelectionFactory([
      folderCandidate("/Synthetic/Literature"),
    ]);
    const catalog = new FakeCloudCatalogRuntime({}, undefined, hybrid);
    const fixture = controllerFixture({
      catalog,
      folderSelectionSessionFactory: factory,
      pauseCloudVerificationUpdate: true,
    });
    fixture.controller.openVerificationFolderSelection();
    let rendered = fixture.controller.snapshot().folderSelection!;
    fixture.controller.folderSelectionActions(rendered.revision)
      .onSelectCandidate("/Synthetic/Literature");
    rendered = fixture.controller.snapshot().folderSelection!;
    const binding = Promise.resolve(
      fixture.controller.folderSelectionActions(rendered.revision).onUse(),
    );
    await expect.poll(() => fixture.store.cloudVerificationSettingsCalls.length).toBe(1);

    const externalBinding = {
      schemaVersion: 1 as const,
      path: "/External",
      sourceImportSha256: SOURCE_HASH,
      verificationGeneration: 1,
    };
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      boundCloudLibrary: externalBinding,
      cloudVerificationGeneration: 1,
    });
    fixture.store.resumeCloudVerificationUpdate();

    await expect(binding).rejects.toThrow("folder-selection-stale");
    expect(fixture.store.settings().boundCloudLibrary).toEqual(externalBinding);
    expect(factory.creates).toHaveLength(2);
    expect(factory.creates[1]).toEqual({
      purpose: factory.creates[0]!.purpose,
      initialPath: "/Synthetic/Literature",
    });
    expect(fixture.controller.snapshot()).toMatchObject({
      verificationRoot: "",
      folderSelection: {
        state: {
          draftSelection: {
            kind: "category",
            selectedPath: "/Synthetic/Literature",
            effectiveRoot: "/Synthetic",
            groupKey,
          },
        },
      },
    });
    expect(fixture.controller.snapshot().folderSelection?.feedbackCode).toBeUndefined();
    expect(fixture.controller.snapshot().verificationDirectorySelection).toBeUndefined();
    expect(catalog.verificationAuthorities).toEqual([]);
    fixture.controller.dispose();
  });

  it("binds a normal directory to itself and rotates a changed root with an exact tombstone", async () => {
    const hybrid = activeHybrid();
    hybrid.setSnapshot({
      ...hybrid.snapshot(),
      status: "paused",
      batch: pausedBatch("batch-old-root"),
    });
    hybrid.beforeRebuildVerificationProjection = () => {
      const { batch: _batch, ...snapshot } = hybrid.snapshot();
      hybrid.setSnapshot({ ...snapshot, status: "ready" });
    };
    const factory = new TestFolderSelectionFactory([folderCandidate("/New Library")]);
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
      folderSelectionSessionFactory: factory,
    });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      boundCloudLibrary: {
        schemaVersion: 1,
        path: "/Old Library",
        sourceImportSha256: SOURCE_HASH,
        verificationGeneration: 1,
      },
      cloudVerificationGeneration: 1,
      legacyVerificationAdoption: { schemaVersion: 1, state: "none" },
    });
    fixture.controller.toggleVerificationGroup(groupKey);
    fixture.controller.openVerificationFolderSelection();
    let rendered = fixture.controller.snapshot().folderSelection!;
    fixture.controller.folderSelectionActions(rendered.revision)
      .onSelectCandidate("/New Library");
    rendered = fixture.controller.snapshot().folderSelection!;

    await fixture.controller.folderSelectionActions(rendered.revision).onUse();

    expect(fixture.store.cloudVerificationSettingsCalls.at(-1)).toEqual({
      settings: {
        boundCloudLibrary: {
          schemaVersion: 1,
          path: "/New Library",
          sourceImportSha256: SOURCE_HASH,
          verificationGeneration: 2,
        },
        cloudVerificationGeneration: 2,
        legacyVerificationAdoption: { schemaVersion: 1, state: "none" },
        verificationBatchTombstones: {
          schemaVersion: 1,
          state: "valid",
          batchIds: ["batch-old-root"],
        },
      },
      transition: {
        kind: "library-binding",
        currentWorkflowBatchId: "batch-old-root",
      },
    });
    expect(fixture.controller.snapshot()).toMatchObject({
      verificationRoot: "/New Library",
      verificationDirectorySelection: {
        kind: "directory",
        selectedPath: "/New Library",
        effectiveRoot: "/New Library",
      },
      selectedVerificationGroupKeys: [groupKey],
    });
    expect(hybrid.preparedAdoptionScopes).toEqual([]);
    fixture.controller.dispose();
  });

  it("treats an adopted batch as historical when switching to a new root", async () => {
    const oldBinding = {
      schemaVersion: 1 as const,
      path: "/Old Library",
      sourceImportSha256: SOURCE_HASH,
      verificationGeneration: 1,
    };
    const oldScope = deriveCloudVerificationScope(oldBinding, hashVerificationRoot)!;
    const historicalAdoption = {
      schemaVersion: 1 as const,
      state: "adopted" as const,
      verificationGeneration: 1,
      sourceImportSha256: SOURCE_HASH,
      cloudRootSha256: oldScope.cloudRootSha256,
      candidate: {
        importId: "legacy-import",
        manifestSha256: "1".repeat(64),
        descriptorSha256: "2".repeat(64),
      },
      overlays: [],
      unified: null,
      resumableBatch: {
        batchId: "adopted-old-root-batch",
        checkpointSha256: "3".repeat(64),
        sourceImportSha256: SOURCE_HASH,
        cloudRootSha256: oldScope.cloudRootSha256,
      },
    };
    const hybrid = activeHybrid({ legacyArtifactSetSha256: "e".repeat(64) });
    hybrid.setSnapshot({
      ...hybrid.snapshot(),
      status: "paused",
      batch: {
        ...pausedBatch("adopted-old-root-batch"),
        verificationScope: oldScope,
        legacyPromotionRequired: true,
      },
    });
    hybrid.beforeRebuildVerificationProjection = () => {
      const { batch: _batch, ...snapshot } = hybrid.snapshot();
      hybrid.setSnapshot({ ...snapshot, status: "ready" });
    };
    const factory = new TestFolderSelectionFactory([folderCandidate("/New Library")]);
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
      folderSelectionSessionFactory: factory,
    });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      boundCloudLibrary: oldBinding,
      cloudVerificationGeneration: 1,
      legacyVerificationAdoption: historicalAdoption,
    });
    fixture.controller.openVerificationFolderSelection();
    let rendered = fixture.controller.snapshot().folderSelection!;
    fixture.controller.folderSelectionActions(rendered.revision)
      .onSelectCandidate("/New Library");
    rendered = fixture.controller.snapshot().folderSelection!;

    await fixture.controller.folderSelectionActions(rendered.revision).onUse();

    expect(fixture.store.settings()).toMatchObject({
      boundCloudLibrary: { path: "/New Library", verificationGeneration: 2 },
      cloudVerificationGeneration: 2,
      legacyVerificationAdoption: historicalAdoption,
      verificationBatchTombstones: {
        schemaVersion: 1,
        state: "valid",
        batchIds: ["adopted-old-root-batch"],
      },
    });
    expect(fixture.controller.snapshot().verificationRoot).toBe("/New Library");
    fixture.controller.dispose();
  });

  it("tombstones an exact same-root batch while the workflow requires batch repair", async () => {
    const binding = {
      schemaVersion: 1 as const,
      path: "/Synthetic",
      sourceImportSha256: SOURCE_HASH,
      verificationGeneration: 1,
    };
    const scope = deriveCloudVerificationScope(binding, hashVerificationRoot)!;
    const hybrid = activeHybrid();
    hybrid.setSnapshot({
      ...hybrid.snapshot(),
      status: "paused",
      messageCode: "hybrid-batch-invalid",
      batch: {
        ...pausedBatch("same-root-invalid-batch"),
        verificationScope: scope,
      },
    });
    hybrid.beforeRebuildVerificationProjection = () => {
      const { batch: _batch, messageCode: _messageCode, ...snapshot } = hybrid.snapshot();
      hybrid.setSnapshot({ ...snapshot, status: "ready" });
    };
    const factory = new TestFolderSelectionFactory([folderCandidate("/Synthetic")]);
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime(
        {},
        new FakeCloudCatalogConnectionRuntime({ status: "authorized" }),
        hybrid,
      ),
      folderSelectionSessionFactory: factory,
    });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      boundCloudLibrary: binding,
      cloudVerificationGeneration: 1,
    });
    hybrid.setSnapshot(hybrid.snapshot());
    fixture.controller.openVerificationFolderSelection();
    let rendered = fixture.controller.snapshot().folderSelection!;
    fixture.controller.folderSelectionActions(rendered.revision).onSelectCandidate("/Synthetic");
    rendered = fixture.controller.snapshot().folderSelection!;

    await fixture.controller.folderSelectionActions(rendered.revision).onUse();

    expect(fixture.store.cloudVerificationSettingsCalls.at(-1)).toMatchObject({
      settings: {
        verificationBatchTombstones: {
          schemaVersion: 1,
          state: "valid",
          batchIds: ["same-root-invalid-batch"],
        },
      },
      transition: {
        kind: "library-binding",
        currentWorkflowBatchId: "same-root-invalid-batch",
      },
    });
    fixture.controller.dispose();
  });

  it("requires one second explicit use after a deterministic legacy lineage conflict", async () => {
    class ConflictingLegacyHybrid extends FakeHybridCatalogRuntime {
      override async prepareLegacyVerificationAdoption(
        scope: Parameters<FakeHybridCatalogRuntime["prepareLegacyVerificationAdoption"]>[0],
      ): Promise<LegacyVerificationAdoptionV1 | null> {
        this.preparedAdoptionScopes.push(structuredClone(scope));
        throw new HybridCatalogError("hybrid-cloud-root-mismatch");
      }
    }
    const hybrid = new ConflictingLegacyHybrid(activeHybrid({
      legacyArtifactSetSha256: "e".repeat(64),
    }).snapshot());
    hybrid.setSnapshot({
      ...hybrid.snapshot(),
      status: "paused",
      batch: pausedBatch("legacy-conflict-batch"),
    });
    const factory = new TestFolderSelectionFactory([
      folderCandidate("/Synthetic/Literature"),
    ]);
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
      folderSelectionSessionFactory: factory,
    });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      legacyVerificationAdoption: { schemaVersion: 1, state: "pending" },
    });
    fixture.controller.openVerificationFolderSelection();
    let rendered = fixture.controller.snapshot().folderSelection!;
    fixture.controller.folderSelectionActions(rendered.revision)
      .onSelectCandidate("/Synthetic/Literature");
    rendered = fixture.controller.snapshot().folderSelection!;

    await fixture.controller.folderSelectionActions(rendered.revision).onUse();

    expect(fixture.store.cloudVerificationSettingsCalls).toEqual([]);
    expect(factory.creates).toHaveLength(2);
    rendered = fixture.controller.snapshot().folderSelection!;
    expect(rendered.legacyProgressMode).toBe("requires-fresh");
    expect(rendered.state.draftSelection).toMatchObject({
      kind: "category",
      effectiveRoot: "/Synthetic",
      groupKey,
    });
    hybrid.beforeRebuildVerificationProjection = () => {
      const { batch: _batch, ...snapshot } = hybrid.snapshot();
      hybrid.setSnapshot({ ...snapshot, status: "ready" });
    };

    await fixture.controller.folderSelectionActions(rendered.revision).onUse();

    expect(hybrid.preparedAdoptionScopes).toHaveLength(1);
    expect(fixture.store.cloudVerificationSettingsCalls).toHaveLength(1);
    expect(fixture.store.cloudVerificationSettingsCalls[0]).toMatchObject({
      settings: {
        boundCloudLibrary: { path: "/Synthetic", verificationGeneration: 1 },
        cloudVerificationGeneration: 1,
        legacyVerificationAdoption: { schemaVersion: 1, state: "ineligible" },
        verificationBatchTombstones: {
          schemaVersion: 1,
          state: "valid",
          batchIds: ["legacy-conflict-batch"],
        },
      },
      transition: {
        kind: "library-binding",
        currentWorkflowBatchId: "legacy-conflict-batch",
      },
    });
    expect(fixture.controller.snapshot().folderSelection).toBeUndefined();
    fixture.controller.dispose();
  });

  it("fresh-binds an invalid legacy sidecar without attempting preservation", async () => {
    const hybrid = activeHybrid({ legacyArtifactSetSha256: "e".repeat(64) });
    const factory = new TestFolderSelectionFactory([folderCandidate("/Synthetic")]);
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
      folderSelectionSessionFactory: factory,
    });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      legacyVerificationAdoption: { schemaVersion: 1, state: "invalid" },
      verificationBatchTombstones: { schemaVersion: 1, state: "invalid" },
    });
    fixture.controller.openVerificationFolderSelection();
    let rendered = fixture.controller.snapshot().folderSelection!;
    expect(rendered.legacyProgressMode).toBe("requires-fresh");
    fixture.controller.folderSelectionActions(rendered.revision).onSelectCandidate("/Synthetic");
    rendered = fixture.controller.snapshot().folderSelection!;

    await fixture.controller.folderSelectionActions(rendered.revision).onUse();

    expect(hybrid.preparedAdoptionScopes).toEqual([]);
    expect(fixture.store.cloudVerificationSettingsCalls[0]).toMatchObject({
      settings: {
        legacyVerificationAdoption: { schemaVersion: 1, state: "ineligible" },
        verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] },
      },
      transition: { kind: "library-binding", currentWorkflowBatchId: null },
    });
    fixture.controller.dispose();
  });

  it("keeps a recoverable session and the old model when the binding save fails", async () => {
    const hybrid = activeHybrid();
    const factory = new TestFolderSelectionFactory([folderCandidate("/Synthetic")]);
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
      folderSelectionSessionFactory: factory,
    });
    fixture.store.failNext = new Error("binding-save-failed");
    fixture.controller.openVerificationFolderSelection();
    let rendered = fixture.controller.snapshot().folderSelection!;
    fixture.controller.folderSelectionActions(rendered.revision).onSelectCandidate("/Synthetic");
    rendered = fixture.controller.snapshot().folderSelection!;

    await expect(fixture.controller.folderSelectionActions(rendered.revision).onUse())
      .rejects.toThrow("binding-save-failed");

    expect(fixture.store.settings().boundCloudLibrary).toBeNull();
    expect(fixture.controller.snapshot().verificationRoot).toBe("");
    expect(fixture.controller.snapshot().verificationDirectorySelection).toBeUndefined();
    expect(factory.creates).toHaveLength(2);
    expect(fixture.controller.snapshot().folderSelection?.state.draftSelection).toEqual({
      kind: "directory",
      selectedPath: "/Synthetic",
      effectiveRoot: "/Synthetic",
    });
    expect(fixture.controller.snapshot().folderSelection?.feedbackCode).toBe("binding-failed");
    const failureRevision = fixture.controller.snapshot().folderSelection!.revision;
    fixture.controller.folderSelectionActions(failureRevision).onQuery("Synthetic");
    expect(fixture.controller.snapshot().folderSelection?.feedbackCode).toBeUndefined();
    fixture.controller.dispose();
  });

  it("keeps a durable binding and reinstalls its authority when projection rebuild fails", async () => {
    const hybrid = activeHybrid();
    hybrid.beforeRebuildVerificationProjection = () => {
      throw new Error("binding-rebuild-failed");
    };
    const factory = new TestFolderSelectionFactory([folderCandidate("/Synthetic")]);
    const catalog = new FakeCloudCatalogRuntime({}, undefined, hybrid);
    const fixture = controllerFixture({
      catalog,
      folderSelectionSessionFactory: factory,
    });
    fixture.controller.openVerificationFolderSelection();
    let rendered = fixture.controller.snapshot().folderSelection!;
    fixture.controller.folderSelectionActions(rendered.revision).onSelectCandidate("/Synthetic");
    rendered = fixture.controller.snapshot().folderSelection!;

    await expect(fixture.controller.folderSelectionActions(rendered.revision).onUse())
      .rejects.toThrow("binding-rebuild-failed");

    expect(fixture.store.settings()).toMatchObject({
      boundCloudLibrary: {
        path: "/Synthetic",
        sourceImportSha256: SOURCE_HASH,
        verificationGeneration: 1,
      },
      cloudVerificationGeneration: 1,
    });
    expect(catalog.verificationAuthorities.at(-1)).toMatchObject({
      kind: "scoped",
      scope: {
        generation: 1,
        sourceImportSha256: SOURCE_HASH,
        cloudRootSha256: hashVerificationRoot("/Synthetic"),
      },
    });
    expect(fixture.controller.snapshot().verificationRoot).toBe("");
    expect(factory.creates).toHaveLength(2);
    expect(fixture.controller.snapshot().folderSelection?.state.draftSelection).toEqual({
      kind: "directory",
      selectedPath: "/Synthetic",
      effectiveRoot: "/Synthetic",
    });
    expect(fixture.controller.snapshot().folderSelection?.feedbackCode).toBe("binding-failed");
    fixture.controller.dispose();
  });

  it("invalidates an adoption result when the page is explicitly closed during its await", async () => {
    const entered = deferred();
    const release = deferred();
    class DeferredLegacyHybrid extends FakeHybridCatalogRuntime {
      override async prepareLegacyVerificationAdoption(
        scope: Parameters<FakeHybridCatalogRuntime["prepareLegacyVerificationAdoption"]>[0],
      ) {
        this.preparedAdoptionScopes.push(structuredClone(scope));
        entered.resolve();
        await release.promise;
        return null;
      }
    }
    const hybrid = new DeferredLegacyHybrid(activeHybrid({
      legacyArtifactSetSha256: "e".repeat(64),
    }).snapshot());
    const factory = new TestFolderSelectionFactory([folderCandidate("/Synthetic")]);
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
      folderSelectionSessionFactory: factory,
    });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      legacyVerificationAdoption: { schemaVersion: 1, state: "pending" },
    });
    fixture.controller.openVerificationFolderSelection();
    let rendered = fixture.controller.snapshot().folderSelection!;
    fixture.controller.folderSelectionActions(rendered.revision).onSelectCandidate("/Synthetic");
    rendered = fixture.controller.snapshot().folderSelection!;
    const binding = Promise.resolve(
      fixture.controller.folderSelectionActions(rendered.revision).onUse(),
    );
    await entered.promise;

    fixture.controller.closeFolderSelection();
    release.resolve();

    await expect(binding).rejects.toThrow("folder-selection-stale");
    expect(fixture.store.cloudVerificationSettingsCalls).toEqual([]);
    expect(fixture.controller.snapshot().folderSelection).toBeUndefined();
    expect(fixture.controller.snapshot().verificationRoot).toBe("");
    fixture.controller.dispose();
  });

  it("prevents a binding write when disposed before the CAS begins", async () => {
    const entered = deferred();
    const release = deferred();
    class DeferredLegacyHybrid extends FakeHybridCatalogRuntime {
      override async prepareLegacyVerificationAdoption(
        scope: Parameters<FakeHybridCatalogRuntime["prepareLegacyVerificationAdoption"]>[0],
      ): Promise<LegacyVerificationAdoptionV1 | null> {
        this.preparedAdoptionScopes.push(structuredClone(scope));
        entered.resolve();
        await release.promise;
        return null;
      }
    }
    const hybrid = new DeferredLegacyHybrid(activeHybrid({
      legacyArtifactSetSha256: "e".repeat(64),
    }).snapshot());
    const factory = new TestFolderSelectionFactory([folderCandidate("/Synthetic")]);
    const catalog = new FakeCloudCatalogRuntime({}, undefined, hybrid);
    const fixture = controllerFixture({
      catalog,
      folderSelectionSessionFactory: factory,
    });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      legacyVerificationAdoption: { schemaVersion: 1, state: "pending" },
    });
    fixture.controller.openVerificationFolderSelection();
    let rendered = fixture.controller.snapshot().folderSelection!;
    fixture.controller.folderSelectionActions(rendered.revision).onSelectCandidate("/Synthetic");
    rendered = fixture.controller.snapshot().folderSelection!;
    const binding = Promise.resolve(
      fixture.controller.folderSelectionActions(rendered.revision).onUse(),
    );
    await entered.promise;

    fixture.controller.dispose();
    release.resolve();

    await expect(binding).rejects.toThrow("folder-selection-stale");
    expect(fixture.store.cloudVerificationSettingsCalls).toEqual([]);
    expect(catalog.verificationAuthorities).toEqual([]);
    expect(hybrid.rebuildVerificationProjectionCalls).toBe(0);
  });

  it("linearizes an explicit close after the binding CAS starts", async () => {
    const hybrid = activeHybrid();
    const factory = new TestFolderSelectionFactory([folderCandidate("/Synthetic")]);
    const catalog = new FakeCloudCatalogRuntime({}, undefined, hybrid);
    const fixture = controllerFixture({
      catalog,
      folderSelectionSessionFactory: factory,
      pauseCloudVerificationUpdate: true,
    });
    fixture.controller.openVerificationFolderSelection();
    let rendered = fixture.controller.snapshot().folderSelection!;
    fixture.controller.folderSelectionActions(rendered.revision).onSelectCandidate("/Synthetic");
    rendered = fixture.controller.snapshot().folderSelection!;
    const binding = Promise.resolve(
      fixture.controller.folderSelectionActions(rendered.revision).onUse(),
    );
    await expect.poll(() => fixture.store.cloudVerificationSettingsCalls.length).toBe(1);

    fixture.controller.closeFolderSelection();
    fixture.controller.openVerificationFolderSelection();

    expect(fixture.controller.snapshot().folderSelection).toBeUndefined();
    expect(factory.creates).toHaveLength(1);
    fixture.store.resumeCloudVerificationUpdate();
    await binding;

    expect(fixture.store.settings().boundCloudLibrary).toMatchObject({
      path: "/Synthetic",
      sourceImportSha256: SOURCE_HASH,
      verificationGeneration: 1,
    });
    expect(catalog.verificationAuthorities.at(-1)).toMatchObject({
      kind: "scoped",
      scope: { generation: 1, sourceImportSha256: SOURCE_HASH },
    });
    expect(hybrid.rebuildVerificationProjectionCalls).toBe(1);
    expect(fixture.controller.snapshot()).toMatchObject({ verificationRoot: "" });
    expect(fixture.controller.snapshot().verificationDirectorySelection).toBeUndefined();
    expect(fixture.controller.snapshot().folderSelection).toBeUndefined();
    fixture.controller.dispose();
  });

  it("allows a linearized CAS to persist after dispose without runtime or model work", async () => {
    const hybrid = activeHybrid();
    const factory = new TestFolderSelectionFactory([folderCandidate("/Synthetic")]);
    const catalog = new FakeCloudCatalogRuntime({}, undefined, hybrid);
    const fixture = controllerFixture({
      catalog,
      folderSelectionSessionFactory: factory,
      pauseCloudVerificationUpdate: true,
    });
    fixture.controller.openVerificationFolderSelection();
    let rendered = fixture.controller.snapshot().folderSelection!;
    fixture.controller.folderSelectionActions(rendered.revision).onSelectCandidate("/Synthetic");
    rendered = fixture.controller.snapshot().folderSelection!;
    const binding = Promise.resolve(
      fixture.controller.folderSelectionActions(rendered.revision).onUse(),
    );
    await expect.poll(() => fixture.store.cloudVerificationSettingsCalls.length).toBe(1);

    fixture.controller.dispose();
    fixture.store.resumeCloudVerificationUpdate();
    await binding;

    expect(fixture.store.settings().boundCloudLibrary).toMatchObject({
      path: "/Synthetic",
      sourceImportSha256: SOURCE_HASH,
      verificationGeneration: 1,
    });
    expect(catalog.verificationAuthorities).toEqual([]);
    expect(hybrid.rebuildVerificationProjectionCalls).toBe(0);
    expect(fixture.controller.snapshot().verificationRoot).toBe("");
    expect(fixture.controller.snapshot().verificationDirectorySelection).toBeUndefined();
  });

  it("does no further binding work when disposed during catalog projection refresh", async () => {
    const enteredRefresh = deferred();
    const releaseRefresh = deferred();
    class DeferredRefreshCatalog extends FakeCloudCatalogRuntime {
      override async initialize(): Promise<void> {
        enteredRefresh.resolve();
        await releaseRefresh.promise;
      }
    }
    const hybrid = activeHybrid();
    const factory = new TestFolderSelectionFactory([folderCandidate("/Synthetic")]);
    const catalog = new DeferredRefreshCatalog({}, undefined, hybrid);
    const fixture = controllerFixture({ catalog, folderSelectionSessionFactory: factory });
    fixture.controller.openVerificationFolderSelection();
    let rendered = fixture.controller.snapshot().folderSelection!;
    fixture.controller.folderSelectionActions(rendered.revision).onSelectCandidate("/Synthetic");
    rendered = fixture.controller.snapshot().folderSelection!;
    const binding = Promise.resolve(
      fixture.controller.folderSelectionActions(rendered.revision).onUse(),
    );
    await enteredRefresh.promise;
    const authorityCountAtDispose = catalog.verificationAuthorities.length;
    const rebuildCountAtDispose = hybrid.rebuildVerificationProjectionCalls;

    fixture.controller.dispose();
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      boundCloudLibrary: {
        schemaVersion: 1,
        path: "/External",
        sourceImportSha256: SOURCE_HASH,
        verificationGeneration: 2,
      },
      cloudVerificationGeneration: 2,
    });
    releaseRefresh.resolve();
    await binding;

    expect(catalog.verificationAuthorities).toHaveLength(authorityCountAtDispose);
    expect(hybrid.rebuildVerificationProjectionCalls).toBe(rebuildCountAtDispose);
    expect(fixture.controller.snapshot().verificationRoot).toBe("");
  });

  it("clears the legacy fresh-start token immediately after durable save", async () => {
    class ConflictingLegacyHybrid extends FakeHybridCatalogRuntime {
      override async prepareLegacyVerificationAdoption(
        scope: Parameters<FakeHybridCatalogRuntime["prepareLegacyVerificationAdoption"]>[0],
      ): Promise<LegacyVerificationAdoptionV1 | null> {
        this.preparedAdoptionScopes.push(structuredClone(scope));
        throw new HybridCatalogError("hybrid-cloud-root-mismatch");
      }
    }
    const hybrid = new ConflictingLegacyHybrid(activeHybrid({
      legacyArtifactSetSha256: "e".repeat(64),
    }).snapshot());
    hybrid.setSnapshot({
      ...hybrid.snapshot(),
      status: "paused",
      batch: pausedBatch("legacy-conflict-batch"),
    });
    const factory = new TestFolderSelectionFactory([folderCandidate("/Synthetic")]);
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
      folderSelectionSessionFactory: factory,
    });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      legacyVerificationAdoption: { schemaVersion: 1, state: "pending" },
    });
    fixture.controller.openVerificationFolderSelection();
    let rendered = fixture.controller.snapshot().folderSelection!;
    fixture.controller.folderSelectionActions(rendered.revision).onSelectCandidate("/Synthetic");
    rendered = fixture.controller.snapshot().folderSelection!;

    await fixture.controller.folderSelectionActions(rendered.revision).onUse();
    hybrid.beforeRebuildVerificationProjection = () => {
      throw new Error("binding-rebuild-failed");
    };
    rendered = fixture.controller.snapshot().folderSelection!;
    await expect(fixture.controller.folderSelectionActions(rendered.revision).onUse())
      .rejects.toThrow("binding-rebuild-failed");

    hybrid.beforeRebuildVerificationProjection = undefined;
    const durableScope = deriveCloudVerificationScope(
      fixture.store.settings().boundCloudLibrary,
      hashVerificationRoot,
    )!;
    hybrid.setSnapshot({
      ...hybrid.snapshot(),
      status: "paused",
      batch: {
        ...pausedBatch("new-batch-after-durable-save"),
        verificationScope: durableScope,
      },
    });
    rendered = fixture.controller.snapshot().folderSelection!;
    await fixture.controller.folderSelectionActions(rendered.revision).onUse();

    expect(fixture.store.cloudVerificationSettingsCalls).toHaveLength(2);
    expect(fixture.store.cloudVerificationSettingsCalls[1]).toMatchObject({
      settings: {
        verificationBatchTombstones: {
          schemaVersion: 1,
          state: "valid",
          batchIds: ["legacy-conflict-batch"],
        },
      },
      transition: { kind: "library-binding", currentWorkflowBatchId: null },
    });
    fixture.controller.dispose();
  });

  it("rejects category purpose drift after projection rebuild", async () => {
    const hybrid = activeHybrid();
    hybrid.beforeRebuildVerificationProjection = () => {
      const snapshot = hybrid.snapshot();
      hybrid.setSnapshot({
        ...snapshot,
        active: {
          ...snapshot.active!,
          groupCount: 0,
          groups: [],
        },
      });
    };
    const factory = new TestFolderSelectionFactory([
      folderCandidate("/Synthetic/Literature"),
    ]);
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
      folderSelectionSessionFactory: factory,
    });
    fixture.controller.openVerificationFolderSelection();
    let rendered = fixture.controller.snapshot().folderSelection!;
    fixture.controller.folderSelectionActions(rendered.revision)
      .onSelectCandidate("/Synthetic/Literature");
    rendered = fixture.controller.snapshot().folderSelection!;

    await expect(fixture.controller.folderSelectionActions(rendered.revision).onUse())
      .rejects.toThrow("folder-selection-stale");

    expect(fixture.store.settings().boundCloudLibrary).toMatchObject({ path: "/Synthetic" });
    expect(fixture.controller.snapshot().verificationRoot).toBe("");
    expect(fixture.controller.snapshot().verificationDirectorySelection).toBeUndefined();
    expect(fixture.controller.snapshot().selectedVerificationGroupKeys).toEqual([]);
    expect(fixture.controller.snapshot().folderSelection).toBeUndefined();
    fixture.controller.dispose();
  });

  it("rejects legacy artifact drift after projection rebuild", async () => {
    const hybrid = activeHybrid({ legacyArtifactSetSha256: "e".repeat(64) });
    hybrid.beforeRebuildVerificationProjection = () => {
      const snapshot = hybrid.snapshot();
      hybrid.setSnapshot({
        ...snapshot,
        active: {
          ...snapshot.active!,
          legacyArtifactSetSha256: "9".repeat(64),
        },
      });
    };
    const factory = new TestFolderSelectionFactory([folderCandidate("/Synthetic")]);
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
      folderSelectionSessionFactory: factory,
    });
    fixture.controller.openVerificationFolderSelection();
    let rendered = fixture.controller.snapshot().folderSelection!;
    fixture.controller.folderSelectionActions(rendered.revision).onSelectCandidate("/Synthetic");
    rendered = fixture.controller.snapshot().folderSelection!;

    await expect(fixture.controller.folderSelectionActions(rendered.revision).onUse())
      .rejects.toThrow("folder-selection-stale");

    expect(fixture.store.settings().boundCloudLibrary).toMatchObject({ path: "/Synthetic" });
    expect(fixture.controller.snapshot().verificationRoot).toBe("");
    expect(fixture.controller.snapshot().folderSelection).toBeUndefined();
    fixture.controller.dispose();
  });

  it("rejects an unexpected batch scope after projection rebuild", async () => {
    const hybrid = activeHybrid();
    hybrid.beforeRebuildVerificationProjection = () => {
      hybrid.setSnapshot({
        ...hybrid.snapshot(),
        status: "paused",
        batch: {
          ...pausedBatch("unexpected-post-binding-batch"),
          verificationScope: {
            generation: 99,
            sourceImportSha256: SOURCE_HASH,
            cloudRootSha256: hashVerificationRoot("/Wrong"),
          },
        },
      });
    };
    const factory = new TestFolderSelectionFactory([folderCandidate("/Synthetic")]);
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
      folderSelectionSessionFactory: factory,
    });
    fixture.controller.openVerificationFolderSelection();
    let rendered = fixture.controller.snapshot().folderSelection!;
    fixture.controller.folderSelectionActions(rendered.revision).onSelectCandidate("/Synthetic");
    rendered = fixture.controller.snapshot().folderSelection!;

    await expect(fixture.controller.folderSelectionActions(rendered.revision).onUse())
      .rejects.toThrow("folder-selection-stale");

    expect(fixture.store.settings().boundCloudLibrary).toMatchObject({ path: "/Synthetic" });
    expect(fixture.controller.snapshot().verificationRoot).toBe("");
    expect(fixture.controller.snapshot().verificationDirectorySelection).toBeUndefined();
    fixture.controller.dispose();
  });

  it.each(["create", "subscribe"] as const)(
    "clears the page when recoverable session %s fails",
    async (failure) => {
      const hybrid = activeHybrid();
      const factory = new TestFolderSelectionFactory([folderCandidate("/Synthetic")]);
      if (failure === "create") factory.failCreateAt = 2;
      else factory.failSubscribeAt = 2;
      const fixture = controllerFixture({
        catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
        folderSelectionSessionFactory: factory,
      });
      fixture.store.failNext = new Error("binding-save-failed");
      fixture.controller.openVerificationFolderSelection();
      let rendered = fixture.controller.snapshot().folderSelection!;
      fixture.controller.folderSelectionActions(rendered.revision).onSelectCandidate("/Synthetic");
      rendered = fixture.controller.snapshot().folderSelection!;
      let emissions = 0;
      const unsubscribe = fixture.controller.subscribe(() => { emissions += 1; });

      await expect(fixture.controller.folderSelectionActions(rendered.revision).onUse())
        .rejects.toThrow("binding-save-failed");

      expect(fixture.controller.snapshot().folderSelection).toBeUndefined();
      expect(fixture.controller.snapshot().statusMessage)
        .toBe("folder-selection-binding-failed");
      expect(emissions).toBeGreaterThan(0);
      if (failure === "subscribe") {
        expect(factory.sessions[1]?.snapshot().phase).toBe("closed");
      }
      unsubscribe();
      fixture.controller.dispose();
    },
  );

  it("rejects use before remember while an identity replacement owns cloud authority", async () => {
    const hybrid = activeHybrid();
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    const factory = new TestFolderSelectionFactory([folderCandidate("/Synthetic")]);
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, connection, hybrid),
      folderSelectionSessionFactory: factory,
      pauseCloudVerificationUpdate: true,
    });
    fixture.controller.openVerificationFolderSelection();
    let rendered = fixture.controller.snapshot().folderSelection!;
    fixture.controller.folderSelectionActions(rendered.revision).onSelectCandidate("/Synthetic");
    rendered = fixture.controller.snapshot().folderSelection!;
    const replacing = fixture.controller.connectCatalog(
      { appKey: "replacement-app", secretKey: "replacement-secret" },
      "replace-identity",
    );
    await expect.poll(() => fixture.store.cloudVerificationSettingsCalls.length).toBe(1);

    await expect(fixture.controller.folderSelectionActions(rendered.revision).onUse())
      .rejects.toThrow("cloud-authority-operation-busy");
    expect(factory.rememberCalls).toEqual([]);

    fixture.store.resumeCloudVerificationUpdate();
    await replacing;
    expect(fixture.controller.snapshot().folderSelection).toBeUndefined();
    fixture.controller.dispose();
  });
});

describe("WorkbenchController verification page state", () => {
  const groupKey = `group:${"b".repeat(64)}`;
  const group = {
    groupKey,
    rootRelativePath: "Literature",
    label: "Literature",
    pdfCount: 12,
    mode: "recursive" as const,
    verificationStatus: "unverified" as const,
  };
  const installCurrentVerificationScope = (
    fixture: ReturnType<typeof controllerFixture>,
    hybrid: FakeHybridCatalogRuntime,
    root: string,
    groupKeys: readonly string[] = [groupKey],
  ): void => {
    const snapshot = hybrid.snapshot();
    const sourceImportSha256 = snapshot.active?.sourceImportSha256;
    if (sourceImportSha256 === undefined) throw new Error("test-active-catalog-required");
    const binding = {
      schemaVersion: 1 as const,
      path: root,
      sourceImportSha256,
      verificationGeneration: 1,
    };
    const scope = deriveCloudVerificationScope(binding, hashVerificationRoot)!;
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      boundCloudLibrary: binding,
      cloudVerificationGeneration: 1,
      verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] },
      legacyVerificationAdoption: { schemaVersion: 1, state: "none" },
    });
    if (snapshot.batch !== undefined) {
      hybrid.setSnapshot({
        ...snapshot,
        batch: {
          ...snapshot.batch,
          verificationScope: scope,
          legacyPromotionRequired: false,
          selectedGroupCount: groupKeys.length,
          selectedGroupKeys: [...groupKeys],
        },
      });
    }
  };
  const resumableHybrid = (): FakeHybridCatalogRuntime => new FakeHybridCatalogRuntime({
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
      coveredCandidatePdfCount: 0,
      groups: [group],
    },
    batch: {
      ...INACTIVE_AUTO_RESUME,
      batchId: "batch-resume-guard",
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
      selectedGroupCount: 1,
      selectedGroupKeys: [groupKey],
      completedGroupCount: 0,
      currentGroupIndex: 0,
      currentGroupKey: null,
      committedPdfCount: 0,
      committedPageCount: 0,
      completedDirectoryCount: 0,
      pendingDirectoryCount: 0,
    },
  });

  it("starts the recommended task scope in one action without opening the legacy modal", async () => {
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
        coveredCandidatePdfCount: 0,
        groups: [group],
      },
    });
    let confirmationCalls = 0;
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, connection, hybrid),
      catalogLargeScanConfirmation: {
        request: async () => { confirmationCalls += 1; return true; },
      },
    });
    installCurrentVerificationScope(fixture, hybrid, "/Synthetic");
    hybrid.setSnapshot(hybrid.snapshot());
    const revision = fixture.controller.snapshot().taskActionRevision;

    await fixture.controller.performTaskVerificationAction("start", revision);

    expect(confirmationCalls).toBe(0);
    expect(hybrid.startInputs).toEqual([{
      cloudRoot: "/Synthetic",
      groupKeys: [groupKey],
    }]);
    expect(fixture.controller.snapshot().taskActionPending).toBe(false);
    fixture.controller.dispose();
  });

  it("rejects a stale task revision before presenting or starting verification", async () => {
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
        coveredCandidatePdfCount: 0,
        groups: [group],
      },
    });
    let confirmationCalls = 0;
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, connection, hybrid),
      catalogLargeScanConfirmation: {
        request: async () => { confirmationCalls += 1; return true; },
      },
    });
    installCurrentVerificationScope(fixture, hybrid, "/Synthetic");
    hybrid.setSnapshot(hybrid.snapshot());
    const staleRevision = fixture.controller.snapshot().taskActionRevision;
    fixture.controller.toggleVerificationGroup(groupKey);

    await expect(fixture.controller.performTaskVerificationAction("start", staleRevision))
      .rejects.toThrow("task-action-stale");
    expect(confirmationCalls).toBe(0);
    expect(hybrid.startInputs).toEqual([]);
    fixture.controller.dispose();
  });

  it("fails fast when a second task verification action is requested while the first is pending", async () => {
    const entered = deferred();
    const gate = deferred();
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
        coveredCandidatePdfCount: 0,
        groups: [group],
      },
    });
    hybrid.beforeStart = async () => {
      hybrid.setSnapshot({
        ...hybrid.snapshot(),
        status: "ready",
        messageCode: "catalog-unavailable",
      });
      entered.resolve();
      await gate.promise;
    };
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, connection, hybrid),
    });
    installCurrentVerificationScope(fixture, hybrid, "/Synthetic");
    hybrid.setSnapshot(hybrid.snapshot());
    const revision = fixture.controller.snapshot().taskActionRevision;

    const first = fixture.controller.performTaskVerificationAction("start", revision);
    await entered.promise;
    expect(fixture.controller.snapshot().taskActionPending).toBe(true);
    await expect(fixture.controller.performTaskVerificationAction(
      "start",
      fixture.controller.snapshot().taskActionRevision,
    ))
      .rejects.toThrow("task-action-busy");
    gate.resolve();
    await first;

    expect(hybrid.startInputs).toHaveLength(1);
    expect(fixture.controller.snapshot().taskActionPending).toBe(false);
    fixture.controller.dispose();
  });

  it("rechecks the task revision inside the cloud permit before starting", async () => {
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
        coveredCandidatePdfCount: 0,
        groups: [group],
      },
    });
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, connection, hybrid),
    });
    installCurrentVerificationScope(fixture, hybrid, "/Synthetic");
    hybrid.setSnapshot(hybrid.snapshot());
    const revision = fixture.controller.snapshot().taskActionRevision;
    let mutated = false;
    const unsubscribe = fixture.controller.subscribe(() => {
      if (mutated || !fixture.controller.snapshot().taskActionPending) return;
      mutated = true;
      fixture.store.setSettingsForTest({
        ...fixture.store.settings(),
        cloudVerificationGeneration: 2,
      });
    });

    await expect(fixture.controller.performTaskVerificationAction("start", revision))
      .rejects.toThrow("task-action-stale");

    expect(mutated).toBe(true);
    expect(hybrid.startInputs).toEqual([]);
    unsubscribe();
    fixture.controller.dispose();
  });

  it("rechecks the task permit after final launch validation before reaching runtime", async () => {
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
        coveredCandidatePdfCount: 0,
        groups: [group],
      },
    });
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, connection, hybrid),
    });
    installCurrentVerificationScope(fixture, hybrid, "/Synthetic");
    hybrid.setSnapshot(hybrid.snapshot());
    fixture.controller.applyCatalogRootSelection({
      kind: "category",
      selectedPath: "/Synthetic/Literature",
      effectiveRoot: "/Synthetic",
      groupKey,
    });
    const internals = fixture.controller as unknown as {
      readonly dependencies: {
        catalogDirectorySelectionValidator: (
          selection: CloudDirectorySelection,
          purpose: CloudDirectoryPickerPurpose,
        ) => CloudDirectorySelection;
      };
    };
    const validateSelection = internals.dependencies.catalogDirectorySelectionValidator;
    let validationCalls = 0;
    internals.dependencies.catalogDirectorySelectionValidator = (selection, purpose) => {
      const validated = validateSelection(selection, purpose);
      validationCalls += 1;
      if (validationCalls === 2) fixture.controller.toggleVerificationGroup(groupKey);
      return validated;
    };
    const revision = fixture.controller.snapshot().taskActionRevision;

    await expect(fixture.controller.performTaskVerificationAction("start", revision))
      .rejects.toThrow("task-action-stale");

    expect(validationCalls).toBe(2);
    expect(hybrid.startInputs).toEqual([]);
    expect(fixture.controller.snapshot().taskActionPending).toBe(false);
    fixture.controller.dispose();
  });

  it.each(["task", "selected"] as const)(
    "resumes only checkpoint groups in stored order through the %s entry",
    async (entry) => {
    const secondGroupKey = `group:${"c".repeat(64)}`;
    const thirdGroupKey = `group:${"d".repeat(64)}`;
    const secondGroup = {
      ...group,
      groupKey: secondGroupKey,
      rootRelativePath: "History",
      label: "History",
    };
    const thirdGroup = {
      ...group,
      groupKey: thirdGroupKey,
      rootRelativePath: "Science",
      label: "Science",
    };
    const hybrid = new FakeHybridCatalogRuntime({
      status: "paused",
      active: {
        importedAt: 1,
        pdfCount: 36,
        unverifiedCount: 36,
        verifiedCount: 0,
        differenceCount: 0,
        cloudMissingCount: 0,
        groupCount: 3,
        verifiedGroupCount: 0,
        coveredCandidatePdfCount: 0,
        groups: [group, secondGroup, thirdGroup],
      },
      batch: {
        ...INACTIVE_AUTO_RESUME,
        batchId: "batch-task-resume-order",
        status: "paused",
        stopReason: "time-limit",
        resumeAvailable: true,
        runOrdinal: 1,
        remainingGroupCount: 2,
        pdfCount: 0,
        directoryCount: 0,
        ignoredFileCount: 0,
        listRequestCount: 1,
        cumulativeListRequestCount: 1,
        selectedGroupCount: 2,
        selectedGroupKeys: [secondGroupKey, groupKey],
        completedGroupCount: 0,
        currentGroupIndex: 0,
        currentGroupKey: null,
        committedPdfCount: 0,
        committedPageCount: 0,
        completedDirectoryCount: 0,
        pendingDirectoryCount: 0,
      },
    });
    let confirmationCalls = 0;
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, connection, hybrid),
      catalogLargeScanConfirmation: {
        request: async () => { confirmationCalls += 1; return true; },
      },
    });
    installCurrentVerificationScope(fixture, hybrid, "/Synthetic", [secondGroupKey, groupKey]);
    hybrid.setSnapshot(hybrid.snapshot());
    fixture.controller.toggleVerificationGroup(thirdGroupKey);
    const revision = fixture.controller.snapshot().taskActionRevision;

    if (entry === "task") {
      await fixture.controller.performTaskVerificationAction("resume", revision);
    } else {
      await fixture.controller.resumeSelectedVerification();
    }

    expect(confirmationCalls).toBe(entry === "task" ? 0 : 1);
    expect(hybrid.resumeInputs).toEqual([{
      cloudRoot: "/Synthetic",
      groupKeys: [secondGroupKey, groupKey],
    }]);
    fixture.controller.dispose();
    },
  );

  it("rejects a tombstoned task resume before the runtime is reached", async () => {
    const hybrid = resumableHybrid();
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, connection, hybrid),
    });
    installCurrentVerificationScope(fixture, hybrid, "/Synthetic");
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      verificationBatchTombstones: {
        schemaVersion: 1,
        state: "valid",
        batchIds: [hybrid.snapshot().batch!.batchId],
      },
    });
    hybrid.setSnapshot(hybrid.snapshot());

    await expect(fixture.controller.performTaskVerificationAction(
      "resume",
      fixture.controller.snapshot().taskActionRevision,
    )).rejects.toThrow("task-action-stale");
    expect(hybrid.resumeInputs).toEqual([]);
    fixture.controller.dispose();
  });

  it("rechecks the full start authority after confirmation before reaching runtime", async () => {
    const entered = deferred();
    const gate = deferred<boolean>();
    let confirmedCallbacks = 0;
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
        coveredCandidatePdfCount: 0,
        groups: [group],
      },
    });
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
      catalogLargeScanConfirmation: {
        request: () => {
          entered.resolve();
          return gate.promise;
        },
      },
    });
    installCurrentVerificationScope(fixture, hybrid, "/Synthetic");

    const starting = fixture.controller.requestLargeCatalogVerification(
      "/Synthetic",
      [groupKey],
      () => { confirmedCallbacks += 1; },
    );
    await entered.promise;
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      cloudVerificationGeneration: 2,
    });
    gate.resolve(true);

    await expect(starting).rejects.toThrow("hybrid-batch-unavailable");
    expect(confirmedCallbacks).toBe(0);
    expect(hybrid.startInputs).toEqual([]);
    fixture.controller.dispose();
  });

  it.each(["direct", "selected"] as const)(
    "accepts an exact allowlisted V3 resume through the %s public entry",
    async (entry) => {
      const hybrid = resumableHybrid();
      let confirmationCalls = 0;
      const fixture = controllerFixture({
        catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
        catalogLargeScanConfirmation: {
          request: async () => { confirmationCalls += 1; return true; },
        },
      });
      installCurrentVerificationScope(fixture, hybrid, "/Synthetic");
      const binding = fixture.store.settings().boundCloudLibrary!;
      const scope = deriveCloudVerificationScope(binding, hashVerificationRoot)!;
      const snapshot = hybrid.snapshot();
      hybrid.setSnapshot({
        ...snapshot,
        batch: {
          ...snapshot.batch!,
          verificationScope: scope,
          legacyPromotionRequired: true,
        },
      });
      fixture.store.setSettingsForTest({
        ...fixture.store.settings(),
        legacyVerificationAdoption: {
          schemaVersion: 1,
          state: "adopted",
          verificationGeneration: scope.generation,
          sourceImportSha256: scope.sourceImportSha256,
          cloudRootSha256: scope.cloudRootSha256,
          candidate: {
            importId: "candidate-v3",
            manifestSha256: "c".repeat(64),
            descriptorSha256: "d".repeat(64),
          },
          overlays: [],
          unified: null,
          resumableBatch: {
            batchId: snapshot.batch!.batchId,
            checkpointSha256: "e".repeat(64),
            sourceImportSha256: scope.sourceImportSha256,
            cloudRootSha256: scope.cloudRootSha256,
          },
        },
      });
      expect(hybrid.snapshot().batch).toMatchObject({
        verificationScope: scope,
        legacyPromotionRequired: true,
      });

      if (entry === "selected") {
        fixture.controller.setVerificationRoot("/Synthetic");
        fixture.controller.toggleVerificationGroup(groupKey);
        await fixture.controller.resumeSelectedVerification();
      } else {
        await fixture.controller.requestResumeLargeCatalogVerification(
          "/Synthetic",
          [groupKey],
        );
      }

      expect(confirmationCalls).toBe(1);
      expect(hybrid.resumeInputs).toEqual([{
        cloudRoot: "/Synthetic",
        groupKeys: [groupKey],
      }]);
      fixture.controller.dispose();
    },
  );

  it.each(["direct", "selected"] as const)(
    "fails closed before confirmation for stale V4/V3 authority through the %s public entry",
    async (entry) => {
      const scenarios: ReadonlyArray<Readonly<{
        label: string;
        mutate(
          fixture: ReturnType<typeof controllerFixture>,
          hybrid: FakeHybridCatalogRuntime,
        ): void;
      }>> = [
        {
          label: "pending-adoption",
          mutate: (fixture) => fixture.store.setSettingsForTest({
            ...fixture.store.settings(),
            legacyVerificationAdoption: { schemaVersion: 1, state: "pending" },
          }),
        },
        {
          label: "invalid-adoption",
          mutate: (fixture) => fixture.store.setSettingsForTest({
            ...fixture.store.settings(),
            legacyVerificationAdoption: { schemaVersion: 1, state: "invalid" },
          }),
        },
        {
          label: "tombstoned-batch",
          mutate: (fixture, hybrid) => fixture.store.setSettingsForTest({
            ...fixture.store.settings(),
            verificationBatchTombstones: {
              schemaVersion: 1,
              state: "valid",
              batchIds: [hybrid.snapshot().batch!.batchId],
            },
          }),
        },
        {
          label: "source-mismatch",
          mutate: (fixture) => fixture.store.setSettingsForTest({
            ...fixture.store.settings(),
            boundCloudLibrary: {
              ...fixture.store.settings().boundCloudLibrary!,
              sourceImportSha256: "9".repeat(64),
            },
          }),
        },
        {
          label: "generation-mismatch",
          mutate: (fixture) => fixture.store.setSettingsForTest({
            ...fixture.store.settings(),
            cloudVerificationGeneration: 2,
          }),
        },
        {
          label: "root-mismatch",
          mutate: (fixture) => fixture.store.setSettingsForTest({
            ...fixture.store.settings(),
            boundCloudLibrary: {
              ...fixture.store.settings().boundCloudLibrary!,
              path: "/Old-root",
            },
          }),
        },
        {
          label: "scope-mismatch",
          mutate: (_fixture, hybrid) => {
            const snapshot = hybrid.snapshot();
            hybrid.setSnapshot({
              ...snapshot,
              batch: {
                ...snapshot.batch!,
                verificationScope: {
                  ...snapshot.batch!.verificationScope!,
                  cloudRootSha256: "8".repeat(64),
                },
              },
            });
          },
        },
        {
          label: "unlisted-v3",
          mutate: (_fixture, hybrid) => {
            const snapshot = hybrid.snapshot();
            hybrid.setSnapshot({
              ...snapshot,
              batch: {
                ...snapshot.batch!,
                legacyPromotionRequired: true,
              },
            });
          },
        },
        {
          label: "stale-v3-allowlist",
          mutate: (fixture, hybrid) => {
            const snapshot = hybrid.snapshot();
            const binding = fixture.store.settings().boundCloudLibrary!;
            const scope = deriveCloudVerificationScope(binding, hashVerificationRoot)!;
            hybrid.setSnapshot({
              ...snapshot,
              batch: {
                ...snapshot.batch!,
                legacyPromotionRequired: true,
              },
            });
            fixture.store.setSettingsForTest({
              ...fixture.store.settings(),
              legacyVerificationAdoption: {
                schemaVersion: 1,
                state: "adopted",
                verificationGeneration: scope.generation,
                sourceImportSha256: scope.sourceImportSha256,
                cloudRootSha256: scope.cloudRootSha256,
                candidate: {
                  importId: "candidate-v3",
                  manifestSha256: "c".repeat(64),
                  descriptorSha256: "d".repeat(64),
                },
                overlays: [],
                unified: null,
                resumableBatch: {
                  batchId: "different-batch",
                  checkpointSha256: "e".repeat(64),
                  sourceImportSha256: scope.sourceImportSha256,
                  cloudRootSha256: scope.cloudRootSha256,
                },
              },
            });
          },
        },
      ];

      for (const scenario of scenarios) {
        const hybrid = resumableHybrid();
        let confirmationCalls = 0;
        const fixture = controllerFixture({
          catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
          catalogLargeScanConfirmation: {
            request: async () => { confirmationCalls += 1; return true; },
          },
        });
        installCurrentVerificationScope(fixture, hybrid, "/Synthetic");
        if (entry === "selected") {
          fixture.controller.setVerificationRoot("/Synthetic");
          fixture.controller.toggleVerificationGroup(groupKey);
        }
        scenario.mutate(fixture, hybrid);

        const operation = entry === "selected"
          ? fixture.controller.resumeSelectedVerification()
          : fixture.controller.requestResumeLargeCatalogVerification(
              "/Synthetic",
              [groupKey],
            );
        await expect(operation, scenario.label).rejects.toThrow("hybrid-batch-unavailable");
        expect(confirmationCalls, scenario.label).toBe(0);
        expect(hybrid.resumeInputs, scenario.label).toEqual([]);
        fixture.controller.dispose();
      }
    },
  );

  it("fails closed when the normal-only directory selection validator is absent", async () => {
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
        coveredCandidatePdfCount: 0,
        groups: [group],
      },
    });
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
    });
    const internals = fixture.controller as unknown as {
      readonly dependencies: {
        catalogDirectoryPicker?: CloudDirectoryPickerPresenter;
        catalogDirectorySelectionValidator?: unknown;
      };
    };
    let pickerCalls = 0;
    internals.dependencies.catalogDirectoryPicker = {
      request: async () => {
        pickerCalls += 1;
        return directorySelection("/Synthetic/Chosen");
      },
    };
    delete internals.dependencies.catalogDirectorySelectionValidator;

    await expect(fixture.controller.chooseCatalogRoot({
      initialRoot: "",
      purpose: scanPurpose,
    })).rejects.toThrow("catalog-unavailable");
    expect(pickerCalls).toBe(0);
    expect(() => fixture.controller.applyCatalogRootSelection({
      kind: "category",
      selectedPath: "/科学文库/Literature",
      effectiveRoot: "/科学文库",
      groupKey,
    })).toThrow("catalog-unavailable");

    fixture.controller.dispose();
  });

  it("applies one validated category selection without starting or resuming verification", async () => {
    const secondKey = `group:${"d".repeat(64)}`;
    const hybrid = new FakeHybridCatalogRuntime({
      status: "ready",
      active: {
        importedAt: 1,
        pdfCount: 20,
        unverifiedCount: 20,
        verifiedCount: 0,
        differenceCount: 0,
        cloudMissingCount: 0,
        groupCount: 2,
        verifiedGroupCount: 0,
        coveredCandidatePdfCount: 0,
        groups: [group, {
          groupKey: secondKey,
          rootRelativePath: "Science",
          label: "Science",
          pdfCount: 8,
          mode: "recursive",
          verificationStatus: "unverified",
        }],
      },
    });
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
    });
    fixture.controller.toggleVerificationGroup(secondKey);
    const selection: CloudDirectorySelection = {
      kind: "category",
      selectedPath: "/科学文库/Literature",
      effectiveRoot: "/科学文库",
      groupKey,
    };

    fixture.controller.applyCatalogRootSelection(selection);

    expect(fixture.controller.snapshot()).toMatchObject({
      verificationRoot: "/科学文库",
      verificationDirectorySelection: selection,
      selectedVerificationGroupKeys: [groupKey],
    });
    expect(hybrid.startInputs).toEqual([]);
    expect(hybrid.resumeInputs).toEqual([]);

    fixture.controller.toggleVerificationGroup(secondKey);
    expect(fixture.controller.snapshot()).toMatchObject({
      verificationRoot: "/科学文库",
      selectedVerificationGroupKeys: [groupKey, secondKey],
    });
    expect(fixture.controller.snapshot().verificationDirectorySelection).toBeUndefined();
    fixture.controller.toggleVerificationGroup(secondKey);

    fixture.controller.setVerificationRoot("/手工父目录");
    expect(fixture.controller.snapshot()).toMatchObject({
      verificationRoot: "/手工父目录",
      selectedVerificationGroupKeys: [groupKey],
    });
    expect(fixture.controller.snapshot().verificationDirectorySelection).toBeUndefined();
    fixture.controller.dispose();
  });

  it("keeps legal groups for a directory selection and rejects an inactive category", async () => {
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
        coveredCandidatePdfCount: 0,
        groups: [group],
      },
    });
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
    });
    fixture.controller.toggleVerificationGroup(groupKey);
    fixture.controller.applyCatalogRootSelection(directorySelection("/科学文库"));
    expect(fixture.controller.snapshot().selectedVerificationGroupKeys).toEqual([groupKey]);

    expect(() => fixture.controller.applyCatalogRootSelection({
      kind: "category",
      selectedPath: "/科学文库/Missing",
      effectiveRoot: "/科学文库",
      groupKey: `group:${"e".repeat(64)}`,
    })).toThrow("cloud-directory-selection-invalid");
    expect(hybrid.startInputs).toEqual([]);
    fixture.controller.dispose();
  });

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
        coveredCandidatePdfCount: 0,
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
        coveredCandidatePdfCount: 0,
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
        coveredCandidatePdfCount: 0,
        groups: [group],
      },
      batch: {
        ...INACTIVE_AUTO_RESUME,
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
        selectedGroupCount: 1,
        completedGroupCount: 0,
        currentGroupIndex: 0,
        currentGroupKey: null,
        committedPdfCount: 0,
        committedPageCount: 0,
        completedDirectoryCount: 0,
        pendingDirectoryCount: 0,
      },
    });
    const confirmations: unknown[] = [];
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
      catalogLargeScanConfirmation: {
        request: async (input) => { confirmations.push(structuredClone(input)); return true; },
      },
    });
    installCurrentVerificationScope(fixture, hybrid, "/Synthetic");
    fixture.controller.setVerificationRoot("/Synthetic");
    fixture.controller.toggleVerificationGroup(groupKey);
    hybrid.beforeStart = () => {
      const snapshot = hybrid.snapshot();
      hybrid.setSnapshot({
        ...snapshot,
        status: "paused",
        batch: {
          ...snapshot.batch!,
          batchId: "batch-after-start",
          runOrdinal: snapshot.batch!.runOrdinal + 1,
        },
      });
    };

    await fixture.controller.startSelectedVerification();
    expect(fixture.controller.snapshot().verificationRootLocked).toBe(true);
    fixture.controller.setVerificationRoot("/Changed-after-start");
    expect(fixture.controller.snapshot().verificationRoot).toBe("/Synthetic");
    await fixture.controller.resumeSelectedVerification();
    fixture.controller.cancelSelectedVerification();

    expect(confirmations).toHaveLength(2);
    expect(hybrid.startInputs).toEqual([{ cloudRoot: "/Synthetic", groupKeys: [groupKey] }]);
    expect(hybrid.resumeRoots).toEqual(["/Synthetic"]);
    expect(hybrid.resumeInputs).toEqual([{
      cloudRoot: "/Synthetic",
      groupKeys: [groupKey],
    }]);
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
        coveredCandidatePdfCount: 0,
        groups: [group],
      },
      batch: {
        ...INACTIVE_AUTO_RESUME,
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
        selectedGroupCount: 1,
        completedGroupCount: 0,
        currentGroupIndex: 0,
        currentGroupKey: null,
        committedPdfCount: 0,
        committedPageCount: 0,
        completedDirectoryCount: 0,
        pendingDirectoryCount: 0,
      },
    });
    hybrid.beforeResume = () => { throw new HybridCatalogError("hybrid-cloud-root-mismatch"); };
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
      catalogLargeScanConfirmation: { request: async () => true },
    });
    installCurrentVerificationScope(fixture, hybrid, "/Wrong-candidate");
    expect(fixture.controller.snapshot().verificationRootLocked).toBe(false);
    fixture.controller.setVerificationRoot("/Wrong-candidate");
    fixture.controller.toggleVerificationGroup(groupKey);

    await expect(fixture.controller.resumeSelectedVerification())
      .rejects.toThrow("hybrid-cloud-root-mismatch");
    expect(fixture.controller.snapshot()).toMatchObject({
      verificationRoot: "/Wrong-candidate",
      verificationRootLocked: false,
      verificationActionMessageCode: "hybrid-cloud-root-mismatch",
    });

    hybrid.beforeResume = undefined;
    installCurrentVerificationScope(fixture, hybrid, "/Synthetic");
    hybrid.beforeResume = () => {
      const snapshot = hybrid.snapshot();
      hybrid.setSnapshot({
        ...snapshot,
        status: "paused",
        batch: {
          ...snapshot.batch!,
          runOrdinal: snapshot.batch!.runOrdinal + 1,
        },
      });
    };
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
        coveredCandidatePdfCount: 0,
        groups: [group],
      },
      batch: {
        ...INACTIVE_AUTO_RESUME,
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
        selectedGroupCount: 1,
        completedGroupCount: 0,
        currentGroupIndex: 0,
        currentGroupKey: null,
        committedPdfCount: 0,
        committedPageCount: 0,
        completedDirectoryCount: 0,
        pendingDirectoryCount: 0,
      },
    });
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
      catalogLargeScanConfirmation: { request: async () => true },
    });
    installCurrentVerificationScope(fixture, hybrid, "/Candidate");
    fixture.controller.setVerificationRoot("/Candidate");
    fixture.controller.toggleVerificationGroup(groupKey);
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
        coveredCandidatePdfCount: 0,
        groups: [group],
      },
      batch: {
        ...INACTIVE_AUTO_RESUME,
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
        selectedGroupCount: 1,
        completedGroupCount: 0,
        currentGroupIndex: 0,
        currentGroupKey: null,
        committedPdfCount: 0,
        committedPageCount: 0,
        completedDirectoryCount: 0,
        pendingDirectoryCount: 0,
      },
    });
    hybrid.beforeStart = () => { throw new Error("baidu-access-unavailable"); };
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
      catalogLargeScanConfirmation: { request: async () => true },
    });
    installCurrentVerificationScope(fixture, hybrid, "/New-root");
    fixture.controller.setVerificationRoot("/New-root");
    fixture.controller.toggleVerificationGroup(groupKey);

    await expect(fixture.controller.startSelectedVerification())
      .rejects.toThrow("baidu-access-unavailable");
    expect(fixture.controller.snapshot().verificationRootLocked).toBe(false);

    hybrid.beforeStart = undefined;
    installCurrentVerificationScope(fixture, hybrid, "/Old-checkpoint-root");
    hybrid.beforeResume = () => {
      const snapshot = hybrid.snapshot();
      hybrid.setSnapshot({
        ...snapshot,
        status: "paused",
        batch: {
          ...snapshot.batch!,
          runOrdinal: snapshot.batch!.runOrdinal + 1,
        },
      });
    };
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
        coveredCandidatePdfCount: 0,
        groups: [group],
      },
    });
    hybrid.beforeStart = () => { throw new Error("hybrid-batch-unavailable"); };
    const fixture = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
      catalogLargeScanConfirmation: { request: async () => true },
    });
    installCurrentVerificationScope(fixture, hybrid, "/Synthetic");
    fixture.controller.setVerificationRoot("/Synthetic");
    fixture.controller.toggleVerificationGroup(groupKey);

    await expect(fixture.controller.startSelectedVerification())
      .rejects.toThrow("hybrid-batch-unavailable");
    expect(fixture.controller.snapshot().verificationRootLocked).toBe(false);
    fixture.controller.setVerificationRoot("/Correctable");
    expect(fixture.controller.snapshot().verificationRoot).toBe("/Correctable");
    fixture.controller.dispose();
  });

  it("unlocks the new root when projection refresh fails after a new paused batch", async () => {
    const previousBatch = {
      ...INACTIVE_AUTO_RESUME,
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
      selectedGroupCount: 1,
      completedGroupCount: 0,
      currentGroupIndex: 0,
      currentGroupKey: null,
      committedPdfCount: 0,
      committedPageCount: 0,
      completedDirectoryCount: 0,
      pendingDirectoryCount: 0,
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
        coveredCandidatePdfCount: 0,
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
    installCurrentVerificationScope(fixture, hybrid, "/New-root");
    fixture.controller.setVerificationRoot("/New-root");
    fixture.controller.toggleVerificationGroup(groupKey);

    await expect(fixture.controller.startSelectedVerification())
      .rejects.toThrow("catalog-unavailable");
    expect(fixture.controller.snapshot()).toMatchObject({
      verificationRoot: "/New-root",
      verificationRootLocked: false,
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
        coveredCandidatePdfCount: 0,
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
