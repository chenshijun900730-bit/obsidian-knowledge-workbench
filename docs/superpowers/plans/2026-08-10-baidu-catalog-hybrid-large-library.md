# Baidu Hybrid Large Library Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Vault-external searchable candidate catalog from the user's tree TXT, then safely reconcile it with manually resumed, bounded Baidu category scans without downloading PDFs.

**Status:** Completed at Checkpoint C on 2026-08-12; final implementation commit `1e99fc6113a0610991765afbaa1597603d859e42` passed the recorded full, performance, packaging, and synthetic-install gates.

**Architecture:** Keep the existing small-sample scanner unchanged. Add an immutable TXT candidate base, per-category cloud overlays, a difference ledger, schema-v3 resumable verification batches, and an atomically compiled unified NDJSON projection. The normal build may read a session-only local TXT path and use the existing whitelisted Baidu list port; the acceptance build receives only disabled/offline implementations.

**Tech Stack:** TypeScript 5.8, Node.js filesystem and crypto APIs, Vitest 4, Obsidian 1.13 APIs, strict JSON/NDJSON, esbuild.

---

## Scope and safety invariants

- Work only in `/Users/example/Documents/obsidian-knowledge-workbench` on the current `codex/baidu-cloud-catalog-core` branch.
- Never stage or modify the unrelated untracked research Markdown files at the repository root.
- Do not run real OAuth, real Baidu listing, a real full-library import, a PDF download, or a real Vault write while implementing Tasks 1–10.
- Do not run old A/B benchmark, long-pilot, public-v1, stress, or batch-model scripts.
- Keep `SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET`, schema-v2 small-scan behavior, and the existing synthetic acceptance boundary unchanged.
- All fixtures use synthetic names and paths. No user book title, local TXT path, cloud path, credential, authorization code, or recall content may enter tests, Git, logs, receipts, or checkpoint reports.
- Every real network continuation remains a product-level explicit action. Loading a checkpoint at startup must issue zero list calls.
- Stop and report after Tasks 1–4, Tasks 5–7, and Tasks 8–10. Do not start a control-model experiment after a checkpoint.

## File map

| File | Responsibility |
| --- | --- |
| `src/catalog/hybrid-catalog-types.ts` | Hybrid records, budgets, summaries, descriptors, error codes, and v3 batch contracts |
| `src/catalog/hybrid-catalog-codec.ts` | Strict key-whitelisted decoders and canonical encoders for hybrid JSON/NDJSON |
| `src/catalog/catalog-txt-parser.ts` | Streaming UTF-8 tree parser with one-line lookahead and deterministic candidate IDs |
| `src/adapters/local-catalog-txt-source-adapter.ts` | Session-only regular-file byte source; never persists or reports the supplied path |
| `src/catalog/hybrid-catalog-ports.ts` | Byte-source, staging writer, hybrid store, overlay, and batch persistence ports |
| `src/catalog/catalog-txt-import-service.ts` | Preview/import orchestration and failure-atomic staging lifecycle |
| `src/adapters/local-hybrid-catalog-adapter.ts` | `0700`/`0600` immutable candidate, overlay, unified, and v3 batch persistence |
| `src/catalog/unified-catalog-projection-service.ts` | Candidate-plus-overlay deterministic unified projection |
| `src/catalog/unified-catalog-search-service.ts` | Local search and status/group/tag filters for unified records |
| `src/catalog/catalog-reconciliation-service.ts` | Exact path and prior-`fsId` category reconciliation with difference ledger |
| `src/catalog/large-catalog-verification-service.ts` | Serial bounded category listing, permits, cancellation, pause, and explicit resume |
| `src/catalog/hybrid-catalog-runtime.ts` | UI-facing local import and large-verification state machine |
| `src/catalog/cloud-catalog-runtime.ts` | Loads unified projection when present and exposes display-safe catalog items |
| `src/runtime/normal-cloud-catalog-composition.ts` | Normal-only local source/store/service composition |
| `src/ui/settings-tab.ts` | Local TXT and large-library controls with session-only inputs |
| `src/ui/cloud-catalog-tab.ts` | Verification chips, filters, aggregate counts, and safe copy actions |
| `src/ui/workbench-controller.ts` | Delegates explicit hybrid catalog actions |
| `src/runtime/runtime-composition.ts` | Confirmation presenter and runtime interface wiring |
| `src/main.ts` | Normal build modal/source bindings only |
| `src/main-acceptance.ts` | Keeps real source/store/network capabilities absent |

## Checkpoint A — candidate base and unified local search

### Task 1: Define hybrid contracts and strict codecs

**Files:**
- Create: `src/catalog/hybrid-catalog-types.ts`
- Create: `src/catalog/hybrid-catalog-codec.ts`
- Create: `tests/unit/catalog/hybrid-catalog-contracts.test.ts`
- Modify: `tests/integration/catalog-offline-composition.test.ts`

- [x] **Step 1: Write failing contract tests**

Create boundary tests that assert frozen product constants, deep-detached records, exact status/difference unions, strict unknown-key rejection, safe integer validation, decimal `fsId`, 64-character lowercase hashes, and error messages containing only fixed codes.

```ts
import { describe, expect, it } from "vitest";
import {
  CATALOG_TXT_IMPORT_BUDGET,
  LARGE_CATALOG_RUN_BUDGET,
  MAX_UNIFIED_CATALOG_PDF_COUNT,
  HybridCatalogError,
} from "../../../src/catalog/hybrid-catalog-types";
import {
  decodeTxtCandidateRecord,
  decodeUnifiedCatalogRecord,
} from "../../../src/catalog/hybrid-catalog-codec";

describe("hybrid catalog contracts", () => {
  it("freezes the approved limits", () => {
    expect(CATALOG_TXT_IMPORT_BUDGET).toEqual({
      maxBytes: 16_777_216,
      maxNonEmptyLineCount: 71_000,
      maxPdfCount: 70_000,
      maxDepth: 32,
      maxLineBytes: 16_384,
    });
    expect(LARGE_CATALOG_RUN_BUDGET).toEqual({
      maxSelectedTopLevelGroups: 5,
      maxPdfCount: 10_000,
      maxDirectoryCount: 500,
      maxListRequestCount: 300,
      maxDurationMs: 1_800_000,
    });
    expect(MAX_UNIFIED_CATALOG_PDF_COUNT).toBe(70_000);
    expect(Object.isFrozen(CATALOG_TXT_IMPORT_BUDGET)).toBe(true);
  });

  it("rejects unknown or private fields with one fixed error", () => {
    expect(() => decodeTxtCandidateRecord(JSON.stringify({
      schemaVersion: 1,
      source: "txt-candidate",
      candidateId: `txt:${"a".repeat(64)}`,
      relativePath: "Synthetic/A.pdf",
      parentRelativePath: "Synthetic",
      filename: "A.pdf",
      title: "A",
      isbnCandidates: [],
      topLevelGroupId: `group:${"b".repeat(64)}`,
      hierarchyTags: ["folder/Synthetic"],
      sourcePath: "/private/source.txt",
    }))).toThrowError(new HybridCatalogError("hybrid-record-invalid"));
  });

  it("decodes a cloud-added unified record without exposing mutable arrays", () => {
    const decoded = decodeUnifiedCatalogRecord(JSON.stringify({
      schemaVersion: 1,
      catalogId: "baidu:7",
      candidateId: null,
      fsId: "7",
      relativePath: "Synthetic/New.pdf",
      cloudPath: "/Synthetic/New.pdf",
      filename: "New.pdf",
      title: "New",
      isbnCandidates: [],
      sizeBytes: 7,
      serverModifiedAt: 11,
      topLevelGroupId: `group:${"b".repeat(64)}`,
      hierarchyTags: ["folder/Synthetic"],
      verificationStatus: "difference",
      differenceKinds: ["cloud-added"],
      visibleByDefault: true,
    }));
    (decoded.differenceKinds as string[]).push("cloud-missing");
    expect(decodeUnifiedCatalogRecord(JSON.stringify(decoded)).differenceKinds)
      .toEqual(["cloud-added"]);
  });
});
```

