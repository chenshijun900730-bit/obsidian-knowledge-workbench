import { describe, expect, it } from "vitest";
import { rankCloudDirectories } from "../../../src/catalog/cloud-directory-search";

const directories = [
  { path: "/Synthetic/Topics/Modern literature", filename: "Modern literature" },
  { path: "/Synthetic/9-Literature-253", filename: "9-Literature-253" },
  { path: "/Synthetic/Updates/Chinese literature", filename: "Chinese literature" },
];

describe("cloud directory search", () => {
  it("matches partial normalized text and ranks name prefixes before path matches", () => {
    expect(rankCloudDirectories(directories, "literature").map((value) => value.path))
      .toEqual([
        "/Synthetic/9-Literature-253",
        "/Synthetic/Topics/Modern literature",
        "/Synthetic/Updates/Chinese literature",
      ]);
  });

  it("matches Chinese fragments and numeric fragments without pinyin inference", () => {
    const values = [
      { path: "/Synthetic/9-文学253册", filename: "9-文学253册" },
      { path: "/Synthetic/哲学601册", filename: "哲学601册" },
    ];
    expect(rankCloudDirectories(values, "文学").map((value) => value.path))
      .toEqual(["/Synthetic/9-文学253册"]);
    expect(rankCloudDirectories(values, "253").map((value) => value.path))
      .toEqual(["/Synthetic/9-文学253册"]);
    expect(rankCloudDirectories(values, "wenxue")).toEqual([]);
  });

  it("returns detached results with deterministic path tie-breaking", () => {
    const result = rankCloudDirectories(directories, "synthetic");
    expect(result.map((value) => value.path)).toEqual([...result.map((value) => value.path)].sort());
    expect(result).not.toBe(directories);
  });
});
