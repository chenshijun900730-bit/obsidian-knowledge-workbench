// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import {
  createCatalogLargeScanConfirmationModalClass,
  type CatalogLargeScanModalConstructor,
} from "../../src/ui/catalog-large-scan-confirmation-modal";
import {
  FakeCloudCatalogRuntime,
  FakeHybridCatalogRuntime,
} from "../fakes/fake-cloud-catalog-runtime";
import {
  controllerFixture,
  TEST_HYBRID_ACTIVE_AUTHORITY,
  TEST_LARGE_BATCH_AUTHORITY,
} from "../helpers/ui-fixtures";
import type { WorkbenchLocale } from "../../src/i18n/workbench-i18n";
import { LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS } from "../../src/catalog/hybrid-catalog-types";

const INACTIVE_AUTO_RESUME = {
  autoResumeState: "inactive" as const,
  autoSegmentIndex: 0,
  autoSegmentLimit: LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
};

class ModalSurface {
  readonly contentEl = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as HTMLDivElement;
  title = "";
  closeCalls = 0;
  constructor(readonly app: App) {}
  setTitle(value: string): void { this.title = value; }
  open(): void { (this as unknown as { onOpen(): void }).onOpen(); }
  close(): void { this.closeCalls += 1; (this as unknown as { onClose(): void }).onClose(); }
}

const fixture = (locale: WorkbenchLocale = "en") => {
  const Concrete = createCatalogLargeScanConfirmationModalClass(
    ModalSurface as unknown as CatalogLargeScanModalConstructor,
    () => locale,
  );
  const modal = new Concrete({} as App);
  return { modal, surface: modal as unknown as ModalSurface };
};

const request = {
  kind: "start" as const,
  cloudRoot: "/Synthetic/private-root",
  groups: [
    { groupKey: "txt-root-items", rootRelativePath: "", label: "Root items", pdfCount: 2 },
    {
      groupKey: `group:${"1".repeat(64)}`,
      rootRelativePath: "Science",
      label: "Science",
      pdfCount: 30,
    },
  ],
};