Add an offline-composition assertion that importing these modules does not load `node:fs`, SecretStorage, or the Baidu source adapter.

- [x] **Step 2: Run tests and verify the new modules are missing**

Run:

```bash
npx vitest run tests/unit/catalog/hybrid-catalog-contracts.test.ts tests/integration/catalog-offline-composition.test.ts
```

Expected: FAIL because `hybrid-catalog-types.ts` and `hybrid-catalog-codec.ts` do not exist.

- [x] **Step 3: Implement the contracts**

Define separate hybrid errors so adding local import failures cannot broaden schema-v2 receipt error codes.

```ts
export const CATALOG_TXT_IMPORT_BUDGET = Object.freeze({
  maxBytes: 16_777_216,
  maxNonEmptyLineCount: 71_000,
  maxPdfCount: 70_000,
  maxDepth: 32,
  maxLineBytes: 16_384,
} as const);

export const LARGE_CATALOG_RUN_BUDGET = Object.freeze({
  maxSelectedTopLevelGroups: 5,
  maxPdfCount: 10_000,
  maxDirectoryCount: 500,
  maxListRequestCount: 300,
  maxDurationMs: 1_800_000,
} as const);

export const MAX_UNIFIED_CATALOG_PDF_COUNT = 70_000 as const;

export type HybridCatalogErrorCode =
  | "txt-source-unavailable"
  | "txt-source-invalid"
  | "txt-import-budget-exceeded"
  | "txt-tree-invalid"
  | "txt-duplicate-path"
  | "hybrid-record-invalid"
  | "hybrid-snapshot-corrupt"
  | "hybrid-batch-invalid"
  | "hybrid-batch-unavailable";

export class HybridCatalogError extends Error {
  constructor(readonly code: HybridCatalogErrorCode) {
    super(code);
    this.name = "HybridCatalogError";
  }
}

export type CatalogVerificationStatus = "unverified" | "verified" | "difference";
export type CatalogDifferenceKind = "cloud-added" | "cloud-missing" | "renamed" | "moved";

export interface TxtCandidateRecordV1 {
  readonly schemaVersion: 1;
  readonly source: "txt-candidate";
  readonly candidateId: string;
  readonly relativePath: string;
  readonly parentRelativePath: string;
  readonly filename: string;
  readonly title: string;
  readonly isbnCandidates: readonly string[];
  readonly topLevelGroupId: string;
  readonly hierarchyTags: readonly string[];
}

export interface CatalogTxtImportSummary {
  readonly sourceSha256: string;
  readonly byteSize: number;
  readonly nonEmptyLineCount: number;
  readonly pdfCount: number;
  readonly directoryCount: number;
  readonly ignoredLeafCount: number;
  readonly normalizedWhitespaceCount: number;
  readonly maxDepth: number;
}

export interface CandidateCatalogDescriptor extends CatalogTxtImportSummary {
  readonly schemaVersion: 1;
  readonly importId: string;
  readonly importedAt: number;
  readonly candidateSha256: string;
}

export interface UnifiedCatalogRecordV1 {
  readonly schemaVersion: 1;
  readonly catalogId: string;
  readonly candidateId: string | null;
  readonly fsId: string | null;
  readonly relativePath: string;
  readonly cloudPath: string | null;
  readonly filename: string;
  readonly title: string;
  readonly isbnCandidates: readonly string[];
  readonly sizeBytes: number | null;
  readonly serverModifiedAt: number | null;
  readonly topLevelGroupId: string;
  readonly hierarchyTags: readonly string[];
  readonly verificationStatus: CatalogVerificationStatus;
  readonly differenceKinds: readonly CatalogDifferenceKind[];
  readonly visibleByDefault: boolean;
}

export interface CatalogDifferenceRecordV1 {
  readonly schemaVersion: 1;
  readonly catalogId: string;
  readonly topLevelGroupId: string;
  readonly kind: CatalogDifferenceKind;
  readonly acknowledgedAt: number | null;
}

export interface UnifiedCatalogDescriptor {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly sourceImportSha256: string;
  readonly completedAt: number;
  readonly recordCount: number;
  readonly differenceCount: number;
  readonly catalogSha256: string;
  readonly differencesSha256: string;
}
```

In `hybrid-catalog-codec.ts`, use exact `Object.keys(...).sort()` comparisons for every persisted shape. Normalize strings with NFC, validate relative paths without `/`-root, `..`, backslash, NUL, or empty segments, and return cloned arrays. Canonical encoders must emit keys in declaration order and append exactly one LF for NDJSON records.

- [x] **Step 4: Run focused tests and TypeScript**

Run:

```bash
npx vitest run tests/unit/catalog/hybrid-catalog-contracts.test.ts tests/integration/catalog-offline-composition.test.ts
npx tsc -noEmit -skipLibCheck
```

Expected: all focused tests pass and TypeScript exits 0.

- [x] **Step 5: Commit Task 1**

```bash
git add src/catalog/hybrid-catalog-types.ts src/catalog/hybrid-catalog-codec.ts tests/unit/catalog/hybrid-catalog-contracts.test.ts tests/integration/catalog-offline-composition.test.ts
git commit -m "feat(目录): 定义混合目录安全合约"
```

### Task 2: Parse the tree TXT as a bounded byte stream

**Files:**
- Create: `src/catalog/catalog-txt-parser.ts`
- Create: `src/adapters/local-catalog-txt-source-adapter.ts`
- Create: `tests/unit/catalog/catalog-txt-parser.test.ts`
- Create: `tests/unit/catalog/local-catalog-txt-source-adapter.test.ts`

- [x] **Step 1: Write failing parser and source tests**

Use only synthetic trees. Cover split multibyte UTF-8 chunks, CRLF, `├──` and `└──`, one-line directory lookahead, root-level PDFs, non-PDF leaves, NFC, whitespace normalization, duplicate normalized paths, a PDF acting as a parent, depth jumps, invalid UTF-8, NUL, `/`, backslash, line/byte/line-count/depth/PDF budgets, a regular file, directory, symlink, mutation during read, and sanitized errors.

