# Baidu Netdisk Cloud Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Build a catalog-only Obsidian workflow that indexes PDF metadata from a user-confirmed Baidu Netdisk path without downloading PDF content or writing catalog data into the Vault. The user has accepted the official account-wide `basic,netdisk` OAuth range, while product code remains restricted to read-only directory listing.

**Architecture:** Keep the existing Vault-facing DocumentRecord pipeline unchanged. Add a separate catalog domain, a Vault-external atomic NDJSON snapshot store, a serial resumable scanner, and a paginated Cloud Catalog tab; compose official OOB OAuth and Baidu list access only in the normal entry point after the user explicitly accepts the broad OAuth range. Authorization never triggers enumeration, and the network adapter exposes only the documented list request.

**Tech Stack:** TypeScript 5.8, Vitest 4, Obsidian 1.13 APIs, Node filesystem/crypto primitives available in Obsidian Desktop, json-bigint 1.0.0, official Baidu OAuth authorization-code flow with `redirect_uri=oob`, and GET /rest/2.0/xpan/file?method=list.

---

## Approved source and non-negotiable boundaries

Implement against:

- Design: docs/superpowers/specs/2026-08-05-baidu-netdisk-cloud-catalog-design.md
- Official file-list documentation: https://pan.baidu.com/union/doc/基础网盘服务/获取文件信息/获取文件列表/
- Official authorization-code documentation: https://pan.baidu.com/union/doc/使用入门/接入授权/授权码模式/
- Official callback documentation: https://pan.baidu.com/union/doc/使用入门/接入授权/授权回调地址/
- Official authorization FAQ: https://pan.baidu.com/union/doc/使用入门/接入授权/faq/
- Official current permission documentation: https://pan.baidu.com/union/doc/使用入门/权限与配额/
- Official common error-code documentation: https://pan.baidu.com/union/doc/平台简介/错误码/

The implementation must not:

- download, preview, parse, OCR, embed, summarize, upload, move, rename, delete, copy, or share a PDF;
- enumerate any directory merely because OAuth succeeded;
- store AppKey, SecretKey, access token, refresh token, cloud path, filename, or catalog snapshot in plugin data, Git, the real Vault, logs, PMH records, or test snapshots;
- import CloudCatalogRecord into Today, Knowledge Map, Suggestions, History, transactions, or AI;
- expose request URLs in errors because the official endpoints carry credentials in URL parameters;
- import requestUrl, secretStorage, Baidu adapters, or Node external-catalog filesystem adapters into src/main-acceptance.ts;
- use cookies, account passwords, browser automation, unofficial APIs, listall, download, filemanager, or an unrestricted Baidu request executor.

## Feasibility gates discovered from current official documentation

These gates are part of the implementation, not assumptions:

1. The official authorization FAQ says a local callback address is not allowed. The callback guide and authorization-code guide document `redirect_uri=oob`; after the loopback gate failed closed, the user explicitly approved the OOB revision on 2026-08-05. No implementation may bind a local HTTP listener, register localhost, or silently substitute another domain.
2. The official authorization surface exposes the account-wide `basic,netdisk` read/write range and no folder selector. On 2026-08-05 the user explicitly accepted that broad external scope. Product capability remains narrower: OAuth, token exchange, and exact `GET + method=list` requests for a user-entered path only. Permission/interface errors -7, 31024, or 20013 and application-access errors 20011 or 20015 are stop signals, not reasons to enumerate parents or add write capabilities; rate-limit errors 20012 or 31034 pause the scan without changing scope.
3. A personal application is acceptable only if the official console allows the required personal-use software application, `redirect_uri=oob`, and `basic,netdisk` scope. A displayed OOB authorization code must never be pasted into chat, terminal history, a project file, a screenshot, or the runbook; real exchange starts only after credential storage and the bounded OOB adapter pass automated isolation tests.

## File responsibility map

