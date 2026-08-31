import { describe, expect, it } from "vitest";
import type { BaiduCatalogSourcePort } from "../../../src/catalog/catalog-ports";
import { CatalogError, type BaiduListEntry } from "../../../src/catalog/catalog-types";
import {
  CLOUD_DIRECTORY_BROWSE_ROUND_BUDGET,
  CloudDirectoryBrowserService,
  type CloudDirectoryLayerSnapshot,
} from "../../../src/catalog/cloud-directory-browser";

const directory = (
  fsId: string,
  path: string,
): BaiduListEntry => ({
  fsId,
  path,
  filename: path.slice(path.lastIndexOf("/") + 1),
  sizeBytes: 0,
  serverModifiedAt: 1,
  isDirectory: true,
});

const file = (
  fsId: string,
  path: string,
): BaiduListEntry => ({
  fsId,
  path,
  filename: path.slice(path.lastIndexOf("/") + 1),
  sizeBytes: 10,
  serverModifiedAt: 1,
  isDirectory: false,
});

const sourceFrom = (
  listDirectory: BaiduCatalogSourcePort["listDirectory"],
): BaiduCatalogSourcePort => ({ listDirectory });

const fillerFiles = (
  parent: string,
  start: number,
  count: number,
): readonly BaiduListEntry[] => Array.from({ length: count }, (_, index) => (
  file(
    String(start + index + 1),
    `${parent}/file-${start + index}.pdf`,
  )
));

