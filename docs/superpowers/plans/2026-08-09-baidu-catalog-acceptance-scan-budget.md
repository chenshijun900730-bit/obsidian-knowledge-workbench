# Baidu Catalog Small-Sample Scan Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fixed, fail-closed small-sample scan budget to the Baidu Cloud Catalog so every list attempt is counted, oversized pages are discarded atomically, every normal terminal state receives an aggregate v2 receipt, and Obsidian shows live aggregate progress without retaining the entered cloud path.

**Architecture:** Keep PDF content in Baidu Netdisk and keep catalog data outside the Vault. New scans use schema-v2 checkpoints and a scanner-owned request permit; the production source adapter must obtain that permit immediately before every real `GET method=list`, including a refresh replay. The local snapshot adapter remains the sole persistence boundary, preserves legacy schema-v1 checkpoints byte-for-byte, and promotes only complete v2 scans. The connection runtime publishes aggregate-only progress through subscriptions to the settings surface.

**Tech Stack:** TypeScript 5.8, Vitest 4, Obsidian 1.13 APIs, Node filesystem/crypto primitives, the existing official Baidu OOB OAuth adapter, and the existing exact `GET /rest/2.0/xpan/file?method=list` transport.

---

## Approved scope and execution rules

- Implement only the design in `docs/superpowers/specs/2026-08-09-baidu-catalog-acceptance-scan-budget-design.md`.
- The production budget is fixed at 1,000 PDFs, 20 directories, 25 list attempts, and 120,000 ms. It is not a setting, runtime option, environment variable, modal field, or command-line option.
- Keep the existing schema-v1 oversized checkpoint untouched. Do not migrate, resume, rewrite, delete, or derive an exact request count from it.
- Do not add download, `dlink`, upload, move, copy, rename, delete, share, OCR, PDF parsing, Markdown conversion, summary, embedding, or unrestricted request capabilities.
- Automated implementation uses synthetic paths, fake credentials, fake clocks, deterministic responses, and temporary directories only.
- Do not perform real OAuth, a real Baidu list request, resume the previous large scan, scan a parent/root directory, or inspect a second directory during Tasks 1–6.
- Do not run old A/B benchmarks, `long-pilot`, `public-v1`, stress scripts, batch model calls, duplicate repositories, worktrees, or subagents.
- Preserve all unrelated untracked research files. Stage only the files named by the current task.
- Use the current branch `codex/baidu-cloud-catalog-core` and the current worktree. Commit messages are Chinese and follow the repository convention.

## File responsibility map

| File | Responsibility in this change |
| --- | --- |
| `src/catalog/catalog-types.ts` | v1/v2 checkpoint union, fixed production budget, stop reasons, receipt v2, aggregate progress/result types |
| `src/catalog/catalog-ports.ts` | Per-list request permit and unified v2 terminal persistence contract |
| `src/adapters/local-catalog-snapshot-adapter.ts` | Strict v1/v2 decoding, monotonic state transitions, aggregate v2 receipt, complete-only promotion |
| `src/catalog/catalog-scan-service.ts` | Fixed-priority budget state machine, page atomicity, cancellation, exact permit ownership |
| `src/adapters/baidu-catalog-source-adapter.ts` | Invoke the permit immediately before initial and replayed list transports |
| `src/catalog/cloud-catalog-connection-runtime.ts` | Convert scanner progress into a subscribed aggregate connection view model |
| `src/catalog/cloud-catalog-runtime.ts` | Forward connection events through the existing catalog subscription lifecycle |
| `src/ui/workbench-controller.ts` | Expose settings subscription and clear-on-confirm callback boundary |
| `src/ui/settings-tab.ts` | Render live counts/limits/reason, scanning-only cancel, and clear the path after confirmation |
| `src/runtime/normal-cloud-catalog-composition.ts` | Inject only the fixed production budget |
| `tests/**` | Synthetic proof of limits, exact counts, isolation, UI behavior, and legacy preservation |
| `docs/runbooks/baidu-cloud-catalog-small-folder.md` | Human procedure and evidence whitelist for a separately authorized second real scan |

## Checkpoint schedule

- Checkpoint E follows Tasks 1–3: contracts, persistence, and the scanner state machine.
- Checkpoint F follows Tasks 4–6: exact production request permits, live UI, composition, packaging, build, and synthetic installation.
- At each checkpoint, stop and report: current Git commit; implemented behavior; commands and actual results; wrong directions and rework count; available input-token telemetry; PMH recall count and token amount without memory contents; and whether cross-project or cross-model contamination was found.
- If token or PMH telemetry is not available from the current task process, report `不可获得`; do not infer it. If no PMH recall was invoked during the interval, report recall count/token as `0 / 0`.
- Do not begin a control-model run after a checkpoint.

### Task 1: Lock schema-v2 contracts and the fixed production budget

**Files:**

- Modify: `src/catalog/catalog-types.ts`
- Modify: `src/catalog/catalog-ports.ts`
- Create: `tests/unit/catalog/catalog-scan-contracts.test.ts`

- [ ] **Step 1: Add the RED fixed-budget contract test**

Create `tests/unit/catalog/catalog-scan-contracts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET } from "../../../src/catalog/catalog-types";

describe("small acceptance catalog scan contracts", () => {
  it("exports one frozen production budget", () => {
    expect(SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET).toEqual({
      maxPdfCount: 1_000,
      maxDirectoryCount: 20,
      maxListRequestCount: 25,
      maxDurationMs: 120_000,
    });
    expect(Object.isFrozen(SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET)).toBe(true);
    expect(Reflect.set(
      SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET as unknown as Record<string, number>,
      "maxPdfCount",
      70_000,
    )).toBe(false);
  });
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run tests/unit/catalog/catalog-scan-contracts.test.ts
```

Expected: FAIL because `SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET` is not exported.

- [ ] **Step 3: Replace the scan-state section with explicit v1/v2 types**

Keep the existing record, credential, list-entry, descriptor, and error-code declarations unchanged. Replace the current checkpoint, receipt, result, and progress declarations in `src/catalog/catalog-types.ts` with these definitions:

