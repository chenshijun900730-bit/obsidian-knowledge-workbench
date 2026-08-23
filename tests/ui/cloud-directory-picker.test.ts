// @vitest-environment jsdom
import type { App } from "obsidian";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_DIRECTORY_DISCOVERY_BUDGET,
  type CloudDirectoryDiscoveryRuntime,
  type CloudDirectoryDiscoverySummary,
} from "../../src/catalog/cloud-directory-discovery-service";
import type { RankedCloudDirectory } from "../../src/catalog/cloud-directory-search";
import { createWorkbenchI18n } from "../../src/i18n/workbench-i18n";
import {
  createCloudDirectoryPickerModalClass,
  type CloudDirectoryPickerModalConstructor,
} from "../../src/ui/cloud-directory-picker";

class ModalSurface {
  readonly contentEl = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as HTMLDivElement;
  title = "";
  closeCalls = 0;
  constructor(readonly app: App) {}
  setTitle(value: string): void { this.title = value; }
  open(): void {
    document.body.append(this.contentEl);
    (this as unknown as { onOpen(): void }).onOpen();
  }
  close(): void {
    this.closeCalls += 1;
    (this as unknown as { onClose(): void }).onClose();
    this.contentEl.remove();
  }
}

interface FakeDirectoryDiscovery extends CloudDirectoryDiscoveryRuntime {
  readonly searchQueries: string[];
  readonly discoverCalls: string[];
  readonly signals: AbortSignal[];
}

const summary = (
  rootPath: string,
  stopReason: CloudDirectoryDiscoverySummary["stopReason"] = "complete",
): CloudDirectoryDiscoverySummary => ({
  status: stopReason === "complete"
    ? "complete"
    : stopReason === "user-canceled" ? "canceled" : "paused",
  stopReason,
  rootPath,
  directoryCount: 1,
  listRequestCount: 1,
  elapsedMs: 1,
});

const fakeDirectoryDiscovery = (
  results: readonly RankedCloudDirectory[],
  discover: (
    rootPath: string,
    signal: AbortSignal | undefined,
  ) => Promise<CloudDirectoryDiscoverySummary> = async (rootPath) => summary(rootPath),
): FakeDirectoryDiscovery => {
  const searchQueries: string[] = [];
  const discoverCalls: string[] = [];
  const signals: AbortSignal[] = [];
  return {
    searchQueries,
    discoverCalls,
    signals,
    searchCached(query) {
      searchQueries.push(query);
      return structuredClone(results);
    },
    snapshotCached: () => [],
    async discoverMore(rootPath, signal) {
      discoverCalls.push(rootPath);
      if (signal !== undefined) signals.push(signal);
      return discover(rootPath, signal);
    },
    clear: () => undefined,
    dispose: () => undefined,
  };
};

const pickerFixture = (discovery: CloudDirectoryDiscoveryRuntime) => {
  const Picker = createCloudDirectoryPickerModalClass(
    ModalSurface as unknown as CloudDirectoryPickerModalConstructor,
  );
  const picker = new Picker(
    {} as App,
    discovery,
    () => createWorkbenchI18n("zh-CN"),
  );
  return { picker, surface: picker as unknown as ModalSurface };
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => {
  document.body.replaceChildren();
});