```ts
const source = (text: string, cuts: readonly number[] = []): CatalogTxtByteSource => ({
  byteSize: new TextEncoder().encode(text).byteLength,
  chunks: async function* () {
    const bytes = new TextEncoder().encode(text);
    let offset = 0;
    for (const cut of [...cuts, bytes.length]) {
      yield bytes.slice(offset, cut);
      offset = cut;
    }
  },
});

it("infers directories and emits deterministic candidates", async () => {
  const records: TxtCandidateRecordV1[] = [];
  const summary = await new CatalogTxtParser().parse({
    source: source([
      "├── Synthetic",
      "│   ├── A.pdf",
      "│   ├── Nested",
      "│   │   └── B.PDF",
      "│   └── ignored.txt",
      "└── Root.pdf",
    ].join("\n"), [5, 13, 27]),
    onCandidate: async (record) => { records.push(record); },
  });

  expect(summary).toMatchObject({
    nonEmptyLineCount: 6,
    pdfCount: 3,
    directoryCount: 2,
    ignoredLeafCount: 1,
    maxDepth: 3,
  });
  expect(records.map((record) => record.relativePath)).toEqual([
    "Synthetic/A.pdf",
    "Synthetic/Nested/B.PDF",
    "Root.pdf",
  ]);
  expect(records[2]?.topLevelGroupId).toBe("txt-root-items");
});
```

- [x] **Step 2: Run focused tests and verify failure**

Run:

```bash
npx vitest run tests/unit/catalog/catalog-txt-parser.test.ts tests/unit/catalog/local-catalog-txt-source-adapter.test.ts
```

Expected: FAIL because the parser and source adapter do not exist.

- [x] **Step 3: Implement streaming parsing and the session-only byte source**

Expose this core interface:

```ts
export interface CatalogTxtByteSource {
  readonly byteSize: number;
  chunks(): AsyncIterable<Uint8Array>;
}

export interface CatalogTxtParseInput {
  readonly source: CatalogTxtByteSource;
  readonly onCandidate: (record: TxtCandidateRecordV1) => Promise<void>;
}
```

Use `TextDecoder("utf-8", { fatal: true })` in streaming mode and a SHA-256 updated with every original byte chunk. Retain only the partial current line, one parsed previous entry, the directory stack, and a `Set` of candidate IDs. Before processing each previous entry, compare it with the next depth:

```ts
const previousIsDirectory = !previous.isPdf && nextDepth > previous.depth;
if (nextDepth > previous.depth + 1 || (previous.isPdf && nextDepth > previous.depth)) {
  throw new HybridCatalogError("txt-tree-invalid");
}
if (previousIsDirectory) {
  stack[previous.depth - 1] = previous.name;
  stack.length = previous.depth;
  directoryCount += 1;
} else if (previous.isPdf) {
  const parents = stack.slice(0, previous.depth - 1);
  if (parents.length !== previous.depth - 1) {
    throw new HybridCatalogError("txt-tree-invalid");
  }
  await input.onCandidate(candidateFrom([...parents, previous.name]));
} else {
  ignoredLeafCount += 1;
}
```

`LocalCatalogTxtSourceAdapter.open(path)` must use `lstat`, reject symlinks and non-regular files, open read-only with `O_NOFOLLOW`, capture device/inode/size/mtime before streaming, and recheck them after EOF. Convert every filesystem failure to `txt-source-unavailable` without including the path or native message.

- [x] **Step 4: Run focused tests, lint the new files, and typecheck**

Run:

```bash
npx vitest run tests/unit/catalog/catalog-txt-parser.test.ts tests/unit/catalog/local-catalog-txt-source-adapter.test.ts tests/unit/catalog/hybrid-catalog-contracts.test.ts
npx eslint src/catalog/catalog-txt-parser.ts src/adapters/local-catalog-txt-source-adapter.ts tests/unit/catalog/catalog-txt-parser.test.ts tests/unit/catalog/local-catalog-txt-source-adapter.test.ts
npx tsc -noEmit -skipLibCheck
```

Expected: tests pass, no new lint errors, TypeScript exits 0.

- [x] **Step 5: Commit Task 2**

```bash
git add src/catalog/catalog-txt-parser.ts src/adapters/local-catalog-txt-source-adapter.ts tests/unit/catalog/catalog-txt-parser.test.ts tests/unit/catalog/local-catalog-txt-source-adapter.test.ts
git commit -m "feat(目录): 解析树形目录 TXT"
```

### Task 3: Persist and atomically activate the candidate base

**Files:**
- Create: `src/catalog/hybrid-catalog-ports.ts`
- Create: `src/catalog/catalog-txt-import-service.ts`
- Create: `src/adapters/local-hybrid-catalog-adapter.ts`
- Create: `tests/unit/catalog/catalog-txt-import-service.test.ts`
- Create: `tests/unit/catalog/local-hybrid-catalog-adapter.test.ts`

- [x] **Step 1: Write failing import and persistence tests**

Test preview side-effect freedom, explicit import staging, abort cleanup, candidate hash/count validation, repeated finalization idempotence, prior-active preservation on rename failure, source path omission, `0700`/`0600`, symlink rejection, traversal-safe IDs, corrupt NDJSON, unknown receipt fields, and source-hash mismatch.

```ts
it("previews without writes and commits only one complete candidate base", async () => {
  const store = new InMemoryHybridCatalogStore();
  const service = new CatalogTxtImportService(new CatalogTxtParser(), store, {
    createImportId: () => "import-1",
    now: () => 100,
  });
  const input = source("├── Synthetic\n│   └── A.pdf\n");

  await expect(service.preview(input)).resolves.toMatchObject({ pdfCount: 1 });
  expect(store.imports).toHaveLength(0);

  const descriptor = await service.import(input);
  expect(descriptor).toMatchObject({ importId: "import-1", importedAt: 100, pdfCount: 1 });
  expect((await store.loadActiveCandidates())?.records).toHaveLength(1);
});
```

Inject atomic rename failures before candidate, receipt, descriptor, and active-manifest replacement. After each failure, `loadActiveCandidates()` must expose either the previous complete import or the new complete import, never a mixture.

- [x] **Step 2: Run focused tests and verify failure**

Run:

```bash
npx vitest run tests/unit/catalog/catalog-txt-import-service.test.ts tests/unit/catalog/local-hybrid-catalog-adapter.test.ts
```

Expected: FAIL because the port, service, and adapter do not exist.

- [x] **Step 3: Implement staging ports, service, and private storage**

Define a narrow writer lifecycle:

```ts
export interface CandidateImportWriter {
  append(record: TxtCandidateRecordV1): Promise<void>;
  commit(input: Readonly<{
    summary: CatalogTxtImportSummary;
    importedAt: number;
  }>): Promise<CandidateCatalogDescriptor>;
  abort(): Promise<void>;
}

export interface HybridCatalogStorePort {
  createCandidateImport(importId: string): Promise<CandidateImportWriter>;
  loadActiveCandidates(): Promise<Readonly<{
    descriptor: CandidateCatalogDescriptor;
    records: readonly TxtCandidateRecordV1[];
  }> | null>;
}
```