```ts
export interface CatalogScanBudget {
  readonly maxPdfCount: number;
  readonly maxDirectoryCount: number;
  readonly maxListRequestCount: number;
  readonly maxDurationMs: number;
}

export const SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET = Object.freeze({
  maxPdfCount: 1_000,
  maxDirectoryCount: 20,
  maxListRequestCount: 25,
  maxDurationMs: 120_000,
} as const satisfies CatalogScanBudget);

export type CatalogScanPauseReason =
  | "user-canceled"
  | "pdf-limit"
  | "directory-limit"
  | "list-request-limit"
  | "time-limit";

export type CatalogScanStopReason = "complete" | CatalogScanPauseReason | CatalogErrorCode;

interface CatalogScanCheckpointBase {
  readonly scanId: string;
  readonly rootPath: string;
  readonly startedAt: number;
  readonly pending: readonly Readonly<{ path: string; start: number }>[];
  readonly committedPageKeys: readonly string[];
  readonly completedDirectoryCount: number;
  readonly directoryCount: number;
  readonly pdfCount: number;
  readonly ignoredFileCount: number;
  readonly errorCodeCounts: Readonly<Partial<Record<CatalogErrorCode, number>>>;
  readonly retryCount: number;
  readonly status: "scanning" | "paused" | "partial";
}

export interface CatalogScanCheckpointV1 extends CatalogScanCheckpointBase {
  readonly schemaVersion: 1;
}

export interface CatalogScanCheckpointV2 extends CatalogScanCheckpointBase {
  readonly schemaVersion: 2;
  readonly budget: CatalogScanBudget;
  readonly listRequestCount: number;
  readonly pauseReason: CatalogScanPauseReason | null;
}

export type CatalogScanCheckpoint = CatalogScanCheckpointV1 | CatalogScanCheckpointV2;

export interface CatalogScanReceiptV1 {
  readonly schemaVersion: 1;
  readonly status: "complete" | "paused" | "partial";
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly directoryCount: number;
  readonly pdfCount: number;
  readonly ignoredFileCount: number;
  readonly errorCodeCounts: Readonly<Partial<Record<CatalogErrorCode, number>>>;
  readonly retryCount: number;
  readonly snapshotSha256?: string;
}

export interface CatalogScanReceiptV2 {
  readonly schemaVersion: 2;
  readonly status: "complete" | "paused" | "partial";
  readonly stopReason: CatalogScanStopReason;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly budget: CatalogScanBudget;
  readonly listRequestCount: number;
  readonly directoryCount: number;
  readonly pdfCount: number;
  readonly ignoredFileCount: number;
  readonly downloadedPdfBytes: 0;
  readonly errorCodeCounts: Readonly<Partial<Record<CatalogErrorCode, number>>>;
  readonly retryCount: number;
  readonly snapshotSha256: string | null;
}

export type CatalogScanReceipt = CatalogScanReceiptV1 | CatalogScanReceiptV2;

export interface CatalogScanProgress {
  readonly status: "scanning" | "paused" | "partial" | "complete";
  readonly directoryCount: number;
  readonly completedDirectoryCount: number;
  readonly pdfCount: number;
  readonly ignoredFileCount: number;
  readonly pendingDirectoryCount: number;
  readonly listRequestCount: number;
  readonly elapsedMs: number;
  readonly budget: CatalogScanBudget;
  readonly stopReason?: CatalogScanStopReason;
}

export interface CatalogScanResult {
  readonly status: "complete" | "paused" | "partial";
  readonly stopReason: CatalogScanStopReason;
  readonly progress: CatalogScanProgress;
  readonly descriptor?: CatalogSnapshotDescriptor;
  readonly errorCode?: CatalogErrorCode;
}

export interface CatalogScanFinalization {
  readonly checkpoint: CatalogScanCheckpointV2;
  readonly status: "complete" | "paused" | "partial";
  readonly stopReason: CatalogScanStopReason;
  readonly endedAt: number;
}

export interface CatalogScanFinalizationResult {
  readonly receipt: CatalogScanReceiptV2;
  readonly descriptor?: CatalogSnapshotDescriptor;
}
```

Use numeric fields in `CatalogScanBudget` so tests can inject smaller deterministic limits; only the frozen production constant carries the approved literal values.

- [ ] **Step 4: Narrow the source permit and terminal storage ports**

In `src/catalog/catalog-ports.ts`, import the new finalization and receipt types, then change the relevant interfaces to:

```ts
export type CatalogListRequestPermit = () => Promise<void>;

export interface BaiduCatalogSourcePort {
  listDirectory(input: Readonly<{
    path: string;
    start: number;
    limit: 1000;
    beforeRequest: CatalogListRequestPermit;
  }>): Promise<Readonly<{ entries: readonly BaiduListEntry[] }>>;
}

export interface CatalogSnapshotPort {
  createScan(checkpoint: CatalogScanCheckpoint): Promise<void>;
  commitPage(input: Readonly<{
    scanId: string;
    pageKey: string;
    records: readonly CatalogSnapshotRecord[];
    nextCheckpoint: CatalogScanCheckpoint;
  }>): Promise<void>;
  loadScan(scanId: string): Promise<Readonly<{
    checkpoint: CatalogScanCheckpoint;
    records: readonly CatalogSnapshotRecord[];
  }> | null>;
  saveScanState(checkpoint: CatalogScanCheckpoint): Promise<void>;
  finalizeScan(input: CatalogScanFinalization): Promise<CatalogScanFinalizationResult>;
  loadReceipt(scanId: string): Promise<CatalogScanReceipt | null>;
  promoteScan(scanId: string, completedAt: number): Promise<CatalogSnapshotDescriptor>;
  loadActive(): Promise<Readonly<{
    descriptor: CatalogSnapshotDescriptor;
    records: readonly CatalogSnapshotRecord[];
  }> | null>;
}
```

Retain `promoteScan` only as the legacy v1 adapter contract used by existing tests and data. New production scans must call `finalizeScan` instead.

- [ ] **Step 5: Run GREEN and type-surface RED**

Run:

```bash
npx vitest run tests/unit/catalog/catalog-scan-contracts.test.ts
npm run build
```

Expected: the new contract test passes; `npm run build` fails at current source/adapter/test implementations because the required permit, v2 result fields, and finalization methods are not implemented yet. Record that failure as the intended cross-module RED state.

- [ ] **Step 6: Commit Task 1 only**

```bash
git add src/catalog/catalog-types.ts src/catalog/catalog-ports.ts tests/unit/catalog/catalog-scan-contracts.test.ts
git commit -m "feat(目录): 定义小样本扫描预算合约"
```

### Task 2: Persist strict v2 checkpoints and aggregate terminal receipts

**Files:**

