import { describe, expect, it, vi } from "vitest";
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

const deferredEntries = (): Readonly<{
  promise: Promise<Readonly<{ entries: readonly BaiduListEntry[] }>>;
  resolve: (entries: readonly BaiduListEntry[]) => void;
}> => {
  let resolvePage: ((value: Readonly<{ entries: readonly BaiduListEntry[] }>) => void) | undefined;
  const promise = new Promise<Readonly<{ entries: readonly BaiduListEntry[] }>>((resolve) => {
    resolvePage = resolve;
  });
  return {
    promise,
    resolve: (entries) => {
      if (resolvePage === undefined) throw new Error("test-page-resolver-unavailable");
      resolvePage({ entries });
    },
  };
};

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

  it("counts every granted permit while committing one adapter page once", async () => {
    const browser = new CloudDirectoryBrowserService(sourceFrom(async (input) => {
      await input.beforeRequest();
      await input.beforeRequest();
      return { entries: [directory("1", "/科学文库/A")] };
    }));

    const summary = await browser.loadLayer({ path: "/科学文库", start: 0 });

    expect(summary.listRequestCount).toBe(2);
    expect(summary.cumulativeListRequestCount).toBe(2);
    expect(summary.checkedEntryCount).toBe(1);
    expect(browser.snapshot("/科学文库")?.directories).toHaveLength(1);
  });

  it("rejects the twenty-first permit before counting it or committing the page", async () => {
    let grantedPermits = 0;
    const browser = new CloudDirectoryBrowserService(sourceFrom(async (input) => {
      for (let index = 0; index < 21; index += 1) {
        await input.beforeRequest();
        grantedPermits += 1;
      }
      return { entries: [directory("1", "/科学文库/不应提交")] };
    }));

    await expect(browser.loadLayer({ path: "/科学文库", start: 0 })).resolves.toMatchObject({
      status: "paused",
      stopReason: "list-request-limit",
      nextStart: 0,
      checkedEntryCount: 0,
      cumulativeCheckedEntryCount: 0,
      listRequestCount: 20,
      cumulativeListRequestCount: 20,
    });
    expect(grantedPermits).toBe(20);
    expect(browser.snapshot("/科学文库")?.directories).toEqual([]);
  });

  it("retains granted permits across network and validation failures while retrying the cursor", async () => {
    let attempt = 0;
    const browser = new CloudDirectoryBrowserService(sourceFrom(async (input) => {
      attempt += 1;
      await input.beforeRequest();
      if (attempt === 1) throw new Error("raw-response token=secret stack=private");
      if (attempt === 2) {
        return { entries: [directory("2", "/科学文库/A/非直接子目录")] };
      }
      return { entries: [directory("3", "/科学文库/重试成功")] };
    }));

    await expect(browser.loadLayer({ path: "/科学文库", start: 0 }))
      .rejects.toThrow("raw-response token=secret stack=private");
    expect(browser.snapshot("/科学文库")).toMatchObject({
      directories: [],
      nextStart: 0,
      cumulativeCheckedEntryCount: 0,
      cumulativeListRequestCount: 1,
      lastStopReason: null,
    });

    await expect(browser.loadLayer({ path: "/科学文库", start: 0 }))
      .rejects.toEqual(new CatalogError("invalid-baidu-response"));
    const afterInvalid = browser.snapshot("/科学文库");
    expect(afterInvalid).toMatchObject({
      directories: [],
      nextStart: 0,
      cumulativeCheckedEntryCount: 0,
      cumulativeListRequestCount: 2,
      lastStopReason: null,
    });
    expect(JSON.stringify(afterInvalid)).not.toMatch(/raw-response|token|secret|stack|private/u);

    await expect(browser.loadLayer({ path: "/科学文库", start: 0 })).resolves.toMatchObject({
      status: "complete",
      checkedEntryCount: 1,
      cumulativeCheckedEntryCount: 1,
      listRequestCount: 1,
      cumulativeListRequestCount: 3,
    });
    expect(browser.snapshot("/科学文库")?.directories).toEqual([
      { fsId: "3", path: "/科学文库/重试成功", filename: "重试成功" },
    ]);
  });

  it("preserves source CatalogError identity without recording its details", async () => {
    const sourceError = new CatalogError("baidu-rate-limited", true);
    const browser = new CloudDirectoryBrowserService(sourceFrom(async (input) => {
      await input.beforeRequest();
      throw sourceError;
    }));

    await expect(browser.loadLayer({ path: "/科学文库", start: 0 })).rejects.toBe(sourceError);
    const snapshot = browser.snapshot("/科学文库");
    expect(snapshot).toMatchObject({
      nextStart: 0,
      cumulativeCheckedEntryCount: 0,
      cumulativeListRequestCount: 1,
      lastStopReason: null,
    });
    expect(JSON.stringify(snapshot)).not.toContain("baidu-rate-limited");
  });

  it("rejects every malformed or conflicting page atomically and retries its exact cursor", async () => {
    const invalidPages: readonly (readonly BaiduListEntry[])[] = [
      [directory("1", "/科学文库/A"), directory("1", "/科学文库/A")],
      [directory("1", "/科学文库/A"), directory("2", "/科学文库/A")],
      [directory("1", "/科学文库/A"), directory("1", "/科学文库/B")],
      [file("1", "/科学文库/A.pdf"), file("2", "/科学文库/A.pdf")],
      [file("1", "/科学文库/A.pdf"), file("1", "/科学文库/B.pdf")],
      [file("1", "/科学文库/A"), directory("2", "/科学文库/A")],
      [directory("1", "/科学文库/A/孙目录")],
      fillerFiles("/科学文库", 0, 1_001),
    ];

    for (const invalidPage of invalidPages) {
      let valid = false;
      const browser = new CloudDirectoryBrowserService(sourceFrom(async (input) => {
        await input.beforeRequest();
        return {
          entries: valid
            ? [directory("9000", "/科学文库/重试成功")]
            : invalidPage,
        };
      }));

      await expect(browser.loadLayer({ path: "/科学文库", start: 0 }))
        .rejects.toEqual(new CatalogError("invalid-baidu-response"));
      expect(browser.snapshot("/科学文库")).toMatchObject({
        directories: [],
        nextStart: 0,
        cumulativeCheckedEntryCount: 0,
        cumulativeListRequestCount: 1,
      });

      valid = true;
      await expect(browser.loadLayer({ path: "/科学文库", start: 0 })).resolves.toMatchObject({
        status: "complete",
        cumulativeListRequestCount: 2,
      });
      expect(browser.snapshot("/科学文库")?.directories).toEqual([
        { fsId: "9000", path: "/科学文库/重试成功", filename: "重试成功" },
      ]);
    }
  });

  it("rejects conflicts with persisted directory identities without mutating the committed page", async () => {
    const invalidSecondPages: readonly (readonly BaiduListEntry[])[] = [
      [directory("2", "/科学文库/A")],
      [directory("1", "/科学文库/B")],
    ];

    for (const invalidSecondPage of invalidSecondPages) {
      let secondPage = invalidSecondPage;
      const browser = new CloudDirectoryBrowserService(sourceFrom(async (input) => {
        await input.beforeRequest();
        if (input.start === 0) {
          return {
            entries: [
              directory("1", "/科学文库/A"),
              ...fillerFiles("/科学文库", 10_000, 999),
            ],
          };
        }
        return { entries: secondPage };
      }));

      await expect(browser.loadLayer({ path: "/科学文库", start: 0 }))
        .rejects.toEqual(new CatalogError("invalid-baidu-response"));
      expect(browser.snapshot("/科学文库")).toMatchObject({
        directories: [{ fsId: "1", path: "/科学文库/A", filename: "A" }],
        nextStart: 1000,
        cumulativeCheckedEntryCount: 1000,
        cumulativeListRequestCount: 2,
      });

      secondPage = [directory("3", "/科学文库/B")];
      await expect(browser.loadLayer({ path: "/科学文库", start: 1000 }))
        .resolves.toMatchObject({ status: "complete", cumulativeListRequestCount: 3 });
      expect(browser.snapshot("/科学文库")?.directories).toEqual([
        { fsId: "1", path: "/科学文库/A", filename: "A" },
        { fsId: "3", path: "/科学文库/B", filename: "B" },
      ]);
    }
  });

  it("uses file identities only inside one page and discards them after commit", async () => {
    const browser = new CloudDirectoryBrowserService(sourceFrom(async (input) => {
      await input.beforeRequest();
      if (input.start === 0) {
        return {
          entries: [
            file("7000", "/科学文库/旧文件.pdf"),
            ...fillerFiles("/科学文库", 20_000, 999),
          ],
        };
      }
      return { entries: [directory("7000", "/科学文库/新目录")] };
    }));

    await expect(browser.loadLayer({ path: "/科学文库", start: 0 })).resolves.toMatchObject({
      status: "complete",
      checkedEntryCount: 1001,
      directoryCount: 1,
    });
    expect(browser.snapshot("/科学文库")?.directories).toEqual([
      { fsId: "7000", path: "/科学文库/新目录", filename: "新目录" },
    ]);
  });

  it("discards a delayed page after external cancellation and preserves prior commits", async () => {
    const delayed = deferredEntries();
    const calls: number[] = [];
    const browser = new CloudDirectoryBrowserService(sourceFrom(async (input) => {
      await input.beforeRequest();
      calls.push(input.start);
      if (input.start === 0) {
        return {
          entries: [
            directory("1", "/科学文库/已提交"),
            ...fillerFiles("/科学文库", 30_000, 999),
          ],
        };
      }
      return delayed.promise;
    }));
    const controller = new AbortController();
    const result = browser.loadLayer({ path: "/科学文库", start: 0 }, controller.signal);
    await vi.waitFor(() => expect(calls).toEqual([0, 1000]));

    controller.abort();
    delayed.resolve([directory("2", "/科学文库/不应提交")]);

    await expect(result).resolves.toMatchObject({
      status: "canceled",
      stopReason: "user-canceled",
      nextStart: 1000,
      checkedEntryCount: 1000,
      cumulativeCheckedEntryCount: 1000,
      listRequestCount: 2,
      cumulativeListRequestCount: 2,
    });
    expect(calls).toEqual([0, 1000]);
    expect(browser.snapshot("/科学文库")?.directories).toEqual([
      { fsId: "1", path: "/科学文库/已提交", filename: "已提交" },
    ]);
  });

  it("discards a response when the clock reaches the time limit before commit", async () => {
    let now = 0;
    const browser = new CloudDirectoryBrowserService(sourceFrom(async (input) => {
      await input.beforeRequest();
      now = CLOUD_DIRECTORY_BROWSE_ROUND_BUDGET.maxDurationMs;
      return { entries: [directory("1", "/科学文库/不应提交")] };
    }), { now: () => now });

    await expect(browser.loadLayer({ path: "/科学文库", start: 0 })).resolves.toMatchObject({
      status: "paused",
      stopReason: "time-limit",
      nextStart: 0,
      checkedEntryCount: 0,
      cumulativeCheckedEntryCount: 0,
      listRequestCount: 1,
      cumulativeListRequestCount: 1,
      elapsedMs: CLOUD_DIRECTORY_BROWSE_ROUND_BUDGET.maxDurationMs,
    });
    expect(browser.snapshot("/科学文库")?.directories).toEqual([]);
  });

  it("rejects concurrent loads while allowing the original operation to finish", async () => {
    const delayed = deferredEntries();
    const browser = new CloudDirectoryBrowserService(sourceFrom(async (input) => {
      await input.beforeRequest();
      return delayed.promise;
    }));
    const first = browser.loadLayer({ path: "/科学文库", start: 0 });
    await Promise.resolve();

    await expect(browser.loadLayer({ path: "/另一个目录", start: 0 }))
      .rejects.toThrow("cloud-directory-browser-busy");
    delayed.resolve([]);
    await expect(first).resolves.toMatchObject({ status: "complete" });
  });

  it("does not retain the busy guard when the initial clock value is invalid", async () => {
    let invalidClock = true;
    const browser = new CloudDirectoryBrowserService(sourceFrom(async (input) => {
      await input.beforeRequest();
      return { entries: [] };
    }), { now: () => invalidClock ? Number.NaN : 0 });

    await expect(browser.loadLayer({ path: "/科学文库", start: 0 }))
      .rejects.toEqual(new CatalogError("invalid-baidu-response"));
    invalidClock = false;
    await expect(browser.loadLayer({ path: "/科学文库", start: 0 }))
      .resolves.toMatchObject({ status: "complete" });
  });

  it("clear aborts an active generation and resets layers plus root consent", async () => {
    const delayed = deferredEntries();
    let sourceCalls = 0;
    const browser = new CloudDirectoryBrowserService(sourceFrom(async (input) => {
      sourceCalls += 1;
      await input.beforeRequest();
      return delayed.promise;
    }));
    browser.grantRootAccess();
    const result = browser.loadLayer({ path: "/", start: 0 });
    await vi.waitFor(() => expect(sourceCalls).toBe(1));

    browser.clear();
    delayed.resolve([directory("1", "/不应提交")]);

    await expect(result).resolves.toMatchObject({
      status: "canceled",
      stopReason: "user-canceled",
      checkedEntryCount: 0,
      listRequestCount: 1,
    });
    expect(browser.rootAccessGranted()).toBe(false);
    expect(browser.snapshot("/")).toBeNull();
    expect(sourceCalls).toBe(1);
  });

  it("dispose aborts late work, is idempotent, and makes every public method unavailable", async () => {
    const delayed = deferredEntries();
    let sourceCalls = 0;
    const browser = new CloudDirectoryBrowserService(sourceFrom(async (input) => {
      sourceCalls += 1;
      await input.beforeRequest();
      return delayed.promise;
    }));
    const result = browser.loadLayer({ path: "/科学文库", start: 0 });
    await vi.waitFor(() => expect(sourceCalls).toBe(1));

    browser.dispose();
    browser.dispose();
    delayed.resolve([directory("1", "/科学文库/不应提交")]);

    await expect(result).resolves.toMatchObject({
      status: "canceled",
      stopReason: "user-canceled",
      checkedEntryCount: 0,
      listRequestCount: 1,
    });
    expect(() => browser.rootAccessGranted()).toThrow("cloud-directory-browser-unavailable");
    expect(() => browser.grantRootAccess()).toThrow("cloud-directory-browser-unavailable");
    await expect(browser.loadLayer({ path: "/科学文库", start: 0 }))
      .rejects.toThrow("cloud-directory-browser-unavailable");
    expect(() => browser.snapshot("/科学文库"))
      .toThrow("cloud-directory-browser-unavailable");
    expect(() => browser.subscribe(() => undefined))
      .toThrow("cloud-directory-browser-unavailable");
    expect(() => browser.clear()).toThrow("cloud-directory-browser-unavailable");
    expect(() => browser.dispose()).not.toThrow();
    expect(sourceCalls).toBe(1);
  });

  it("returns canceled without a ghost notification when a page listener clears the service", async () => {
    const browser = new CloudDirectoryBrowserService(sourceFrom(async (input) => {
      await input.beforeRequest();
      return { entries: [directory("1", "/科学文库/已提交后清理")] };
    }));
    let notifications = 0;
    browser.subscribe(() => {
      notifications += 1;
      browser.clear();
    });

    await expect(browser.loadLayer({ path: "/科学文库", start: 0 })).resolves.toMatchObject({
      status: "canceled",
      stopReason: "user-canceled",
      checkedEntryCount: 1,
      directoryCount: 1,
    });
    expect(notifications).toBe(1);
    expect(browser.snapshot("/科学文库")).toBeNull();
  });

  it("returns canceled and unavailable when a page listener disposes the service", async () => {
    const browser = new CloudDirectoryBrowserService(sourceFrom(async (input) => {
      await input.beforeRequest();
      return { entries: [directory("1", "/科学文库/已提交后释放")] };
    }));
    let notifications = 0;
    browser.subscribe(() => {
      notifications += 1;
      browser.dispose();
    });

    await expect(browser.loadLayer({ path: "/科学文库", start: 0 })).resolves.toMatchObject({
      status: "canceled",
      stopReason: "user-canceled",
      checkedEntryCount: 1,
      directoryCount: 1,
    });
    expect(notifications).toBe(1);
    expect(() => browser.snapshot("/科学文库"))
      .toThrow("cloud-directory-browser-unavailable");
  });

  it("downgrades a final completion notification cleared by its listener without renotifying", async () => {
    const browser = new CloudDirectoryBrowserService(sourceFrom(async (input) => {
      await input.beforeRequest();
      return { entries: [directory("1", "/科学文库/已提交")] };
    }));
    let notifications = 0;
    browser.subscribe(() => {
      notifications += 1;
      if (notifications === 2) browser.clear();
    });

    await expect(browser.loadLayer({ path: "/科学文库", start: 0 })).resolves.toMatchObject({
      status: "canceled",
      stopReason: "user-canceled",
      checkedEntryCount: 1,
      directoryCount: 1,
    });
    expect(notifications).toBe(2);
    expect(browser.snapshot("/科学文库")).toBeNull();
  });

  it("contains listener failures after commit and still notifies remaining listeners", async () => {
    const browser = new CloudDirectoryBrowserService(sourceFrom(async (input) => {
      await input.beforeRequest();
      return { entries: [directory("1", "/科学文库/A")] };
    }));
    const observed: CloudDirectoryLayerSnapshot[] = [];
    browser.subscribe(() => {
      throw new Error("listener token=secret stack=private");
    });
    browser.subscribe((path) => {
      const snapshot = browser.snapshot(path);
      if (snapshot !== null) observed.push(snapshot);
    });

    const summary = await browser.loadLayer({ path: "/科学文库", start: 0 });

    expect(summary).toMatchObject({
      status: "complete",
      stopReason: "complete",
      checkedEntryCount: 1,
      directoryCount: 1,
    });
    expect(observed).toHaveLength(2);
    expect(observed.at(-1)).toMatchObject({
      complete: true,
      lastStopReason: "complete",
    });
    expect(JSON.stringify({ summary, observed })).not.toMatch(/token|secret|stack|private/u);
  });
});