`CatalogTxtImportService.preview()` parses with a no-op sink. `import()` creates a writer, streams every candidate to it, commits only after the parser summary succeeds, and calls `abort()` in `catch` before rethrowing the fixed hybrid error.

Use the design storage layout under `<catalog-root>/hybrid`. Create directories at `0700`, files with exclusive temporary creation and `0600`, `fsync` before atomic rename, and a strict active manifest containing only the import ID, descriptor hash, record count, and schema version. Validate containment with `resolve` plus separator-boundary checks; reject symlinks in every parent component.

- [x] **Step 4: Run focused and regression tests**

Run:

```bash
npx vitest run tests/unit/catalog/catalog-txt-import-service.test.ts tests/unit/catalog/local-hybrid-catalog-adapter.test.ts tests/unit/catalog/local-catalog-snapshot-adapter.test.ts
npx tsc -noEmit -skipLibCheck
```

Expected: all focused and existing snapshot-adapter tests pass; TypeScript exits 0.

- [x] **Step 5: Commit Task 3**

```bash
git add src/catalog/hybrid-catalog-ports.ts src/catalog/catalog-txt-import-service.ts src/adapters/local-hybrid-catalog-adapter.ts tests/unit/catalog/catalog-txt-import-service.test.ts tests/unit/catalog/local-hybrid-catalog-adapter.test.ts
git commit -m "feat(目录): 持久化候选目录底座"
```

### Task 4: Build the unified projection and local search

**Files:**
- Create: `src/catalog/unified-catalog-projection-service.ts`
- Create: `src/catalog/unified-catalog-search-service.ts`
- Create: `tests/unit/catalog/unified-catalog-projection-service.test.ts`
- Create: `tests/unit/catalog/unified-catalog-search-service.test.ts`
- Create: `tests/performance/hybrid-catalog-search.bench.test.ts`
- Modify: `src/catalog/hybrid-catalog-ports.ts`
- Modify: `src/adapters/local-hybrid-catalog-adapter.ts`

- [x] **Step 1: Write failing projection and search tests**

Assert deterministic candidate-to-unverified projection, stable sort by relative path then catalog ID, default hiding of cloud-missing, combined status/group/tag/text filters, title/path/ISBN search, root items, detached output, pagination bounds, overlay source-hash rejection, global `fsId` supersession, and the 70,000/70,001 atomic boundary.

```ts
it("projects candidate records as searchable unverified items", async () => {
  const result = await new UnifiedCatalogProjectionService(store).rebuild();
  expect(result.records).toEqual([expect.objectContaining({
    catalogId: `txt:${"a".repeat(64)}`,
    fsId: null,
    cloudPath: null,
    verificationStatus: "unverified",
    differenceKinds: [],
    visibleByDefault: true,
  })]);

  const search = new UnifiedCatalogSearchService(result.records);
  expect(search.query({
    text: "synthetic",
    statuses: ["unverified"],
    offset: 0,
    limit: 50,
  }).total).toBe(1);
});
```

The opt-in performance test builds 70,000 deterministic synthetic records, measures constructor plus 50 fixed queries, and asserts build under 10 seconds and query p95 under 250 ms.

- [x] **Step 2: Run focused tests and verify failure**

Run:

```bash
npx vitest run tests/unit/catalog/unified-catalog-projection-service.test.ts tests/unit/catalog/unified-catalog-search-service.test.ts
```

Expected: FAIL because the projection and search services do not exist.

- [x] **Step 3: Implement projection storage and indexed search**

Extend the store port with immutable unified snapshot methods:

```ts
writeUnifiedSnapshot(input: Readonly<{
  sourceImportSha256: string;
  records: readonly UnifiedCatalogRecordV1[];
  differences: readonly CatalogDifferenceRecordV1[];
  completedAt: number;
}>): Promise<UnifiedCatalogDescriptor>;

loadActiveUnified(): Promise<Readonly<{
  descriptor: UnifiedCatalogDescriptor;
  records: readonly UnifiedCatalogRecordV1[];
  differences: readonly CatalogDifferenceRecordV1[];
}> | null>;
```

On initial rebuild, map every candidate to an unverified record with `catalogId = candidateId`, null cloud facts, copied hierarchy tags, and `visibleByDefault = true`. Refuse more than `MAX_UNIFIED_CATALOG_PDF_COUNT`, encode to a temporary NDJSON, re-decode and count it, then atomically replace the unified active manifest.

Implement bigram postings by adapting the existing `CatalogSearchService` algorithm without changing that class. Index filename, title, relative path, optional cloud path, hierarchy tags, and ISBN candidates. Intersect optional status/group/tag postings before substring verification. Query limits remain 1–50 and results are cloned.

- [x] **Step 4: Run focused tests, performance, and the first batch regression gate**

Run:

```bash
npx vitest run tests/unit/catalog/hybrid-catalog-contracts.test.ts tests/unit/catalog/catalog-txt-parser.test.ts tests/unit/catalog/local-catalog-txt-source-adapter.test.ts tests/unit/catalog/catalog-txt-import-service.test.ts tests/unit/catalog/local-hybrid-catalog-adapter.test.ts tests/unit/catalog/unified-catalog-projection-service.test.ts tests/unit/catalog/unified-catalog-search-service.test.ts
KNOWLEDGE_WORKBENCH_PERFORMANCE=1 npx vitest run tests/performance/hybrid-catalog-search.bench.test.ts --no-file-parallelism --maxWorkers=1 --testTimeout=180000 --reporter=verbose
npm run build
```

Expected: all focused tests and performance thresholds pass; normal build exits 0. No real source path or network is accessed.

- [x] **Step 5: Commit Task 4**

```bash
git add src/catalog/unified-catalog-projection-service.ts src/catalog/unified-catalog-search-service.ts src/catalog/hybrid-catalog-ports.ts src/adapters/local-hybrid-catalog-adapter.ts tests/unit/catalog/unified-catalog-projection-service.test.ts tests/unit/catalog/unified-catalog-search-service.test.ts tests/performance/hybrid-catalog-search.bench.test.ts
git commit -m "feat(目录): 建立统一目录搜索投影"
```

- [x] **Step 6: Stop at Checkpoint A**

Report the current Git commit; Tasks 1–4 behavior; exact focused, performance, build, and regression results; wrong directions and rework count since the design checkpoint; available input-token telemetry; PMH recall count and token quantity without contents; and whether any cross-project, cross-source, or cross-model contamination was found. Confirm zero real Baidu requests, zero PDF downloads, zero real Vault writes, and no staged unrelated files. Do not start Task 5 or a control-model experiment in the same checkpoint turn.

## Checkpoint B — reconciliation and resumable category verification

### Task 5: Reconcile complete category snapshots and acknowledge differences locally

**Files:**
- Create: `src/catalog/catalog-reconciliation-service.ts`
- Create: `tests/unit/catalog/catalog-reconciliation-service.test.ts`
- Modify: `src/catalog/hybrid-catalog-types.ts`
- Modify: `src/catalog/hybrid-catalog-codec.ts`
- Modify: `src/catalog/hybrid-catalog-ports.ts`
- Modify: `src/adapters/local-hybrid-catalog-adapter.ts`
- Modify: `src/catalog/unified-catalog-projection-service.ts`