- Modify: `src/adapters/local-catalog-snapshot-adapter.ts`
- Modify: `tests/unit/catalog/local-catalog-snapshot-adapter.test.ts`

- [ ] **Step 1: Add RED v2 storage fixtures and terminal tests**

Add this v2 fixture beside the existing v1 `checkpoint` helper in `tests/unit/catalog/local-catalog-snapshot-adapter.test.ts`:

```ts
import {
  SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET,
  type CatalogScanCheckpointV2,
} from "../../../src/catalog/catalog-types";

const checkpointV2 = (
  rootPath: string,
  scanId = "scan-v2",
): CatalogScanCheckpointV2 => ({
  schemaVersion: 2,
  scanId,
  rootPath,
  startedAt: 10,
  budget: SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET,
  listRequestCount: 0,
  pending: [{ path: rootPath, start: 0 }],
  committedPageKeys: [],
  completedDirectoryCount: 0,
  directoryCount: 0,
  pdfCount: 0,
  ignoredFileCount: 0,
  errorCodeCounts: {},
  retryCount: 0,
  status: "scanning",
  pauseReason: null,
});
```

Add tests with these exact assertions:

```ts
it("persists one monotonic list permit before terminal receipt creation", async () => {
  const adapter = new LocalCatalogSnapshotAdapter(await temporaryRoot());
  const initial = checkpointV2("/synthetic-small-folder");
  await adapter.createScan(initial);
  await adapter.saveScanState({ ...initial, listRequestCount: 1 });
  await expect(adapter.saveScanState(initial)).rejects.toMatchObject({ code: "snapshot-corrupt" });
  await expect(adapter.saveScanState({
    ...initial,
    listRequestCount: 2,
    budget: { ...initial.budget, maxPdfCount: 70_000 },
  })).rejects.toMatchObject({ code: "snapshot-corrupt" });
});

it("writes one strict aggregate paused receipt without replacing active", async () => {
  const adapter = new LocalCatalogSnapshotAdapter(await temporaryRoot());
  const initial = checkpointV2("/synthetic-small-folder");
  await adapter.createScan(initial);
  let permitted = initial;
  for (let listRequestCount = 1; listRequestCount <= 25; listRequestCount += 1) {
    permitted = { ...permitted, listRequestCount };
    await adapter.saveScanState(permitted);
  }
  const result = await adapter.finalizeScan({
    checkpoint: {
      ...permitted,
      status: "paused",
      pauseReason: "list-request-limit",
    },
    status: "paused",
    stopReason: "list-request-limit",
    endedAt: 110,
  });

  expect(result).toEqual({
    receipt: {
      schemaVersion: 2,
      status: "paused",
      stopReason: "list-request-limit",
      startedAt: 10,
      endedAt: 110,
      durationMs: 100,
      budget: SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET,
      listRequestCount: 25,
      directoryCount: 0,
      pdfCount: 0,
      ignoredFileCount: 0,
      downloadedPdfBytes: 0,
      errorCodeCounts: {},
      retryCount: 0,
      snapshotSha256: null,
    },
  });
  expect(await adapter.loadReceipt(initial.scanId)).toEqual(result.receipt);
  expect(await adapter.loadActive()).toBeNull();
});

it("rejects a receipt containing a cloud path or any unknown key", async () => {
  const root = await temporaryRoot();
  const adapter = new LocalCatalogSnapshotAdapter(root);
  const initial = checkpointV2("/synthetic-small-folder");
  await adapter.createScan(initial);
  await adapter.finalizeScan({
    checkpoint: { ...initial, status: "paused", pauseReason: "user-canceled" },
    status: "paused",
    stopReason: "user-canceled",
    endedAt: 20,
  });
  const receiptPath = join(root, "scans", initial.scanId, "receipt.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
  await writeFile(receiptPath, `${JSON.stringify({ ...receipt, rootPath: "/must-not-survive" })}\n`);

  await expect(new LocalCatalogSnapshotAdapter(root).loadReceipt(initial.scanId))
    .rejects.toMatchObject({ code: "snapshot-corrupt" });
});
```

Add a complete-v2 case that commits one PDF, calls `finalizeScan` with `status: "complete"`, verifies a non-null SHA-256 in the receipt and descriptor, and verifies `active.json` changes. Add paused and partial cases after a previously complete scan and compare the prior `active.json` bytes before/after.

Add a legacy preservation case that creates a v1 checkpoint, reads `checkpoint.json` bytes, creates and finalizes a different v2 scan, loads the v1 scan, and asserts the original bytes are unchanged.

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/unit/catalog/local-catalog-snapshot-adapter.test.ts
```

Expected: FAIL because the adapter only decodes schema v1 and has no `finalizeScan` or `loadReceipt`.

- [ ] **Step 3: Add strict budget, v2 checkpoint, and v2 receipt decoders**

In `src/adapters/local-catalog-snapshot-adapter.ts`, keep the existing v1 decoder as `decodeCheckpointV1` without changing its exact-key list. Add a dispatcher and v2 decoder. Validate every budget value as a positive safe integer, require `listRequestCount <= budget.maxListRequestCount`, require content counts not to exceed their budget, and accept only the five fixed pause reasons.

Use this exact receipt key list:

```ts
const RECEIPT_V2_KEYS = [
  "schemaVersion",
  "status",
  "stopReason",
  "startedAt",
  "endedAt",
  "durationMs",
  "budget",
  "listRequestCount",
  "directoryCount",
  "pdfCount",
  "ignoredFileCount",
  "downloadedPdfBytes",
  "errorCodeCounts",
  "retryCount",
  "snapshotSha256",
] as const;

const decodeCheckpoint = (value: unknown): CatalogScanCheckpoint => {
  const record = asRecord(value);
  if (record.schemaVersion === 1) return decodeCheckpointV1(record);
  if (record.schemaVersion === 2) return decodeCheckpointV2(record);
  return corrupt();
};