describe("large catalog scan confirmation", () => {
  it.each([
    ["zh-CN", "确认分类核验", "开始核验", "取消"],
    ["en", "Confirm category verification", "Start verification", "Cancel"],
  ] as const)("renders localized budgets while preserving names and paths in %s", (
    locale,
    title,
    confirm,
    cancel,
  ) => {
    const { modal, surface } = fixture(locale);
    document.body.append(surface.contentEl);
    void modal.request({
      ...request,
      cloudRoot: "/原文/Keep-Root",
      groups: [{ ...request.groups[0]!, label: "原文 Keep Group" }],
    });
    expect(surface.title).toBe(title);
    expect(surface.contentEl.textContent).toContain(confirm);
    expect(surface.contentEl.textContent).toContain(cancel);
    expect(surface.contentEl.textContent).toContain("/原文/Keep-Root");
    expect(document.activeElement?.getAttribute("data-action")).toBe("start-large-catalog-verification");
    surface.contentEl.remove();
  });

  it("shows selected category aggregates and fixed metadata-only budgets", async () => {
    const { modal, surface } = fixture();
    const result = modal.request(request);

    expect(surface.title).toBe("Confirm category verification");
    expect(surface.contentEl.textContent).toContain("Selected categories: 2 / 5");
    expect(surface.contentEl.textContent).toContain("Candidate PDFs: 32");
    expect(surface.contentEl.textContent).toContain("10,000 PDFs");
    expect(surface.contentEl.textContent).toContain("500 directories");
    expect(surface.contentEl.textContent).toContain("300 list requests");
    expect(surface.contentEl.textContent).toContain("30 minutes");
    expect(surface.contentEl.textContent).toContain("No PDF files will be downloaded");
    expect(surface.contentEl.textContent).toContain("/Synthetic/private-root");
    expect(surface.contentEl.textContent).not.toContain("Example.pdf");

    surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="start-large-catalog-verification"]',
    )!.click();
    await expect(result).resolves.toBe(true);
    expect(surface.contentEl.textContent).toBe("");
    expect(surface.contentEl.textContent).not.toContain("private-root");
  });

  it("describes resume separately and rejects more than five categories before opening", async () => {
    const resumed = fixture();
    const resumeResult = resumed.modal.request({
      kind: "resume",
      cloudRoot: "/Synthetic",
      groups: [],
    });
    expect(resumed.surface.title).toBe("Confirm category verification resume");
    expect(resumed.surface.contentEl.textContent).toContain("Resume the saved local checkpoint");
    resumed.surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="resume-large-catalog-verification"]',
    )!.click();
    await expect(resumeResult).resolves.toBe(true);

    const excessive = fixture();
    expect(() => excessive.modal.request({
      ...request,
      groups: Array.from({ length: 6 }, (_, index) => ({
        groupKey: `group:${String(index).repeat(64)}`,
        rootRelativePath: `Group-${index}`,
        label: `Group ${index}`,
        pdfCount: 1,
      })),
    })).toThrow("invalid-large-catalog-selection");
    expect(excessive.surface.contentEl.textContent).toBe("");
  });

  it("renders a detached category selection and rejects forged or mismatched context", () => {
    const groupKey = `group:${"3".repeat(64)}`;
    const input = {
      kind: "start" as const,
      cloudRoot: "/科学文库",
      groups: [{
        groupKey,
        rootRelativePath: "6-经济类",
        label: "经济类",
        pdfCount: 12,
      }],
      directorySelection: {
        kind: "category" as const,
        selectedPath: "/科学文库/6-经济类",
        effectiveRoot: "/科学文库",
        groupKey,
      },
    };
    const accepted = fixture("zh-CN");
    void accepted.modal.request(input);
    (input.directorySelection as { selectedPath: string }).selectedPath = "/已篡改";
    expect(accepted.surface.contentEl.textContent).toContain("/科学文库/6-经济类");
    expect(accepted.surface.contentEl.textContent).toContain("/科学文库");
    expect(accepted.surface.contentEl.textContent).toContain("经济类");
    expect(accepted.surface.contentEl.textContent).not.toContain("/已篡改");

    for (const directorySelection of [{
      ...input.directorySelection,
      selectedPath: "/科学文库/其他",
    }, {
      ...input.directorySelection,
      effectiveRoot: "/其他父目录",
    }, {
      ...input.directorySelection,
      groupKey: `group:${"4".repeat(64)}`,
    }, {
      kind: "directory" as const,
      selectedPath: "/",
      effectiveRoot: "/",
    }]) {
      expect(() => fixture().modal.request({
        ...input,
        directorySelection,
      })).toThrow("invalid-large-catalog-selection");
    }
  });

  it("keeps directory and legacy start flows compatible but rejects selection on resume", () => {
    expect(() => fixture().modal.request(request)).not.toThrow();
    expect(() => fixture().modal.request({
      ...request,
      directorySelection: {
        kind: "directory",
        selectedPath: request.cloudRoot,
        effectiveRoot: request.cloudRoot,
      },
    })).not.toThrow();
    expect(() => fixture().modal.request({
      kind: "resume",
      cloudRoot: "/Synthetic",
      groups: [],
      directorySelection: {
        kind: "directory",
        selectedPath: "/Synthetic",
        effectiveRoot: "/Synthetic",
      },
    })).toThrow("invalid-large-catalog-selection");
  });

  it("resolves false on Cancel, Escape, or host close", async () => {
    const canceled = fixture();
    const cancelResult = canceled.modal.request(request);
    canceled.surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="cancel-large-catalog-verification"]',
    )!.click();
    await expect(cancelResult).resolves.toBe(false);

    const escaped = fixture();
    const escapeResult = escaped.modal.request(request);
    escaped.surface.contentEl.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    }));
    await expect(escapeResult).resolves.toBe(false);

    const closed = fixture();
    const closeResult = closed.modal.request(request);
    closed.surface.close();
    await expect(closeResult).resolves.toBe(false);
  });

  it("clears a normalized root before explicit start or resume reaches the runtime", async () => {
    const groupKey = `group:${"1".repeat(64)}`;
    const hybrid = new FakeHybridCatalogRuntime({
      status: "paused",
      active: {
        ...TEST_HYBRID_ACTIVE_AUTHORITY,
        importedAt: 1,
        pdfCount: 30,
        unverifiedCount: 30,
        verifiedCount: 0,
        differenceCount: 0,
        cloudMissingCount: 0,
        groupCount: 1,
        verifiedGroupCount: 0,
        coveredCandidatePdfCount: 0,
        groups: [{
          groupKey,
          rootRelativePath: "Science",
          label: "Science",
          pdfCount: 30,
          mode: "recursive",
          verificationStatus: "unverified",
        }],
      },
      batch: {
        ...TEST_LARGE_BATCH_AUTHORITY,
        ...INACTIVE_AUTO_RESUME,
        batchId: "batch-confirmation",
        status: "paused",
        stopReason: "list-request-limit",
        resumeAvailable: true,
        runOrdinal: 1,
        remainingGroupCount: 1,
        pdfCount: 10,
        directoryCount: 2,
        ignoredFileCount: 0,
        listRequestCount: 300,
        cumulativeListRequestCount: 300,
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
    const confirmation = { request: vi.fn(async () => true) };
    const catalog = new FakeCloudCatalogRuntime({}, undefined, hybrid);
    const controller = controllerFixture({
      catalog,
      catalogLargeScanConfirmation: confirmation,
    }).controller;
    const events: string[] = [];
    hybrid.beforeStart = () => { events.push("start"); };
    hybrid.beforeResume = () => { events.push("resume"); };

    await controller.requestLargeCatalogVerification(
      "/Synthetic",
      [groupKey],
      () => { events.push("clear-start"); },
    );
    await controller.requestResumeLargeCatalogVerification(
      "/Synthetic",
      [groupKey],
      () => { events.push("clear-resume"); },
    );

    expect(confirmation.request).toHaveBeenNthCalledWith(1, {
      kind: "start",
      cloudRoot: "/Synthetic",
      groups: [{ groupKey, rootRelativePath: "Science", label: "Science", pdfCount: 30 }],
    });
    expect(confirmation.request).toHaveBeenNthCalledWith(2, {
      kind: "resume",
      cloudRoot: "/Synthetic",
      groups: [],
    });
    expect(hybrid.startInputs).toEqual([{ cloudRoot: "/Synthetic", groupKeys: [groupKey] }]);
    expect(hybrid.resumeRoots).toEqual(["/Synthetic"]);
    expect(catalog.initializeCalls).toBe(2);
    expect(events).toEqual(["clear-start", "start", "clear-resume", "resume"]);
  });

  it("refuses a root that already includes a selected category before confirmation", async () => {
    const groupKey = `group:${"2".repeat(64)}`;
    const hybrid = new FakeHybridCatalogRuntime({
      status: "ready",
      active: {
        ...TEST_HYBRID_ACTIVE_AUTHORITY,
        importedAt: 1,
        pdfCount: 30,
        unverifiedCount: 30,
        verifiedCount: 0,
        differenceCount: 0,
        cloudMissingCount: 0,
        groupCount: 1,
        verifiedGroupCount: 0,
        coveredCandidatePdfCount: 0,
        groups: [{
          groupKey,
          rootRelativePath: "Science",
          label: "Science",
          pdfCount: 30,
          mode: "recursive",
          verificationStatus: "unverified",
        }],
      },
    });
    const confirmation = { request: vi.fn(async () => true) };
    const catalog = new FakeCloudCatalogRuntime({}, undefined, hybrid);
    const controller = controllerFixture({
      catalog,
      catalogLargeScanConfirmation: confirmation,
    }).controller;

    await expect(controller.requestLargeCatalogVerification(
      "/Synthetic/Science",
      [groupKey],
    )).rejects.toThrow("invalid-large-catalog-root");

    expect(confirmation.request).not.toHaveBeenCalled();
    expect(hybrid.startInputs).toEqual([]);
    expect(catalog.initializeCalls).toBe(0);
  });

  it("forwards the structured category context only after an explicit start action", async () => {
    const groupKey = `group:${"5".repeat(64)}`;
    const hybrid = new FakeHybridCatalogRuntime({
      status: "ready",
      active: {
        ...TEST_HYBRID_ACTIVE_AUTHORITY,
        importedAt: 1,
        pdfCount: 8,
        unverifiedCount: 8,
        verifiedCount: 0,
        differenceCount: 0,
        cloudMissingCount: 0,
        groupCount: 1,
        verifiedGroupCount: 0,
        coveredCandidatePdfCount: 0,
        groups: [{
          groupKey,
          rootRelativePath: "5-艺术",
          label: "艺术",
          pdfCount: 8,
          mode: "recursive",
          verificationStatus: "unverified",
        }],
      },
    });
    const confirmation = { request: vi.fn(async () => false) };
    const controller = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, hybrid),
      catalogLargeScanConfirmation: confirmation,
    }).controller;
    const selection = {
      kind: "category" as const,
      selectedPath: "/科学文库/5-艺术",
      effectiveRoot: "/科学文库",
      groupKey,
    };

    controller.applyCatalogRootSelection(selection);
    expect(confirmation.request).not.toHaveBeenCalled();
    await controller.startSelectedVerification();

    expect(confirmation.request).toHaveBeenCalledWith({
      kind: "start",
      cloudRoot: "/科学文库",
      groups: [{
        groupKey,
        rootRelativePath: "5-艺术",
        label: "艺术",
        pdfCount: 8,
      }],
      directorySelection: selection,
    });
    expect(hybrid.startInputs).toEqual([]);
    controller.dispose();
  });
});