- [x] **Step 1: Write failing reconciliation tests**

Use synthetic candidates, all active overlays, and cloud files. Lock these cases: first exact relative-path match, existing `fsId` rename, existing `fsId` move within the group, existing `fsId` move across top-level groups, cloud-added, cloud-missing, same title but different path not merged, cross-group escape rejected, duplicate cloud `fsId` rejected, incomplete input cannot reconcile, and local acknowledgement invokes neither cloud nor Vault ports.

```ts
it("uses prior fsId before path and preserves four explicit differences", () => {
  const result = service.reconcile({
    sourceImportSha256: "a".repeat(64),
    topLevelGroupId: `group:${"b".repeat(64)}`,
    cloudRoot: "/Library/Synthetic",
    candidates,
    activeOverlays,
    cloudRecords,
    completedAt: 100,
  });

  expect(result.records.map((record) => [record.fsId, record.differenceKinds]))
    .toEqual([
      ["1", ["renamed"]],
      ["2", ["moved"]],
      ["3", ["cloud-added"]],
      [null, ["cloud-missing"]],
    ]);
});
```

- [x] **Step 2: Run the test and verify failure**

Run:

```bash
npx vitest run tests/unit/catalog/catalog-reconciliation-service.test.ts
```

Expected: FAIL because the reconciliation service and overlay contracts do not exist.

- [x] **Step 3: Implement deterministic reconciliation and overlay persistence**

Add `CatalogOverlayDescriptor`, a global active-`fsId` identity index, overlay supersession links, and immutable acknowledgement records to the existing difference contracts. Match in this order: unique `fsId` from every active overlay, then unique exact normalized relative path. Never use title, size, timestamp, or ISBN similarity.

```ts
for (const cloud of cloudRecords) {
  const prior = globalPriorByFsId.get(cloud.fsId);
  if (prior !== undefined) bindExisting(prior, cloud);
}
for (const cloud of unmatchedCloud) {
  const candidate = candidateByRelativePath.get(relativeFromRoot(cloud.path));
  if (candidate !== undefined) bindFirstVerification(candidate, cloud);
  else addCloudAdded(cloud);
}
for (const candidate of unmatchedCandidates) addCloudMissing(candidate);
```

Persist the overlay and differences under a staging overlay ID. Re-decode, hash, and count both files before updating the group overlay manifest. When an `fsId` came from another group, store its prior catalog identity as superseded; the unified projector must suppress that old location without rewriting its immutable overlay. Acknowledgement writes a new immutable overlay version: added/rename/move becomes verified; missing is removed from active records and retained only as an aggregate archived difference fact. Rebuild the unified projection only after overlay activation succeeds.

- [x] **Step 4: Run focused and projection regression tests**

Run:

```bash
npx vitest run tests/unit/catalog/catalog-reconciliation-service.test.ts tests/unit/catalog/unified-catalog-projection-service.test.ts tests/unit/catalog/unified-catalog-search-service.test.ts tests/unit/catalog/local-hybrid-catalog-adapter.test.ts
npx tsc -noEmit -skipLibCheck
```

Expected: all tests pass and TypeScript exits 0.

- [x] **Step 5: Commit Task 5**

```bash
git add src/catalog/catalog-reconciliation-service.ts src/catalog/hybrid-catalog-types.ts src/catalog/hybrid-catalog-codec.ts src/catalog/hybrid-catalog-ports.ts src/adapters/local-hybrid-catalog-adapter.ts src/catalog/unified-catalog-projection-service.ts tests/unit/catalog/catalog-reconciliation-service.test.ts
git commit -m "feat(目录): 核验分类目录差异"
```

### Task 6: Persist strict schema-v3 verification batches

**Files:**
- Create: `tests/unit/catalog/large-catalog-batch-contracts.test.ts`
- Modify: `src/catalog/hybrid-catalog-types.ts`
- Modify: `src/catalog/hybrid-catalog-codec.ts`
- Modify: `src/catalog/hybrid-catalog-ports.ts`
- Modify: `src/adapters/local-hybrid-catalog-adapter.ts`
- Modify: `tests/unit/catalog/local-hybrid-catalog-adapter.test.ts`

- [x] **Step 1: Write failing v3 checkpoint tests**

Cover new batch creation, at most five groups, immutable source hash and budget, monotonic request permits, monotonic committed pages/counters, per-group status, exact page idempotence, conflicting replay rejection, terminal receipt idempotence, crash after permit without receipt, paused reload, v1/v2 rejection, strict aggregate receipt keys, and absence of paths/names/IDs from receipts.

```ts
const checkpoint: LargeCatalogBatchCheckpointV3 = {
  schemaVersion: 3,
  batchId: "batch-1",
  sourceImportSha256: "a".repeat(64),
  cloudRootSha256: "c".repeat(64),
  startedAt: 10,
  runOrdinal: 1,
  budget: LARGE_CATALOG_RUN_BUDGET,
  selectedGroupCount: 1,
  currentGroupIndex: 0,
  groups: [{
    groupKey: "g0",
    rootRelativePath: "Synthetic",
    mode: "recursive",
    status: "scanning",
    pending: [{ relativePath: "", start: 0 }],
    committedPageKeys: [],
    completedDirectoryCount: 0,
  }],
  pdfCount: 0,
  directoryCount: 0,
  ignoredFileCount: 0,
  listRequestCount: 0,
  cumulativeListRequestCount: 0,
  status: "scanning",
  stopReason: null,
  errorCodeCounts: {},
};
```

- [x] **Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run tests/unit/catalog/large-catalog-batch-contracts.test.ts tests/unit/catalog/local-hybrid-catalog-adapter.test.ts
```

Expected: FAIL because v3 contracts and store methods are absent.

- [x] **Step 3: Implement v3 batch persistence**

Extend `HybridCatalogStorePort` with `createBatch`, `loadBatch`, `saveBatchPermit`, `commitBatchPage`, `finalizeBatchRun`, and `loadBatchReceipt`. `saveBatchPermit` may only increment both current-run and cumulative request counts by one. `commitBatchPage` atomically writes one NDJSON page plus the exact next checkpoint. `finalizeBatchRun` saves terminal state before writing a strict aggregate receipt.

```ts
export type LargeCatalogErrorCode =
  | "baidu-permission-denied"
  | "baidu-not-found"
  | "baidu-rate-limited"
  | "baidu-token-expired"
  | "baidu-access-unavailable"
  | "invalid-baidu-response"
  | "hybrid-snapshot-corrupt"
  | "hybrid-batch-invalid"
  | "hybrid-batch-unavailable";