describe("cloud directory picker", () => {
  it("defines standalone visible focus and long confirmation-root styles for the modal", async () => {
    const css = await readFile("styles.css", "utf8");

    expect(css).toMatch(
      /\.knowledge-workbench__directory-picker button:focus-visible,\s*\.knowledge-workbench__directory-picker input\[type="search"\]:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--interactive-accent\);[^}]*outline-offset:\s*2px;/u,
    );
    expect(css).toMatch(
      /\.knowledge-workbench__directory-picker-confirmation-root\s*\{[^}]*overflow-wrap:\s*anywhere;/u,
    );
  });

  it("filters cached folders while typing and requires a second confirmation before discovery", async () => {
    const discovery = fakeDirectoryDiscovery([
      { path: "/Synthetic/9-文学253册", filename: "9-文学253册", score: 0 },
    ]);
    const { picker, surface } = pickerFixture(discovery);
    const result = picker.request({ initialRoot: "/Synthetic" });
    const input = surface.contentEl.querySelector<HTMLInputElement>(
      '[data-directory-query="true"]',
    )!;

    input.value = "文学";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(discovery.searchQueries).toEqual(["文学"]);
    expect(discovery.discoverCalls).toEqual([]);
    const confirmation = surface.contentEl.querySelector<HTMLElement>(
      '[data-directory-discovery-confirmation="true"]',
    )!;
    expect(confirmation.hidden).toBe(true);
    surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="search-more-directories"]',
    )!.click();
    expect(confirmation.hidden).toBe(false);
    expect(discovery.discoverCalls).toEqual([]);
    expect(surface.contentEl.textContent).toContain("/Synthetic");
    expect(surface.contentEl.textContent).toContain(
      String(CLOUD_DIRECTORY_DISCOVERY_BUDGET.maxDirectoryCount),
    );
    expect(surface.contentEl.textContent).toContain(
      String(CLOUD_DIRECTORY_DISCOVERY_BUDGET.maxListRequestCount),
    );
    expect(surface.contentEl.textContent).toContain(
      String(CLOUD_DIRECTORY_DISCOVERY_BUDGET.maxDurationMs / 60_000),
    );

    surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-directory-discovery"]',
    )!.click();
    await flush();
    expect(discovery.discoverCalls).toEqual(["/Synthetic"]);
    expect(discovery.signals).toHaveLength(1);
    surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-directory-path="/Synthetic/9-文学253册"]',
    )!.click();
    surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="use-directory"]',
    )!.click();

    await expect(result).resolves.toBe("/Synthetic/9-文学253册");
  });

  it.each(["", "/", "Synthetic", "/Synthetic//Child", "/Synthetic/../Child"])(
    "rejects invalid initial root %j before cached or remote discovery",
    (initialRoot) => {
      const discovery = fakeDirectoryDiscovery([]);
      const { picker, surface } = pickerFixture(discovery);

      expect(() => picker.request({ initialRoot })).toThrow("invalid-scan-root");
      expect(discovery.searchQueries).toEqual([]);
      expect(discovery.discoverCalls).toEqual([]);
      expect(surface.contentEl.textContent).toBe("");
    },
  );

  it("aborts on Escape, clears sensitive drafts, detaches listeners, restores focus, and settles null once", async () => {
    const discovery = fakeDirectoryDiscovery([]);
    const opener = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "button",
    ) as HTMLButtonElement;
    document.body.append(opener);
    opener.focus();
    const { picker, surface } = pickerFixture(discovery);
    let settlements = 0;
    const result = picker.request({ initialRoot: "/Synthetic" }).then((value) => {
      settlements += 1;
      return value;
    });
    const input = surface.contentEl.querySelector<HTMLInputElement>(
      '[data-directory-query="true"]',
    )!;
    expect(document.activeElement).toBe(input);
    input.value = "private-folder-name";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const password = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "input",
    ) as HTMLInputElement;
    password.type = "password";
    password.value = "private-password-draft";
    surface.contentEl.append(password);

    surface.contentEl.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    }));

    await expect(result).resolves.toBeNull();
    expect(input.value).toBe("");
    expect(password.value).toBe("");
    expect(document.activeElement).toBe(opener);
    expect(surface.contentEl.textContent).toBe("");
    const callsAtClose = discovery.searchQueries.length;
    input.value = "detached-private-query";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    surface.close();
    await flush();
    expect(discovery.searchQueries).toHaveLength(callsAtClose);
    expect(settlements).toBe(1);
  });

  it("aborts the one in-flight discovery controller when canceled", async () => {
    const discovery = fakeDirectoryDiscovery([], (rootPath, signal) => new Promise((resolve) => {
      signal?.addEventListener("abort", () => resolve(summary(rootPath, "user-canceled")), {
        once: true,
      });
    }));
    const { picker, surface } = pickerFixture(discovery);
    let settlements = 0;
    const result = picker.request({ initialRoot: "/Synthetic" }).then((value) => {
      settlements += 1;
      return value;
    });
    surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="search-more-directories"]',
    )!.click();
    surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-directory-discovery"]',
    )!.click();
    expect(discovery.signals).toHaveLength(1);
    expect(discovery.signals[0]?.aborted).toBe(false);

    surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="cancel-directory-picker"]',
    )!.click();

    await expect(result).resolves.toBeNull();
    expect(discovery.signals[0]?.aborted).toBe(true);
    expect(discovery.discoverCalls).toEqual(["/Synthetic"]);
    surface.close();
    await flush();
    expect(settlements).toBe(1);
    expect(surface.contentEl.textContent).toBe("");
    expect(discovery.searchQueries).toEqual([]);
  });

  it("treats a host close as a single null cancellation", async () => {
    const discovery = fakeDirectoryDiscovery([]);
    const { picker, surface } = pickerFixture(discovery);
    const result = picker.request({ initialRoot: "/Synthetic" });

    surface.close();
    surface.close();

    await expect(result).resolves.toBeNull();
    expect(surface.contentEl.textContent).toBe("");
    expect(discovery.discoverCalls).toEqual([]);
  });

  it("explains partial fixed-limit results and never renders PDF rows", async () => {
    const discovery = fakeDirectoryDiscovery([
      { path: "/Synthetic/Science", filename: "Science", score: 0 },
      { path: "/Synthetic/private.pdf", filename: "private.pdf", score: 1 },
    ], async (rootPath) => summary(rootPath, "directory-limit"));
    const { picker, surface } = pickerFixture(discovery);
    const result = picker.request({ initialRoot: "/Synthetic" });
    const input = surface.contentEl.querySelector<HTMLInputElement>(
      '[data-directory-query="true"]',
    )!;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(surface.contentEl.querySelector('[data-directory-path="/Synthetic/Science"]'))
      .not.toBeNull();
    expect(surface.contentEl.querySelector('[data-directory-path="/Synthetic/private.pdf"]'))
      .toBeNull();
    expect(surface.contentEl.textContent).not.toContain("private.pdf");
    surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="search-more-directories"]',
    )!.click();
    surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-directory-discovery"]',
    )!.click();
    await flush();
    expect(surface.contentEl.textContent).toContain("文件夹数量上限");
    expect(surface.contentEl.textContent).toContain("结果可能不完整");

    surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="cancel-directory-picker"]',
    )!.click();
    await expect(result).resolves.toBeNull();
  });

  it("sanitizes discovery errors and preserves cached folders for retry", async () => {
    const privateDetail = "private-token-and-response-body";
    const discovery = fakeDirectoryDiscovery([
      { path: "/Synthetic/Cached", filename: "Cached", score: 0 },
    ], async () => { throw new Error(privateDetail); });
    const { picker, surface } = pickerFixture(discovery);
    const result = picker.request({ initialRoot: "/Synthetic" });
    surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="search-more-directories"]',
    )!.click();
    surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-directory-discovery"]',
    )!.click();
    await vi.waitFor(() => {
      expect(surface.contentEl.textContent).toContain("已加载的目录仍可使用");
    });

    expect(surface.contentEl.textContent).not.toContain(privateDetail);
    expect(surface.contentEl.querySelector('[data-directory-path="/Synthetic/Cached"]'))
      .not.toBeNull();
    surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="cancel-directory-picker"]',
    )!.click();
    await expect(result).resolves.toBeNull();
  });
});