describe("cloud directory browser", () => {
  it("freezes the fixed 20,000-entry round budget", () => {
    expect(CLOUD_DIRECTORY_BROWSE_ROUND_BUDGET).toEqual({
      maxEntryCount: 20_000,
      maxListRequestCount: 20,
      maxDurationMs: 120_000,
    });
    expect(Object.isFrozen(CLOUD_DIRECTORY_BROWSE_ROUND_BUDGET)).toBe(true);
  });

  it("requires session consent only for the internal root entry", async () => {
    const calls: Array<Readonly<{ path: string; start: number; limit: number }>> = [];
    const browser = new CloudDirectoryBrowserService(sourceFrom(async (input) => {
      await input.beforeRequest();
      calls.push({ path: input.path, start: input.start, limit: input.limit });
      return { entries: [] };
    }));

    expect(browser.rootAccessGranted()).toBe(false);
    await expect(browser.loadLayer({ path: "/", start: 0 })).rejects.toThrow(
      "cloud-directory-root-consent-required",
    );
    expect(calls).toEqual([]);

    browser.grantRootAccess();
    expect(browser.rootAccessGranted()).toBe(true);
    await browser.loadLayer({ path: "/", start: 0 });
    await browser.loadLayer({ path: "/科学文库", start: 0 });

    expect(calls).toEqual([
      { path: "/", start: 0, limit: 1000 },
      { path: "/科学文库", start: 0, limit: 1000 },
    ]);

    const withoutRootConsent = new CloudDirectoryBrowserService(sourceFrom(async (input) => {
      await input.beforeRequest();
      return { entries: [] };
    }));
    await expect(withoutRootConsent.loadLayer({ path: "/非根目录", start: 0 }))
      .resolves.toMatchObject({ status: "complete", path: "/非根目录" });
    expect(withoutRootConsent.rootAccessGranted()).toBe(false);
  });

  it("loads only the current layer, discards validated files, and emits page progress", async () => {
    const calls: Array<Readonly<{ path: string; start: number; limit: number }>> = [];
    const firstPage = [
      directory("1", "/科学文库/A"),
      ...fillerFiles("/科学文库", 1_000, 999),
    ];
    const source = sourceFrom(async (input) => {
      await input.beforeRequest();
      calls.push({ path: input.path, start: input.start, limit: input.limit });
      if (input.start === 0) return { entries: firstPage };
      return {
        entries: [
          file("3000", "/科学文库/ignored.pdf"),
          directory("3001", "/科学文库/B"),
        ],
      };
    });
    const browser = new CloudDirectoryBrowserService(source);
    const notifications: CloudDirectoryLayerSnapshot[] = [];
    const unsubscribe = browser.subscribe((path) => {
      const snapshot = browser.snapshot(path);
      if (snapshot !== null) notifications.push(snapshot);
    });

    const summary = await browser.loadLayer({ path: "/科学文库", start: 0 });
    unsubscribe();

    expect(calls).toEqual([
      { path: "/科学文库", start: 0, limit: 1000 },
      { path: "/科学文库", start: 1000, limit: 1000 },
    ]);
    expect(calls.some((call) => call.path === "/科学文库/A")).toBe(false);
    expect(summary).toMatchObject({
      path: "/科学文库",
      status: "complete",
      stopReason: "complete",
      nextStart: null,
      checkedEntryCount: 1_002,
      cumulativeCheckedEntryCount: 1_002,
      directoryCount: 2,
      listRequestCount: 2,
      cumulativeListRequestCount: 2,
    });
    expect(summary.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(notifications).toHaveLength(3);
    expect(notifications[0]).toMatchObject({
      nextStart: 1000,
      complete: false,
      cumulativeCheckedEntryCount: 1000,
      cumulativeListRequestCount: 1,
      lastStopReason: null,
    });
    expect(notifications[1]).toMatchObject({
      nextStart: null,
      complete: true,
      cumulativeCheckedEntryCount: 1_002,
      cumulativeListRequestCount: 2,
      lastStopReason: null,
    });
    expect(notifications[2]).toMatchObject({
      nextStart: null,
      complete: true,
      lastStopReason: "complete",
    });
    expect(browser.snapshot("/科学文库")?.directories).toEqual([
      { fsId: "1", path: "/科学文库/A", filename: "A" },
      { fsId: "3001", path: "/科学文库/B", filename: "B" },
    ]);

    const detached = browser.snapshot("/科学文库");
    const detachedAgain = browser.snapshot("/科学文库");
    expect(detached?.directories).not.toBe(detachedAgain?.directories);
    expect(detached?.directories[0]).not.toBe(detachedAgain?.directories[0]);
    expect(detachedAgain?.directories[0]?.path).toBe("/科学文库/A");
  });

  it("validates files before discarding them", async () => {
    const browser = new CloudDirectoryBrowserService(sourceFrom(async (input) => {
      await input.beforeRequest();
      return {
        entries: [{
          ...file("1", "/科学文库/invalid.pdf"),
          sizeBytes: -1,
        }],
      };
    }));

    await expect(browser.loadLayer({ path: "/科学文库", start: 0 })).rejects.toEqual(
      new CatalogError("invalid-baidu-response"),
    );
    expect(browser.snapshot("/科学文库")?.directories).toEqual([]);
  });

  it("pauses after exactly 20 full pages and reports round versus layer totals", async () => {
    const calls: Array<Readonly<{ path: string; start: number; limit: number }>> = [];
    const browser = new CloudDirectoryBrowserService(sourceFrom(async (input) => {
      await input.beforeRequest();
      calls.push({ path: input.path, start: input.start, limit: input.limit });
      if (input.start < 20_000) {
        return { entries: fillerFiles("/科学文库", input.start, 1000) };
      }
      return { entries: [directory("50000", "/科学文库/续页目录")] };
    }));

    const firstRound = await browser.loadLayer({ path: "/科学文库", start: 0 });
    expect(calls).toHaveLength(20);
    expect(calls.every((call) => call.path === "/科学文库" && call.limit === 1000)).toBe(true);
    expect(firstRound).toMatchObject({
      status: "paused",
      stopReason: "entry-limit",
      nextStart: 20_000,
      checkedEntryCount: 20_000,
      cumulativeCheckedEntryCount: 20_000,
      directoryCount: 0,
      listRequestCount: 20,
      cumulativeListRequestCount: 20,
    });
    expect(browser.snapshot("/科学文库")).toMatchObject({
      nextStart: 20_000,
      complete: false,
      cumulativeCheckedEntryCount: 20_000,
      cumulativeListRequestCount: 20,
      lastStopReason: "entry-limit",
    });

    await expect(browser.loadLayer({ path: "/科学文库", start: 19_000 }))
      .rejects.toThrow("cloud-directory-browser-start-invalid");
    expect(calls).toHaveLength(20);

    const secondRound = await browser.loadLayer({ path: "/科学文库", start: 20_000 });
    expect(calls).toHaveLength(21);
    expect(secondRound).toMatchObject({
      status: "complete",
      stopReason: "complete",
      nextStart: null,
      checkedEntryCount: 1,
      cumulativeCheckedEntryCount: 20_001,
      directoryCount: 1,
      listRequestCount: 1,
      cumulativeListRequestCount: 21,
    });
  });

  it("rejects unsafe page starts without contacting the source", async () => {
    let calls = 0;
    const browser = new CloudDirectoryBrowserService(sourceFrom(async (input) => {
      calls += 1;
      await input.beforeRequest();
      return { entries: [] };
    }));

    for (const start of [-1, 1, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(browser.loadLayer({ path: "/科学文库", start })).rejects.toThrow(
        "cloud-directory-browser-start-invalid",
      );
    }
    expect(calls).toBe(0);
  });
});