const decodeReceipt = (value: unknown): CatalogScanReceipt => {
  const record = asRecord(value);
  if (record.schemaVersion === 1) return decodeReceiptV1(record);
  if (!hasExactKeys(record, RECEIPT_V2_KEYS) || record.schemaVersion !== 2) return corrupt();
  const startedAt = safeNonNegativeInteger(record.startedAt);
  const endedAt = safeNonNegativeInteger(record.endedAt);
  const durationMs = safeNonNegativeInteger(record.durationMs);
  if (endedAt < startedAt || durationMs !== endedAt - startedAt) return corrupt();
  if (record.downloadedPdfBytes !== 0) return corrupt();
  const status = decodeReceiptStatus(record.status);
  const stopReason = decodeStopReason(record.stopReason);
  const snapshotSha256 = record.snapshotSha256 === null
    ? null
    : decodeSha256(record.snapshotSha256);
  if ((status === "complete") !== (snapshotSha256 !== null)) return corrupt();
  validateStopReasonForStatus(status, stopReason);
  return {
    schemaVersion: 2,
    status,
    stopReason,
    startedAt,
    endedAt,
    durationMs,
    budget: decodeBudget(record.budget),
    listRequestCount: safeNonNegativeInteger(record.listRequestCount),
    directoryCount: safeNonNegativeInteger(record.directoryCount),
    pdfCount: safeNonNegativeInteger(record.pdfCount),
    ignoredFileCount: safeNonNegativeInteger(record.ignoredFileCount),
    downloadedPdfBytes: 0,
    errorCodeCounts: errorCodeCounts(record.errorCodeCounts),
    retryCount: safeNonNegativeInteger(record.retryCount),
    snapshotSha256,
  };
};
```

Implement `decodeReceiptV1`, `decodeReceiptStatus`, `decodeStopReason`, `decodeSha256`, `decodeBudget`, and `validateStopReasonForStatus` as total fail-closed helpers. Do not include `scanId`, `rootPath`, pending work, page keys, names, credentials, tokens, URLs, or response text in the v2 decoder or receipt object.

- [ ] **Step 4: Enforce version-aware monotonic transitions**

Keep v1 `saveScanState` behavior unchanged. For v2:

- immutable across every transition: schema, scan ID, root, start time, budget, pending queue, committed page keys, completed-directory count, directory/PDF/ignored counts;
- permit transition: only `listRequestCount` may increase by exactly one while status remains `scanning` and `pauseReason` remains null;
- terminal transition: `listRequestCount` remains unchanged, and status may move from `scanning` to `paused` or `partial` with a valid reason/counter change;
- exact repeated writes are idempotent;
- page commits must retain the same budget and list count, append exactly one page key, and preserve `pauseReason: null`.

Do not infer a v2 request count from v1 page state.

- [ ] **Step 5: Implement unified v2 finalization**

Implement `loadReceipt` by strict decode. Implement `finalizeScan` in this order:

1. decode and require a v2 checkpoint;
2. validate status/stop-reason/checkpoint consistency;
3. persist the terminal checkpoint through `saveScanState`;
4. for `complete`, require an empty queue, validate records, materialize the immutable snapshot, and compute SHA-256;
5. build a v2 aggregate receipt with `durationMs = endedAt - startedAt` and `downloadedPdfBytes: 0`;
6. if a receipt exists, require exact canonical equality; otherwise write it atomically with mode 0600;
7. update `active.json` only for `complete`;
8. map any integrity/finalization failure to `CatalogError("snapshot-corrupt")` while leaving the prior active descriptor unchanged.

Retain the existing v1 `promoteScan` implementation for legacy adapter tests. Do not call it from the new scanner.

- [ ] **Step 6: Run GREEN**

```bash
npx vitest run tests/unit/catalog/local-catalog-snapshot-adapter.test.ts
npx vitest run tests/unit/catalog/catalog-scan-contracts.test.ts
```

Expected: PASS, including strict unknown-key rejection, private permissions, monotonic permit persistence, complete-only promotion, and byte-identical v1 preservation.

- [ ] **Step 7: Commit Task 2 only**

```bash
git add src/adapters/local-catalog-snapshot-adapter.ts tests/unit/catalog/local-catalog-snapshot-adapter.test.ts
git commit -m "feat(目录): 持久化扫描回执与预算状态"
```

### Task 3: Implement the scanner state machine and exact production request permits

**Files:**

- Modify: `src/catalog/catalog-scan-service.ts`
- Modify: `src/adapters/baidu-catalog-source-adapter.ts`
- Modify: `src/runtime/normal-cloud-catalog-composition.ts`
- Modify: `tests/integration/catalog-scan.test.ts`
- Modify: `tests/unit/catalog/baidu-catalog-source-adapter.test.ts`
- Modify: `tests/unit/catalog/cloud-catalog-connection-runtime.test.ts`

- [ ] **Step 1: Convert the synthetic source to the new permit contract**

Update the integration-test source input to include `beforeRequest`. Count a synthetic transport only after the permit resolves:

```ts
type ListInput = Readonly<{
  path: string;
  start: number;
  limit: 1000;
  beforeRequest: () => Promise<void>;
}>;

class ScriptedSource implements BaiduCatalogSourcePort {
  readonly calls: Array<Readonly<{ path: string; start: number; limit: 1000 }>> = [];
  maximumConcurrentCalls = 0;
  private activeCalls = 0;

  constructor(
    private readonly respond: (
      input: Readonly<{ path: string; start: number; limit: 1000 }>,
    ) => Promise<readonly BaiduListEntry[]> | readonly BaiduListEntry[],
  ) {}

  async listDirectory(input: ListInput): Promise<Readonly<{ entries: readonly BaiduListEntry[] }>> {
    await input.beforeRequest();
    this.calls.push({ path: input.path, start: input.start, limit: input.limit });
    this.activeCalls += 1;
    this.maximumConcurrentCalls = Math.max(this.maximumConcurrentCalls, this.activeCalls);
    try {
      return { entries: await this.respond(input) };
    } finally {
      this.activeCalls -= 1;
    }
  }
}
```

- [ ] **Step 2: Add RED production permit-order tests**

Extend the source-adapter fixture so each call passes a permit and records events. Add these assertions:

```ts
it("obtains a permit immediately before the initial list transport", async () => {
  const { adapter, requests } = fixture();
  const events: string[] = [];
  requests.responses.push(successfulResponse());
  requests.beforeSend = () => { events.push("transport"); };

  await adapter.listDirectory({
    path: privateCloudPath,
    start: 0,
    limit: 1000,
    beforeRequest: async () => { events.push("permit"); },
  });

  expect(events).toEqual(["permit", "transport"]);
  expect(requests.calls).toHaveLength(1);
});