export interface LargeCatalogRunReceiptV3 {
  readonly schemaVersion: 3;
  readonly status: "complete" | "paused" | "partial";
  readonly stopReason: LargeCatalogStopReason;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly budget: typeof LARGE_CATALOG_RUN_BUDGET;
  readonly selectedGroupCount: number;
  readonly completedGroupCount: number;
  readonly listRequestCount: number;
  readonly cumulativeListRequestCount: number;
  readonly directoryCount: number;
  readonly pdfCount: number;
  readonly ignoredFileCount: number;
  readonly downloadedPdfBytes: 0;
  readonly errorCodeCounts: Readonly<Partial<Record<LargeCatalogErrorCode, number>>>;
}
```

The receipt must not contain `batchId`, source hash, group key, root, relative path, pending queue, page key, filename, account, token, URL, or response body. A nonterminal checkpoint is never converted to a receipt during load.

- [x] **Step 4: Run contract, adapter, and legacy regression tests**

Run:

```bash
npx vitest run tests/unit/catalog/large-catalog-batch-contracts.test.ts tests/unit/catalog/local-hybrid-catalog-adapter.test.ts tests/unit/catalog/local-catalog-snapshot-adapter.test.ts tests/unit/catalog/catalog-scan-contracts.test.ts
npx tsc -noEmit -skipLibCheck
```

Expected: all tests pass; legacy small-scan tests remain unchanged.

- [x] **Step 5: Commit Task 6**

```bash
git add src/catalog/hybrid-catalog-types.ts src/catalog/hybrid-catalog-codec.ts src/catalog/hybrid-catalog-ports.ts src/adapters/local-hybrid-catalog-adapter.ts tests/unit/catalog/large-catalog-batch-contracts.test.ts tests/unit/catalog/local-hybrid-catalog-adapter.test.ts
git commit -m "feat(目录): 持久化大书库核验批次"
```

### Task 7: Execute bounded serial category scans with explicit resume

**Files:**
- Create: `src/catalog/large-catalog-verification-service.ts`
- Create: `tests/unit/catalog/large-catalog-verification-service.test.ts`
- Create: `tests/integration/catalog-large-verification.test.ts`
- Modify: `src/catalog/hybrid-catalog-ports.ts`

- [x] **Step 1: Write failing scanner tests**

Lock serial order, no call before `runSegment`, up to five groups, 10,000 PDF/500 directory/300 request/30 minute budgets, permit-before-request, page atomicity, root-items direct-only behavior, pagination, directory queue, cancellation, rate limit pause, fixed errors, one token refresh replay counted twice by the existing source, category completion reconciliation, incomplete category non-promotion, and explicit resume without replaying committed pages.

```ts
it("loads paused state without networking and resumes only after an explicit segment call", async () => {
  const source = new CapturingCatalogSource();
  const service = new LargeCatalogVerificationService({ source, store, reconcile, project, now });

  const summary = await service.loadPaused("batch-1");
  expect(summary).toMatchObject({ status: "paused", remainingGroupCount: 1 });
  expect(source.requests).toHaveLength(0);

  await service.runSegment({ batchId: "batch-1", cloudRoot: "/Synthetic", signal });
  expect(source.requests).toEqual([{ path: "/Synthetic/Group", start: 1000 }]);
});

it("lists root items once and never enqueues returned directories", async () => {
  await service.start({
    batchId: "batch-root",
    sourceImportSha256: "a".repeat(64),
    cloudRoot: "/Synthetic",
    groups: [{ groupKey: "txt-root-items", mode: "direct-files-only" }],
  });
  expect(source.requests.map((request) => request.path)).toEqual(["/Synthetic"]);
});
```

- [x] **Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run tests/unit/catalog/large-catalog-verification-service.test.ts tests/integration/catalog-large-verification.test.ts
```

Expected: FAIL because the verification service does not exist.

- [x] **Step 3: Implement the scanner state machine**

Use one `AbortController` and one active run. Validate and normalize the session root, but never place it in a receipt. The source adapter may replay once after token refresh, so the v3 permit must remain inside the `beforeRequest` callback that runs immediately before every actual transport:

```ts
const page = await source.listDirectory({
  path: absoluteFromSessionRoot(cloudRoot, current.relativePath),
  start: current.start,
  limit: 1000,
  beforeRequest: async () => {
    const pause = preRequestPauseReason(checkpoint, now(), signal);
    if (pause !== null) throw new LargeCatalogPause(pause);
    checkpoint = incrementPermit(checkpoint);
    await store.saveBatchPermit(checkpoint);
  },
});
```

The service owns the v3 permit and the source owns exact transport placement; this preserves request counting for both the initial list and a refreshed replay. Convert the complete page in memory, recheck cancellation/time, and discard the whole page if committing it would exceed a quantity budget. For `direct-files-only`, count returned directories but never enqueue them. For recursive groups, enqueue only strict direct child directories.

After a group queue becomes empty, finalize its staged cloud records, reconcile, activate the overlay, and rebuild unified projection before moving to the next group. Any failure leaves that group on its prior complete overlay. Resume requires `runSegment` and a session root whose normalized value hashes to the stored root hash.

- [x] **Step 4: Run focused, integration, source, and small-scan regressions**

Run:

```bash
npx vitest run tests/unit/catalog/large-catalog-verification-service.test.ts tests/integration/catalog-large-verification.test.ts tests/unit/catalog/baidu-catalog-source-adapter.test.ts tests/integration/catalog-scan.test.ts tests/integration/catalog-small-folder-preflight.test.ts
npm run build
```

Expected: all tests pass and the normal build exits 0. Captured PDF download calls remain zero.

- [x] **Step 5: Commit Task 7**

```bash
git add src/catalog/large-catalog-verification-service.ts src/catalog/hybrid-catalog-ports.ts tests/unit/catalog/large-catalog-verification-service.test.ts tests/integration/catalog-large-verification.test.ts
git commit -m "feat(目录): 支持分段分类核验"
```

- [x] **Step 6: Stop at Checkpoint B**

Report the current Git commit; Tasks 5–7 behavior; exact test/build results; wrong directions and rework; available input-token telemetry; PMH recall count/token amount without contents; contamination finding; and zero real network/download/Vault writes. Do not begin Task 8 or a control-model run in the same checkpoint turn.

## Checkpoint C — product surfaces, isolation, and completion

### Task 8: Expose local import and verification through the runtime and settings

**Files:**
- Create: `src/catalog/hybrid-catalog-runtime.ts`
- Create: `src/ui/catalog-txt-import-confirmation-modal.ts`
- Create: `src/ui/catalog-large-scan-confirmation-modal.ts`
- Create: `tests/unit/catalog/hybrid-catalog-runtime.test.ts`
- Create: `tests/ui/catalog-txt-import-confirmation-modal.test.ts`
- Create: `tests/ui/catalog-large-scan-confirmation-modal.test.ts`
- Modify: `src/catalog/cloud-catalog-runtime.ts`
- Modify: `src/catalog/offline-cloud-catalog-runtime.ts`
- Modify: `src/catalog/disabled-cloud-catalog-runtime.ts`
- Modify: `src/ui/settings-tab.ts`
- Modify: `src/ui/workbench-controller.ts`
- Modify: `src/runtime/runtime-composition.ts`

- [x] **Step 1: Write failing runtime, modal, and settings tests**

