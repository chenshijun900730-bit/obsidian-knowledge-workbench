// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import {
  createCatalogTxtImportConfirmationModalClass,
  type CatalogTxtImportModalConstructor,
} from "../../src/ui/catalog-txt-import-confirmation-modal";
import {
  FakeCloudCatalogRuntime,
  FakeHybridCatalogRuntime,
} from "../fakes/fake-cloud-catalog-runtime";
import { controllerFixture } from "../helpers/ui-fixtures";
import type { WorkbenchLocale } from "../../src/i18n/workbench-i18n";

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
  const Concrete = createCatalogTxtImportConfirmationModalClass(
    ModalSurface as unknown as CatalogTxtImportModalConstructor,
    () => locale,
  );
  const modal = new Concrete({} as App);
  return { modal, surface: modal as unknown as ModalSurface };
};

const aggregate = {
  sourceSha256: "a".repeat(64),
  byteSize: 1_024,
  nonEmptyLineCount: 12,
  pdfCount: 7,
  directoryCount: 3,
  ignoredLeafCount: 2,
  normalizedWhitespaceCount: 1,
  maxDepth: 4,
} as const;

describe("catalog TXT import confirmation", () => {
  it.each([
    ["zh-CN", "确认导入本地目录", "导入本地目录", "取消"],
    ["en", "Confirm local catalog import", "Import local catalog", "Cancel"],
  ] as const)("renders aggregate-only controls in %s", (locale, title, confirm, cancel) => {
    const { modal, surface } = fixture(locale);
    document.body.append(surface.contentEl);
    void modal.request(aggregate);
    expect(surface.title).toBe(title);
    expect(surface.contentEl.textContent).toContain(confirm);
    expect(surface.contentEl.textContent).toContain(cancel);
    expect(surface.contentEl.textContent).not.toContain(aggregate.sourceSha256);
    expect(document.activeElement?.getAttribute("data-action")).toBe("confirm-catalog-txt-import");
    surface.contentEl.remove();
  });

  it("shows only aggregate facts and confirms an import explicitly", async () => {
    const { modal, surface } = fixture();
    const result = modal.request(aggregate);

    expect(surface.title).toBe("Confirm local catalog import");
    expect(surface.contentEl.textContent).toContain("PDFs: 7 / 70,000");
    expect(surface.contentEl.textContent).toContain("Directories: 3");
    expect(surface.contentEl.textContent).toContain("Ignored leaves: 2");
    expect(surface.contentEl.textContent).toContain("No PDF files will be opened or downloaded");
    expect(surface.contentEl.textContent).not.toContain("inventory.txt");

    surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-catalog-txt-import"]',
    )!.click();
    await expect(result).resolves.toBe(true);
    expect(surface.closeCalls).toBe(1);
    expect(surface.contentEl.textContent).toBe("");
  });

  it("resolves false on Cancel, Escape, or host close", async () => {
    const canceled = fixture();
    const cancelResult = canceled.modal.request(aggregate);
    canceled.surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="cancel-catalog-txt-import"]',
    )!.click();
    await expect(cancelResult).resolves.toBe(false);

    const escaped = fixture();
    const escapeResult = escaped.modal.request(aggregate);
    escaped.surface.contentEl.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    }));
    await expect(escapeResult).resolves.toBe(false);

    const closed = fixture();
    const closeResult = closed.modal.request(aggregate);
    closed.surface.close();
    await expect(closeResult).resolves.toBe(false);
  });

  it("consumes the one-use preview before clearing the path after explicit confirmation", async () => {
    const hybrid = new FakeHybridCatalogRuntime({ status: "previewed", candidate: aggregate });
    hybrid.previewSummary = aggregate;
    const catalog = new FakeCloudCatalogRuntime({}, undefined, hybrid);
    const confirmation = { request: vi.fn(async () => true) };
    const controller = controllerFixture({
      catalog,
      catalogTxtImportConfirmation: confirmation,
    }).controller;
    const events: string[] = [];
    hybrid.beforeConsumeTxtPreview = () => { events.push("consume"); };

    await controller.previewCatalogTxt("/synthetic/inventory.txt");
    await controller.requestCatalogTxtImport(
      "/synthetic/inventory.txt",
      () => { events.push("clear"); },
    );

    expect(hybrid.previewPaths).toEqual(["/synthetic/inventory.txt"]);
    expect(confirmation.request).toHaveBeenCalledWith(aggregate);
    expect(hybrid.consumeTxtPreviewInputs).toEqual([{
      path: "/synthetic/inventory.txt",
      expectedSourceSha256: aggregate.sourceSha256,
    }]);
    expect(hybrid.importPaths).toEqual([]);
    expect(catalog.initializeCalls).toBe(1);
    expect(events).toEqual(["consume", "clear"]);

    const canceledHybrid = new FakeHybridCatalogRuntime({ status: "previewed", candidate: aggregate });
    const canceledController = controllerFixture({
      catalog: new FakeCloudCatalogRuntime({}, undefined, canceledHybrid),
      catalogTxtImportConfirmation: { request: async () => false },
    }).controller;
    await canceledController.requestCatalogTxtImport("/synthetic/inventory.txt");
    expect(canceledHybrid.consumeTxtPreviewInputs).toEqual([]);
    expect(canceledHybrid.importPaths).toEqual([]);
  });
});