| File | Responsibility |
| --- | --- |
| src/catalog/catalog-types.ts | Catalog-only records, scan state, snapshot metadata, stable error codes |
| src/catalog/catalog-ports.ts | Narrow snapshot, source, credential, browser, clipboard, and confirmation ports |
| src/catalog/catalog-codec.ts | Strict path normalization, ISBN candidates, raw Baidu JSON decoding with exact fs_id strings |
| src/catalog/catalog-scan-service.ts | Serial breadth-first paging, checkpointing, cancellation, and atomic promotion |
| src/catalog/catalog-search-service.ts | Immutable normalized index and stable paginated search |
| src/catalog/cloud-catalog-runtime.ts | Catalog view state and actions without Vault, AI, or transaction dependencies |
| src/catalog/disabled-cloud-catalog-runtime.ts | Network-free and filesystem-free acceptance-build implementation |
| src/adapters/local-catalog-snapshot-adapter.ts | 0700/0600 Vault-external NDJSON/checkpoint/receipt storage |
| src/adapters/obsidian-baidu-credential-adapter.ts | Strict secretStorage bundle read, replace, and revoke |
| src/adapters/baidu-oauth-adapter.ts | Exact OOB authorize/token/refresh endpoints and bounded manual-code attempt state |
| src/adapters/baidu-catalog-source-adapter.ts | Exact GET method=list request construction and stable error mapping |
| src/ui/cloud-catalog-tab.ts | Search/filter/pagination/result actions |
| src/ui/catalog-scan-confirmation-modal.ts | Explicit root, recursive scope, and no-download confirmation |
| src/ui/workbench-controller.ts | Delegate catalog actions and subscribe to the separate catalog runtime |
| src/ui/workbench-view.ts | Add the Cloud Catalog tab without mixing catalog records into other tabs |
| src/ui/settings-tab.ts | Credential status, OOB authorization-code input, scan-root entry, and explicit start controls |
| src/runtime/runtime-composition.ts | Inject normal or disabled catalog runtime factory |
| src/plugin/knowledge-workbench-plugin.ts | Own and dispose the catalog runtime alongside existing services |
| src/main.ts | Compose Node storage, secret storage, browser, clipboard, OAuth, and list adapters |
| src/main-acceptance.ts | Compose only the disabled catalog runtime |
| tests/fakes/fake-cloud-catalog-runtime.ts | Deterministic UI and controller fixture |
| tests/unit/catalog/*.test.ts | Contract, codec, snapshot, search, OAuth, and source tests |
| tests/integration/catalog-scan.test.ts | Resume, cancellation, partial failure, and promotion tests |
| tests/ui/cloud-catalog-tab.test.ts | Accessible catalog rendering and explicit actions |
| tests/ui/settings-tab.test.ts | No automatic OAuth/list calls and safe settings errors |
| tests/packaging/composition-roots.test.ts | Prove normal-only network/secret/filesystem dependencies stay out of acceptance |
| tests/performance/catalog-search.bench.test.ts | Normal 100,000-record product fixture and 50-query p95 |
| docs/runbooks/baidu-cloud-catalog-small-folder.md | Human-authorized real small-directory procedure and evidence whitelist |
| docs/runbooks/baidu-cloud-catalog-directory-scope-gate.md | Manual no-exchange check for personal app, OOB page, and existing-directory selection |

## Checkpoint schedule

- Checkpoint A after Tasks 1–4: catalog contracts, storage, scan engine, and search performance.
- Checkpoint B after Tasks 5–8: disabled runtime, controller/view, settings confirmation, and composition-root isolation.
- Checkpoint C at the Task 9 loopback failure: official feasibility evidence and fail-closed stop; the user then approved the OOB design revision.
- Checkpoint D after the revised Task 9 plus Tasks 10–13: OOB feasibility evidence, credentials, OOB OAuth, list adapter, real small-directory acceptance, and final verification.
- At every checkpoint, stop and report the Git commit, implemented functions, executed tests, wrong directions/rework, available input-token statistics, PMH recall count/token estimate, and cross-project/model contamination finding. Never report recalled memory or cloud metadata.

### Task 1: Lock the separate catalog domain and strict Baidu codec

**Files:**

- Modify: package.json
- Modify: package-lock.json
- Create: src/catalog/catalog-types.ts
- Create: src/catalog/catalog-ports.ts
- Create: src/catalog/catalog-codec.ts
- Test: tests/unit/catalog/catalog-codec.test.ts

- [ ] **Step 1: Add RED codec tests**

Create tests/unit/catalog/catalog-codec.test.ts with these cases:

~~~ts
import { describe, expect, it } from "vitest";
import {
  decodeBaiduListResponse,
  isbnCandidatesFromFilename,
  normalizeCloudAbsolutePath,
} from "../../../src/catalog/catalog-codec";

describe("catalog codec", () => {
  it("keeps uint64 fs_id exact and accepts only the required list fields", () => {
    const raw = "{\"errno\":0,\"list\":[{\"fs_id\":9007199254740993,\"path\":\"/书库/例子.pdf\",\"server_filename\":\"例子.pdf\",\"size\":7,\"server_mtime\":11,\"isdir\":0}]}";
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

  it("normalizes NFC but rejects relative, traversal, control, and backslash paths", () => {
    expect(normalizeCloudAbsolutePath("/资料/e\u0301.pdf")).toBe("/资料/é.pdf");
    for (const value of ["资料/a.pdf", "/资料/../a.pdf", "/资料/\u0000.pdf", "\\资料\\a.pdf"]) {
      expect(() => normalizeCloudAbsolutePath(value)).toThrow("invalid-scan-root");
    }
  });

  it("extracts normalized ISBN candidates without claiming verification", () => {
    expect(isbnCandidatesFromFilename("书名 ISBN 978-7-03-012345-6.pdf")).toEqual(["9787030123456"]);
    expect(isbnCandidatesFromFilename("no-isbn.pdf")).toEqual([]);
  });

  it("maps nonzero errno without retaining raw response text", () => {
    expect(() => decodeBaiduListResponse("{\"errno\":-7,\"list\":[]}")).toThrow("baidu-permission-denied");
  });
});
~~~

- [ ] **Step 2: Run the RED test**

Run:

~~~bash
npx vitest run tests/unit/catalog/catalog-codec.test.ts
~~~

Expected: FAIL because src/catalog/catalog-codec.ts does not exist.

- [ ] **Step 3: Add exact record and port contracts**

Define CloudCatalogRecord independently from DocumentRecord:

~~~ts
export interface CloudCatalogRecord {
  readonly schemaVersion: 1;
  readonly source: "baidu-netdisk";
  readonly fsId: string;
  readonly kind: "file";
  readonly path: string;
  readonly parentPath: string;
  readonly filename: string;
  readonly extension: "pdf";
  readonly title: string;
  readonly isbnCandidates: readonly string[];
  readonly sizeBytes: number;
  readonly serverModifiedAt: number;
}

export interface CloudCatalogDirectory {
  readonly schemaVersion: 1;
  readonly source: "baidu-netdisk";
  readonly fsId: string;
  readonly kind: "directory";
  readonly path: string;
  readonly parentPath: string;
  readonly filename: string;
  readonly sizeBytes: 0;
  readonly serverModifiedAt: number;
}

export type CatalogSnapshotRecord = CloudCatalogRecord | CloudCatalogDirectory;
export type CatalogErrorCode =
  | "authorization-canceled"
  | "authorization-attempt-unavailable"
  | "authorization-attempt-expired"
  | "authorization-code-invalid"
  | "authorization-exchange-failed"
  | "credentials-unavailable"
  | "invalid-scan-root"
  | "baidu-permission-denied"
  | "baidu-not-found"
  | "baidu-rate-limited"
  | "baidu-token-expired"
  | "baidu-access-unavailable"
  | "invalid-baidu-response"
  | "snapshot-corrupt";

export class CatalogError extends Error {
  constructor(readonly code: CatalogErrorCode, readonly retryable = false) {
    super(code);
    this.name = "CatalogError";
  }
}

export interface BaiduListEntry {
  readonly fsId: string;
  readonly path: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly serverModifiedAt: number;
  readonly isDirectory: boolean;
}

export interface CatalogScanCheckpoint {
  readonly schemaVersion: 1;
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

export interface CatalogSnapshotDescriptor {
  readonly snapshotId: string;
  readonly schemaVersion: 1;
  readonly completedAt: number;
  readonly recordCount: number;
  readonly pdfCount: number;
  readonly sha256: string;
}

export interface CatalogScanReceipt {
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

export interface CatalogScanResult {
  readonly status: "complete" | "paused" | "partial";
  readonly descriptor?: CatalogSnapshotDescriptor;
  readonly errorCode?: CatalogErrorCode;
}

export interface CatalogScanProgress {
  readonly directoryCount: number;
  readonly completedDirectoryCount: number;
  readonly pdfCount: number;
  readonly ignoredFileCount: number;
  readonly pendingDirectoryCount: number;
}
~~~

In src/catalog/catalog-ports.ts define only purpose-specific methods:

~~~ts
import type {
  CatalogScanCheckpoint,
  CatalogSnapshotDescriptor,
  CatalogSnapshotRecord,
} from "./catalog-types";

export interface BaiduCatalogSourcePort {
  listDirectory(input: Readonly<{ path: string; start: number; limit: 1000 }>): Promise<Readonly<{
    entries: readonly Readonly<{
      fsId: string;
      path: string;
      filename: string;
      sizeBytes: number;
      serverModifiedAt: number;
      isDirectory: boolean;
    }>[];
  }>>;
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
  promoteScan(scanId: string, completedAt: number): Promise<CatalogSnapshotDescriptor>;
  loadActive(): Promise<Readonly<{
    descriptor: CatalogSnapshotDescriptor;
    records: readonly CatalogSnapshotRecord[];
  }> | null>;
}
~~~

The scan types above are the complete persisted shape. Do not add token fields, account identity, or request URLs.

- [ ] **Step 4: Implement strict decoding**

Add json-bigint 1.0.0 and @types/json-bigint 1.0.4, configure storeAsString, and decode from response text before any native JSON.parse:

~~~ts
import JSONbigFactory from "json-bigint";
import { CatalogError, type BaiduListEntry } from "./catalog-types";

const parseJson = JSONbigFactory({ storeAsString: true, strict: true }).parse;
export const normalizeCloudAbsolutePath = (value: string): string => {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\\") || /\p{Cc}/u.test(value)) {
    throw new CatalogError("invalid-scan-root");
  }
  const normalized = value.normalize("NFC");
  const segments = normalized.split("/").slice(1);
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    if (normalized !== "/") throw new CatalogError("invalid-scan-root");
  }
  return normalized;
};
export const isbnCandidatesFromFilename = (filename: string): readonly string[] => {
  const matches = filename.normalize("NFC").match(/(?:97[89][\d -]{10,20}[\dXx]|\d[\d -]{8,15}[\dXx])/gu) ?? [];
  return [...new Set(matches
    .map((value) => value.replace(/[^\dXx]/gu, "").toLocaleUpperCase("en-US"))
    .filter((value) => value.length === 10 || value.length === 13))]
    .sort();
};
const asRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CatalogError("invalid-baidu-response");
  }
  return value as Readonly<Record<string, unknown>>;
};
const finiteInteger = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new CatalogError("invalid-baidu-response");
  }
  return value;
};
const decimalId = (value: unknown): string => {
  if (typeof value === "string" && /^(0|[1-9]\d*)$/u.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new CatalogError("invalid-baidu-response");
};
const mapBaiduErrno = (errno: number): CatalogError => {
  if (errno === -6 || errno === 31045) return new CatalogError("baidu-token-expired");
  if (errno === -7 || errno === 31024 || errno === 20013) {
    return new CatalogError("baidu-permission-denied");
  }
  if (errno === -9) return new CatalogError("baidu-not-found");
  if (errno === 20012 || errno === 31034) {
    return new CatalogError("baidu-rate-limited", true);
  }
  if (errno === 20011 || errno === 20015) return new CatalogError("baidu-access-unavailable");
  return new CatalogError("baidu-access-unavailable");
};
const decodeEntry = (value: unknown): BaiduListEntry => {
  const object = asRecord(value);
  if (typeof object.path !== "string" || typeof object.server_filename !== "string") {
    throw new CatalogError("invalid-baidu-response");
  }
  const path = normalizeCloudAbsolutePath(object.path);
  const filename = object.server_filename.normalize("NFC");
  const sizeBytes = finiteInteger(object.size);
  const serverModifiedAt = finiteInteger(object.server_mtime);
  const isdir = finiteInteger(object.isdir);
  if (filename.length === 0 || sizeBytes < 0 || serverModifiedAt < 0 || (isdir !== 0 && isdir !== 1)) {
    throw new CatalogError("invalid-baidu-response");
  }
  return {
    fsId: decimalId(object.fs_id),
    path,
    filename,
    sizeBytes,
    serverModifiedAt,
    isDirectory: isdir === 1,
  };
};

export function decodeBaiduListResponse(raw: string): Readonly<{ entries: readonly BaiduListEntry[] }> {
  let value: unknown;
  try {
    value = parseJson(raw);
  } catch {
    throw new CatalogError("invalid-baidu-response");
  }
  const object = asRecord(value);
  const errno = finiteInteger(object.errno);
  if (errno !== 0) throw mapBaiduErrno(errno);
  if (!Array.isArray(object.list)) throw new CatalogError("invalid-baidu-response");
  return { entries: object.list.map(decodeEntry) };
}
~~~

Do not include raw, URLs, filenames, paths, or credential values in thrown messages.

Install the pinned parser before running GREEN:

~~~bash
npm install --save-exact json-bigint@1.0.0
npm install --save-dev --save-exact @types/json-bigint@1.0.4
~~~

- [ ] **Step 5: Run GREEN and commit**

Run:

~~~bash
npx vitest run tests/unit/catalog/catalog-codec.test.ts
npm run build
git add package.json package-lock.json src/catalog tests/unit/catalog/catalog-codec.test.ts
git commit -m "feat(目录): 建立云端目录领域契约"
~~~

Expected: focused tests and type-check pass; the commit contains no Vault or plugin-data change.

### Task 2: Build the Vault-external atomic snapshot adapter

**Files:**

- Create: src/adapters/local-catalog-snapshot-adapter.ts
- Test: tests/unit/catalog/local-catalog-snapshot-adapter.test.ts

- [ ] **Step 1: Add RED filesystem tests**

Use mkdtemp under os.tmpdir(), never a Vault path. Define the fixtures and assert:

~~~ts
const checkpoint = (rootPath: string): CatalogScanCheckpoint => ({
  schemaVersion: 1,
  scanId: "scan-1",
  rootPath,
  startedAt: 1,
  pending: [{ path: rootPath, start: 0 }],
  committedPageKeys: [],
  completedDirectoryCount: 0,
  directoryCount: 0,
  pdfCount: 0,
  ignoredFileCount: 0,
  errorCodeCounts: {},
  retryCount: 0,
  status: "scanning",
});
const pdfRecord = (path: string): CloudCatalogRecord => ({
  schemaVersion: 1,
  source: "baidu-netdisk",
  fsId: "1",
  kind: "file",
  path,
  parentPath: "/样本",
  filename: "A.pdf",
  extension: "pdf",
  title: "A",
  isbnCandidates: [],
  sizeBytes: 7,
  serverModifiedAt: 11,
});
const adapter = new LocalCatalogSnapshotAdapter(root);
const initial = checkpoint("/样本");
await adapter.createScan(initial);
await adapter.commitPage({
  scanId: "scan-1",
  pageKey: "0".repeat(64),
  records: [pdfRecord("/样本/A.pdf")],
  nextCheckpoint: {
    ...initial,
    pending: [],
    committedPageKeys: ["0".repeat(64)],
    completedDirectoryCount: 1,
    pdfCount: 1,
  },
});
const promoted = await adapter.promoteScan("scan-1", 100);

expect(promoted.recordCount).toBe(1);
expect((await adapter.loadActive())?.records).toEqual([pdfRecord("/样本/A.pdf")]);
expect((await stat(root)).mode & 0o777).toBe(0o700);
expect((await stat(join(root, "active.json"))).mode & 0o777).toBe(0o600);
~~~

Also inject failures before page-state rename, before checkpoint rename, and before active rename. Prove loadScan either exposes the prior checkpoint or recovers the fully committed page, while active.json and the previous snapshot remain byte-for-byte unchanged. Corrupt one NDJSON line and prove loadActive() throws only snapshot-corrupt.

- [ ] **Step 2: Run the RED test**

Run:

~~~bash
npx vitest run tests/unit/catalog/local-catalog-snapshot-adapter.test.ts
~~~

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement bounded paths and permissions**

The constructor must accept an already resolved root and reject symlinked/non-directory ancestors. Create:

~~~text
<root>/
  active.json
  snapshots/<snapshot-id>/catalog.ndjson
  scans/<scan-id>/checkpoint.json
  scans/<scan-id>/pages/<page-key>.ndjson
  scans/<scan-id>/pages/<page-key>.state.json
  scans/<scan-id>/receipt.json
~~~

Use mkdir mode 0700, file mode 0600, lstat/realpath checks, scan IDs limited to /^[a-z0-9][a-z0-9-]{0,63}$/u, and join only validated path segments. Never accept an arbitrary filesystem destination from a cloud path.

- [ ] **Step 4: Implement append, validate, hash, and atomic promotion**

Write one canonical JSON object per line. page-key is the lowercase SHA-256 of normalized path, a NUL separator, and decimal start; it never exposes the cloud path in a filename. commitPage writes the NDJSON page and a state file containing nextCheckpoint with unique temporary files and atomic renames, then updates checkpoint.json. Repeating the same page key with the same content is a no-op; a different hash is snapshot-corrupt. loadScan validates the committed-page chain and recovers the newest nextCheckpoint even if the process stopped before checkpoint.json was replaced. saveScanState may change only status, retryCount, and errorCodeCounts without changing pending, committedPageKeys, or item counters.

On promotion, concatenate page files strictly in committedPageKeys order:

~~~ts
await concatenateCommittedPages(scanDirectory, snapshotCandidatePath);
await validateCandidate(snapshotCandidatePath);
const sha256 = await hashFile(snapshotCandidatePath);
await mkdir(snapshotDirectory, { mode: 0o700 });
await rename(snapshotCandidatePath, join(snapshotDirectory, "catalog.ndjson"));
await writeJsonAtomic(receiptPath, receipt, 0o600);
await writeJsonAtomic(activePath, descriptor, 0o600);
~~~

writeJsonAtomic must create a unique sibling temporary file with wx mode, fsync the file, close it, rename it, and fsync the parent directory. A failed candidate never replaces active.json. validateCandidate rejects duplicate fsId values, duplicate paths, and mismatched parent paths across committed pages. loadActive() must recompute the hash and strict-decode every record.

- [ ] **Step 5: Run GREEN and commit**

Run:

~~~bash
npx vitest run tests/unit/catalog/local-catalog-snapshot-adapter.test.ts
npm run build
git add src/adapters/local-catalog-snapshot-adapter.ts tests/unit/catalog/local-catalog-snapshot-adapter.test.ts
git commit -m "feat(目录): 增加外部原子快照存储"
~~~

Expected: permissions, corruption, symlink, and atomic-failure tests pass.

### Task 3: Implement the serial resumable breadth-first scanner

**Files:**

- Create: src/catalog/catalog-scan-service.ts
- Test: tests/integration/catalog-scan.test.ts

- [ ] **Step 1: Add RED scanner tests**

Create a scripted source with two pages and a child directory. Assert call order and promotion:

~~~ts
expect(source.calls).toEqual([
  { path: "/样本", start: 0, limit: 1000 },
  { path: "/样本/子目录", start: 0, limit: 1000 },
]);
expect(source.maximumConcurrentCalls).toBe(1);
expect(result.status).toBe("complete");
expect((await snapshots.loadActive())?.descriptor.pdfCount).toBe(2);
~~~

Add cases for a full 1000-entry page followed by start 1000, cancellation after a saved page, resume without repeating completed pages, duplicate fsId/path rejection, ignored non-PDF counts, -7 partial state, and rate-limit retry state. Assert partial scans never call promoteScan.

- [ ] **Step 2: Run the RED test**

Run:

~~~bash
npx vitest run tests/integration/catalog-scan.test.ts
~~~

Expected: FAIL because CatalogScanService does not exist.

- [ ] **Step 3: Implement one-call-at-a-time BFS**

Use a queue whose head retains its next start value:

~~~ts
const catalogPageKey = (path: string, start: number): Promise<string> =>
  sha256(path.normalize("NFC") + "\u0000" + String(start));

const convertEntries = (entries: readonly BaiduListEntry[]): Readonly<{
  records: readonly CatalogSnapshotRecord[];
  childDirectories: readonly string[];
  directoryCount: number;
  pdfCount: number;
  ignoredFileCount: number;
}> => {
  const records: CatalogSnapshotRecord[] = [];
  const childDirectories: string[] = [];
  let directoryCount = 0;
  let pdfCount = 0;
  let ignoredFileCount = 0;
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    const parentPath = entry.path.slice(0, entry.path.lastIndexOf("/")) || "/";
    if (entry.isDirectory) {
      directoryCount += 1;
      childDirectories.push(entry.path);
      records.push({
        schemaVersion: 1,
        source: "baidu-netdisk",
        fsId: entry.fsId,
        kind: "directory",
        path: entry.path,
        parentPath,
        filename: entry.filename,
        sizeBytes: 0,
        serverModifiedAt: entry.serverModifiedAt,
      });
    } else if (entry.filename.toLocaleLowerCase("en-US").endsWith(".pdf")) {
      pdfCount += 1;
      records.push({
        schemaVersion: 1,
        source: "baidu-netdisk",
        fsId: entry.fsId,
        kind: "file",
        path: entry.path,
        parentPath,
        filename: entry.filename,
        extension: "pdf",
        title: entry.filename.slice(0, -4),
        isbnCandidates: isbnCandidatesFromFilename(entry.filename),
        sizeBytes: entry.sizeBytes,
        serverModifiedAt: entry.serverModifiedAt,
      });
    } else {
      ignoredFileCount += 1;
    }
  }
  return { records, childDirectories, directoryCount, pdfCount, ignoredFileCount };
};

const advanceCheckpoint = (
  checkpoint: CatalogScanCheckpoint,
  current: Readonly<{ path: string; start: number }>,
  sourceEntryCount: number,
  converted: ReturnType<typeof convertEntries>,
  pageKey: string,
): CatalogScanCheckpoint => {
  const pageContinues = sourceEntryCount === 1000;
  const tail = checkpoint.pending.slice(1);
  const nextHead = pageContinues ? [{ path: current.path, start: current.start + 1000 }] : [];
  const queued = new Set([...nextHead, ...tail].map((item) => item.path));
  const children = converted.childDirectories
    .filter((path) => {
      if (queued.has(path)) return false;
      queued.add(path);
      return true;
    })
    .map((path) => ({ path, start: 0 }));
  return {
    ...checkpoint,
    pending: [...nextHead, ...tail, ...children],
    committedPageKeys: [...checkpoint.committedPageKeys, pageKey],
    completedDirectoryCount: checkpoint.completedDirectoryCount + (pageContinues ? 0 : 1),
    directoryCount: checkpoint.directoryCount + converted.directoryCount,
    pdfCount: checkpoint.pdfCount + converted.pdfCount,
    ignoredFileCount: checkpoint.ignoredFileCount + converted.ignoredFileCount,
    status: "scanning",
  };
};

while (checkpoint.pending.length > 0) {
  throwIfAborted(signal);
  const current = checkpoint.pending[0]!;
  const page = await source.listDirectory({ path: current.path, start: current.start, limit: 1000 });
  const converted = convertEntries(page.entries);
  const pageKey = await catalogPageKey(current.path, current.start);
  const next = advanceCheckpoint(checkpoint, current, page.entries.length, converted, pageKey);
  await snapshots.commitPage({
    scanId: checkpoint.scanId,
    pageKey,
    records: converted.records,
    nextCheckpoint: next,
  });
  checkpoint = next;
  onProgress(toProgress(checkpoint));
}
~~~

If page.entries.length is 1000, advance start by 1000 and keep the directory at the queue head. Otherwise remove it and continue with queued child directories. Sort child directories by normalized path before enqueueing. Do not use Promise.all.

- [ ] **Step 4: Implement safe stop and resume semantics**

On startup, call loadScan and continue from its recovered checkpoint and committed-page chain. Permission, missing-directory, unrecoverable response, and refresh failure call saveScanState with status partial before returning. Rate limiting calls saveScanState with status paused and increments retryCount once, without a tight retry loop. Cancellation waits for the latest commitPage, saves paused state, and then throws AbortError. Only an empty pending queue can call promoteScan.

- [ ] **Step 5: Run GREEN and commit**

Run:

~~~bash
npx vitest run tests/integration/catalog-scan.test.ts
npm run build
git add src/catalog/catalog-scan-service.ts tests/integration/catalog-scan.test.ts
git commit -m "feat(目录): 实现串行可恢复目录扫描"
~~~

Expected: complete, partial, paused, cancellation, and resume tests pass.

### Task 4: Add immutable search and the 100,000-record product gate

**Files:**

- Create: src/catalog/catalog-search-service.ts
- Create: tests/unit/catalog/catalog-search-service.test.ts
- Create: tests/performance/catalog-search.bench.test.ts
- Modify: package.json
- Modify: package-lock.json

- [ ] **Step 1: Add RED search tests**

Lock title, path, ISBN, folder, stable order, pagination, and detached returns:

~~~ts
const search = new CatalogSearchService(records);
expect(search.query({ text: "因果", offset: 0, limit: 50 }).items.map((item) => item.path))
  .toEqual(["/统计/因果推断.pdf", "/统计/现代因果分析.pdf"]);
expect(search.query({ text: "9787030123456", offset: 0, limit: 50 }).items).toHaveLength(1);
expect(search.query({ text: "", folderPrefix: "/统计", offset: 0, limit: 1 })).toMatchObject({
  total: 2,
  offset: 0,
  limit: 1,
});
~~~

Mutate a returned array and prove a second query is unchanged.

- [ ] **Step 2: Run the RED test**

Run:

~~~bash
npx vitest run tests/unit/catalog/catalog-search-service.test.ts
~~~

Expected: FAIL because the search service does not exist.

- [ ] **Step 3: Implement a pre-normalized immutable index**

At construction, retain only kind=file records, clone them, sort by path then fsId, and precompute normalized filename/title/path plus search tokens. Maintain an ISBN map and token-to-record-index map. Query processing must intersect useful token postings, verify final substring matches against normalized fields, apply the folder prefix, and return clones.

~~~ts
export interface CatalogSearchQuery {
  readonly text: string;
  readonly folderPrefix?: string;
  readonly modifiedAfter?: number;
  readonly offset: number;
  readonly limit: number;
}

export interface CatalogSearchPage {
  readonly items: readonly CloudCatalogRecord[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
}
~~~

Reject non-integer or negative offsets and limits outside 1–50. Single-character and punctuation-only queries may scan the pre-normalized array, but must still apply the requested page limit and the 50-item maximum.

- [ ] **Step 4: Add and run the normal product performance fixture**

Generate 100,000 in-memory records with deterministic Chinese/English titles and paths. Build once, execute 50 fixed queries, and use nearest-rank p95:

~~~ts
expect(buildElapsedMs).toBeLessThanOrEqual(10_000);
expect(percentile95(queryTimesMs)).toBeLessThanOrEqual(250);
expect(resultSizes.every((size) => size <= 50)).toBe(true);
~~~

Add:

~~~json
"test:catalog-performance": "KNOWLEDGE_WORKBENCH_PERFORMANCE=1 vitest run tests/performance/catalog-search.bench.test.ts --no-file-parallelism --maxWorkers=1 --testTimeout=180000 --reporter=verbose"
~~~

Run:

~~~bash
npx vitest run tests/unit/catalog/catalog-search-service.test.ts
npm run test:catalog-performance
npm run build
~~~

Expected: correctness tests pass; build is at most 10 seconds and 50-query p95 is at most 250 ms on the target Mac. This is a normal product fixture, not a PMH or long-context pressure script.

- [ ] **Step 5: Commit and stop at Checkpoint A**

Run:

~~~bash
git add package.json package-lock.json src/catalog/catalog-search-service.ts tests/unit/catalog/catalog-search-service.test.ts tests/performance/catalog-search.bench.test.ts
git commit -m "perf(目录): 建立十万条目录检索门"
~~~

Stop and report Checkpoint A before starting UI work.

### Task 5: Add an isolated catalog runtime and acceptance-safe disabled runtime

**Files:**

- Create: src/catalog/cloud-catalog-runtime.ts
- Create: src/catalog/disabled-cloud-catalog-runtime.ts
- Create: tests/fakes/fake-cloud-catalog-runtime.ts
- Test: tests/unit/catalog/cloud-catalog-runtime.test.ts

- [ ] **Step 1: Add RED runtime-state tests**

Assert initialization states no-snapshot, ready, corrupt, and unavailable; search state; page boundaries; copy/open delegation; and disposal:

~~~ts
expect(runtime.snapshot()).toMatchObject({ status: "no-snapshot", query: "", page: 0, pageSize: 50 });
await runtime.initialize();
runtime.setQuery("统计");
expect(runtime.snapshot()).toMatchObject({ status: "ready", total: 2, page: 0 });
await runtime.copyCloudPath("fs-1");
expect(actions.copied).toEqual(["/统计/因果推断.pdf"]);
~~~

The disabled runtime must expose status unavailable and make every network/scan action return catalog-unavailable without touching supplied trap ports.

- [ ] **Step 2: Run the RED test**

Run:

~~~bash
npx vitest run tests/unit/catalog/cloud-catalog-runtime.test.ts
~~~

Expected: FAIL because the runtime files do not exist.

- [ ] **Step 3: Implement the narrow runtime surface**

Define:

~~~ts
export interface CloudCatalogViewModel {
  readonly status: "unconfigured" | "no-snapshot" | "loading" | "ready" | "partial" | "error" | "unavailable";
  readonly snapshotCompletedAt?: number;
  readonly pdfCount: number;
  readonly query: string;
  readonly folderPrefix: string;
  readonly page: number;
  readonly pageSize: 50;
  readonly total: number;
  readonly items: readonly CloudCatalogRecord[];
  readonly messageCode?: CatalogErrorCode | "catalog-unavailable";
}

export interface CloudCatalogRuntime {
  readonly connection?: CloudCatalogConnectionRuntime;
  initialize(): Promise<void>;
  snapshot(): CloudCatalogViewModel;
  subscribe(listener: () => void): () => void;
  setQuery(value: string): void;
  setFolderPrefix(value: string): void;
  setPage(value: number): void;
  copyFilename(fsId: string): Promise<void>;
  copyCloudPath(fsId: string): Promise<void>;
  openBaidu(): Promise<void>;
  dispose(): void;
}
~~~

Keep credential and scan methods in this optional connection interface so the acceptance runtime does not gain them:

~~~ts
export interface CloudCatalogConnectionViewModel {
  readonly status: "unconfigured" | "configured" | "authorizing" | "authorized" | "scanning" | "paused" | "partial";
  readonly messageCode?: CatalogErrorCode | "catalog-unavailable";
}

export interface CloudCatalogConnectionRuntime {
  snapshot(): CloudCatalogConnectionViewModel;
  saveApplicationCredentials(input: Readonly<{ appKey: string; secretKey: string }>): Promise<void>;
  authorize(): Promise<void>;
  revoke(): Promise<void>;
  startScan(rootPath: string): Promise<void>;
  cancelScan(): void;
}
~~~

CloudCatalogRuntime exposes readonly connection?: CloudCatalogConnectionRuntime. DISABLED_CLOUD_CATALOG_RUNTIME omits connection entirely.

- [ ] **Step 4: Run GREEN and commit**

Run:

~~~bash
npx vitest run tests/unit/catalog/cloud-catalog-runtime.test.ts
npm run build
git add src/catalog tests/fakes/fake-cloud-catalog-runtime.ts tests/unit/catalog/cloud-catalog-runtime.test.ts
git commit -m "feat(目录): 增加隔离目录运行时"
~~~

Expected: no VaultReadPort, VaultWritePort, AiClientPort, ChangePlanService, or DocumentRecord import appears under src/catalog.

### Task 6: Add the accessible paginated Cloud Catalog tab

**Files:**

- Create: src/ui/cloud-catalog-tab.ts
- Modify: src/ui/workbench-view.ts
- Modify: src/ui/workbench-controller.ts
- Modify: tests/helpers/ui-fixtures.ts
- Create: tests/ui/cloud-catalog-tab.test.ts
- Modify: tests/ui/workbench-view.test.ts
- Modify: styles.css

- [ ] **Step 1: Add RED UI tests**

Assert a fifth tab, ARIA linkage, 50-row maximum, empty/error states, focus retention, page buttons, and explicit result actions:

~~~ts
expect(root.querySelector('[data-tab="cloud-catalog"]')?.textContent).toBe("Cloud Catalog");
expect(root.querySelectorAll("[data-catalog-result]")).toHaveLength(50);
expect(root.textContent).toContain("100,000 PDFs");
root.querySelector<HTMLButtonElement>('[data-action="copy-cloud-path"]')!.click();
expect(actions.copyCloudPath).toEqual(["fs-000001"]);
~~~

Assert typing into catalog search does not call onSearchMap and does not alter Today/Map models.

- [ ] **Step 2: Run the RED tests**

Run:

~~~bash
npx vitest run tests/ui/cloud-catalog-tab.test.ts tests/ui/workbench-view.test.ts
~~~

Expected: FAIL because cloud-catalog is not a WorkbenchTab.

- [ ] **Step 3: Render a separate tab**

Extend WorkbenchTab with cloud-catalog and WorkbenchViewModel with readonly catalog: CloudCatalogViewModel. Add catalog-specific actions:

~~~ts
readonly onSearchCatalog: (query: string) => void;
readonly onFilterCatalogFolder: (prefix: string) => void;
readonly onCatalogPage: (page: number) => void;
readonly onCopyCatalogFilename: (fsId: string) => void;
readonly onCopyCatalogPath: (fsId: string) => void;
readonly onOpenBaidu: () => void;
~~~

cloud-catalog-tab.ts must render only model.catalog. Result buttons must use type=button and data attributes; neither filename nor path may be placed in an aria-live status string.

- [ ] **Step 4: Delegate through WorkbenchController**

Inject readonly catalog: CloudCatalogRuntime into WorkbenchDependencies, subscribe once in the constructor, copy catalog.snapshot() into the model, and unsubscribe/dispose ownership correctly. Do not append catalog records to this.records.

- [ ] **Step 5: Run GREEN and commit**

Run:

~~~bash
npx vitest run tests/ui/cloud-catalog-tab.test.ts tests/ui/workbench-view.test.ts
npx vitest run tests/unit/map tests/unit/today tests/unit/suggestions
npm run build
git add src/ui src/catalog/cloud-catalog-runtime.ts tests/helpers/ui-fixtures.ts tests/ui styles.css
git commit -m "feat(界面): 增加云端书库检索页"
~~~

Expected: catalog UI passes and existing Workbench projections remain unchanged.

### Task 7: Add explicit scan-root confirmation without network capability

**Files:**

- Create: src/ui/catalog-scan-confirmation-modal.ts
- Modify: src/ui/settings-tab.ts
- Modify: src/ui/workbench-controller.ts
- Modify: src/runtime/runtime-composition.ts
- Modify: src/main.ts
- Modify: src/main-acceptance.ts
- Modify: tests/ui/settings-tab.test.ts
- Create: tests/ui/catalog-scan-confirmation-modal.test.ts

- [ ] **Step 1: Add RED confirmation tests**

Assert OAuth success alone yields zero list calls and that invalid roots never reach confirmation:

~~~ts
const connectionFake = fakeCloudCatalogConnection({ status: "authorized" });
const confirmations = fakeCatalogScanConfirmation(false);
const controller = controllerFixture({ catalogConnection: connectionFake, catalogConfirmation: confirmations }).controller;
expect(connectionFake.startScanCalls).toEqual([]);
await expect(controller.requestCatalogScan("relative/path")).rejects.toThrow("invalid-scan-root");
expect(confirmations.requests).toEqual([]);
~~~

For /样本, assert the modal states recursive metadata-only scanning, no PDF download, old snapshot preservation, and returns only after the user presses Start read-only scan. Cancel must yield false and zero list calls.

- [ ] **Step 2: Run the RED tests**

Run:

~~~bash
npx vitest run tests/ui/catalog-scan-confirmation-modal.test.ts tests/ui/settings-tab.test.ts
~~~

Expected: FAIL because catalog settings and confirmation do not exist.

- [ ] **Step 3: Add session-only root controls**

The settings tab may retain the current root only in the live input element. Do not add it to PluginSettings. Add Connect, Revoke, Validate path, and Start read-only scan controls only when the injected catalog connection runtime exists. Read-only acceptance must show a locked explanation and no credential input.

- [ ] **Step 4: Wire a fake-only connection surface**

Extend RuntimeComposition with createCatalog(app) and createCatalogConfirmation(app). main-acceptance.ts must return DISABLED_CLOUD_CATALOG_RUNTIME and a confirmation that always returns false. In this task main.ts uses an offline runtime with no Baidu source, so Connect and Start return credentials-unavailable; network remains absent until Tasks 10–12.

- [ ] **Step 5: Run GREEN and commit**

Run:

~~~bash
npx vitest run tests/ui/catalog-scan-confirmation-modal.test.ts tests/ui/settings-tab.test.ts
npx vitest run tests/packaging/composition-roots.test.ts
npm run build
git add src/ui src/runtime src/main.ts src/main-acceptance.ts tests/ui
git commit -m "feat(设置): 增加目录扫描确认门"
~~~

Expected: no list call occurs without the final confirmation.

### Task 8: Compose external storage only in the normal bundle

**Files:**

- Modify: src/main.ts
- Modify: src/catalog/cloud-catalog-runtime.ts
- Modify: src/plugin/knowledge-workbench-plugin.ts
- Modify: src/runtime/runtime-composition.ts
- Modify: tests/packaging/composition-roots.test.ts
- Create: tests/integration/catalog-offline-composition.test.ts

- [ ] **Step 1: Add RED composition tests**

Build both entry points. Require local-catalog-snapshot-adapter.ts in normal inputs and forbid it, every Baidu adapter, requestUrl, secretStorage, node:fs, node:path, and node:os in acceptance output.

The existing test bundle helper currently externalizes only obsidian. Import builtinModules from node:module and externalize both spellings of every Node built-in so the test can inspect module inputs without attempting to bundle desktop-only primitives:

~~~ts
import { builtinModules } from "node:module";

const nodeExternals = [...new Set(
  builtinModules.flatMap((name) => [name, name.startsWith("node:") ? name.slice(5) : `node:${name}`]),
)];

await build({
  // preserve the helper's existing entry, bundle, platform, format, and metafile fields
  external: ["obsidian", ...nodeExternals],
});
~~~

Do not add Node built-ins to the acceptance composition merely to satisfy the test; the metafile assertion must still prove that none are reachable from src/main-acceptance.ts.

- [ ] **Step 2: Run the RED tests**

Run:

~~~bash
npx vitest run tests/packaging/composition-roots.test.ts tests/integration/catalog-offline-composition.test.ts
~~~

Expected: FAIL because normal composition has no snapshot adapter.

- [ ] **Step 3: Resolve the fixed external root**

In normal composition only:

~~~ts
const catalogRoot = join(
  homedir(),
  "Library",
  "Application Support",
  "Knowledge Workbench",
  "baidu-catalog",
);
~~~

Reject process.platform other than darwin for this first release. Do not derive the path from app.vault, Vault.configDir, repository cwd, HOME overrides, or user cloud paths.

- [ ] **Step 4: Own initialization and disposal**

The plugin creates the catalog runtime after the startup gate, calls initialize without blocking the Vault index, reports fixed catalog error codes to the catalog tab, and disposes it before clearing controller references. Catalog initialization failure must not trigger a Vault scan or write.

- [ ] **Step 5: Run GREEN, full verify, commit, and stop at Checkpoint B**

Run:

~~~bash
npx vitest run tests/packaging/composition-roots.test.ts tests/integration/catalog-offline-composition.test.ts
npm run verify
git add src/main.ts src/plugin src/runtime tests/packaging/composition-roots.test.ts tests/integration/catalog-offline-composition.test.ts
git commit -m "build(目录): 隔离正常与验收运行时"
~~~

Expected: verify passes and the acceptance bundle contains no catalog network, secret, or external-filesystem capability. Stop and report Checkpoint B.

### Task 9: Pass the official console and directory-scope feasibility gates

**Files:**

- Modify: docs/superpowers/specs/2026-08-05-baidu-netdisk-cloud-catalog-design.md
- Modify: docs/superpowers/plans/2026-08-05-baidu-netdisk-cloud-catalog.md
- Create: docs/runbooks/baidu-cloud-catalog-directory-scope-gate.md

- [x] **Step 1: Record the failed loopback gate and approved OOB revision**

The current official authorization FAQ states that a local callback address is not allowed. The callback and authorization-code guides document `redirect_uri=oob`. Record that the exact loopback design was rejected by official published policy and that the user approved OOB on 2026-08-05. Remove every local listener, callback-host, callback-path, and unverifiable callback `state` assumption from the design and implementation plan.

Expected: the approved design uses a manual one-time OOB authorization code, one active ten-minute local attempt, single submission, immediate input clearing, and no local HTTP server. It does not claim callback-style `state` verification because the official OOB documentation does not guarantee a plugin-verifiable returned state.

- [x] **Step 2: Verify the personal application prerequisite**

The user, not Codex, logs into the official Baidu console, completes any required personal real-name verification, creates one personal-use software application, and records AppKey/SecretKey only through the later private credential input. Do not paste credentials into chat, terminal history, environment variables, project files, or screenshots.

- [x] **Step 3: Verify the official OOB authorization page without exchanging a code**

Using only the official authorization URL described in docs/runbooks/baidu-cloud-catalog-directory-scope-gate.md, verify that `redirect_uri=oob` and `scope=basic,netdisk` reach the official authorization surface for the user-owned application. Do not configure localhost, start a listener, exchange the displayed code, or record the code.

Expected: available. If OOB is rejected, stop Task 9; no OAuth implementation begins.

- [x] **Step 4: Record the missing directory selector and explicit broad-scope decision**

The official authorization UI did not expose an existing-directory selector. It exposed a checked `netdisk` permission for creating folders and reading/writing netdisk data. The user explicitly accepted this account-wide range on 2026-08-05. Record no account identity, path, credential, code, token, screenshot, or raw URL.

Expected: broad scope accepted, while the implementation remains fail-closed and list-only. This decision does not prove that an existing path is readable; that requires one separately approved, non-sensitive, read-only small-directory test after Tasks 10–12.

- [x] **Step 5: Report the gate**

Reported: personal application ready, OOB page available, folder-level selector unavailable, broad `netdisk` scope accepted, and real code exchange deferred until isolated credential/OAuth/list adapters are verified. Never report a path, account identity, AppKey, SecretKey, authorization code, token, screenshot, or raw URL.

### Task 10: Store one strict credential bundle through Obsidian secret storage

**Files:**

- Create: src/adapters/obsidian-baidu-credential-adapter.ts
- Modify: src/catalog/catalog-types.ts
- Modify: src/catalog/catalog-ports.ts
- Test: tests/unit/catalog/obsidian-baidu-credential-adapter.test.ts

- [ ] **Step 1: Add RED credential tests**

Use an in-memory SecretStorage-shaped fake. Test missing, replace, token rotation, malformed JSON, revoke, and detached returns. Assert captured logs/errors contain none of the four secret sentinel values.

- [ ] **Step 2: Run the RED test**

Run:

~~~bash
npx vitest run tests/unit/catalog/obsidian-baidu-credential-adapter.test.ts
~~~

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement one versioned secret bundle**

~~~ts
export interface BaiduCredentialBundle {
  readonly schemaVersion: 1;
  readonly profileId: string;
  readonly appKey: string;
  readonly secretKey: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly accessTokenExpiresAt?: number;
}

export interface CatalogCredentialPort {
  read(): Promise<BaiduCredentialBundle | null>;
  replace(value: BaiduCredentialBundle): Promise<void>;
  revoke(): Promise<void>;
}
~~~

Use one fixed SecretStorage key owned by the plugin. Validate exact keys, non-empty bounded strings, finite expiry, and clone on input/output. Do not modify PluginSettings or the plugin-data schema; the UI queries the credential port for configured status.

Before any real credential is entered, verify on the target macOS/Obsidian version that this SecretStorage implementation does not place the four sentinel values in plugin data, the Vault, repository files, logs, or the external catalog directory. If the backing security cannot be evidenced, stop and revise the credential-storage design; do not claim Keychain protection from the API name alone and do not proceed with real AppKey, SecretKey, or tokens.

- [ ] **Step 4: Run GREEN and commit**

Run:

~~~bash
npx vitest run tests/unit/catalog/obsidian-baidu-credential-adapter.test.ts
npm run build
git add src/adapters/obsidian-baidu-credential-adapter.ts src/catalog tests/unit/catalog/obsidian-baidu-credential-adapter.test.ts
git commit -m "feat(授权): 安全保存百度授权凭证"
~~~

Expected: strict bundle and redaction tests pass.

### Task 11: Implement OOB OAuth with exact endpoint and manual-code boundaries

**Files:**

- Modify: src/catalog/catalog-types.ts
- Modify: src/catalog/catalog-ports.ts
- Create: src/adapters/baidu-oauth-adapter.ts
- Test: tests/unit/catalog/baidu-oauth-adapter.test.ts

- [ ] **Step 1: Add RED OAuth tests**

Assert:

- authorize host is openapi.baidu.com, path is /oauth/2.0/authorize, response_type=code, scope=basic,netdisk, and redirect_uri is exactly oob;
- no callback host, callback path, local listener, or general callback handler exists in the adapter contract or production dependency graph;
- only one OOB attempt can be active, it expires after ten minutes, and a second begin call replaces and invalidates the first attempt;
- submitted codes must contain 1 to 512 visible ASCII characters with no whitespace or controls, are accepted only during the active attempt, and are consumed before token exchange so retry cannot reuse them;
- cancel, timeout, validation failure, exchange completion, and dispose clear all code-bearing input/state; the adapter never logs or returns the code;
- the authorize request does not claim a callback-verifiable state round trip; callback-style state errors and tests do not exist;
- token host/path are exact, grant_type is authorization_code or refresh_token, and no POST/body variant exists;
- authorization-code exchange sends redirect_uri=oob exactly;
- refresh replaces both access and refresh tokens once; refresh failure requires reauthorization and never loops;
- replace `authorization-state-mismatch` with the fixed codes `authorization-attempt-unavailable`, `authorization-attempt-expired`, `authorization-code-invalid`, and `authorization-exchange-failed`;
- errors expose only fixed codes and never URLs or credentials.

- [ ] **Step 2: Run the RED test**

Run:

~~~bash
npx vitest run tests/unit/catalog/baidu-oauth-adapter.test.ts
~~~

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement one bounded OOB attempt**

Open only the internally constructed official authorize URL with `redirect_uri=oob`. Expose a narrow `beginAuthorization()`, `submitAuthorizationCode(code)`, and `cancelAuthorization()` workflow rather than a callback server or general URL handler. Keep one private attempt deadline, consume the attempt before exchange, enforce the visible-ASCII length boundary, and clear all code-bearing values on every terminal path. Never persist the code, return it from a method, or include it in an error.

Add these ports to `src/catalog/catalog-ports.ts`:

~~~ts
export interface CatalogAuthorizationBrowserPort {
  openAuthorizationPage(url: string): Promise<void>;
}

export interface BaiduOAuthPort {
  beginAuthorization(): Promise<Readonly<{ expiresAt: number }>>;
  submitAuthorizationCode(code: string): Promise<void>;
  cancelAuthorization(): void;
  refresh(): Promise<void>;
  dispose(): void;
}
~~~

The browser port is called only with the internally constructed official authorize URL. No URL enters a view model, log, error, receipt, or test snapshot.

- [ ] **Step 4: Implement token exchange and one-time refresh**

Construct URLSearchParams internally, require `redirect_uri=oob` for authorization-code exchange, call the injected request function only after exact URL assertions, parse response text strictly, replace the entire credential bundle atomically, and translate all failures to fixed CatalogError codes. Do not expose a general request(url) method from the adapter.

- [ ] **Step 5: Run GREEN and commit**

Run:

~~~bash
npx vitest run tests/unit/catalog/baidu-oauth-adapter.test.ts
npm run build
git add src/catalog/catalog-types.ts src/catalog/catalog-ports.ts src/adapters/baidu-oauth-adapter.ts tests/unit/catalog/baidu-oauth-adapter.test.ts
git commit -m "feat(授权): 实现官方授权码流程"
~~~

Expected: OOB-only endpoint, active-attempt timeout, single-use code, input clearing, refresh rotation, and redaction tests pass without any listener capability.

### Task 12: Implement the exact read-only list adapter

**Files:**

- Create: src/adapters/baidu-catalog-source-adapter.ts
- Test: tests/unit/catalog/baidu-catalog-source-adapter.test.ts

- [ ] **Step 1: Add RED request-whitelist tests**

Capture the outgoing request and require:

~~~ts
expect(request.method).toBe("GET");
expect(url.origin).toBe("https://pan.baidu.com");
expect(url.pathname).toBe("/rest/2.0/xpan/file");
expect(url.searchParams.get("method")).toBe("list");
expect(url.searchParams.get("order")).toBe("name");
expect(url.searchParams.get("desc")).toBe("0");
expect(url.searchParams.get("limit")).toBe("1000");
expect(url.searchParams.get("web")).toBeNull();
expect(url.searchParams.get("folder")).toBe("0");
~~~

Assert no adapter method or output contains dlink, download, upload, filemanager, move, copy, delete, share, listall, or a request URL. Test errno -6, -7, -9, 20011, 20012, 20013, 20015, 31024, 31034, 31045, token expiry, one refresh, and refresh failure.

- [ ] **Step 2: Run the RED test**

Run:

~~~bash
npx vitest run tests/unit/catalog/baidu-catalog-source-adapter.test.ts
~~~

Expected: FAIL because the source adapter does not exist.

- [ ] **Step 3: Build only the documented list request**

Normalize dir before URL encoding. Accept start as a non-negative safe integer and limit only as the literal 1000. Use order=name, desc=0, folder=0, and no web/showempty/thumbnail fields. Parse response.text with decodeBaiduListResponse so fs_id never passes through native JSON.parse.

- [ ] **Step 4: Add bounded token refresh**

On documented authentication failures -6 or 31045, call OAuth refresh once, replace the bundle, and repeat the same list request once. Every other error returns immediately. Map -7, 31024, and 20013 to baidu-permission-denied; -9 to baidu-not-found; 20011 and 20015 to baidu-access-unavailable; and 20012 or 31034 to baidu-rate-limited with retryable=true. The adapter does not sleep or loop.

- [ ] **Step 5: Run GREEN and commit**

Run:

~~~bash
npx vitest run tests/unit/catalog/baidu-catalog-source-adapter.test.ts
npx vitest run tests/unit/catalog/baidu-oauth-adapter.test.ts
npm run build
git add src/adapters/baidu-catalog-source-adapter.ts tests/unit/catalog/baidu-catalog-source-adapter.test.ts
git commit -m "feat(目录): 接入官方只读列表接口"
~~~

Expected: whitelist, error mapping, exact fs_id, and single-refresh tests pass.

### Task 13: Wire normal runtime, perform the authorized small-directory acceptance, and release

**Files:**

- Modify: src/main.ts
- Modify: src/plugin/knowledge-workbench-plugin.ts
- Modify: src/ui/settings-tab.ts
- Modify: src/ui/workbench-controller.ts
- Modify: src/runtime/runtime-composition.ts
- Modify: tests/packaging/composition-roots.test.ts
- Modify: tests/ui/settings-tab.test.ts
- Create: docs/runbooks/baidu-cloud-catalog-small-folder.md
- Modify: README.md

- [x] **Step 1: Add RED end-to-end composition tests**

The normal graph must include OAuth, source, credential, snapshot, scan, and catalog runtime adapters. The acceptance graph must exclude all of them except disabled-cloud-catalog-runtime.ts. Simulate Connect and prove it opens one OOB authorization URL but makes zero token or list calls; simulate local code submission and prove it makes one token exchange but zero list calls; simulate confirmed Start and prove exactly one serial list call begins.

- [x] **Step 2: Compose normal-only capabilities**

main.ts creates the credential adapter from app.secretStorage, OAuth adapter from requestUrl plus a browser opener, list adapter, external snapshot adapter, CatalogScanService, and CloudCatalogRuntime. No listener or local-server capability is composed. The plugin owns the runtime. Replace the connection runtime's single `authorize()` action with `beginAuthorization()`, `submitAuthorizationCode(code)`, and `cancelAuthorization()` so the UI cannot pass a callback URL or general request. settings-tab.ts clears AppKey/SecretKey inputs immediately after save, clears the OOB authorization code on submit/cancel/timeout, and shows only fixed state labels.

- [x] **Step 3: Run automated release gates before real authorization**

Run:

~~~bash
npx vitest run tests/unit/catalog tests/integration/catalog-scan.test.ts tests/ui/cloud-catalog-tab.test.ts tests/ui/settings-tab.test.ts tests/packaging/composition-roots.test.ts
npm run test:catalog-performance
npm run verify
npm run test:coverage
~~~

Expected: all tests pass; coverage remains above the existing thresholds; the 100,000-record gate passes; acceptance bundle safety passes.

- [x] **Step 4: Write and review the small-directory runbook**

The runbook must require:

1. user-owned personal app, official OOB authorization availability, and no localhost callback;
2. explicit user entry and confirmation of one non-sensitive small-directory path, without first enumerating `/` or a parent directory;
3. visible confirmation of recursive metadata-only scanning and no download;
4. before/after network evidence showing only OAuth endpoints and GET method=list;
5. manual comparison of returned item count with the Baidu client;
6. evidence limited to status, counts, duration, response error codes, request count, and downloaded PDF bytes;
7. an immediate stop on permission or quota errors;
8. no installation into or scan of the real Vault.
9. the one-time authorization code is never recorded and is cleared before evidence collection.

- [ ] **Step 5: Obtain explicit user authorization and run exactly one small-directory acceptance**

Do not execute this step from plan approval alone. Ask the user to approve the named non-sensitive directory and real OAuth action. After approval, run one scan and record:

~~~text
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
~~~

Never record the directory path, filenames, tokens, AppKey, account identity, or raw request URLs. Stop after the small directory; do not expand to the root.

- [ ] **Step 6: Finalize documentation and commit**

Document Cloud Catalog setup, external storage location, revocation, refresh behavior, permission limitations, and recovery. State plainly that current Baidu directory authorization may prevent existing-library access.

Run:

~~~bash
npm run verify
npm run test:coverage
npm run test:catalog-performance
git diff --check
graphify hook status
git add src tests package.json package-lock.json README.md docs/runbooks/baidu-cloud-catalog-small-folder.md
git commit -m "feat(目录): 完成云端书库首期链路"
~~~

After the commit, let the Graphify hook update code. Do not run document semantic extraction or batch model calls under the PMH sample rules.

- [ ] **Step 7: Stop at Checkpoint C**

Report the final commit, exact automated and real-small-directory results, product rework count, available input-token statistics, PMH recall count/token estimate, same-project recall noise, and whether any cross-project/model pollution was observed. Do not start a root scan, control-model run, deployment, or real-Vault installation.

## Execution handoff

Under the current no-batch-model-call rule, inline execution with superpowers:executing-plans is the default. Subagent-driven execution requires a new explicit user decision because it creates repeated model calls. In either mode, Tasks 9 and 13 still require the user's separate real-account authorization and cannot be inferred from plan approval.
