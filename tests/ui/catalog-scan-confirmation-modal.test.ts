// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import {
  createCatalogScanConfirmationModalClass,
  type CatalogScanModalConstructor,
} from "../../src/ui/catalog-scan-confirmation-modal";
import {
  FakeCatalogScanConfirmationPresenter,
  FakeCloudCatalogConnectionRuntime,
  FakeCloudCatalogRuntime,
} from "../fakes/fake-cloud-catalog-runtime";
import { controllerFixture } from "../helpers/ui-fixtures";
import type { WorkbenchLocale } from "../../src/i18n/workbench-i18n";

class ModalSurface {
  readonly contentEl = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as HTMLDivElement;
  title = "";
  openCalls = 0;
  closeCalls = 0;

  constructor(readonly app: App) {}
  setTitle(value: string): void { this.title = value; }
  open(): void { this.openCalls += 1; (this as unknown as { onOpen(): void }).onOpen(); }
  close(): void { this.closeCalls += 1; (this as unknown as { onClose(): void }).onClose(); }
}

const fixture = (locale: WorkbenchLocale = "en") => {
  const Concrete = createCatalogScanConfirmationModalClass(
    ModalSurface as unknown as CatalogScanModalConstructor,
    () => locale,
  );
  const modal = new Concrete({} as App);
  return { modal, surface: modal as unknown as ModalSurface };
};

describe("catalog scan confirmation", () => {
  it.each([
    ["zh-CN", "确认只读云端扫描", "开始只读扫描", "取消"],
    ["en", "Confirm read-only cloud scan", "Start read-only scan", "Cancel"],
  ] as const)("renders the normalized user path and controls in %s", (locale, title, start, cancel) => {
    const { modal, surface } = fixture(locale);
    document.body.append(surface.contentEl);
    void modal.request("/原文/Keep-Name");
    expect(surface.title).toBe(title);
    expect(surface.contentEl.textContent).toContain("/原文/Keep-Name");
    expect(surface.contentEl.textContent).toContain(start);
    expect(surface.contentEl.textContent).toContain(cancel);
    expect(document.activeElement?.getAttribute("data-action")).toBe("start-catalog-scan");
    surface.contentEl.remove();
  });

  it("describes recursive metadata-only scanning and resolves only after Start", async () => {
    const { modal, surface } = fixture();
    let settled = false;
    const result = modal.request("/样本").then((value) => {
      settled = true;
      return value;
    });

    expect(surface.title).toBe("Confirm read-only cloud scan");
    expect(surface.contentEl.textContent).toContain("recursively list metadata under /样本");
    expect(surface.contentEl.textContent).toContain("No PDF files will be downloaded");
    expect(surface.contentEl.textContent).toContain("previous completed snapshot remains available");
    await Promise.resolve();
    expect(settled).toBe(false);
    surface.contentEl.querySelector<HTMLButtonElement>('[data-action="start-catalog-scan"]')!.click();
    await expect(result).resolves.toBe(true);
    expect(surface.closeCalls).toBe(1);
  });

  it("resolves false on Cancel, Escape, or host close", async () => {
    const canceled = fixture();
    const cancelResult = canceled.modal.request("/样本");
    canceled.surface.contentEl.querySelector<HTMLButtonElement>('[data-action="cancel-catalog-scan"]')!.click();
    await expect(cancelResult).resolves.toBe(false);

    const escaped = fixture();
    const escapeResult = escaped.modal.request("/样本");
    escaped.surface.contentEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect(escapeResult).resolves.toBe(false);

    const closed = fixture();
    const closeResult = closed.modal.request("/样本");
    closed.surface.close();
    await expect(closeResult).resolves.toBe(false);
  });

  it("never starts a scan merely because authorization succeeds", async () => {
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "configured" });
    const confirmation = new FakeCatalogScanConfirmationPresenter(true);
    const catalog = new FakeCloudCatalogRuntime({}, connection);
    const controller = controllerFixture({ catalog, catalogConfirmation: confirmation }).controller;

    await controller.connectCatalog({
      appKey: "app-key-sentinel",
      secretKey: "secret-key-sentinel",
    });
    await controller.submitCatalogAuthorizationCode("one-time-code-sentinel");

    expect(connection.beginAuthorizationCalls).toBe(1);
    expect(connection.submittedAuthorizationCodes).toEqual(["one-time-code-sentinel"]);
    expect(connection.startScanCalls).toEqual([]);
    expect(confirmation.requests).toEqual([]);
  });

  it("rejects invalid roots before confirmation or connection calls", async () => {
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    const confirmation = new FakeCatalogScanConfirmationPresenter(true);
    const catalog = new FakeCloudCatalogRuntime({}, connection);
    const controller = controllerFixture({ catalog, catalogConfirmation: confirmation }).controller;

    await expect(controller.requestCatalogScan("relative/path")).rejects.toThrow("invalid-scan-root");

    expect(confirmation.requests).toEqual([]);
    expect(connection.startScanCalls).toEqual([]);
  });

  it("starts only the normalized root that receives final confirmation", async () => {
    const connection = new FakeCloudCatalogConnectionRuntime({ status: "authorized" });
    const canceled = new FakeCatalogScanConfirmationPresenter(false);
    const catalog = new FakeCloudCatalogRuntime({}, connection);
    const first = controllerFixture({ catalog, catalogConfirmation: canceled }).controller;
    const canceledEvents: string[] = [];
    await first.requestCatalogScan("/样本", () => { canceledEvents.push("clear"); });
    expect(canceled.requests).toEqual(["/样本"]);
    expect(connection.startScanCalls).toEqual([]);
    expect(canceledEvents).toEqual([]);
    first.dispose();

    const accepted = new FakeCatalogScanConfirmationPresenter(true);
    const secondCatalog = new FakeCloudCatalogRuntime({}, connection);
    const second = controllerFixture({
      catalog: secondCatalog,
      catalogConfirmation: accepted,
    }).controller;
    const events: string[] = [];
    connection.beforeStartScan = () => { events.push("start"); };
    await second.requestCatalogScan("/样本", () => { events.push("clear"); });
    expect(accepted.requests).toEqual(["/样本"]);
    expect(connection.startScanCalls).toEqual(["/样本"]);
    expect(events).toEqual(["clear", "start"]);
  });
});