Test preview versus import confirmation, immediate clearing of the local path control, candidate aggregate display, category selection cap, fixed budget text, immediate clearing of cloud root after confirmation, disabled states, cancel, paused summary, explicit resume, no startup network, disposed inertness, safe errors, and read-only acceptance hiding every local/import/network action.

```ts
it("previews locally, clears the path after confirmation, and never starts a list request", async () => {
  const view = renderSettings({ hybridRuntime, importConfirmation: async () => true });
  const input = view.querySelector<HTMLInputElement>("[data-catalog-txt-path]")!;
  input.value = "/synthetic/inventory.txt";
  view.querySelector<HTMLButtonElement>("[data-action=catalog-preview-txt]")!.click();
  await flushPromises();
  expect(hybridRuntime.previewCalls).toHaveLength(1);
  expect(hybridRuntime.listCalls).toBe(0);

  view.querySelector<HTMLButtonElement>("[data-action=catalog-import-txt]")!.click();
  await flushPromises();
  expect(input.value).toBe("");
});
```

- [x] **Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run tests/unit/catalog/hybrid-catalog-runtime.test.ts tests/ui/catalog-txt-import-confirmation-modal.test.ts tests/ui/catalog-large-scan-confirmation-modal.test.ts tests/ui/settings-tab.test.ts
```

Expected: FAIL because hybrid runtime actions and modals are absent.

- [x] **Step 3: Implement the UI-facing state machine and controllers**

Expose immutable aggregate-only state:

```ts
export interface HybridCatalogViewModel {
  readonly status: "empty" | "previewed" | "importing" | "ready" | "scanning" | "paused" | "partial" | "error" | "unavailable";
  readonly candidate?: CatalogTxtImportSummary;
  readonly active?: Readonly<{
    importedAt: number;
    pdfCount: number;
    unverifiedCount: number;
    verifiedCount: number;
    differenceCount: number;
    cloudMissingCount: number;
    groupCount: number;
    verifiedGroupCount: number;
  }>;
  readonly batch?: LargeCatalogBatchSummary;
  readonly messageCode?: HybridCatalogErrorCode;
}
```

`previewTxt(path)` opens a session-only source and parses without writes. `importTxt(path)` must require the preview source hash to match a fresh parse, import, rebuild unified projection, clear preview state, and notify subscribers. `startLargeVerification` and `resumeLargeVerification` require a caller-supplied session root every time. `initialize()` only loads local descriptors and paused aggregates.

Add controller methods and settings controls only when the normal runtime exposes the hybrid capability. Confirmation modals display aggregate counts and fixed budgets, never source paths after confirmation and never filenames. In acceptance mode, show one locked explanation and render no path fields or action buttons.

- [x] **Step 4: Run runtime/UI regressions and typecheck**

Run:

```bash
npx vitest run tests/unit/catalog/hybrid-catalog-runtime.test.ts tests/ui/catalog-txt-import-confirmation-modal.test.ts tests/ui/catalog-large-scan-confirmation-modal.test.ts tests/ui/settings-tab.test.ts tests/unit/catalog/cloud-catalog-runtime.test.ts tests/unit/catalog/cloud-catalog-connection-runtime.test.ts
npx tsc -noEmit -skipLibCheck
```

Expected: all tests pass; TypeScript exits 0.

- [x] **Step 5: Commit Task 8**

```bash
git add src/catalog/hybrid-catalog-runtime.ts src/ui/catalog-txt-import-confirmation-modal.ts src/ui/catalog-large-scan-confirmation-modal.ts src/catalog/cloud-catalog-runtime.ts src/catalog/offline-cloud-catalog-runtime.ts src/catalog/disabled-cloud-catalog-runtime.ts src/ui/settings-tab.ts src/ui/workbench-controller.ts src/runtime/runtime-composition.ts tests/unit/catalog/hybrid-catalog-runtime.test.ts tests/ui/catalog-txt-import-confirmation-modal.test.ts tests/ui/catalog-large-scan-confirmation-modal.test.ts tests/ui/settings-tab.test.ts
git commit -m "feat(设置): 接入混合目录管理"
```

### Task 9: Render unified catalog state and safe actions

**Files:**
- Modify: `src/catalog/cloud-catalog-runtime.ts`
- Modify: `src/ui/cloud-catalog-tab.ts`
- Modify: `src/ui/workbench-controller.ts`
- Modify: `src/ui/workbench-view.ts`
- Modify: `styles.css`
- Modify: `tests/unit/catalog/cloud-catalog-runtime.test.ts`
- Modify: `tests/ui/cloud-catalog-tab.test.ts`
- Modify: `tests/ui/workbench-view.test.ts`
- Create: `tests/ui/workbench-controller.test.ts`

- [x] **Step 1: Write failing unified-view tests**

Assert aggregate chips, status/group/tag filters, default hidden cloud-missing, unverified records with disabled cloud-path copy, verified/difference records with safe copy, difference-kind labels, no content-tag claim, pagination, keyboard labels, focus preservation, and fallback to the existing small-scan snapshot when no hybrid projection exists.

```ts
expect(root.textContent).toContain("Unverified 2");
expect(root.textContent).toContain("Verified 1");
expect(root.textContent).toContain("Differences 1");
expect(root.textContent).toContain("Directory tags only; PDF content is not indexed.");
expect(root.querySelector('[data-catalog-result="txt:synthetic"] [data-action="copy-cloud-path"]'))
  .toBeDisabled();
```

- [x] **Step 2: Run UI tests and verify failure**

Run:

```bash
npx vitest run tests/unit/catalog/cloud-catalog-runtime.test.ts tests/ui/cloud-catalog-tab.test.ts tests/ui/workbench-view.test.ts
```

Expected: FAIL because existing view models expose only cloud records and folder filtering.

- [x] **Step 3: Implement display-safe unified view models**

Make `CloudCatalogRuntimeService.initialize()` prefer `loadActiveUnified()` when present and otherwise preserve the current `CatalogSnapshotPort` behavior. Expose `CatalogDisplayItem` rather than persisted records:

```ts
export interface CatalogDisplayItem {
  readonly catalogId: string;
  readonly filename: string;
  readonly pathLabel: string;
  readonly cloudPathAvailable: boolean;
  readonly verificationStatus: CatalogVerificationStatus;
  readonly differenceKinds: readonly CatalogDifferenceKind[];
  readonly hierarchyTags: readonly string[];
}
```

Use `catalogId` for action lookup. `copyCloudPath` rejects `catalog-record-unavailable` when the record has no cloud path. Search/filter actions modify only local view state. Render status chips as buttons with `aria-pressed`, render hierarchy tags as local filters, and never prefix them with `#` or call them content tags.

- [x] **Step 4: Run UI, runtime, search, and accessibility regressions**

Run:

```bash
npx vitest run tests/unit/catalog/cloud-catalog-runtime.test.ts tests/unit/catalog/unified-catalog-search-service.test.ts tests/ui/cloud-catalog-tab.test.ts tests/ui/workbench-view.test.ts tests/ui/workbench-controller.test.ts
npx eslint src/catalog/cloud-catalog-runtime.ts src/ui/cloud-catalog-tab.ts src/ui/workbench-controller.ts src/ui/workbench-view.ts
```