it("counts initial and refresh replay separately and preserves a blocked permit", async () => {
  const { adapter, oauth, requests } = fixture();
  const events: string[] = [];
  const blocked = new Error("synthetic-permit-blocked");
  let permits = 0;
  requests.responses.push({ status: 200, text: JSON.stringify({ errno: -6, list: [] }) });
  requests.beforeSend = () => { events.push("transport"); };

  const error = await adapter.listDirectory({
    path: "/safe",
    start: 0,
    limit: 1000,
    beforeRequest: async () => {
      permits += 1;
      events.push("permit");
      if (permits === 2) throw blocked;
    },
  }).catch((value: unknown) => value);

  expect(error).toBe(blocked);
  expect(events).toEqual(["permit", "transport", "permit"]);
  expect(oauth.refreshCalls).toBe(1);
  expect(requests.calls).toHaveLength(1);
});
```

Update every existing source-adapter invocation with `beforeRequest: async () => undefined`. Validation and missing credentials must fail before a permit because no list transport can occur.

- [ ] **Step 3: Add RED scanner matrix tests**

Use constructor-injected synthetic budgets and a manual `now()` sequence. Lock all of these cases:

| Case | Required assertion |
| --- | --- |
| request cap | a completed first list with pending child work produces `paused/list-request-limit`; no second transport occurs |
| exact last request | an empty final page on the maximum permitted request may complete |
| PDF overflow | a page that would cross the PDF cap is not committed; prior counts remain in receipt |
| directory overflow | a page that would cross the directory cap is not committed |
| exact PDF cap with empty queue | completes |
| exact PDF cap with pagination/children pending | pauses before another request |
| time cap before request | no transport, `paused/time-limit` |
| time cap after response | response page is discarded, `paused/time-limit` |
| canceled before request | no transport, `paused/user-canceled` |
| canceled during request | wait for response, discard the page, write paused receipt |
| rate limit | one counted request, `paused/baidu-rate-limited`, no retry or sleep |
| fixed source failure | one counted request, `partial` with that fixed error code |
| permit crash window | list count is persisted in a nonterminal checkpoint, transport count is zero, receipt is absent |
| progress privacy | progress contains only aggregate fields and the frozen/injected budget |

Use this exact overflow assertion pattern:

```ts
const result = await service.scan({
  scanId: "scan-pdf-overflow",
  rootPath: "/synthetic-small-folder",
});

expect(source.calls).toHaveLength(1);
expect(result).toMatchObject({
  status: "paused",
  stopReason: "pdf-limit",
  progress: { pdfCount: 0, listRequestCount: 1 },
});
expect((await snapshots.loadScan("scan-pdf-overflow"))?.records).toEqual([]);
expect(await snapshots.loadReceipt("scan-pdf-overflow")).toMatchObject({
  status: "paused",
  stopReason: "pdf-limit",
  pdfCount: 0,
  listRequestCount: 1,
  downloadedPdfBytes: 0,
});
expect(await snapshots.loadActive()).toBeNull();
```

Replace the old “resume without repeating” test with a no-resume test: seed any existing scan ID, call `scan` with that ID, expect `snapshot-corrupt`, and assert its checkpoint bytes and receipt absence remain unchanged.

- [ ] **Step 4: Run RED**

```bash
npx vitest run tests/integration/catalog-scan.test.ts tests/unit/catalog/baidu-catalog-source-adapter.test.ts
```

Expected: FAIL because the scanner still creates v1 checkpoints, does not persist a permit, commits over-budget pages, throws on cancel, and only writes a receipt for complete promotion; the source adapter also does not invoke a permit before each list transport.

- [ ] **Step 5: Change the scanner constructor and initialize v2 before the first await**

Use an options object:

```ts
export interface CatalogScanServiceOptions {
  readonly budget: CatalogScanBudget;
  readonly now?: () => number;
}

export class CatalogScanService {
  readonly #budget: CatalogScanBudget;
  readonly #now: () => number;

