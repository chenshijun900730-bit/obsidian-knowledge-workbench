import { describe, expect, it } from "vitest";
import {
  decodeBaiduListResponse,
  isbnCandidatesFromFilename,
  normalizeCloudAbsolutePath,
} from "../../../src/catalog/catalog-codec";
import { CatalogError } from "../../../src/catalog/catalog-types";

describe("catalog codec", () => {
  it("keeps uint64 fs_id exact and returns only normalized list fields", () => {
    const raw = "{\"errno\":0,\"request_id\":\"secret-request\",\"list\":[{\"fs_id\":9007199254740993,\"path\":\"/书库/例子.pdf\",\"server_filename\":\"例子.pdf\",\"size\":7,\"server_mtime\":11,\"isdir\":0,\"dlink\":\"forbidden\"}]}";

    expect(decodeBaiduListResponse(raw)).toEqual({
      entries: [{
        fsId: "9007199254740993",
        path: "/书库/例子.pdf",
        filename: "例子.pdf",
        sizeBytes: 7,
        serverModifiedAt: 11,
        isDirectory: false,
      }],
    });
  });

  it("normalizes NFC absolute paths and accepts the cloud root", () => {
    expect(normalizeCloudAbsolutePath("/资料/e\u0301.pdf")).toBe("/资料/é.pdf");
    expect(normalizeCloudAbsolutePath("/")).toBe("/");
  });

  it.each([
    "资料/a.pdf",
    "/资料/../a.pdf",
    "/资料/./a.pdf",
    "/资料//a.pdf",
    "/资料/\u0000.pdf",
    "\\资料\\a.pdf",
  ])("rejects an unsafe cloud path without echoing it: %j", (value) => {
    expect(() => normalizeCloudAbsolutePath(value)).toThrow("invalid-scan-root");
    try {
      normalizeCloudAbsolutePath(value);
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogError);
      expect((error as Error).message).not.toContain(value);
    }
  });

  it("extracts normalized ISBN candidates without claiming verification", () => {
    expect(isbnCandidatesFromFilename("书名 ISBN 978-7-03-012345-6 / 7-03-012345-X.pdf"))
      .toEqual(["703012345X", "9787030123456"]);
    expect(isbnCandidatesFromFilename("no-isbn.pdf")).toEqual([]);
  });

  it.each([
    [-6, "baidu-token-expired", false],
    [31045, "baidu-token-expired", false],
    [-7, "baidu-permission-denied", false],
    [31024, "baidu-permission-denied", false],
    [20013, "baidu-permission-denied", false],
    [-9, "baidu-not-found", false],
    [20012, "baidu-rate-limited", true],
    [31034, "baidu-rate-limited", true],
    [20011, "baidu-access-unavailable", false],
    [20015, "baidu-access-unavailable", false],
    [99999, "baidu-access-unavailable", false],
  ] as const)("maps errno %s to %s", (errno, code, retryable) => {
    try {
      decodeBaiduListResponse(JSON.stringify({ errno, list: [], sentinel: "do-not-retain" }));
      throw new Error("expected decode to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogError);
      expect(error).toMatchObject({ code, retryable, message: code });
      expect((error as Error).message).not.toContain("do-not-retain");
    }
  });

  it.each([
    "not-json sentinel",
    "{\"errno\":0}",
    "{\"errno\":0,\"list\":{}}",
    "{\"errno\":0,\"list\":[{\"fs_id\":-1,\"path\":\"/a.pdf\",\"server_filename\":\"a.pdf\",\"size\":1,\"server_mtime\":1,\"isdir\":0}]}",
    "{\"errno\":0,\"list\":[{\"fs_id\":1,\"path\":\"/a.pdf\",\"server_filename\":\"a.pdf\",\"size\":-1,\"server_mtime\":1,\"isdir\":0}]}",
    "{\"errno\":0,\"list\":[{\"fs_id\":1,\"path\":\"/a.pdf\",\"server_filename\":\"a.pdf\",\"size\":1,\"server_mtime\":1,\"isdir\":2}]}",
  ])("rejects a malformed response with one fixed error: %s", (raw) => {
    expect(() => decodeBaiduListResponse(raw)).toThrow("invalid-baidu-response");
    try {
      decodeBaiduListResponse(raw);
    } catch (error) {
      expect((error as Error).message).toBe("invalid-baidu-response");
    }
  });
});
