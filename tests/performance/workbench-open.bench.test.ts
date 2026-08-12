// @vitest-environment jsdom
import { expect, it } from "vitest";
import type { DocumentRecord } from "../../src/core/types";
import { benchmarkWorkbenchOpen, percentile95 } from "./index-benchmark";

const records = Array.from({ length: 5_000 }, (_, index): DocumentRecord => ({
  id: `record-${index}`,
  path: `Generated/${String(index).padStart(4, "0")}.md`,
  basename: String(index).padStart(4, "0"),
  kind: index % 2 === 0 ? "note" : "reference",
  title: `Generated ${index}`,
  aliases: [],
  headings: [`Generated ${index}`],
  tags: [],
  ownedFields: {},
  relationFields: {},
  outgoingLinks: [],
  tokens: ["generated", String(index)],
  mtime: index + 1,
  size: 128,
  contentHash: `hash-${index}`,
}));

it("opens a preloaded 5000-record workbench within the DOM-render p95 gate", async () => {
  const result = await benchmarkWorkbenchOpen(records, 20);
  const scope = "ItemView construction, subscription, snapshot clone, and jsdom render over an already materialized controller; excludes projection and Obsidian-host launch";
  process.stdout.write(`[knowledge-workbench open performance]\n${JSON.stringify({
    ...result,
    p95Ms: percentile95(result.openTimesMs),
    sampleCount: result.openTimesMs.length,
    scope,
  }, null, 2)}\n`);
  expect(scope).toBe("ItemView construction, subscription, snapshot clone, and jsdom render over an already materialized controller; excludes projection and Obsidian-host launch");
  expect(result.openTimesMs).toHaveLength(20);
  expect(percentile95(result.openTimesMs)).toBeLessThanOrEqual(2_000);
}, 60_000);

it("reports the detached preloaded index count instead of a later-mutated input length", async () => {
  const mutable = [...records];
  const pending = benchmarkWorkbenchOpen(mutable, 1);
  mutable.length = 0;
  await expect(pending).resolves.toMatchObject({ recordCount: 5_000 });
}, 60_000);