Expected: tests pass and there are no new lint errors.

- [x] **Step 5: Commit Task 9**

```bash
git add src/catalog/cloud-catalog-runtime.ts src/ui/cloud-catalog-tab.ts src/ui/workbench-controller.ts src/ui/workbench-view.ts styles.css tests/unit/catalog/cloud-catalog-runtime.test.ts tests/ui/cloud-catalog-tab.test.ts tests/ui/workbench-view.test.ts tests/ui/workbench-controller.test.ts
git commit -m "feat(目录): 展示统一目录核验状态"
```

### Task 10: Wire normal-only capabilities and complete isolated verification

**Files:**
- Modify: `src/runtime/normal-cloud-catalog-composition.ts`
- Modify: `src/main.ts`
- Modify: `src/main-acceptance.ts`
- Modify: `src/runtime/catalog-runtime-lifecycle.ts`
- Modify: `tests/integration/catalog-offline-composition.test.ts`
- Modify: `tests/packaging/read-only-acceptance-build.test.ts`
- Create: `tests/integration/catalog-hybrid-composition.test.ts`
- Create: `scripts/inspect-catalog-txt-aggregate.mjs`
- Create: `tests/scripts/inspect-catalog-txt-aggregate.test.ts`
- Modify: `package.json`

- [x] **Step 1: Write failing composition, package, and aggregate-inspection tests**

Assert normal composition creates local TXT/store/import/projection/reconciliation/verification services under the existing resolved catalog root; startup initializes local state with zero host requests; acceptance bundles contain none of `node:fs`, TXT path controls, SecretStorage, Baidu adapter, hybrid storage path, or verification actions; and the aggregate-inspection CLI prints only approved numeric/hash fields.

```ts
it("initializes hybrid local state without requesting Baidu", async () => {
  const requests: unknown[] = [];
  const runtime = createNormalCloudCatalogRuntime({
    host: fakeHost((request) => { requests.push(request); throw new Error("unexpected"); }),
    environment: fakeEnvironment(root),
  });
  await runtime.initialize();
  expect(requests).toEqual([]);
});
```

The CLI test passes a synthetic TXT path through argv, captures stdout, and proves neither the input path nor any filename occurs. Allowed keys are `source_sha256`, `byte_size`, `nonempty_lines`, `pdf_count`, `directory_count`, `ignored_leaf_count`, `duplicate_pdf_paths`, `max_depth`, and `within_70000_limit`.

- [x] **Step 2: Run focused integration tests and verify failure**

Run:

```bash
npx vitest run tests/integration/catalog-hybrid-composition.test.ts tests/integration/catalog-offline-composition.test.ts tests/packaging/read-only-acceptance-build.test.ts tests/scripts/inspect-catalog-txt-aggregate.test.ts
```

Expected: FAIL because normal composition and the aggregate inspection script are not wired.

- [x] **Step 3: Implement normal composition and the safe local aggregate command**

Construct one `LocalHybridCatalogAdapter` alongside the existing `LocalCatalogSnapshotAdapter`. Inject it into import, projection, reconciliation, verification, hybrid runtime, and display runtime. Keep `main-acceptance.ts` on disabled/offline objects with no imports from local source, local hybrid adapter, OAuth, credential, or Baidu source files.

Add:

```json
{
  "scripts": {
    "inspect:catalog-txt": "node scripts/inspect-catalog-txt-aggregate.mjs"
  }
}
```

The inspection script uses the production parser with a no-op candidate sink and prints only the whitelist above. It never writes an import, opens a Vault, calls a network port, or logs caught native errors.

- [x] **Step 4: Run the complete automated gate**

Run:

```bash
npx vitest run tests/unit/catalog tests/integration/catalog-scan.test.ts tests/integration/catalog-small-folder-preflight.test.ts tests/integration/catalog-large-verification.test.ts tests/integration/catalog-hybrid-composition.test.ts tests/integration/catalog-offline-composition.test.ts tests/packaging/read-only-acceptance-build.test.ts tests/ui/catalog-scan-confirmation-modal.test.ts tests/ui/catalog-txt-import-confirmation-modal.test.ts tests/ui/catalog-large-scan-confirmation-modal.test.ts tests/ui/cloud-catalog-tab.test.ts tests/ui/settings-tab.test.ts tests/scripts/inspect-catalog-txt-aggregate.test.ts
npm run lint
npm test
npm run build
npm run build:acceptance
```

Expected: all focused and full tests pass; lint has zero errors; normal and acceptance builds exit 0. Record existing warnings separately and do not claim they were fixed.

- [x] **Step 5: Run the disabled normal synthetic-vault install verification only**

Preflight the already marked project-local vault. Confirm the `plugin is disabled` and
`Obsidian is fully quit` before replacing any plugin artifact. This verification must
not delete or replace an existing fixed read-only acceptance run; its state, receipt,
report, and installed target are immutable evidence for a separate workflow.

Run:

```bash
OBSIDIAN_DEV_VAULT="$(pwd)/.dev-vault/baidu-catalog-oob" npm run install:dev
```

Expected: the guarded normal installer updates only `main.js`, `manifest.json`, and
`styles.css` under the marked synthetic Vault; all three installed hashes equal the
root normal artifacts; `community-plugins.json` remains the exact disabled list; and
no installer stage or backup remains. It must not launch OAuth, read the user TXT,
access a cloud path, alter the real Vault, or touch unrelated local files.

`prepare:acceptance:synthetic` and `install:acceptance:dev` belong to the fixed
read-only acceptance rehearsal, whose clean-HEAD and one-run evidence rules are
different from this normal product verification. `validate:acceptance` validates an
optional legacy host evidence file; an absent legacy file is not a failed normal
installation and must not be fabricated as proof for this task.

- [x] **Step 6: Commit Task 10**

```bash
git add src/runtime/normal-cloud-catalog-composition.ts src/main.ts src/main-acceptance.ts src/runtime/catalog-runtime-lifecycle.ts tests/integration/catalog-offline-composition.test.ts tests/packaging/read-only-acceptance-build.test.ts tests/integration/catalog-hybrid-composition.test.ts scripts/inspect-catalog-txt-aggregate.mjs tests/scripts/inspect-catalog-txt-aggregate.test.ts package.json
git commit -m "chore(目录): 完成混合目录安全验证"
```

- [x] **Step 7: Stop at Checkpoint C and complete the engineering Goal if every criterion is met**

Report the current Git commit; Tasks 8–10 functionality; all exact test/lint/build/install results; wrong directions and rework across the batch; available input-token telemetry; PMH recall count and token quantity without contents; contamination finding; and proof of zero real Baidu requests, zero PDF downloads, and zero real Vault writes. Confirm unrelated untracked files stayed unstaged.

If all design completion criteria are met, mark the active Goal complete and report the final tool-provided token usage. Do not perform the real TXT import, real category scan, real Vault install, push, PR, or control-model experiment unless a later request independently authorizes that exact external action.
