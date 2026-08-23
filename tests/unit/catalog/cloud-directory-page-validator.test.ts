import { describe, expect, it } from "vitest";
import { validateBaiduListEntry } from "../../../src/catalog/cloud-directory-page-validator";
import { CatalogError, type BaiduListEntry } from "../../../src/catalog/catalog-types";

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

const invalidResponse = new CatalogError("invalid-baidu-response");

describe("cloud directory page validator", () => {
  it("accepts direct normalized descendants under the dedicated root traversal", () => {
    expect(validateBaiduListEntry({
      entry: directory("1", "/Science"),
      currentPath: "/",
      traversalRoot: "/",
    })).toEqual(directory("1", "/Science"));

    expect(validateBaiduListEntry({
      entry: { ...directory("2", "/Science/é"), filename: "e\u0301" },
      currentPath: "/Science",
      traversalRoot: "/Science",
    })).toEqual(directory("2", "/Science/é"));
  });

  it("maps malformed traversal inputs and every malformed entry rule to one fixed error", () => {
    const base = directory("1", "/Science/Books");
    const invalid: readonly Readonly<{
      entry: unknown;
      currentPath?: string;
      traversalRoot?: string;
    }>[] = [
      { entry: null },
      { entry: [] },
      { entry: { ...base, path: 1 } },
      { entry: { ...base, filename: 1 } },
      { entry: { ...base, fsId: 1 } },
      { entry: { ...base, sizeBytes: Number.MAX_SAFE_INTEGER + 1 } },
      { entry: { ...base, sizeBytes: -1 } },
      { entry: { ...base, serverModifiedAt: 1.5 } },
      { entry: { ...base, serverModifiedAt: -1 } },
      { entry: { ...base, isDirectory: "yes" } },
      { entry: { ...base, path: "/Science/e\u0301", filename: "é" } },
      { entry: { ...base, path: "/Science//Books" } },
      { entry: { ...base, path: "/Other/Books" } },
      { entry: { ...base, path: "/Science/Parent/Books" } },
      { entry: { ...base, filename: "Other" } },
      { entry: { ...base, fsId: "01" } },
      { entry: { ...base, fsId: "-1" } },
      { entry: { ...base, sizeBytes: 1 } },
      { entry: base, currentPath: "Science" },
      { entry: base, traversalRoot: "Science" },
      { entry: directory("1", "/"), currentPath: "/", traversalRoot: "/" },
    ];

    for (const value of invalid) {
      expect(() => validateBaiduListEntry({
        entry: value.entry,
        currentPath: value.currentPath ?? "/Science",
        traversalRoot: value.traversalRoot ?? "/Science",
      })).toThrow(invalidResponse);
    }
  });

  it("keeps file validation rules while allowing nonzero file size", () => {
    const entry: BaiduListEntry = {
      ...directory("3", "/Science/book.pdf"),
      sizeBytes: 42,
      isDirectory: false,
    };
    expect(validateBaiduListEntry({
      entry,
      currentPath: "/Science",
      traversalRoot: "/",
    })).toEqual(entry);
  });

  it("contains throwing getters and proxies behind the fixed response error", () => {
    const throwingGetter = Object.defineProperty({}, "path", {
      get: () => { throw new Error("raw-getter-message"); },
    });
    const throwingProxy = new Proxy({}, {
      get: () => { throw new Error("raw-proxy-message"); },
    });

    for (const entry of [throwingGetter, throwingProxy]) {
      expect(() => validateBaiduListEntry({
        entry,
        currentPath: "/",
        traversalRoot: "/",
      })).toThrow(new CatalogError("invalid-baidu-response"));
    }
  });
});