  constructor(
    private readonly source: BaiduCatalogSourcePort,
    private readonly snapshots: CatalogSnapshotPort,
    options: CatalogScanServiceOptions,
  ) {
    this.#budget = validateScanBudget(options.budget);
    this.#now = options.now ?? Date.now;
  }
}
```

At scan entry, normalize the root and capture `startedAt = safeNow(this.#now)` before any filesystem await. Reject any pre-existing scan ID with `snapshot-corrupt`; new scans never resume v1 or v2 state. Create a v2 checkpoint with a frozen copy of the injected budget, zero request count, and `pauseReason: null`. Publish initial aggregate progress after `createScan`.

- [ ] **Step 6: Own every request permit in the scanner**

Pass this narrow closure to every `listDirectory` call:

```ts
const beforeRequest = async (): Promise<void> => {
  const reason = this.preRequestPauseReason(checkpoint, input.signal);
  if (reason !== null) throw new CatalogScanPause(reason);
  const permitted: CatalogScanCheckpointV2 = {
    ...checkpoint,
    listRequestCount: checkpoint.listRequestCount + 1,
  };
  await this.snapshots.saveScanState(permitted);
  checkpoint = permitted;
  input.onProgress?.(this.progressFrom(checkpoint, "scanning"));
};
```

`preRequestPauseReason` must check in this order: user cancellation, elapsed time `>= maxDurationMs`, PDF count at cap with pending work, directory count at cap with pending work, then request count at cap. The request-count check belongs last because it applies to the next transport; local content limits retain their fixed priority.

Use a private `CatalogScanPause` class that carries only `CatalogScanPauseReason`. The source adapter must receive and rethrow this value unchanged.

- [ ] **Step 7: Put the permit directly in front of both production transports**

Change `BaiduCatalogSourceAdapter.listDirectory` so both the initial call and the one allowed refresh replay pass the same permit into `#list`. Implement the boundary as:

```ts
async #list(
  page: Readonly<{ path: string; start: number }>,
  accessToken: string,
  beforeRequest: CatalogListRequestPermit,
): Promise<ReturnType<typeof decodeBaiduListResponse>> {
  await beforeRequest();
  return this.#sendList(page, accessToken);
}

async #sendList(
  page: Readonly<{ path: string; start: number }>,
  accessToken: string,
): Promise<ReturnType<typeof decodeBaiduListResponse>> {
  const url = listUrl(page, accessToken);
  let response: BaiduCatalogListResponse;
  try {
    response = await this.#request({ method: "GET", url });
  } catch {
    throw catalogError("baidu-access-unavailable");
  }
  if (!Number.isSafeInteger(response.status) || response.status < 200 || response.status >= 300) {
    throw catalogError("baidu-access-unavailable");
  }
  return decodeBaiduListResponse(response.text);
}
```

`#sendList` is invoked in the same synchronous continuation immediately after permit resolution. It constructs the URL and invokes the transport before its first await. Do not place another await, branch, logging call, refresh check, or side effect between the permit and that invocation. OAuth refresh itself is not counted. Permit rejections bubble unchanged.

- [ ] **Step 8: Enforce post-response priority and whole-page discard**

After a response returns and before conversion/commit:

1. check user cancellation;
2. check elapsed time;
3. strictly decode/convert in memory;
4. compute candidate PDF and directory totals;
5. if candidate PDFs exceed the cap, finalize paused with `pdf-limit` without calling `commitPage`;
6. otherwise, if candidate directories exceed the cap, finalize paused with `directory-limit` without calling `commitPage`;
7. otherwise commit the entire page and next checkpoint atomically;
8. publish progress;
9. continue the serial breadth-first loop.

If cancellation happens while a non-abortable transport is in flight, wait for its response and discard it before finalizing. A page that lands exactly on a count cap may complete only when the computed queue is empty; otherwise the next loop pauses before another transport.

- [ ] **Step 9: Route every normal terminal state through `finalizeScan`**

Add one helper that constructs the terminal checkpoint, calls `snapshots.finalizeScan`, publishes terminal progress, and returns a `CatalogScanResult`. Use:

- `complete/complete` only with an empty queue;
- `paused/user-canceled`, each budget reason, and `baidu-rate-limited`;
- `partial/<fixed CatalogErrorCode>` for other source failures;
- `pauseReason` set only for the five local pause reasons, and null for rate limiting;
- `retryCount + 1` only for the existing rate-limit outcome;
- one increment in `errorCodeCounts` only for a fixed source error.

Generic exceptions, `snapshot-corrupt`, invalid roots, and the injected crash-window exception must propagate without creating a receipt.

- [ ] **Step 10: Wire the fixed budget and update compatibility fixtures**

In `src/runtime/normal-cloud-catalog-composition.ts`, construct the scanner only as:

```ts
const scanner = new CatalogScanService(source, snapshots, {
  budget: SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET,
});
```

Do not add a budget option to any public runtime/UI interface. Update the scripted results in `tests/unit/catalog/cloud-catalog-connection-runtime.test.ts` with aggregate v2 result/progress fixtures so TypeScript remains green; do not add live runtime behavior there yet.

- [ ] **Step 11: Run GREEN and the build type check**

```bash
npx vitest run tests/integration/catalog-scan.test.ts tests/unit/catalog/local-catalog-snapshot-adapter.test.ts tests/unit/catalog/baidu-catalog-source-adapter.test.ts
npm run build
```

Expected: all focused tests pass and `npm run build` exits 0. The checkpoint must not be taken with an unresolved TypeScript error.

- [ ] **Step 12: Commit Task 3 only**

```bash
git add src/catalog/catalog-scan-service.ts src/adapters/baidu-catalog-source-adapter.ts src/runtime/normal-cloud-catalog-composition.ts tests/integration/catalog-scan.test.ts tests/unit/catalog/baidu-catalog-source-adapter.test.ts tests/unit/catalog/cloud-catalog-connection-runtime.test.ts
git commit -m "feat(目录): 实现预算扫描与逐次请求许可"
```

### Checkpoint E: Stop after Tasks 1–3

- [ ] Record `git rev-parse HEAD` and `git status --short`.
- [ ] Report only actual test/build outcomes; confirm `npm run build` is green or stop on the exact remaining compile failure.
- [ ] Report wrong directions and rework count since the preceding checkpoint.
- [ ] Report available input-token telemetry, PMH recall count/token amount, and contamination finding without memory contents.
- [ ] Confirm the existing large v1 checkpoint was not rewritten or deleted.
- [ ] Stop. Do not begin Task 4 until the user confirms continuation.

### Task 4: Publish aggregate scanner progress through the connection runtime

**Files:**

- Modify: `src/catalog/cloud-catalog-runtime.ts`
- Modify: `src/catalog/cloud-catalog-connection-runtime.ts`
- Modify: `tests/fakes/fake-cloud-catalog-runtime.ts`
- Modify: `tests/unit/catalog/cloud-catalog-connection-runtime.test.ts`

- [ ] **Step 1: Add RED connection subscription and progress tests**

Extend `CatalogScannerPort.scan` with `onProgress`. In the test scanner, retain that callback and expose an `emitProgress` helper. Add a test that:

1. subscribes to the connection runtime;
2. starts an authorized deferred scan;
3. emits scanning progress with PDF 12/1,000, directories 2/20, requests 3/25, elapsed 4,000/120,000;
4. asserts the subscriber fired and `snapshot().scanProgress` equals that aggregate object;
5. resolves paused with `pdf-limit` and asserts the terminal view retains the counts and reason;
6. asserts no root path or filename occurs in `JSON.stringify(snapshot())`.

Add a `CloudCatalogRuntimeService` test or extend the connection test to prove a connection event is forwarded through `catalog.subscribe` and that disposal unsubscribes it.

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/unit/catalog/cloud-catalog-connection-runtime.test.ts
```

Expected: FAIL because connection subscriptions/progress do not exist and the catalog runtime does not forward connection events.

- [ ] **Step 3: Add connection progress and subscription lifecycle**

Extend `CloudCatalogConnectionViewModel` with:

```ts
readonly scanProgress?: CatalogScanProgress;
```

Extend `CloudCatalogConnectionRuntime` with:

```ts
subscribe(listener: () => void): () => void;
```

In `CloudCatalogConnectionRuntimeService`, add a listener set and one `#setViewModel` method that clones progress, assigns the view model, and emits. Replace every direct view-model assignment with that method. Pass scanner progress through `onProgress`, mapping progress status to the existing connection status while retaining only aggregate fields.

When the scan completes, keep `status: "authorized"` and retain terminal `scanProgress.status: "complete"`. For paused/partial, keep the matching connection status and terminal progress. Cancellation resolves as a paused scanner result; remove the old `AbortError` terminal shortcut.

In `CloudCatalogRuntimeService`, subscribe to `connection` in the constructor, forward notifications through the existing `emit()`, and unsubscribe before disposing the connection.

- [ ] **Step 4: Run GREEN**

```bash
npx vitest run tests/unit/catalog/cloud-catalog-connection-runtime.test.ts
npm run build
```

Expected: PASS and build exit 0. Every connection notification remains aggregate-only.

- [ ] **Step 5: Commit Task 4 only**

```bash
git add src/catalog/cloud-catalog-runtime.ts src/catalog/cloud-catalog-connection-runtime.ts tests/fakes/fake-cloud-catalog-runtime.ts tests/unit/catalog/cloud-catalog-connection-runtime.test.ts
git commit -m "feat(目录): 发布扫描聚合进度"
```

### Task 5: Render live settings progress and clear the confirmed session path

**Files:**

- Modify: `src/ui/workbench-controller.ts`
- Modify: `src/ui/settings-tab.ts`
- Modify: `styles.css`
- Modify: `tests/ui/catalog-scan-confirmation-modal.test.ts`
- Modify: `tests/ui/settings-tab.test.ts`

- [ ] **Step 1: Add RED controller ordering and settings DOM tests**

In `tests/ui/catalog-scan-confirmation-modal.test.ts`, lock callback order:

```ts
const events: string[] = [];
connection.beforeStartScan = () => { events.push("start"); };
await controller.requestCatalogScan("/样本", () => { events.push("clear"); });
expect(events).toEqual(["clear", "start"]);
```

Also assert the callback is not invoked when the modal returns false.

In `tests/ui/settings-tab.test.ts`, add a mutable connection snapshot and a captured subscription listener. Assert these data hooks update without calling `display()` again:

- `[data-catalog-connection-status="true"]`
- `[data-catalog-scan-status="true"]`
- `[data-catalog-pdf-progress="true"]`
- `[data-catalog-directory-progress="true"]`
- `[data-catalog-request-progress="true"]`
- `[data-catalog-time-progress="true"]`
- `[data-catalog-stop-reason="true"]`
- `[data-action="catalog-cancel-scan"]`

Expected text at the synthetic progress point:

```text
Connection status: scanning
Scan status: scanning
PDFs: 12 / 1000
Directories: 2 / 20
List requests: 3 / 25
Elapsed: 4000 ms / 120000 ms
Stop reason: —
```

The cancel button is hidden and disabled unless connection status is `scanning`. No element may have `data-action="catalog-resume-scan"`.

Make the fake `requestCatalogScan` invoke its confirmed callback and then wait on a deferred promise. After clicking Start and before resolving that promise, assert the path input is already empty and the delegated path was the prior value.

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/ui/catalog-scan-confirmation-modal.test.ts tests/ui/settings-tab.test.ts
```

Expected: FAIL because settings read a one-time snapshot and the path is not cleared at the confirmation boundary.

- [ ] **Step 3: Add the controller confirmation callback and settings subscription**

Change the settings/controller method signature to:

```ts
requestCatalogScan?(rootPath: string, onConfirmed?: () => void): Promise<void>;
subscribeCatalogConnection?(listener: () => void): () => void;
```

Implement in `WorkbenchController`:

```ts
subscribeCatalogConnection(listener: () => void): () => void {
  if (this.disposed) return () => undefined;
  return this.dependencies.catalog.subscribe(listener);
}

async requestCatalogScan(rootPath: string, onConfirmed?: () => void): Promise<void> {
  if (this.disposed) return;
  const normalized = this.validateCatalogScanRoot(rootPath);
  const connection = this.dependencies.catalog.connection;
  if (connection === undefined) throw new Error("catalog-unavailable");
  const confirmed = await this.dependencies.catalogConfirmation.request(normalized);
  if (this.disposed || !confirmed) return;
  onConfirmed?.();
  await connection.startScan(normalized);
}
```

The callback carries no path or credential data. It runs only after a true modal result and before the runtime call.

- [ ] **Step 4: Render live aggregate settings without rerendering secret inputs**

Add `private unsubscribeCatalogConnection: (() => void) | null = null` to the setting-tab class. Clear any prior subscription at the start of `display()` and in a new `hide()` method. Build fixed status/progress DOM nodes once, then use a local `renderCatalogConnection` function to update only their text and the cancel button state.

Start scan with:

```ts
() => requestCatalogScan(root.value, () => { root.value = ""; })
```

Do not call `display()` from the listener because that would reconstruct credential/code inputs. Do not persist the root in plugin data. Add a small grid style for the aggregate progress block only; never put path text in the progress DOM.

- [ ] **Step 5: Run GREEN**

```bash
npx vitest run tests/ui/catalog-scan-confirmation-modal.test.ts tests/ui/settings-tab.test.ts
npm run build
```

Expected: PASS with event-driven progress, clear-before-start ordering, scanning-only cancel, no resume action, and build exit 0.

- [ ] **Step 6: Commit Task 5 only**

```bash
git add src/ui/workbench-controller.ts src/ui/settings-tab.ts styles.css tests/ui/catalog-scan-confirmation-modal.test.ts tests/ui/settings-tab.test.ts
git commit -m "feat(设置): 显示云目录扫描实时进度"
```

### Task 6: Prove fixed-budget isolation, document the next real gate, and install synthetically

**Files:**

- Modify: `tests/integration/catalog-offline-composition.test.ts`
- Modify: `tests/integration/catalog-small-folder-preflight.test.ts`
- Modify: `tests/packaging/composition-roots.test.ts`
- Modify: `docs/runbooks/baidu-cloud-catalog-small-folder.md`

- [ ] **Step 1: Add the normal-composition budget proof**

In `tests/integration/catalog-offline-composition.test.ts`, run a synthetic authorized scan whose one response contains 21 direct child directories. Assert:

- exactly one list transport occurred;
- the connection ends `paused` with `directory-limit`;
- no active snapshot is created;
- the v2 receipt contains the exact production budget, `listRequestCount: 1`, `directoryCount: 0`, and `downloadedPdfBytes: 0`;
- `NormalCloudCatalogOptions` and the public start-scan API accept no budget value.

In `tests/integration/catalog-small-folder-preflight.test.ts`, extend the existing one-PDF successful case to read the v2 receipt under the temporary application-support root and assert:

```ts
expect(receipt).toMatchObject({
  schemaVersion: 2,
  status: "complete",
  stopReason: "complete",
  budget: {
    maxPdfCount: 1_000,
    maxDirectoryCount: 20,
    maxListRequestCount: 25,
    maxDurationMs: 120_000,
  },
  listRequestCount: 1,
  directoryCount: 0,
  pdfCount: 1,
  ignoredFileCount: 0,
  downloadedPdfBytes: 0,
});
```

- [ ] **Step 2: Run the integration proof**

```bash
npx vitest run tests/integration/catalog-offline-composition.test.ts tests/integration/catalog-small-folder-preflight.test.ts
```

Expected: PASS because Task 3 already injected the frozen production budget. If it fails, fix only the production composition or scanner behavior demonstrated by the assertion; do not weaken the expected limits.

- [ ] **Step 3: Audit the single fixed-budget injection**

Confirm `src/runtime/normal-cloud-catalog-composition.ts` constructs the scanner exactly as:

```ts
const scanner = new CatalogScanService(source, snapshots, {
  budget: SMALL_ACCEPTANCE_CATALOG_SCAN_BUDGET,
});
```

Run `rg -n "maxPdfCount|maxDirectoryCount|maxListRequestCount|maxDurationMs" src` and verify no budget field exists in `NormalCloudCatalogOptions`, `CloudCatalogConnectionRuntime.startScan`, `CatalogScannerPort.scan`, `SettingsController`, plugin settings, modal input, environment parsing, or CLI scripts.

- [ ] **Step 4: Strengthen packaging and no-download assertions**

Keep the acceptance bundle free of the normal scanner, local catalog storage, SecretStorage, OAuth, and Baidu adapters. In `tests/packaging/composition-roots.test.ts`, retain the exact forbidden input list; assert the normal bundle contains `maxListRequestCount` and `maxDurationMs`, while the acceptance bundle contains neither property name. Also assert neither bundle contains a Baidu `method=download`, `filemanager`, or `dlink` capability string.

In the synthetic preflight, assert every captured list request is exact `GET + method=list`, no body is present, and no URL contains `download` or `dlink`. Assert no test creates or writes a PDF file.

- [ ] **Step 5: Update the human runbook without authorizing a real request**

Update `docs/runbooks/baidu-cloud-catalog-small-folder.md` to state:

- implementation verification does not authorize another real OAuth/list operation;
- after Checkpoint F, obtain a new explicit user authorization before any real directory request;
- the user enters the path and any credentials/code only in the local plugin UI, never chat, terminal, source, logs, screenshots, or PMH;
- the candidate is non-sensitive, non-root, ideally 20–100 PDFs and one or two levels, with client-side PDF/directory/other-file counts prepared first;
- success requires `complete`, exact count agreement, list requests at most 25, no fixed errors, and `downloaded_pdf_bytes=0`;
- any budget pause is safe but is not acceptance success;
- stop after that one directory; do not proceed to the 70,000-PDF mode without a separate approved design.

Keep the evidence whitelist aggregate-only:

```text
authorization_status=<success|canceled|blocked>
scan_status=<complete|partial|paused|blocked>
list_request_count=<integer>
directory_count=<integer>
pdf_count=<integer>
ignored_file_count=<integer>
downloaded_pdf_bytes=0
error_codes=<fixed codes only>
duration_ms=<integer>
client_count_match=<yes|no|not-available>
```

- [ ] **Step 6: Run focused and full automated gates**

Run in this order:

```bash
npx vitest run tests/unit/catalog/catalog-scan-contracts.test.ts tests/unit/catalog/local-catalog-snapshot-adapter.test.ts tests/integration/catalog-scan.test.ts tests/unit/catalog/baidu-catalog-source-adapter.test.ts tests/unit/catalog/cloud-catalog-connection-runtime.test.ts tests/ui/catalog-scan-confirmation-modal.test.ts tests/ui/settings-tab.test.ts tests/integration/catalog-offline-composition.test.ts tests/integration/catalog-small-folder-preflight.test.ts tests/packaging/composition-roots.test.ts
npm run lint
npm test
npm run build
npm run build:acceptance
git diff --check
```

Expected: every command exits 0. Record exact test counts and durations from actual output; do not estimate them.

Do not run `test:catalog-performance`, old experiment scripts, real OAuth, or a real Baidu request in this task.

- [ ] **Step 7: Install the verified normal artifact only into the dedicated synthetic Vault**

First verify the existing dedicated destination and its synthetic marker through the guarded installer; do not create another Vault or repository. Then run:

```bash
OBSIDIAN_DEV_VAULT="/Users/example/Documents/obsidian-knowledge-workbench/.dev-vault/baidu-catalog-oob" npm run install:dev
```

Expected: build succeeds and the guarded installer updates only `main.js`, `manifest.json`, and `styles.css` under that marked synthetic Vault. It must not launch OAuth, call Baidu, read a cloud path, alter the real Vault, or touch the external legacy checkpoint.

If the marker/preflight rejects the destination, stop and report the fixed installer error. Do not bypass it, create a replacement Vault, or broaden the destination.

- [ ] **Step 8: Commit Task 6 only**

```bash
git add tests/integration/catalog-offline-composition.test.ts tests/integration/catalog-small-folder-preflight.test.ts tests/packaging/composition-roots.test.ts docs/runbooks/baidu-cloud-catalog-small-folder.md
git commit -m "chore(目录): 接入并验证小样本安全闸"
```

### Checkpoint F: Stop before any second real directory request

- [ ] Record `git rev-parse HEAD`, `git status --short`, and the installed artifact verification result.
- [ ] Report implemented behavior and only the tests/build/install commands actually executed with their actual outcomes.
- [ ] Report wrong directions and rework count since Checkpoint E.
- [ ] Report available input-token telemetry, PMH recall count/token amount, and contamination finding without memory contents.
- [ ] Confirm no real OAuth/list request ran, no PDF bytes were downloaded, no real Vault note changed, and the legacy large checkpoint remains untouched.
- [ ] Stop and request fresh explicit authorization for exactly one user-selected non-sensitive, non-root small directory. Do not request its path, AppKey, SecretKey, or authorization code in chat.
- [ ] Do not start the 70,000-PDF design or a control-model experiment.

## Final self-review before executing this plan

- Every approved design requirement maps to a named task/test above.
- Tasks 1–6 contain no real network action; the only network-like behavior is deterministic synthetic transport in tests.
- v1 persistence remains a separate exact decoder and legacy method; the new scanner rejects all pre-existing scan IDs.
- Request counts are persisted before the corresponding list transport and include a single refresh replay.
- Candidate pages are all-or-nothing for PDF/directory budgets.
- Every normal terminal outcome gets one strict aggregate v2 receipt; crash-window exits do not.
- Only complete v2 scans may replace `active.json`.
- The settings surface never stores or echoes the path and does not expose resume.
- Production budget values have exactly one composition source and no user override path.
- Checkpoints force a stop after three implementation tasks and again before real acceptance.
