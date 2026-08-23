import { describe, expect, it } from "vitest";
import {
  EMPTY_RECENT_CLOUD_DIRECTORIES,
  MAX_RECENT_CLOUD_DIRECTORY_COUNT,
  decodeRecentCloudDirectories,
  rememberRecentCloudDirectory,
} from "../../../src/storage/recent-cloud-directories";

describe("recent cloud directories", () => {
  it("normalizes, deduplicates, moves the selected path to the front, and caps at ten", () => {
    let state = EMPTY_RECENT_CLOUD_DIRECTORIES;
    for (let index = 0; index < 11; index += 1) {
      state = rememberRecentCloudDirectory(
        state,
        `/Synthetic/Folder-${index}`,
        Date.UTC(2026, 7, 23, 0, 0, index),
      );
    }
    state = rememberRecentCloudDirectory(
      state,
      "/Synthetic/Folder-5",
      Date.UTC(2026, 7, 23, 0, 1, 0),
    );

    expect(state.schemaVersion).toBe(1);
    expect(state.items).toHaveLength(MAX_RECENT_CLOUD_DIRECTORY_COUNT);
    expect(state.items[0]).toEqual({
      path: "/Synthetic/Folder-5",
      filename: "Folder-5",
      lastUsedAt: "2026-08-23T00:01:00.000Z",
    });
    expect(new Set(state.items.map((item) => item.path)).size).toBe(10);
    expect(state.items.some((item) => item.path === "/Synthetic/Folder-0")).toBe(false);
  });

  it("normalizes Unicode paths and derives the filename from the normalized tail", () => {
    const state = rememberRecentCloudDirectory(
      EMPTY_RECENT_CLOUD_DIRECTORIES,
      "/Synthetic/Cafe\u0301",
      Date.UTC(2026, 7, 23),
    );

    expect(state.items).toEqual([{
      path: "/Synthetic/Caf\u00e9",
      filename: "Caf\u00e9",
      lastUsedAt: "2026-08-23T00:00:00.000Z",
    }]);
  });

  it.each(["/", "Synthetic", "/Synthetic//Child", "/Synthetic/../Child"]) (
    "refuses an invalid remembered path %j",
    (path) => {
      expect(() => rememberRecentCloudDirectory(
        EMPTY_RECENT_CLOUD_DIRECTORIES,
        path,
        Date.UTC(2026, 7, 23),
      )).toThrow("invalid-scan-root");
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 8.64e15 + 1])(
    "refuses an invalid usage timestamp %j",
    (usedAt) => {
      expect(() => rememberRecentCloudDirectory(
        EMPTY_RECENT_CLOUD_DIRECTORIES,
        "/Synthetic/Child",
        usedAt,
      )).toThrow("invalid-recent-cloud-directory-timestamp");
    },
  );

  it("keeps a reused path first after reload when the clock repeats or moves backward", () => {
    const first = rememberRecentCloudDirectory(
      EMPTY_RECENT_CLOUD_DIRECTORIES,
      "/Synthetic/Zeta",
      1_000,
    );
    const second = rememberRecentCloudDirectory(first, "/Synthetic/Alpha", 1_000);
    const reused = rememberRecentCloudDirectory(second, "/Synthetic/Zeta", 999);

    expect(reused.items[0]).toMatchObject({
      path: "/Synthetic/Zeta",
      lastUsedAt: "1970-01-01T00:00:01.002Z",
    });
    expect(decodeRecentCloudDirectories(structuredClone(reused)).items.map((item) => item.path))
      .toEqual(["/Synthetic/Zeta", "/Synthetic/Alpha"]);
  });

  it("decodes a valid value into deterministic descending timestamp and path order", () => {
    const input = {
      schemaVersion: 1,
      items: [
        { path: "/Synthetic/Zeta", filename: "Zeta", lastUsedAt: "2026-08-22T00:00:00.000Z" },
        { path: "/Synthetic/Beta", filename: "Beta", lastUsedAt: "2026-08-23T00:00:00.000Z" },
        { path: "/Synthetic/Alpha", filename: "Alpha", lastUsedAt: "2026-08-23T00:00:00.000Z" },
      ],
    };

    const decoded = decodeRecentCloudDirectories(input);
    input.items[0]!.path = "/mutated";

    expect(decoded.items.map((item) => item.path)).toEqual([
      "/Synthetic/Alpha",
      "/Synthetic/Beta",
      "/Synthetic/Zeta",
    ]);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(decoded.items.every(Object.isFrozen)).toBe(true);
  });

  it("keeps the last same-millisecond selection first after a decode round trip", () => {
    const usedAt = Date.UTC(2026, 7, 23);
    const first = rememberRecentCloudDirectory(
      EMPTY_RECENT_CLOUD_DIRECTORIES,
      "/Synthetic/Alpha",
      usedAt,
    );
    const second = rememberRecentCloudDirectory(first, "/Synthetic/Zeta", usedAt);

    expect(second.items.map((item) => item.path)).toEqual([
      "/Synthetic/Zeta",
      "/Synthetic/Alpha",
    ]);
    expect(decodeRecentCloudDirectories(second).items.map((item) => item.path)).toEqual([
      "/Synthetic/Zeta",
      "/Synthetic/Alpha",
    ]);
    expect(second.items[0]?.lastUsedAt).toBe("2026-08-23T00:00:00.001Z");
  });

  it("returns an empty value instead of propagating malformed property access", () => {
    const malformed = new Proxy({}, {
      get: () => { throw new Error("malformed getter"); },
    });

    expect(() => decodeRecentCloudDirectories(malformed)).not.toThrow();
    expect(decodeRecentCloudDirectories(malformed)).toEqual({ schemaVersion: 1, items: [] });
  });

  it.each([
    ["wrong schema", { schemaVersion: 2, items: [] }],
    ["non-array items", { schemaVersion: 1, items: {} }],
    [
      "more than ten items",
      {
        schemaVersion: 1,
        items: Array.from({ length: 11 }, (_, index) => ({
          path: `/Synthetic/${index}`,
          filename: String(index),
          lastUsedAt: "2026-08-23T00:00:00.000Z",
        })),
      },
    ],
    [
      "root path",
      {
        schemaVersion: 1,
        items: [{ path: "/", filename: "", lastUsedAt: "2026-08-23T00:00:00.000Z" }],
      },
    ],
    [
      "mismatched filename",
      {
        schemaVersion: 1,
        items: [{ path: "/Synthetic/Alpha", filename: "Beta", lastUsedAt: "2026-08-23T00:00:00.000Z" }],
      },
    ],
    [
      "duplicate normalized path",
      {
        schemaVersion: 1,
        items: [
          { path: "/Synthetic/Cafe\u0301", filename: "Caf\u00e9", lastUsedAt: "2026-08-23T00:00:00.000Z" },
          { path: "/Synthetic/Caf\u00e9", filename: "Caf\u00e9", lastUsedAt: "2026-08-22T00:00:00.000Z" },
        ],
      },
    ],
    [
      "non-canonical timestamp",
      {
        schemaVersion: 1,
        items: [{ path: "/Synthetic/Alpha", filename: "Alpha", lastUsedAt: "2026-08-23T00:00:00Z" }],
      },
    ],
  ])("fails the entire field closed for %s", (_, value) => {
    const decoded = decodeRecentCloudDirectories(value);

    expect(decoded).toEqual({ schemaVersion: 1, items: [] });
    expect(decoded).not.toBe(EMPTY_RECENT_CLOUD_DIRECTORIES);
  });

  it("keeps only the public recent-path fields", () => {
    const decoded = decodeRecentCloudDirectories({
      schemaVersion: 1,
      items: [{
        path: "/Synthetic/Alpha",
        filename: "Alpha",
        lastUsedAt: "2026-08-23T00:00:00.000Z",
        fsId: "synthetic-identity",
        accessToken: "synthetic-token",
      }],
    });

    expect(decoded).toEqual({
      schemaVersion: 1,
      items: [{
        path: "/Synthetic/Alpha",
        filename: "Alpha",
        lastUsedAt: "2026-08-23T00:00:00.000Z",
      }],
    });
  });
});
