import { describe, expect, it, vi } from "vitest";
import type { BaiduCatalogSourcePort } from "../../../src/catalog/catalog-ports";
import { CatalogError, type BaiduListEntry } from "../../../src/catalog/catalog-types";
import {
  CLOUD_DIRECTORY_LOCATOR_BUDGET,
  CloudDirectoryLocatorService,
} from "../../../src/catalog/cloud-directory-locator";

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
  file(String(start + index), `${parent === "/" ? "" : parent}/file-${start + index}.txt`)
));

describe("cloud directory locator", () => {
  it("freezes its fixed, non-configurable budget", () => {
    expect(CLOUD_DIRECTORY_LOCATOR_BUDGET).toEqual({
      maxDirectoryCount: 500,
      maxListRequestCount: 50,
      maxDurationMs: 120_000,
    });
    expect(Object.isFrozen(CLOUD_DIRECTORY_LOCATOR_BUDGET)).toBe(true);
  });

  it("refuses a blank query before issuing any source request", async () => {
    let sourceCalls = 0;
    const locator = new CloudDirectoryLocatorService(sourceFrom(async () => {
      sourceCalls += 1;
      return { entries: [] };
    }));

    await expect(locator.locateByName(" \n\t ")).rejects.toThrow(
      "cloud-directory-locator-query-required",
    );
    expect(sourceCalls).toBe(0);
  });

  it("lists only from root, completes parent pagination first, and matches directory names locally", async () => {
    const calls: Array<Readonly<{ path: string; start: number }>> = [];
    const locator = new CloudDirectoryLocatorService(sourceFrom(async (input) => {
      await input.beforeRequest();
      if (input.path === "/" && input.start === 1_000) await input.beforeRequest();
      calls.push({ path: input.path, start: input.start });
      if (input.path === "/" && input.start === 0) {
        return { entries: [directory("1", "/A"), ...fillerFiles("/", 10_000, 999)] };
      }
      if (input.path === "/" && input.start === 1_000) {
        return { entries: [directory("2", "/B")] };
      }
      if (input.path === "/A") {
        return { entries: [
          file("3", "/A/Science.pdf"),
          directory("4", "/A/Science Library"),
        ] };
      }
      if (input.path === "/B") {
        return { entries: [directory("5", "/B/science-archive")] };
      }
      return { entries: [] };
    }));

    const result = await locator.locateByName("science");

    expect(calls).toEqual([
      { path: "/", start: 0 },
      { path: "/", start: 1_000 },
      { path: "/A", start: 0 },
      { path: "/B", start: 0 },
      { path: "/A/Science Library", start: 0 },
      { path: "/B/science-archive", start: 0 },
    ]);
    expect(result).toMatchObject({
      status: "complete",
      stopReason: "complete",
      query: "science",
      directoryCount: 4,
      matchCount: 2,
      listRequestCount: 7,
    });
    expect(result.candidates).toEqual([
      {
        kind: "exact",
        path: "/A/Science Library",
        filename: "Science Library",
        source: "cloud-locator",
        pathState: "session-verified",
        cloudFsId: "4",
      },
      {
        kind: "exact",
        path: "/B/science-archive",
        filename: "science-archive",
        source: "cloud-locator",
        pathState: "session-verified",
        cloudFsId: "5",
      },
    ]);
    expect(result.candidates.some((candidate) => (
      candidate.kind !== "name-hint" && candidate.path === "/"
    ))).toBe(false);
    expect(result.candidates.some((candidate) => candidate.filename.endsWith(".pdf"))).toBe(false);
  });

  it("matches the directory name without treating parent-path tokens as a name hit", async () => {
    const locator = new CloudDirectoryLocatorService(sourceFrom(async (input) => {
      await input.beforeRequest();
      if (input.path === "/") return { entries: [directory("1", "/Science")] };
      if (input.path === "/Science") {
        return { entries: [directory("2", "/Science/Other")] };
      }
      return { entries: [] };
    }));

    const result = await locator.locateByName("science");
    expect(result.candidates).toEqual([expect.objectContaining({ path: "/Science" })]);
  });

  it("allows the 50th permit to complete an empty queue and pauses before a 51st replay", async () => {
    const exactlyFifty = new CloudDirectoryLocatorService(sourceFrom(async (input) => {
      for (let index = 0; index < 50; index += 1) await input.beforeRequest();
      return { entries: [] };
    }));
    await expect(exactlyFifty.locateByName("science")).resolves.toMatchObject({
      status: "complete",
      stopReason: "complete",
      listRequestCount: 50,
    });

    const replayOverflow = new CloudDirectoryLocatorService(sourceFrom(async (input) => {
      for (let index = 0; index < 51; index += 1) await input.beforeRequest();
      return { entries: [directory("1", "/Discarded")] };
    }));
    await expect(replayOverflow.locateByName("discarded")).resolves.toMatchObject({
      status: "paused",
      stopReason: "list-request-limit",
      directoryCount: 0,
      matchCount: 0,
      listRequestCount: 50,
      candidates: [],
    });
  });

  it("discards an over-500 page atomically while retaining prior committed matches", async () => {
    const locator = new CloudDirectoryLocatorService(sourceFrom(async (input) => {
      await input.beforeRequest();
      if (input.start === 0) {
        return {
          entries: [
            directory("1", "/Science Committed"),
            ...fillerFiles("/", 10_000, 999),
          ],
        };
      }
      return {
        entries: Array.from({ length: 500 }, (_, index) => (
          directory(String(20_000 + index), `/Science Overflow ${index}`)
        )),
      };
    }));

    await expect(locator.locateByName("science")).resolves.toMatchObject({
      status: "paused",
      stopReason: "directory-limit",
      directoryCount: 1,
      matchCount: 1,
      listRequestCount: 2,
      candidates: [{ path: "/Science Committed", cloudFsId: "1" }],
    });
  });

  it("discards pages canceled before request or after response", async () => {
    let sourceCalls = 0;
    const before = new AbortController();
    before.abort();
    const beforeLocator = new CloudDirectoryLocatorService(sourceFrom(async () => {
      sourceCalls += 1;
      return { entries: [] };
    }));
    await expect(beforeLocator.locateByName("science", before.signal)).resolves.toMatchObject({
      status: "canceled",
      stopReason: "user-canceled",
      listRequestCount: 0,
      candidates: [],
    });
    expect(sourceCalls).toBe(0);

    const after = new AbortController();
    const afterLocator = new CloudDirectoryLocatorService(sourceFrom(async (input) => {
      await input.beforeRequest();
      after.abort();
      return { entries: [directory("1", "/Science Discarded")] };
    }));
    await expect(afterLocator.locateByName("science", after.signal)).resolves.toMatchObject({
      status: "canceled",
      stopReason: "user-canceled",
      directoryCount: 0,
      listRequestCount: 1,
      candidates: [],
    });

    const rejectedAfterCancel = new AbortController();
    const rejectingLocator = new CloudDirectoryLocatorService(sourceFrom(async (input) => {
      await input.beforeRequest();
      rejectedAfterCancel.abort();
      throw new Error("raw-transport-message");
    }));
    await expect(
      rejectingLocator.locateByName("science", rejectedAfterCancel.signal),
    ).resolves.toMatchObject({
      status: "canceled",
      stopReason: "user-canceled",
      listRequestCount: 1,
      candidates: [],
    });
  });

  it("discards a response at the time limit and checks time again before complete", async () => {
    let now = 0;
    const afterResponse = new CloudDirectoryLocatorService(sourceFrom(async (input) => {
      await input.beforeRequest();
      now = CLOUD_DIRECTORY_LOCATOR_BUDGET.maxDurationMs;
      return { entries: [directory("1", "/Science Discarded")] };
    }), { now: () => now });
    await expect(afterResponse.locateByName("science")).resolves.toMatchObject({
      status: "paused",
      stopReason: "time-limit",
      directoryCount: 0,
      listRequestCount: 1,
      elapsedMs: CLOUD_DIRECTORY_LOCATOR_BUDGET.maxDurationMs,
      candidates: [],
    });

    let clockCalls = 0;
    const finalCheck = new CloudDirectoryLocatorService(sourceFrom(async (input) => {
      await input.beforeRequest();
      return { entries: [] };
    }), {
      now: () => {
        clockCalls += 1;
        return clockCalls >= 5 ? CLOUD_DIRECTORY_LOCATOR_BUDGET.maxDurationMs : 0;
      },
    });
    await expect(finalCheck.locateByName("science")).resolves.toMatchObject({
      status: "paused",
      stopReason: "time-limit",
      directoryCount: 0,
      listRequestCount: 1,
      candidates: [],
    });
  });

  it("turns a late directory path identity collision into one disabled conflict", async () => {
    const calls: Array<Readonly<{ path: string; start: number }>> = [];
    const locator = new CloudDirectoryLocatorService(sourceFrom(async (input) => {
      await input.beforeRequest();
      calls.push({ path: input.path, start: input.start });
      if (input.path === "/" && input.start === 0) {
        return { entries: [
          directory("1", "/Science"),
          directory("2", "/Science Other"),
          ...fillerFiles("/", 10_000, 998),
        ] };
      }
      if (input.path === "/" && input.start === 1_000) {
        return { entries: [directory("3", "/Science")] };
      }
      return { entries: [] };
    }));

    const result = await locator.locateByName("science");

    expect(calls).toEqual([
      { path: "/", start: 0 },
      { path: "/", start: 1_000 },
      { path: "/Science Other", start: 0 },
    ]);
    expect(result).toMatchObject({
      status: "complete",
      directoryCount: 3,
      matchCount: 2,
      listRequestCount: 3,
    });
    expect(result.candidates).toEqual([
      {
        kind: "conflict",
        filename: "Science",
        path: "/Science",
        source: "cloud-locator",
        reason: "same-path-different-identity",
      },
      {
        kind: "exact",
        filename: "Science Other",
        path: "/Science Other",
        source: "cloud-locator",
        pathState: "session-verified",
        cloudFsId: "2",
      },
    ]);
  });

  it("rejects one fsId at different paths and file path identity conflicts", async () => {
    const invalidPages: readonly (readonly BaiduListEntry[])[] = [
      [directory("1", "/A"), directory("1", "/B")],
      [file("1", "/same.txt"), file("2", "/same.txt")],
      [file("1", "/same"), directory("2", "/same")],
    ];
    for (const entries of invalidPages) {
      const locator = new CloudDirectoryLocatorService(sourceFrom(async (input) => {
        await input.beforeRequest();
        return { entries };
      }));
      await expect(locator.locateByName("same")).rejects.toEqual(
        new CatalogError("invalid-baidu-response"),
      );
    }
  });

  it("isolates concurrent runs, bridges caller cancellation, and disposes idempotently", async () => {
    const resolvers: Array<(entries: readonly BaiduListEntry[]) => void> = [];
    const locator = new CloudDirectoryLocatorService(sourceFrom(async (input) => {
      await input.beforeRequest();
      if (input.path !== "/") return { entries: [] };
      return new Promise((resolve) => {
        resolvers.push((entries) => resolve({ entries }));
      });
    }));
    const firstController = new AbortController();
    const addListener = vi.spyOn(firstController.signal, "addEventListener");
    const removeListener = vi.spyOn(firstController.signal, "removeEventListener");
    const first = locator.locateByName("science", firstController.signal);
    const second = locator.locateByName("science");
    await Promise.resolve();
    expect(resolvers).toHaveLength(2);

    firstController.abort();
    resolvers[0]?.([directory("1", "/Science First")]);
    resolvers[1]?.([directory("2", "/Science Second")]);

    await expect(first).resolves.toMatchObject({
      status: "canceled",
      stopReason: "user-canceled",
      candidates: [],
    });
    await expect(second).resolves.toMatchObject({
      status: "complete",
      candidates: [{ path: "/Science Second" }],
    });
    expect(addListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledTimes(1);

    locator.cancel();
    locator.cancel();
    locator.dispose();
    locator.dispose();
    await expect(locator.locateByName("science")).rejects.toThrow("catalog-unavailable");
  });

  it("aborts each active run exactly once across repeated cancel and dispose", async () => {
    let resolvePage: ((entries: readonly BaiduListEntry[]) => void) | undefined;
    const abort = vi.spyOn(AbortController.prototype, "abort");
    const locator = new CloudDirectoryLocatorService(sourceFrom(async (input) => {
      await input.beforeRequest();
      return new Promise((resolve) => {
        resolvePage = (entries) => resolve({ entries });
      });
    }));
    const result = locator.locateByName("science");
    await Promise.resolve();
    await Promise.resolve();
    expect(resolvePage).toBeTypeOf("function");

    locator.cancel();
    locator.cancel();
    locator.dispose();
    locator.dispose();
    resolvePage?.([directory("1", "/Science Discarded")]);

    await expect(result).resolves.toMatchObject({
      status: "canceled",
      stopReason: "user-canceled",
      candidates: [],
    });
    expect(abort).toHaveBeenCalledTimes(1);
    abort.mockRestore();
  });
});
