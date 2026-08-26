import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  decodeCandidateCatalogDescriptor,
  decodeCatalogDifferenceRecord,
  decodeCatalogOverlayDescriptor,
  decodeLargeCatalogBatchCheckpoint,
  decodeLargeCatalogRunReceipt,
  decodeTxtCandidateRecord,
  decodeUnifiedCatalogDescriptor,
  decodeUnifiedCatalogRecord,
  encodeCatalogDifferenceRecordLine,
  encodeCatalogOverlayDescriptor,
  encodeLargeCatalogBatchCheckpoint,
  encodeLargeCatalogRunReceipt,
  encodeTxtCandidateRecordLine,
  encodeUnifiedCatalogRecordLine,
} from "../catalog/hybrid-catalog-codec";
import { isbnCandidatesFromFilename } from "../catalog/catalog-codec";
import { normalizeCloudAbsolutePath } from "../catalog/catalog-path";
import type { CloudCatalogRecord } from "../catalog/catalog-types";
import type {
  CandidateImportWriter,
  HybridCatalogActivationSnapshot,
  HybridCatalogStorePort,
  LargeCatalogPageIdentity,
} from "../catalog/hybrid-catalog-ports";
import {
  CATALOG_TXT_IMPORT_BUDGET,
  MAX_UNIFIED_CATALOG_PDF_COUNT,
  HybridCatalogError,
  type ActiveCatalogOverlay,
  type CandidateCatalogDescriptor,
  type CatalogDifferenceRecordV1,
  type CatalogOverlayDescriptor,
  type CatalogReconciliationResult,
  type LargeCatalogBatchCheckpointV3,
  type LargeCatalogRunReceiptV3,
  type TxtCandidateRecordV1,
  type UnifiedCatalogDescriptor,
  type UnifiedCatalogRecordV1,
} from "../catalog/hybrid-catalog-types";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_CANDIDATE_BYTES = CATALOG_TXT_IMPORT_BUDGET.maxBytes * 32;
const MAX_UNIFIED_BYTES = CATALOG_TXT_IMPORT_BUDGET.maxBytes * 32;
const MAX_DIFFERENCE_COUNT = MAX_UNIFIED_CATALOG_PDF_COUNT * 4;
const MAX_BATCH_CHECKPOINT_BYTES = 16 * 1024 * 1024;
const MAX_BATCH_PAGE_BYTES = 64 * 1024 * 1024;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const GROUP_PATTERN = /^(?:txt-root-items|group:[a-f0-9]{64})$/u;
const CANDIDATE_GROUP_FIELD_PATTERN = /"topLevelGroupId":"(txt-root-items|group:[a-f0-9]{64})"/u;
const CATALOG_ID_PATTERN = /^(?:txt:[a-f0-9]{64}|baidu:(?:0|[1-9]\d*))$/u;

export interface HybridAtomicRenamePort {
  rename(source: string, destination: string): Promise<void>;
}

const SYSTEM_RENAME_PORT: HybridAtomicRenamePort = Object.freeze({ rename });

interface ActiveCandidateManifest {
  readonly schemaVersion: 1;
  readonly importId: string;
  readonly receiptSha256: string;
  readonly recordCount: number;
}

interface ActiveUnifiedManifestV1 {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly sourceImportSha256: string;
  readonly descriptorSha256: string;
  readonly recordCount: number;
  readonly differenceCount: number;
}

interface ActiveUnifiedManifestV2 {
  readonly schemaVersion: 2;
  readonly snapshotId: string;
  readonly sourceImportSha256: string;
  readonly candidateImportId: string;
  readonly descriptorSha256: string;
  readonly recordCount: number;
  readonly differenceCount: number;
}

type ActiveUnifiedManifest = ActiveUnifiedManifestV1 | ActiveUnifiedManifestV2;

interface ActiveOverlayReference {
  readonly schemaVersion: 1;
  readonly overlayId: string;
  readonly sourceImportSha256: string;
  readonly topLevelGroupId: string;
  readonly descriptorSha256: string;
}

interface ActiveOverlaysManifest {
  readonly schemaVersion: 1;
  readonly overlays: readonly ActiveOverlayReference[];
}

interface LargeCatalogBatchPageEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly pageKey: string;
  readonly records: readonly CloudCatalogRecord[];
  readonly nextCheckpoint: LargeCatalogBatchCheckpointV3;
}

interface LargeCatalogBatchPageEnvelopeV2 {
  readonly schemaVersion: 2;
  readonly pageKey: string;
  readonly records: readonly CloudCatalogRecord[];
  readonly identities: readonly LargeCatalogPageIdentity[];
  readonly nextCheckpoint: LargeCatalogBatchCheckpointV3;
}

interface DecodedLargeCatalogBatchPage {
  readonly records: readonly CloudCatalogRecord[];
  readonly identities: readonly LargeCatalogPageIdentity[];
  readonly identitiesComplete: boolean;
  readonly nextCheckpoint: LargeCatalogBatchCheckpointV3;
}

const corrupt = (): HybridCatalogError => new HybridCatalogError("hybrid-snapshot-corrupt");

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const cloneCandidate = (record: TxtCandidateRecordV1): TxtCandidateRecordV1 => ({
  ...record,
  isbnCandidates: [...record.isbnCandidates],
  hierarchyTags: [...record.hierarchyTags],
});

const cloneDescriptor = (descriptor: CandidateCatalogDescriptor): CandidateCatalogDescriptor => ({
  ...descriptor,
});

const cloneUnifiedRecord = (record: UnifiedCatalogRecordV1): UnifiedCatalogRecordV1 => ({
  ...record,
  isbnCandidates: [...record.isbnCandidates],
  hierarchyTags: [...record.hierarchyTags],
  differenceKinds: [...record.differenceKinds],
});

const cloneDifference = (record: CatalogDifferenceRecordV1): CatalogDifferenceRecordV1 => ({
  ...record,
});

const cloneUnifiedDescriptor = (
  descriptor: UnifiedCatalogDescriptor,
): UnifiedCatalogDescriptor => ({ ...descriptor });

const cloneOverlayDescriptor = (
  descriptor: CatalogOverlayDescriptor,
): CatalogOverlayDescriptor => ({ ...descriptor });

const cloneCloudRecord = (record: CloudCatalogRecord): CloudCatalogRecord => ({
  ...record,
  isbnCandidates: [...record.isbnCandidates],
});

const isNotFound = (error: unknown): boolean => (
  typeof error === "object"
  && error !== null
  && "code" in error
  && (error as { code?: unknown }).code === "ENOENT"
);

const sameFile = (left: Stats, right: Stats): boolean => (
  left.dev === right.dev
  && left.ino === right.ino
  && left.size === right.size
  && left.mtimeMs === right.mtimeMs
  && right.isFile()
  && !right.isSymbolicLink()
);

const safeImportId = (value: string): string => {
  if (!SAFE_ID_PATTERN.test(value)) throw corrupt();
  return value;
};

const decodeActiveManifest = (raw: string): ActiveCandidateManifest => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw corrupt();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw corrupt();
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  const expected = ["importId", "receiptSha256", "recordCount", "schemaVersion"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw corrupt();
  }
  if (
    record.schemaVersion !== 1
    || typeof record.importId !== "string"
    || !SAFE_ID_PATTERN.test(record.importId)
    || typeof record.receiptSha256 !== "string"
    || !HASH_PATTERN.test(record.receiptSha256)
    || typeof record.recordCount !== "number"
    || !Number.isSafeInteger(record.recordCount)
    || record.recordCount < 1
    || record.recordCount > CATALOG_TXT_IMPORT_BUDGET.maxPdfCount
  ) throw corrupt();
  const decoded = {
    schemaVersion: 1,
    importId: record.importId,
    receiptSha256: record.receiptSha256,
    recordCount: record.recordCount,
  } as const;
  if (raw !== `${JSON.stringify(decoded)}\n`) throw corrupt();
  return decoded;
};

const decodeActiveUnifiedManifest = (raw: string): ActiveUnifiedManifest => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw corrupt();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw corrupt();
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  const commonKeys = [
    "schemaVersion",
    "snapshotId",
    "sourceImportSha256",
    "descriptorSha256",
    "recordCount",
    "differenceCount",
  ];
  const current = record.schemaVersion === 2;
  const expected = [...commonKeys, ...(current ? ["candidateImportId"] : [])].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw corrupt();
  }
  if (
    (record.schemaVersion !== 1 && !current)
    || typeof record.snapshotId !== "string"
    || !SAFE_ID_PATTERN.test(record.snapshotId)
    || typeof record.sourceImportSha256 !== "string"
    || !HASH_PATTERN.test(record.sourceImportSha256)
    || typeof record.descriptorSha256 !== "string"
    || !HASH_PATTERN.test(record.descriptorSha256)
    || typeof record.recordCount !== "number"
    || !Number.isSafeInteger(record.recordCount)
    || record.recordCount < 0
    || record.recordCount > MAX_UNIFIED_CATALOG_PDF_COUNT
    || typeof record.differenceCount !== "number"
    || !Number.isSafeInteger(record.differenceCount)
    || record.differenceCount < 0
    || record.differenceCount > MAX_DIFFERENCE_COUNT
  ) throw corrupt();
  let decoded: ActiveUnifiedManifest;
  if (current) {
    const candidateImportId = record.candidateImportId;
    if (typeof candidateImportId !== "string" || !SAFE_ID_PATTERN.test(candidateImportId)) {
      throw corrupt();
    }
    decoded = {
      schemaVersion: 2,
      snapshotId: record.snapshotId,
      sourceImportSha256: record.sourceImportSha256,
      candidateImportId,
      descriptorSha256: record.descriptorSha256,
      recordCount: record.recordCount,
      differenceCount: record.differenceCount,
    };
  } else {
    decoded = {
      schemaVersion: 1,
      snapshotId: record.snapshotId,
      sourceImportSha256: record.sourceImportSha256,
      descriptorSha256: record.descriptorSha256,
      recordCount: record.recordCount,
      differenceCount: record.differenceCount,
    };
  }
  if (raw !== `${JSON.stringify(decoded)}\n`) throw corrupt();
  return decoded;
};

const decodeActiveOverlaysManifest = (raw: string): ActiveOverlaysManifest => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw corrupt();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw corrupt();
  const root = value as Readonly<Record<string, unknown>>;
  const rootKeys = Object.keys(root).sort();
  if (
    rootKeys.length !== 2
    || rootKeys[0] !== "overlays"
    || rootKeys[1] !== "schemaVersion"
    || root.schemaVersion !== 1
    || !Array.isArray(root.overlays)
  ) throw corrupt();
  const overlays: ActiveOverlayReference[] = [];
  const groups = new Set<string>();
  const ids = new Set<string>();
  for (const item of root.overlays) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw corrupt();
    const record = item as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).sort();
    const expected = [
      "schemaVersion",
      "overlayId",
      "sourceImportSha256",
      "topLevelGroupId",
      "descriptorSha256",
    ].sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
      throw corrupt();
    }
    if (
      record.schemaVersion !== 1
      || typeof record.overlayId !== "string"
      || !SAFE_ID_PATTERN.test(record.overlayId)
      || typeof record.sourceImportSha256 !== "string"
      || !HASH_PATTERN.test(record.sourceImportSha256)
      || typeof record.topLevelGroupId !== "string"
      || !GROUP_PATTERN.test(record.topLevelGroupId)
      || typeof record.descriptorSha256 !== "string"
      || !HASH_PATTERN.test(record.descriptorSha256)
      || groups.has(record.topLevelGroupId)
      || ids.has(record.overlayId)
    ) throw corrupt();
    const prior = overlays.at(-1);
    if (prior !== undefined && prior.topLevelGroupId >= record.topLevelGroupId) throw corrupt();
    groups.add(record.topLevelGroupId);
    ids.add(record.overlayId);
    overlays.push({
      schemaVersion: 1,
      overlayId: record.overlayId,
      sourceImportSha256: record.sourceImportSha256,
      topLevelGroupId: record.topLevelGroupId,
      descriptorSha256: record.descriptorSha256,
    });
  }
  const decoded: ActiveOverlaysManifest = { schemaVersion: 1, overlays };
  if (raw !== `${JSON.stringify(decoded)}\n`) throw corrupt();
  return decoded;
};

export class LocalHybridCatalogAdapter implements HybridCatalogStorePort {
  readonly #root: string;
  readonly #hybridRoot: string;
  readonly #importsRoot: string;
  readonly #activeCandidatePath: string;
  readonly #unifiedRoot: string;
  readonly #activeUnifiedPath: string;
  readonly #overlaysRoot: string;
  readonly #activeOverlaysPath: string;
  readonly #batchesRoot: string;

  constructor(
    root: string,
    private readonly renames: HybridAtomicRenamePort = SYSTEM_RENAME_PORT,
    private readonly createUnifiedSnapshotId: () => string = () => `unified-${randomUUID()}`,
    private readonly createOverlayId: () => string = () => `overlay-${randomUUID()}`,
  ) {
    this.#root = resolve(root);
    if (!isAbsolute(root) || this.#root === parse(this.#root).root) throw corrupt();
    this.#hybridRoot = join(this.#root, "hybrid");
    this.#importsRoot = join(this.#hybridRoot, "imports");
    this.#activeCandidatePath = join(this.#hybridRoot, "candidate-active.json");
    this.#unifiedRoot = join(this.#hybridRoot, "unified");
    this.#activeUnifiedPath = join(this.#hybridRoot, "unified-active.json");
    this.#overlaysRoot = join(this.#hybridRoot, "overlays");
    this.#activeOverlaysPath = join(this.#hybridRoot, "overlays-active.json");
    this.#batchesRoot = join(this.#hybridRoot, "batches");
  }

  async createCandidateImport(importIdInput: string): Promise<CandidateImportWriter> {
    const importId = safeImportId(importIdInput);
    await this.#ensureLayout();
    const stagingDirectory = this.#contained(join(this.#importsRoot, `.staging-${importId}`));
    const finalDirectory = this.#contained(join(this.#importsRoot, importId));
    try {
      await mkdir(stagingDirectory, { mode: DIRECTORY_MODE });
      await this.#requirePrivateDirectory(stagingDirectory);
    } catch (error) {
      if (error instanceof HybridCatalogError) throw error;
      throw corrupt();
    }
    const candidateTemporary = join(stagingDirectory, "candidates.ndjson.tmp");
    const candidateFinal = join(stagingDirectory, "candidates.ndjson");
    let handle: FileHandle;
    try {
      handle = await open(candidateTemporary, "wx", FILE_MODE);
      await chmod(candidateTemporary, FILE_MODE);
    } catch {
      await rm(stagingDirectory, { recursive: true, force: true });
      throw corrupt();
    }
    const candidateHasher = createHash("sha256");
    const candidateIds = new Set<string>();
    let recordCount = 0;
    let state: "open" | "committing" | "committed" | "failed" | "aborted" = "open";
    let committedDescriptor: CandidateCatalogDescriptor | undefined;
    let committedInput: string | undefined;
    let promotedToFinal = false;

    const closeHandle = async (): Promise<void> => {
      try {
        await handle.close();
      } catch {
        // All public failures remain fixed catalog errors.
      }
    };

    const cleanupUncommittedDirectories = async (): Promise<void> => {
      try {
        await rm(stagingDirectory, { recursive: true, force: true });
        if (promotedToFinal) await rm(finalDirectory, { recursive: true, force: true });
      } catch {
        throw corrupt();
      }
    };

    const abort = async (): Promise<void> => {
      if (state === "committed" || state === "aborted") return;
      state = "aborted";
      await closeHandle();
      await cleanupUncommittedDirectories();
    };

    return {
      append: async (record) => {
        if (state !== "open") throw corrupt();
        const line = encodeTxtCandidateRecordLine(record);
        const decoded = decodeTxtCandidateRecord(line.slice(0, -1));
        if (candidateIds.has(decoded.candidateId)) throw corrupt();
        candidateIds.add(decoded.candidateId);
        try {
          await handle.write(line, null, "utf8");
        } catch {
          state = "failed";
          throw corrupt();
        }
        candidateHasher.update(line, "utf8");
        recordCount += 1;
      },
      commit: async (input) => {
        const inputKey = JSON.stringify({ summary: input.summary, importedAt: input.importedAt });
        const assertNotAborted = (): void => {
          if (input.signal?.aborted === true) throw corrupt();
        };
        if (state === "committed") {
          if (committedDescriptor === undefined || inputKey !== committedInput) throw corrupt();
          return cloneDescriptor(committedDescriptor);
        }
        if (state !== "open") throw corrupt();
        state = "committing";
        try {
          assertNotAborted();
          if (recordCount !== input.summary.pdfCount || recordCount < 1) throw corrupt();
          const candidateSha256 = candidateHasher.digest("hex");
          const descriptor = decodeCandidateCatalogDescriptor(JSON.stringify({
            schemaVersion: 1,
            importId,
            importedAt: input.importedAt,
            ...input.summary,
            candidateSha256,
          }));
          await handle.sync();
          assertNotAborted();
          await closeHandle();
          await chmod(candidateTemporary, FILE_MODE);
          assertNotAborted();
          await this.renames.rename(candidateTemporary, candidateFinal);
          await this.#verifyCandidates(candidateFinal, descriptor.pdfCount, candidateSha256);
          assertNotAborted();

          const receiptRaw = `${JSON.stringify(descriptor)}\n`;
          const receiptPath = join(stagingDirectory, "receipt.json");
          await this.#writeAtomic(receiptPath, receiptRaw);
          assertNotAborted();
          const receiptSha256 = sha256(receiptRaw);
          await this.renames.rename(stagingDirectory, finalDirectory);
          promotedToFinal = true;
          await this.#requirePrivateDirectory(finalDirectory);
          assertNotAborted();

          let priorActiveRaw: string | null = null;
          try {
            await lstat(this.#activeCandidatePath);
            priorActiveRaw = (await this.#readPrivateFile(
              this.#activeCandidatePath,
              64 * 1024,
            )).toString("utf8");
          } catch (error) {
            if (!isNotFound(error)) throw error;
          }
          assertNotAborted();

          const active: ActiveCandidateManifest = {
            schemaVersion: 1,
            importId,
            receiptSha256,
            recordCount,
          };
          await this.#writeAtomic(this.#activeCandidatePath, `${JSON.stringify(active)}\n`);
          if (input.signal?.aborted === true) {
            if (priorActiveRaw === null) await rm(this.#activeCandidatePath, { force: true });
            else await this.#writeAtomic(this.#activeCandidatePath, priorActiveRaw);
            throw corrupt();
          }
          committedDescriptor = descriptor;
          committedInput = inputKey;
          state = "committed";
          return cloneDescriptor(descriptor);
        } catch (error) {
          state = "failed";
          await closeHandle();
          await cleanupUncommittedDirectories();
          if (error instanceof HybridCatalogError) throw error;
          throw corrupt();
        }
      },
      abort,
    };
  }

  async #loadActiveCandidateReference(): Promise<Readonly<{
    descriptor: CandidateCatalogDescriptor;
    candidatesPath: string;
  }> | null> {
    await this.#ensureLayout();
    try {
      await lstat(this.#activeCandidatePath);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw corrupt();
    }
    let activeRaw: string;
    try {
      activeRaw = (await this.#readPrivateFile(this.#activeCandidatePath, 64 * 1024)).toString("utf8");
    } catch (error) {
      if (error instanceof HybridCatalogError) throw error;
      throw corrupt();
    }
    const active = decodeActiveManifest(activeRaw);
    const importDirectory = this.#contained(join(this.#importsRoot, active.importId));
    await this.#requirePrivateDirectory(importDirectory);
    const receiptRaw = (await this.#readPrivateFile(
      join(importDirectory, "receipt.json"),
      64 * 1024,
    )).toString("utf8");
    if (!receiptRaw.endsWith("\n") || sha256(receiptRaw) !== active.receiptSha256) throw corrupt();
    const descriptor = decodeCandidateCatalogDescriptor(receiptRaw.slice(0, -1));
    if (
      receiptRaw !== `${JSON.stringify(descriptor)}\n`
      || descriptor.importId !== active.importId
      || descriptor.pdfCount !== active.recordCount
    ) throw corrupt();
    return {
      descriptor,
      candidatesPath: join(importDirectory, "candidates.ndjson"),
    };
  }

  async loadActiveCandidateDescriptor(): Promise<CandidateCatalogDescriptor | null> {
    const active = await this.#loadActiveCandidateReference();
    return active === null ? null : cloneDescriptor(active.descriptor);
  }

  async loadActiveCandidateGroups(groupKeys: readonly string[]): Promise<Readonly<{
    descriptor: CandidateCatalogDescriptor;
    records: readonly TxtCandidateRecordV1[];
  }> | null> {
    const selected = new Set(groupKeys);
    if (
      selected.size !== groupKeys.length
      || groupKeys.some((groupKey) => !GROUP_PATTERN.test(groupKey))
    ) throw corrupt();
    const active = await this.#loadActiveCandidateReference();
    if (active === null) return null;
    const records = await this.#verifyCandidateGroups(
      active.candidatesPath,
      active.descriptor.pdfCount,
      active.descriptor.candidateSha256,
      selected,
    );
    return {
      descriptor: cloneDescriptor(active.descriptor),
      records: records.map(cloneCandidate),
    };
  }

  async loadActiveCandidates(): Promise<Readonly<{
    descriptor: CandidateCatalogDescriptor;
    records: readonly TxtCandidateRecordV1[];
  }> | null> {
    const active = await this.#loadActiveCandidateReference();
    if (active === null) return null;
    const records = await this.#verifyCandidateGroups(
      active.candidatesPath,
      active.descriptor.pdfCount,
      active.descriptor.candidateSha256,
      null,
    );
    return {
      descriptor: cloneDescriptor(active.descriptor),
      records: records.map(cloneCandidate),
    };
  }

  async restoreCatalogActivation(input: HybridCatalogActivationSnapshot): Promise<void> {
    await this.#ensureUnifiedLayout();
    let candidateManifestRaw: string | null = null;
    let candidateDescriptor: CandidateCatalogDescriptor | null = null;
    if (input.candidate !== null) {
      const descriptor = decodeCandidateCatalogDescriptor(JSON.stringify(input.candidate));
      if (JSON.stringify(descriptor) !== JSON.stringify(input.candidate)) throw corrupt();
      const directory = this.#contained(join(this.#importsRoot, safeImportId(descriptor.importId)));
      await this.#requirePrivateDirectory(directory);
      const receiptRaw = (await this.#readPrivateFile(
        join(directory, "receipt.json"),
        64 * 1024,
      )).toString("utf8");
      if (receiptRaw !== `${JSON.stringify(descriptor)}\n`) throw corrupt();
      await this.#verifyCandidates(
        join(directory, "candidates.ndjson"),
        descriptor.pdfCount,
        descriptor.candidateSha256,
      );
      const manifest: ActiveCandidateManifest = {
        schemaVersion: 1,
        importId: descriptor.importId,
        receiptSha256: sha256(receiptRaw),
        recordCount: descriptor.pdfCount,
      };
      candidateManifestRaw = `${JSON.stringify(manifest)}\n`;
      candidateDescriptor = descriptor;
    }

    let unifiedManifestRaw: string | null = null;
    if (input.unified !== null) {
      const descriptor = decodeUnifiedCatalogDescriptor(JSON.stringify(input.unified));
      if (
        JSON.stringify(descriptor) !== JSON.stringify(input.unified)
        || candidateDescriptor === null
        || descriptor.sourceImportSha256 !== candidateDescriptor.sourceSha256
      ) throw corrupt();
      const directory = this.#contained(join(this.#unifiedRoot, safeImportId(descriptor.snapshotId)));
      await this.#requirePrivateDirectory(directory);
      const descriptorRaw = (await this.#readPrivateFile(
        join(directory, "descriptor.json"),
        64 * 1024,
      )).toString("utf8");
      if (descriptorRaw !== `${JSON.stringify(descriptor)}\n`) throw corrupt();
      await this.#verifyUnifiedRecords(
        join(directory, "catalog.ndjson"),
        descriptor.recordCount,
        descriptor.catalogSha256,
      );
      await this.#verifyDifferences(
        join(directory, "differences.ndjson"),
        descriptor.differenceCount,
        descriptor.differencesSha256,
      );
      const manifest: ActiveUnifiedManifestV2 = {
        schemaVersion: 2,
        snapshotId: descriptor.snapshotId,
        sourceImportSha256: descriptor.sourceImportSha256,
        candidateImportId: candidateDescriptor.importId,
        descriptorSha256: sha256(descriptorRaw),
        recordCount: descriptor.recordCount,
        differenceCount: descriptor.differenceCount,
      };
      unifiedManifestRaw = `${JSON.stringify(manifest)}\n`;
    }

    if (candidateManifestRaw === null) await rm(this.#activeCandidatePath, { force: true });
    else await this.#writeAtomic(this.#activeCandidatePath, candidateManifestRaw);
    if (unifiedManifestRaw === null) await rm(this.#activeUnifiedPath, { force: true });
    else await this.#writeAtomic(this.#activeUnifiedPath, unifiedManifestRaw);
    const [restoredCandidate, restoredUnified] = await Promise.all([
      this.loadActiveCandidateDescriptor(),
      this.loadActiveUnified(),
    ]);
    if (
      JSON.stringify(restoredCandidate) !== JSON.stringify(candidateDescriptor)
      || JSON.stringify(restoredUnified?.descriptor ?? null)
        !== JSON.stringify(input.unified)
    ) throw corrupt();
  }

  async createBatch(checkpointInput: LargeCatalogBatchCheckpointV3): Promise<void> {
    await this.#ensureBatchLayout();
    const checkpoint = this.#validatedBatchCheckpoint(checkpointInput);
    const candidate = await this.loadActiveCandidateDescriptor();
    if (
      candidate === null
      || candidate.sourceSha256 !== checkpoint.sourceImportSha256
      || checkpoint.runOrdinal !== 1
      || checkpoint.listRequestCount !== 0
      || checkpoint.cumulativeListRequestCount !== 0
      || checkpoint.status !== "scanning"
      || checkpoint.stopReason !== null
    ) throw new HybridCatalogError("hybrid-batch-invalid");
    const directory = this.#batchDirectory(checkpoint.batchId);
    let created = false;
    try {
      await mkdir(directory, { mode: DIRECTORY_MODE });
      created = true;
      await this.#requirePrivateDirectory(directory);
      for (const child of ["pages", "receipts"]) {
        const childPath = this.#contained(join(directory, child));
        await mkdir(childPath, { mode: DIRECTORY_MODE });
        await chmod(childPath, DIRECTORY_MODE);
        await this.#requirePrivateDirectory(childPath);
      }
      await this.#writeBatchCheckpoint(directory, checkpoint);
    } catch (error) {
      if (created) {
        try {
          await rm(directory, { recursive: true, force: true });
        } catch {
          // Preserve the fixed batch error.
        }
      }
      if (error instanceof HybridCatalogError) throw error;
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
  }

  async resumeBatch(checkpointInput: LargeCatalogBatchCheckpointV3): Promise<void> {
    const next = this.#validatedBatchCheckpoint(checkpointInput);
    const loaded = await this.loadBatch(next.batchId);
    if (loaded === null) throw new HybridCatalogError("hybrid-batch-unavailable");
    const prior = loaded.checkpoint;
    const priorReceipt = await this.loadBatchReceipt(prior.batchId);
    if (
      priorReceipt === null
      || (prior.status !== "paused" && prior.status !== "partial")
      || next.status !== "scanning"
      || next.stopReason !== null
      || next.runOrdinal !== prior.runOrdinal + 1
      || next.startedAt < priorReceipt.endedAt
      || next.listRequestCount !== 0
      || next.pdfCount !== 0
      || next.directoryCount !== 0
      || next.ignoredFileCount !== 0
      || Object.keys(next.errorCodeCounts).length !== 0
      || next.cumulativeListRequestCount !== prior.cumulativeListRequestCount
      || !this.#sameBatchStructure(prior, next, { allowRunFields: true })
    ) throw new HybridCatalogError("hybrid-batch-invalid");
    await this.#writeBatchCheckpoint(this.#batchDirectory(next.batchId), next);
  }

  async loadBatch(batchIdInput: string): Promise<Readonly<{
    checkpoint: LargeCatalogBatchCheckpointV3;
    records: readonly CloudCatalogRecord[];
    identities: readonly LargeCatalogPageIdentity[];
    identitiesComplete: boolean;
  }> | null> {
    await this.#ensureBatchLayout();
    let batchId: string;
    try {
      batchId = safeImportId(batchIdInput);
    } catch {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    const directory = this.#batchDirectory(batchId);
    try {
      await lstat(directory);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new HybridCatalogError("hybrid-batch-unavailable");
    }
    await this.#requirePrivateDirectory(directory);
    await this.#requirePrivateDirectory(join(directory, "pages"));
    await this.#requirePrivateDirectory(join(directory, "receipts"));
    const checkpoint = await this.#readBatchCheckpoint(directory);
    if (checkpoint.batchId !== batchId) throw new HybridCatalogError("hybrid-batch-invalid");
    const records: CloudCatalogRecord[] = [];
    const identities: LargeCatalogPageIdentity[] = [];
    const fsIds = new Set<string>();
    const paths = new Set<string>();
    let identitiesComplete = true;
    for (const group of checkpoint.groups) {
      for (const pageKey of group.committedPageKeys) {
        const envelope = await this.#readBatchPage(directory, pageKey);
        if (
          envelope.nextCheckpoint.batchId !== batchId
          || !envelope.nextCheckpoint.groups.some((value) => (
            value.committedPageKeys.includes(pageKey)
          ))
        ) throw new HybridCatalogError("hybrid-batch-invalid");
        if (!envelope.identitiesComplete) identitiesComplete = false;
        const pageIdentityPairs = new Set<string>();
        for (const identity of envelope.identities) {
          if (fsIds.has(identity.fsId) || paths.has(identity.path)) {
            throw new HybridCatalogError("hybrid-batch-invalid");
          }
          fsIds.add(identity.fsId);
          paths.add(identity.path);
          pageIdentityPairs.add(`${identity.fsId}\u0000${identity.path}`);
          identities.push({ ...identity });
        }
        for (const record of envelope.records) {
          if (!pageIdentityPairs.has(`${record.fsId}\u0000${record.path}`)) {
            throw new HybridCatalogError("hybrid-batch-invalid");
          }
          records.push(cloneCloudRecord(record));
        }
      }
    }
    return {
      checkpoint: this.#validatedBatchCheckpoint(checkpoint),
      records,
      identities,
      identitiesComplete,
    };
  }

  async loadLatestBatch(): Promise<Readonly<{
    checkpoint: LargeCatalogBatchCheckpointV3;
    records: readonly CloudCatalogRecord[];
    identities: readonly LargeCatalogPageIdentity[];
    identitiesComplete: boolean;
  }> | null> {
    await this.#ensureBatchLayout();
    let entries;
    try {
      entries = await readdir(this.#batchesRoot, { withFileTypes: true });
    } catch {
      throw new HybridCatalogError("hybrid-batch-unavailable");
    }
    const batchIds = entries.map((entry) => {
      if (!entry.isDirectory() || !SAFE_ID_PATTERN.test(entry.name)) {
        throw new HybridCatalogError("hybrid-batch-invalid");
      }
      return entry.name;
    }).sort();
    let latest: Readonly<{
      checkpoint: LargeCatalogBatchCheckpointV3;
      records: readonly CloudCatalogRecord[];
      identities: readonly LargeCatalogPageIdentity[];
      identitiesComplete: boolean;
    }> | null = null;
    for (const batchId of batchIds) {
      const loaded = await this.loadBatch(batchId);
      if (loaded === null) throw new HybridCatalogError("hybrid-batch-invalid");
      if (
        latest === null
        || loaded.checkpoint.startedAt > latest.checkpoint.startedAt
        || (
          loaded.checkpoint.startedAt === latest.checkpoint.startedAt
          && loaded.checkpoint.runOrdinal > latest.checkpoint.runOrdinal
        )
        || (
          loaded.checkpoint.startedAt === latest.checkpoint.startedAt
          && loaded.checkpoint.runOrdinal === latest.checkpoint.runOrdinal
          && loaded.checkpoint.batchId > latest.checkpoint.batchId
        )
      ) latest = loaded;
    }
    return latest;
  }

  async saveBatchPermit(checkpointInput: LargeCatalogBatchCheckpointV3): Promise<void> {
    const next = this.#validatedBatchCheckpoint(checkpointInput);
    const loaded = await this.loadBatch(next.batchId);
    if (loaded === null) throw new HybridCatalogError("hybrid-batch-unavailable");
    const prior = loaded.checkpoint;
    const expected = this.#validatedBatchCheckpoint({
      ...prior,
      listRequestCount: prior.listRequestCount + 1,
      cumulativeListRequestCount: prior.cumulativeListRequestCount + 1,
    });
    if (
      prior.status !== "scanning"
      || next.status !== "scanning"
      || encodeLargeCatalogBatchCheckpoint(next) !== encodeLargeCatalogBatchCheckpoint(expected)
    ) throw new HybridCatalogError("hybrid-batch-invalid");
    await this.#writeBatchCheckpoint(this.#batchDirectory(next.batchId), next);
  }

  async advanceBatchGroup(checkpointInput: LargeCatalogBatchCheckpointV3): Promise<void> {
    const next = this.#validatedBatchCheckpoint(checkpointInput);
    const loaded = await this.loadBatch(next.batchId);
    if (loaded === null) throw new HybridCatalogError("hybrid-batch-unavailable");
    const prior = loaded.checkpoint;
    const priorGroup = prior.groups[prior.currentGroupIndex];
    const nextPriorGroup = next.groups[prior.currentGroupIndex];
    const nextGroup = next.groups[next.currentGroupIndex];
    if (
      prior.status !== "scanning"
      || next.status !== "scanning"
      || priorGroup === undefined
      || priorGroup.pending.length !== 0
      || priorGroup.status !== "scanning"
      || next.currentGroupIndex !== prior.currentGroupIndex + 1
      || nextPriorGroup === undefined
      || nextPriorGroup.status !== "complete"
      || nextGroup === undefined
      || nextGroup.status !== "scanning"
      || JSON.stringify({ ...nextPriorGroup, status: "scanning" }) !== JSON.stringify(priorGroup)
      || !this.#sameBatchStructure(prior, next, { allowGroupAdvance: true })
    ) throw new HybridCatalogError("hybrid-batch-invalid");
    await this.#writeBatchCheckpoint(this.#batchDirectory(next.batchId), next);
  }

  async commitBatchPage(input: Readonly<{
    batchId: string;
    pageKey: string;
    records: readonly CloudCatalogRecord[];
    identities: readonly LargeCatalogPageIdentity[];
    nextCheckpoint: LargeCatalogBatchCheckpointV3;
  }>): Promise<void> {
    let batchId: string;
    try {
      batchId = safeImportId(input.batchId);
    } catch {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    if (!HASH_PATTERN.test(input.pageKey)) throw new HybridCatalogError("hybrid-batch-invalid");
    const next = this.#validatedBatchCheckpoint(input.nextCheckpoint);
    if (next.batchId !== batchId) throw new HybridCatalogError("hybrid-batch-invalid");
    const records = input.records.map((record) => this.#validatedCloudRecord(record));
    const identities = this.#validatedPageIdentities(input.identities);
    const identityPairs = new Set(identities.map((identity) => (
      `${identity.fsId}\u0000${identity.path}`
    )));
    if (records.some((record) => !identityPairs.has(`${record.fsId}\u0000${record.path}`))) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    const directory = this.#batchDirectory(batchId);
    const loaded = await this.loadBatch(batchId);
    if (loaded === null) throw new HybridCatalogError("hybrid-batch-unavailable");
    const prior = loaded.checkpoint;
    const envelope: LargeCatalogBatchPageEnvelopeV2 = {
      schemaVersion: 2,
      pageKey: input.pageKey,
      records,
      identities,
      nextCheckpoint: next,
    };
    const pageRaw = `${JSON.stringify(envelope)}\n`;
    const pagePath = this.#contained(join(directory, "pages", `${input.pageKey}.json`));
    const alreadyCommitted = encodeLargeCatalogBatchCheckpoint(prior)
      === encodeLargeCatalogBatchCheckpoint(next);
    const previouslyCommitted = prior.groups.some((group) => (
      group.committedPageKeys.includes(input.pageKey)
    ));
    if (!alreadyCommitted && !previouslyCommitted) {
      const loadedFsIds = new Set(loaded.identities.map((identity) => identity.fsId));
      const loadedPaths = new Set(loaded.identities.map((identity) => identity.path));
      if (
        !loaded.identitiesComplete
        || identities.some((identity) => (
          loadedFsIds.has(identity.fsId) || loadedPaths.has(identity.path)
        ))
      ) throw new HybridCatalogError("hybrid-batch-invalid");
      this.#validateBatchPageTransition(
        prior,
        next,
        input.pageKey,
        records.length,
        identities.length,
      );
    }

    let pageExists = false;
    try {
      await lstat(pagePath);
      pageExists = true;
    } catch (error) {
      if (!isNotFound(error)) throw new HybridCatalogError("hybrid-batch-invalid");
    }
    if (pageExists) {
      const existing = (await this.#readPrivateFile(pagePath, MAX_BATCH_PAGE_BYTES)).toString("utf8");
      if (existing !== pageRaw) throw new HybridCatalogError("hybrid-batch-invalid");
    } else {
      if (alreadyCommitted || previouslyCommitted) {
        throw new HybridCatalogError("hybrid-batch-invalid");
      }
      await this.#writeAtomic(pagePath, pageRaw);
      const verified = (await this.#readPrivateFile(pagePath, MAX_BATCH_PAGE_BYTES)).toString("utf8");
      if (verified !== pageRaw) throw new HybridCatalogError("hybrid-batch-invalid");
    }
    if (!alreadyCommitted && !previouslyCommitted) {
      await this.#writeBatchCheckpoint(directory, next);
    }
  }

  async finalizeBatchRun(input: Readonly<{
    checkpoint: LargeCatalogBatchCheckpointV3;
    endedAt: number;
  }>): Promise<LargeCatalogRunReceiptV3> {
    const terminal = this.#validatedBatchCheckpoint(input.checkpoint);
    if (!Number.isSafeInteger(input.endedAt) || input.endedAt < terminal.startedAt) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    const loaded = await this.loadBatch(terminal.batchId);
    if (loaded === null) throw new HybridCatalogError("hybrid-batch-unavailable");
    const prior = loaded.checkpoint;
    const receipt = this.#receiptFor(terminal, input.endedAt);
    const directory = this.#batchDirectory(terminal.batchId);
    const receiptPath = this.#batchReceiptPath(directory, terminal.runOrdinal);
    let existing: LargeCatalogRunReceiptV3 | null = null;
    try {
      existing = await this.#readBatchReceiptPath(receiptPath);
    } catch (error) {
      if (!(error instanceof HybridCatalogError) || error.code !== "hybrid-batch-unavailable") {
        throw error;
      }
    }
    if (existing !== null) {
      if (encodeLargeCatalogRunReceipt(existing) !== encodeLargeCatalogRunReceipt(receipt)) {
        throw new HybridCatalogError("hybrid-batch-invalid");
      }
      return { ...existing, budget: { ...existing.budget }, errorCodeCounts: { ...existing.errorCodeCounts } };
    }
    const priorAlreadyTerminal = encodeLargeCatalogBatchCheckpoint(prior)
      === encodeLargeCatalogBatchCheckpoint(terminal);
    if (!priorAlreadyTerminal) this.#validateBatchFinalization(prior, terminal);
    await this.#writeBatchCheckpoint(directory, terminal);
    const raw = `${encodeLargeCatalogRunReceipt(receipt)}\n`;
    await this.#writeAtomic(receiptPath, raw);
    const verified = await this.#readBatchReceiptPath(receiptPath);
    if (encodeLargeCatalogRunReceipt(verified) !== encodeLargeCatalogRunReceipt(receipt)) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    return { ...verified, budget: { ...verified.budget }, errorCodeCounts: { ...verified.errorCodeCounts } };
  }

  async loadBatchReceipt(batchIdInput: string): Promise<LargeCatalogRunReceiptV3 | null> {
    const loaded = await this.loadBatch(batchIdInput);
    if (loaded === null) return null;
    const path = this.#batchReceiptPath(
      this.#batchDirectory(loaded.checkpoint.batchId),
      loaded.checkpoint.runOrdinal,
    );
    try {
      return await this.#readBatchReceiptPath(path);
    } catch (error) {
      if (error instanceof HybridCatalogError && error.code === "hybrid-batch-unavailable") {
        return null;
      }
      throw error;
    }
  }

  async loadActiveOverlays(): Promise<readonly ActiveCatalogOverlay[]> {
    await this.#ensureOverlayLayout();
    const references = await this.#readActiveOverlayReferences();
    const activeCandidate = await this.loadActiveCandidateDescriptor();
    if (activeCandidate === null) return [];
    const overlays: ActiveCatalogOverlay[] = [];
    for (const reference of references) {
      if (reference.sourceImportSha256 !== activeCandidate.sourceSha256) continue;
      const directory = this.#contained(join(this.#overlaysRoot, reference.overlayId));
      await this.#requirePrivateDirectory(directory);
      const descriptorRaw = (await this.#readPrivateFile(
        join(directory, "descriptor.json"),
        64 * 1024,
      )).toString("utf8");
      if (!descriptorRaw.endsWith("\n") || sha256(descriptorRaw) !== reference.descriptorSha256) {
        throw corrupt();
      }
      const descriptor = decodeCatalogOverlayDescriptor(descriptorRaw.slice(0, -1));
      if (
        descriptorRaw !== `${encodeCatalogOverlayDescriptor(descriptor)}\n`
        || descriptor.overlayId !== reference.overlayId
        || descriptor.sourceImportSha256 !== reference.sourceImportSha256
        || descriptor.topLevelGroupId !== reference.topLevelGroupId
      ) throw corrupt();
      const records = await this.#verifyUnifiedRecords(
        join(directory, "records.ndjson"),
        descriptor.recordCount,
        descriptor.recordsSha256,
      );
      const differences = await this.#verifyDifferences(
        join(directory, "differences.ndjson"),
        descriptor.differenceCount,
        descriptor.differencesSha256,
      );
      const supersededCatalogIds = await this.#verifySupersededCatalogIds(
        join(directory, "superseded.ndjson"),
        descriptor.supersededCount,
        descriptor.supersededSha256,
      );
      this.#validateOverlayConsistency(
        descriptor.topLevelGroupId,
        records,
        differences,
      );
      overlays.push({
        descriptor: cloneOverlayDescriptor(descriptor),
        records: records.map(cloneUnifiedRecord),
        differences: differences.map(cloneDifference),
        supersededCatalogIds: [...supersededCatalogIds],
      });
    }
    return overlays;
  }

  async writeCatalogOverlay(
    input: CatalogReconciliationResult,
  ): Promise<CatalogOverlayDescriptor> {
    await this.#ensureOverlayLayout();
    const activeCandidate = await this.loadActiveCandidateDescriptor();
    if (
      activeCandidate === null
      || activeCandidate.sourceSha256 !== input.sourceImportSha256
      || !HASH_PATTERN.test(input.sourceImportSha256)
      || !GROUP_PATTERN.test(input.topLevelGroupId)
      || !Number.isSafeInteger(input.completedAt)
      || input.completedAt < 0
      || input.records.length > MAX_UNIFIED_CATALOG_PDF_COUNT
      || input.differences.length > MAX_DIFFERENCE_COUNT
      || input.supersededCatalogIds.length > MAX_UNIFIED_CATALOG_PDF_COUNT
    ) throw corrupt();
    const priorOverlay = (await this.loadActiveOverlays()).find((overlay) => (
      overlay.descriptor.topLevelGroupId === input.topLevelGroupId
    ));
    if (priorOverlay !== undefined && input.completedAt <= priorOverlay.descriptor.completedAt) {
      throw corrupt();
    }
    const records = input.records.map((record) => (
      decodeUnifiedCatalogRecord(encodeUnifiedCatalogRecordLine(record).slice(0, -1))
    ));
    const recordIds = new Set<string>();
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      const prior = records[index - 1];
      if (
        recordIds.has(record.catalogId)
        || (prior !== undefined && this.#compareUnified(prior, record) >= 0)
      ) throw corrupt();
      recordIds.add(record.catalogId);
    }
    const differences = input.differences.map((difference) => (
      decodeCatalogDifferenceRecord(encodeCatalogDifferenceRecordLine(difference).slice(0, -1))
    ));
    const differenceKeys = new Set<string>();
    for (let index = 0; index < differences.length; index += 1) {
      const difference = differences[index]!;
      const key = `${difference.catalogId}\u0000${difference.kind}`;
      const prior = differences[index - 1];
      if (
        differenceKeys.has(key)
        || (prior !== undefined && this.#compareDifference(prior, difference) >= 0)
      ) throw corrupt();
      differenceKeys.add(key);
    }
    const supersededCatalogIds = [...input.supersededCatalogIds];
    if (
      supersededCatalogIds.some((catalogId) => !CATALOG_ID_PATTERN.test(catalogId))
      || new Set(supersededCatalogIds).size !== supersededCatalogIds.length
      || supersededCatalogIds.some((catalogId, index) => (
        index > 0 && supersededCatalogIds[index - 1]! >= catalogId
      ))
    ) throw corrupt();
    this.#validateOverlayConsistency(input.topLevelGroupId, records, differences);

    let overlayId: string;
    try {
      overlayId = safeImportId(this.createOverlayId());
    } catch {
      throw corrupt();
    }
    const stagingDirectory = this.#contained(join(this.#overlaysRoot, `.staging-${overlayId}`));
    const finalDirectory = this.#contained(join(this.#overlaysRoot, overlayId));
    try {
      await mkdir(stagingDirectory, { mode: DIRECTORY_MODE });
      await this.#requirePrivateDirectory(stagingDirectory);
      const recordsRaw = records.map(encodeUnifiedCatalogRecordLine).join("");
      const differencesRaw = differences.map(encodeCatalogDifferenceRecordLine).join("");
      const supersededRaw = supersededCatalogIds.map((catalogId) => `${JSON.stringify(catalogId)}\n`).join("");
      const descriptor = decodeCatalogOverlayDescriptor(JSON.stringify({
        schemaVersion: 1,
        overlayId,
        sourceImportSha256: input.sourceImportSha256,
        topLevelGroupId: input.topLevelGroupId,
        completedAt: input.completedAt,
        recordCount: records.length,
        differenceCount: differences.length,
        supersededCount: supersededCatalogIds.length,
        recordsSha256: sha256(recordsRaw),
        differencesSha256: sha256(differencesRaw),
        supersededSha256: sha256(supersededRaw),
      }));
      const descriptorRaw = `${encodeCatalogOverlayDescriptor(descriptor)}\n`;
      await this.#writeAtomic(join(stagingDirectory, "records.ndjson"), recordsRaw);
      await this.#writeAtomic(join(stagingDirectory, "differences.ndjson"), differencesRaw);
      await this.#writeAtomic(join(stagingDirectory, "superseded.ndjson"), supersededRaw);
      await this.#writeAtomic(join(stagingDirectory, "descriptor.json"), descriptorRaw);
      await this.#verifyUnifiedRecords(
        join(stagingDirectory, "records.ndjson"),
        descriptor.recordCount,
        descriptor.recordsSha256,
      );
      await this.#verifyDifferences(
        join(stagingDirectory, "differences.ndjson"),
        descriptor.differenceCount,
        descriptor.differencesSha256,
      );
      await this.#verifySupersededCatalogIds(
        join(stagingDirectory, "superseded.ndjson"),
        descriptor.supersededCount,
        descriptor.supersededSha256,
      );
      await this.renames.rename(stagingDirectory, finalDirectory);
      await this.#requirePrivateDirectory(finalDirectory);

      const references = await this.#readActiveOverlayReferences();
      const nextReference: ActiveOverlayReference = {
        schemaVersion: 1,
        overlayId,
        sourceImportSha256: descriptor.sourceImportSha256,
        topLevelGroupId: descriptor.topLevelGroupId,
        descriptorSha256: sha256(descriptorRaw),
      };
      const nextReferences = [
        ...references.filter((reference) => (
          reference.topLevelGroupId !== descriptor.topLevelGroupId
        )),
        nextReference,
      ].sort((left, right) => (
        left.topLevelGroupId < right.topLevelGroupId
          ? -1
          : left.topLevelGroupId > right.topLevelGroupId ? 1 : 0
      ));
      const manifest: ActiveOverlaysManifest = { schemaVersion: 1, overlays: nextReferences };
      await this.#writeAtomic(this.#activeOverlaysPath, `${JSON.stringify(manifest)}\n`);
      return cloneOverlayDescriptor(descriptor);
    } catch (error) {
      try {
        await rm(stagingDirectory, { recursive: true, force: true });
      } catch {
        // Preserve the fixed snapshot failure.
      }
      if (error instanceof HybridCatalogError) throw error;
      throw corrupt();
    }
  }

  async restoreCatalogOverlayActivation(input: Readonly<{
    topLevelGroupId: string;
    descriptor: CatalogOverlayDescriptor | null;
  }>): Promise<void> {
    await this.#ensureOverlayLayout();
    if (!GROUP_PATTERN.test(input.topLevelGroupId)) throw corrupt();
    const activeCandidate = await this.loadActiveCandidateDescriptor();
    if (activeCandidate === null) throw corrupt();
    const references = await this.#readActiveOverlayReferences();
    let restored: ActiveOverlayReference | null = null;
    if (input.descriptor !== null) {
      const descriptor = decodeCatalogOverlayDescriptor(encodeCatalogOverlayDescriptor(
        input.descriptor,
      ));
      if (
        descriptor.topLevelGroupId !== input.topLevelGroupId
        || descriptor.sourceImportSha256 !== activeCandidate.sourceSha256
      ) throw corrupt();
      const directory = this.#contained(join(this.#overlaysRoot, descriptor.overlayId));
      await this.#requirePrivateDirectory(directory);
      const descriptorRaw = (await this.#readPrivateFile(
        join(directory, "descriptor.json"),
        64 * 1024,
      )).toString("utf8");
      if (descriptorRaw !== `${encodeCatalogOverlayDescriptor(descriptor)}\n`) throw corrupt();
      restored = {
        schemaVersion: 1,
        overlayId: descriptor.overlayId,
        sourceImportSha256: descriptor.sourceImportSha256,
        topLevelGroupId: descriptor.topLevelGroupId,
        descriptorSha256: sha256(descriptorRaw),
      };
    }
    const nextReferences = [
      ...references.filter((reference) => reference.topLevelGroupId !== input.topLevelGroupId),
      ...(restored === null ? [] : [restored]),
    ].sort((left, right) => (
      left.topLevelGroupId < right.topLevelGroupId
        ? -1
        : left.topLevelGroupId > right.topLevelGroupId ? 1 : 0
    ));
    const manifest: ActiveOverlaysManifest = { schemaVersion: 1, overlays: nextReferences };
    await this.#writeAtomic(this.#activeOverlaysPath, `${JSON.stringify(manifest)}\n`);
  }

  async writeUnifiedSnapshot(input: Readonly<{
    sourceImportSha256: string;
    records: readonly UnifiedCatalogRecordV1[];
    differences: readonly CatalogDifferenceRecordV1[];
    completedAt: number;
    signal?: AbortSignal;
  }>): Promise<UnifiedCatalogDescriptor> {
    const assertNotAborted = (): void => {
      if (input.signal?.aborted === true) throw corrupt();
    };
    assertNotAborted();
    await this.#ensureUnifiedLayout();
    assertNotAborted();
    const candidate = await this.loadActiveCandidateDescriptor();
    if (
      candidate === null
      || !HASH_PATTERN.test(input.sourceImportSha256)
      || candidate.sourceSha256 !== input.sourceImportSha256
      || !Number.isSafeInteger(input.completedAt)
      || input.completedAt < 0
      || input.records.length > MAX_UNIFIED_CATALOG_PDF_COUNT
      || input.differences.length > MAX_DIFFERENCE_COUNT
    ) throw corrupt();
    const records = input.records.map((record) => (
      decodeUnifiedCatalogRecord(encodeUnifiedCatalogRecordLine(record).slice(0, -1))
    ));
    const recordIds = new Set<string>();
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      if (recordIds.has(record.catalogId)) throw corrupt();
      recordIds.add(record.catalogId);
      const prior = records[index - 1];
      if (prior !== undefined && this.#compareUnified(prior, record) >= 0) throw corrupt();
    }
    const differences = input.differences.map((difference) => (
      decodeCatalogDifferenceRecord(encodeCatalogDifferenceRecordLine(difference).slice(0, -1))
    ));
    const differenceKeys = new Set<string>();
    for (let index = 0; index < differences.length; index += 1) {
      const difference = differences[index]!;
      const key = `${difference.catalogId}\u0000${difference.kind}`;
      if (!recordIds.has(difference.catalogId) || differenceKeys.has(key)) throw corrupt();
      differenceKeys.add(key);
      const prior = differences[index - 1];
      if (prior !== undefined && this.#compareDifference(prior, difference) >= 0) throw corrupt();
    }
    let snapshotId: string;
    try {
      snapshotId = safeImportId(this.createUnifiedSnapshotId());
    } catch {
      throw corrupt();
    }
    const stagingDirectory = this.#contained(join(this.#unifiedRoot, `.staging-${snapshotId}`));
    const finalDirectory = this.#contained(join(this.#unifiedRoot, snapshotId));
    let promotedToFinal = false;
    try {
      await mkdir(stagingDirectory, { mode: DIRECTORY_MODE });
      await this.#requirePrivateDirectory(stagingDirectory);
      const catalogRaw = records.map(encodeUnifiedCatalogRecordLine).join("");
      const differencesRaw = differences.map(encodeCatalogDifferenceRecordLine).join("");
      const descriptor = decodeUnifiedCatalogDescriptor(JSON.stringify({
        schemaVersion: 1,
        snapshotId,
        sourceImportSha256: input.sourceImportSha256,
        completedAt: input.completedAt,
        recordCount: records.length,
        differenceCount: differences.length,
        catalogSha256: sha256(catalogRaw),
        differencesSha256: sha256(differencesRaw),
      }));
      const descriptorRaw = `${JSON.stringify(descriptor)}\n`;
      await this.#writeAtomic(join(stagingDirectory, "catalog.ndjson"), catalogRaw);
      assertNotAborted();
      await this.#writeAtomic(join(stagingDirectory, "differences.ndjson"), differencesRaw);
      assertNotAborted();
      await this.#writeAtomic(join(stagingDirectory, "descriptor.json"), descriptorRaw);
      await this.#verifyUnifiedRecords(
        join(stagingDirectory, "catalog.ndjson"),
        descriptor.recordCount,
        descriptor.catalogSha256,
      );
      await this.#verifyDifferences(
        join(stagingDirectory, "differences.ndjson"),
        descriptor.differenceCount,
        descriptor.differencesSha256,
      );
      assertNotAborted();
      await this.renames.rename(stagingDirectory, finalDirectory);
      promotedToFinal = true;
      await this.#requirePrivateDirectory(finalDirectory);
      assertNotAborted();
      const active: ActiveUnifiedManifestV2 = {
        schemaVersion: 2,
        snapshotId,
        sourceImportSha256: descriptor.sourceImportSha256,
        candidateImportId: candidate.importId,
        descriptorSha256: sha256(descriptorRaw),
        recordCount: descriptor.recordCount,
        differenceCount: descriptor.differenceCount,
      };
      let priorActiveRaw: string | null = null;
      try {
        await lstat(this.#activeUnifiedPath);
        priorActiveRaw = (await this.#readPrivateFile(
          this.#activeUnifiedPath,
          64 * 1024,
        )).toString("utf8");
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      assertNotAborted();
      await this.#writeAtomic(this.#activeUnifiedPath, `${JSON.stringify(active)}\n`);
      if (input.signal?.aborted === true) {
        if (priorActiveRaw === null) await rm(this.#activeUnifiedPath, { force: true });
        else await this.#writeAtomic(this.#activeUnifiedPath, priorActiveRaw);
        throw corrupt();
      }
      return cloneUnifiedDescriptor(descriptor);
    } catch (error) {
      try {
        await rm(stagingDirectory, { recursive: true, force: true });
        if (promotedToFinal) await rm(finalDirectory, { recursive: true, force: true });
      } catch {
        // Preserve the fixed snapshot failure.
      }
      if (error instanceof HybridCatalogError) throw error;
      throw corrupt();
    }
  }

  async loadActiveUnified(): Promise<Readonly<{
    descriptor: UnifiedCatalogDescriptor;
    records: readonly UnifiedCatalogRecordV1[];
    differences: readonly CatalogDifferenceRecordV1[];
  }> | null> {
    await this.#ensureUnifiedLayout();
    try {
      await lstat(this.#activeUnifiedPath);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw corrupt();
    }
    const activeRaw = (await this.#readPrivateFile(
      this.#activeUnifiedPath,
      64 * 1024,
    )).toString("utf8");
    const active = decodeActiveUnifiedManifest(activeRaw);
    const candidate = await this.loadActiveCandidateDescriptor();
    if (
      candidate === null
      || candidate.sourceSha256 !== active.sourceImportSha256
      || (
        active.schemaVersion === 2
        && candidate.importId !== active.candidateImportId
      )
    ) {
      return null;
    }
    const snapshotDirectory = this.#contained(join(this.#unifiedRoot, active.snapshotId));
    await this.#requirePrivateDirectory(snapshotDirectory);
    const descriptorRaw = (await this.#readPrivateFile(
      join(snapshotDirectory, "descriptor.json"),
      64 * 1024,
    )).toString("utf8");
    if (!descriptorRaw.endsWith("\n") || sha256(descriptorRaw) !== active.descriptorSha256) {
      throw corrupt();
    }
    const descriptor = decodeUnifiedCatalogDescriptor(descriptorRaw.slice(0, -1));
    if (
      descriptorRaw !== `${JSON.stringify(descriptor)}\n`
      || descriptor.snapshotId !== active.snapshotId
      || descriptor.sourceImportSha256 !== active.sourceImportSha256
      || descriptor.recordCount !== active.recordCount
      || descriptor.differenceCount !== active.differenceCount
    ) throw corrupt();
    const records = await this.#verifyUnifiedRecords(
      join(snapshotDirectory, "catalog.ndjson"),
      descriptor.recordCount,
      descriptor.catalogSha256,
    );
    const differences = await this.#verifyDifferences(
      join(snapshotDirectory, "differences.ndjson"),
      descriptor.differenceCount,
      descriptor.differencesSha256,
    );
    const recordIds = new Set(records.map((record) => record.catalogId));
    if (differences.some((difference) => !recordIds.has(difference.catalogId))) throw corrupt();
    return {
      descriptor: cloneUnifiedDescriptor(descriptor),
      records: records.map(cloneUnifiedRecord),
      differences: differences.map(cloneDifference),
    };
  }

  #validatedBatchCheckpoint(
    checkpoint: LargeCatalogBatchCheckpointV3,
  ): LargeCatalogBatchCheckpointV3 {
    return decodeLargeCatalogBatchCheckpoint(encodeLargeCatalogBatchCheckpoint(checkpoint));
  }

  #batchDirectory(batchId: string): string {
    return this.#contained(join(this.#batchesRoot, safeImportId(batchId)));
  }

  #batchReceiptPath(directory: string, runOrdinal: number): string {
    if (!Number.isSafeInteger(runOrdinal) || runOrdinal < 1) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    return this.#contained(join(directory, "receipts", `run-${runOrdinal}.json`));
  }

  async #writeBatchCheckpoint(
    directory: string,
    checkpoint: LargeCatalogBatchCheckpointV3,
  ): Promise<void> {
    const decoded = this.#validatedBatchCheckpoint(checkpoint);
    await this.#writeAtomic(
      join(directory, "checkpoint.json"),
      `${encodeLargeCatalogBatchCheckpoint(decoded)}\n`,
    );
  }

  async #readBatchCheckpoint(directory: string): Promise<LargeCatalogBatchCheckpointV3> {
    let raw: string;
    try {
      raw = (await this.#readPrivateFile(
        join(directory, "checkpoint.json"),
        MAX_BATCH_CHECKPOINT_BYTES,
      )).toString("utf8");
    } catch {
      throw new HybridCatalogError("hybrid-batch-unavailable");
    }
    if (!raw.endsWith("\n")) throw new HybridCatalogError("hybrid-batch-invalid");
    const decoded = decodeLargeCatalogBatchCheckpoint(raw.slice(0, -1));
    if (raw !== `${encodeLargeCatalogBatchCheckpoint(decoded)}\n`) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    return decoded;
  }

  #validatedCloudRecord(input: CloudCatalogRecord): CloudCatalogRecord {
    let path: string;
    try {
      path = normalizeCloudAbsolutePath(input.path);
    } catch {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    const filename = path.slice(path.lastIndexOf("/") + 1);
    const parentPath = path.slice(0, path.lastIndexOf("/")) || "/";
    const expectedIsbns = isbnCandidatesFromFilename(filename);
    const decoded: CloudCatalogRecord = {
      schemaVersion: 1,
      source: "baidu-netdisk",
      fsId: input.fsId,
      kind: "file",
      path,
      parentPath,
      filename,
      extension: "pdf",
      title: filename.slice(0, -4),
      isbnCandidates: [...expectedIsbns],
      sizeBytes: input.sizeBytes,
      serverModifiedAt: input.serverModifiedAt,
    };
    if (
      input.schemaVersion !== 1
      || input.source !== "baidu-netdisk"
      || input.kind !== "file"
      || !/^(?:0|[1-9]\d*)$/u.test(input.fsId)
      || input.path !== path
      || input.parentPath !== parentPath
      || input.filename !== filename
      || input.extension !== "pdf"
      || input.title !== decoded.title
      || JSON.stringify(input.isbnCandidates) !== JSON.stringify(expectedIsbns)
      || !Number.isSafeInteger(input.sizeBytes)
      || input.sizeBytes < 0
      || !Number.isSafeInteger(input.serverModifiedAt)
      || input.serverModifiedAt < 0
      || !/\.pdf$/iu.test(filename)
      || JSON.stringify(input) !== JSON.stringify(decoded)
    ) throw new HybridCatalogError("hybrid-batch-invalid");
    return cloneCloudRecord(decoded);
  }

  #validatedPageIdentities(
    input: readonly LargeCatalogPageIdentity[],
  ): readonly LargeCatalogPageIdentity[] {
    if (input.length > 1000) throw new HybridCatalogError("hybrid-batch-invalid");
    const fsIds = new Set<string>();
    const paths = new Set<string>();
    const identities = input.map((identity) => {
      let path: string;
      try {
        path = normalizeCloudAbsolutePath(identity.path);
      } catch {
        throw new HybridCatalogError("hybrid-batch-invalid");
      }
      const decoded: LargeCatalogPageIdentity = { fsId: identity.fsId, path };
      if (
        !/^(?:0|[1-9]\d*)$/u.test(identity.fsId)
        || identity.path !== path
        || JSON.stringify(identity) !== JSON.stringify(decoded)
        || fsIds.has(identity.fsId)
        || paths.has(path)
      ) throw new HybridCatalogError("hybrid-batch-invalid");
      fsIds.add(identity.fsId);
      paths.add(path);
      return decoded;
    });
    if (identities.some((identity, index) => {
      const prior = identities[index - 1];
      return prior !== undefined && (
        prior.path > identity.path
        || (prior.path === identity.path && prior.fsId >= identity.fsId)
      );
    })) throw new HybridCatalogError("hybrid-batch-invalid");
    return identities;
  }

  async #readBatchPage(
    directory: string,
    pageKey: string,
  ): Promise<DecodedLargeCatalogBatchPage> {
    if (!HASH_PATTERN.test(pageKey)) throw new HybridCatalogError("hybrid-batch-invalid");
    let raw: string;
    try {
      raw = (await this.#readPrivateFile(
        join(directory, "pages", `${pageKey}.json`),
        MAX_BATCH_PAGE_BYTES,
      )).toString("utf8");
    } catch {
      throw new HybridCatalogError("hybrid-batch-unavailable");
    }
    if (!raw.endsWith("\n")) throw new HybridCatalogError("hybrid-batch-invalid");
    let value: unknown;
    try {
      value = JSON.parse(raw.slice(0, -1));
    } catch {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    const record = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).sort();
    const legacy = record.schemaVersion === 1;
    const current = record.schemaVersion === 2;
    if (
      (!legacy && !current)
      || record.pageKey !== pageKey
      || !Array.isArray(record.records)
      || (legacy && (
        keys.length !== 4
        || keys[0] !== "nextCheckpoint"
        || keys[1] !== "pageKey"
        || keys[2] !== "records"
        || keys[3] !== "schemaVersion"
      ))
      || (current && (
        keys.length !== 5
        || keys[0] !== "identities"
        || keys[1] !== "nextCheckpoint"
        || keys[2] !== "pageKey"
        || keys[3] !== "records"
        || keys[4] !== "schemaVersion"
        || !Array.isArray(record.identities)
      ))
    ) throw new HybridCatalogError("hybrid-batch-invalid");
    const records = record.records.map((item) => this.#validatedCloudRecord(
      item as CloudCatalogRecord,
    ));
    const identities = current
      ? this.#validatedPageIdentities(record.identities as readonly LargeCatalogPageIdentity[])
      : this.#validatedPageIdentities(records.map(({ fsId, path }) => ({ fsId, path })));
    const nextCheckpoint = decodeLargeCatalogBatchCheckpoint(JSON.stringify(record.nextCheckpoint));
    const decoded = current
      ? {
        schemaVersion: 2 as const,
        pageKey,
        records,
        identities,
        nextCheckpoint,
      } satisfies LargeCatalogBatchPageEnvelopeV2
      : {
        schemaVersion: 1 as const,
        pageKey,
        records,
        nextCheckpoint,
      } satisfies LargeCatalogBatchPageEnvelopeV1;
    if (raw !== `${JSON.stringify(decoded)}\n`) throw new HybridCatalogError("hybrid-batch-invalid");
    return {
      records,
      identities,
      identitiesComplete: current,
      nextCheckpoint,
    };
  }

  #sameBatchStructure(
    left: LargeCatalogBatchCheckpointV3,
    right: LargeCatalogBatchCheckpointV3,
    options: Readonly<{
      allowRunFields?: boolean;
      allowGroupAdvance?: boolean;
    }>,
  ): boolean {
    const normalized = (value: LargeCatalogBatchCheckpointV3): LargeCatalogBatchCheckpointV3 => ({
      ...value,
      ...(options.allowRunFields ? {
        startedAt: 0,
        runOrdinal: 1,
        pdfCount: 0,
        directoryCount: 0,
        ignoredFileCount: 0,
        listRequestCount: 0,
        status: "scanning",
        stopReason: null,
        errorCodeCounts: {},
      } as const : {}),
      ...(options.allowGroupAdvance ? {
        currentGroupIndex: 0,
        groups: value.groups.map((group) => ({ ...group, status: "pending" as const })),
      } : {}),
    });
    return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
  }

  #validateBatchPageTransition(
    prior: LargeCatalogBatchCheckpointV3,
    next: LargeCatalogBatchCheckpointV3,
    pageKey: string,
    recordCount: number,
    identityCount: number,
  ): void {
    const priorGroup = prior.groups[prior.currentGroupIndex];
    const nextGroup = next.groups[next.currentGroupIndex];
    const immutableMatches = (
      prior.batchId === next.batchId
      && prior.sourceImportSha256 === next.sourceImportSha256
      && prior.cloudRootSha256 === next.cloudRootSha256
      && prior.startedAt === next.startedAt
      && prior.runOrdinal === next.runOrdinal
      && JSON.stringify(prior.budget) === JSON.stringify(next.budget)
      && prior.selectedGroupCount === next.selectedGroupCount
      && prior.currentGroupIndex === next.currentGroupIndex
      && prior.listRequestCount === next.listRequestCount
      && prior.cumulativeListRequestCount === next.cumulativeListRequestCount
      && prior.status === "scanning"
      && next.status === "scanning"
      && prior.stopReason === null
      && next.stopReason === null
      && JSON.stringify(prior.errorCodeCounts) === JSON.stringify(next.errorCodeCounts)
    );
    if (
      !immutableMatches
      || priorGroup === undefined
      || nextGroup === undefined
      || priorGroup.status !== "scanning"
      || nextGroup.status !== "scanning"
      || priorGroup.groupKey !== nextGroup.groupKey
      || priorGroup.rootRelativePath !== nextGroup.rootRelativePath
      || priorGroup.mode !== nextGroup.mode
      || nextGroup.committedPageKeys.length !== priorGroup.committedPageKeys.length + 1
      || nextGroup.committedPageKeys.at(-1) !== pageKey
      || nextGroup.committedPageKeys.slice(0, -1).some((key, index) => (
        key !== priorGroup.committedPageKeys[index]
      ))
      || prior.groups.some((group, index) => (
        index !== prior.currentGroupIndex
        && JSON.stringify(group) !== JSON.stringify(next.groups[index])
      ))
      || nextGroup.completedDirectoryCount < priorGroup.completedDirectoryCount
      || nextGroup.completedDirectoryCount > priorGroup.completedDirectoryCount + 1
      || next.pdfCount !== prior.pdfCount + recordCount
      || next.directoryCount < prior.directoryCount
      || next.ignoredFileCount < prior.ignoredFileCount
      || identityCount !== (
        (next.pdfCount - prior.pdfCount)
        + (next.directoryCount - prior.directoryCount)
        + (next.ignoredFileCount - prior.ignoredFileCount)
      )
    ) throw new HybridCatalogError("hybrid-batch-invalid");
  }

  #validateBatchFinalization(
    prior: LargeCatalogBatchCheckpointV3,
    terminal: LargeCatalogBatchCheckpointV3,
  ): void {
    const priorGroup = prior.groups[prior.currentGroupIndex];
    const completesLastGroup = (
      terminal.status === "complete"
      && prior.currentGroupIndex === prior.selectedGroupCount - 1
      && terminal.currentGroupIndex === prior.selectedGroupCount
      && priorGroup !== undefined
      && priorGroup.status === "scanning"
      && priorGroup.pending.length === 0
      && JSON.stringify(terminal.groups) === JSON.stringify(prior.groups.map((group, index) => (
        index === prior.currentGroupIndex ? { ...group, status: "complete" as const } : group
      )))
    );
    if (
      prior.status !== "scanning"
      || terminal.status === "scanning"
      || prior.batchId !== terminal.batchId
      || prior.sourceImportSha256 !== terminal.sourceImportSha256
      || prior.cloudRootSha256 !== terminal.cloudRootSha256
      || prior.startedAt !== terminal.startedAt
      || prior.runOrdinal !== terminal.runOrdinal
      || JSON.stringify(prior.budget) !== JSON.stringify(terminal.budget)
      || prior.selectedGroupCount !== terminal.selectedGroupCount
      || (!completesLastGroup && prior.currentGroupIndex !== terminal.currentGroupIndex)
      || (!completesLastGroup && JSON.stringify(prior.groups) !== JSON.stringify(terminal.groups))
      || prior.pdfCount !== terminal.pdfCount
      || prior.directoryCount !== terminal.directoryCount
      || prior.ignoredFileCount !== terminal.ignoredFileCount
      || prior.listRequestCount !== terminal.listRequestCount
      || prior.cumulativeListRequestCount !== terminal.cumulativeListRequestCount
    ) throw new HybridCatalogError("hybrid-batch-invalid");
    if (terminal.status === "partial") {
      const code = terminal.stopReason;
      const expected = {
        ...prior.errorCodeCounts,
        [code!]: (prior.errorCodeCounts[code as keyof typeof prior.errorCodeCounts] ?? 0) + 1,
      };
      if (JSON.stringify(expected) !== JSON.stringify(terminal.errorCodeCounts)) {
        throw new HybridCatalogError("hybrid-batch-invalid");
      }
    } else if (JSON.stringify(prior.errorCodeCounts) !== JSON.stringify(terminal.errorCodeCounts)) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
  }

  #receiptFor(
    checkpoint: LargeCatalogBatchCheckpointV3,
    endedAt: number,
  ): LargeCatalogRunReceiptV3 {
    if (checkpoint.status === "scanning" || checkpoint.stopReason === null) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    return decodeLargeCatalogRunReceipt(JSON.stringify({
      schemaVersion: 3,
      status: checkpoint.status,
      stopReason: checkpoint.stopReason,
      startedAt: checkpoint.startedAt,
      endedAt,
      durationMs: endedAt - checkpoint.startedAt,
      budget: checkpoint.budget,
      selectedGroupCount: checkpoint.selectedGroupCount,
      completedGroupCount: checkpoint.groups.filter((group) => group.status === "complete").length,
      listRequestCount: checkpoint.listRequestCount,
      cumulativeListRequestCount: checkpoint.cumulativeListRequestCount,
      directoryCount: checkpoint.directoryCount,
      pdfCount: checkpoint.pdfCount,
      ignoredFileCount: checkpoint.ignoredFileCount,
      downloadedPdfBytes: 0,
      errorCodeCounts: checkpoint.errorCodeCounts,
    }));
  }

  async #readBatchReceiptPath(path: string): Promise<LargeCatalogRunReceiptV3> {
    let raw: string;
    try {
      raw = (await this.#readPrivateFile(path, 1024 * 1024)).toString("utf8");
    } catch {
      throw new HybridCatalogError("hybrid-batch-unavailable");
    }
    if (!raw.endsWith("\n")) throw new HybridCatalogError("hybrid-batch-invalid");
    const decoded = decodeLargeCatalogRunReceipt(raw.slice(0, -1));
    if (raw !== `${encodeLargeCatalogRunReceipt(decoded)}\n`) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    return {
      ...decoded,
      budget: { ...decoded.budget },
      errorCodeCounts: { ...decoded.errorCodeCounts },
    };
  }

  async #ensureLayout(): Promise<void> {
    try {
      await mkdir(this.#root, { recursive: true, mode: DIRECTORY_MODE });
      const root = await lstat(this.#root);
      if (!root.isDirectory() || root.isSymbolicLink()) throw corrupt();
    } catch (error) {
      if (error instanceof HybridCatalogError) throw error;
      throw corrupt();
    }
    for (const path of [this.#hybridRoot, this.#importsRoot]) {
      this.#contained(path);
      try {
        await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
        const entry = await lstat(path);
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw corrupt();
        await chmod(path, DIRECTORY_MODE);
        await this.#requirePrivateDirectory(path);
      } catch (error) {
        if (error instanceof HybridCatalogError) throw error;
        throw corrupt();
      }
    }
  }

  async #ensureUnifiedLayout(): Promise<void> {
    await this.#ensureLayout();
    try {
      await mkdir(this.#unifiedRoot, { recursive: true, mode: DIRECTORY_MODE });
      const entry = await lstat(this.#unifiedRoot);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw corrupt();
      await chmod(this.#unifiedRoot, DIRECTORY_MODE);
      await this.#requirePrivateDirectory(this.#unifiedRoot);
    } catch (error) {
      if (error instanceof HybridCatalogError) throw error;
      throw corrupt();
    }
  }

  async #ensureOverlayLayout(): Promise<void> {
    await this.#ensureLayout();
    try {
      await mkdir(this.#overlaysRoot, { recursive: true, mode: DIRECTORY_MODE });
      const entry = await lstat(this.#overlaysRoot);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw corrupt();
      await chmod(this.#overlaysRoot, DIRECTORY_MODE);
      await this.#requirePrivateDirectory(this.#overlaysRoot);
    } catch (error) {
      if (error instanceof HybridCatalogError) throw error;
      throw corrupt();
    }
  }

  async #ensureBatchLayout(): Promise<void> {
    await this.#ensureLayout();
    try {
      await mkdir(this.#batchesRoot, { recursive: true, mode: DIRECTORY_MODE });
      const entry = await lstat(this.#batchesRoot);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw corrupt();
      await chmod(this.#batchesRoot, DIRECTORY_MODE);
      await this.#requirePrivateDirectory(this.#batchesRoot);
    } catch (error) {
      if (error instanceof HybridCatalogError) throw error;
      throw new HybridCatalogError("hybrid-batch-unavailable");
    }
  }

  async #readActiveOverlayReferences(): Promise<readonly ActiveOverlayReference[]> {
    try {
      await lstat(this.#activeOverlaysPath);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw corrupt();
    }
    const raw = (await this.#readPrivateFile(
      this.#activeOverlaysPath,
      1024 * 1024,
    )).toString("utf8");
    return decodeActiveOverlaysManifest(raw).overlays.map((reference) => ({ ...reference }));
  }

  #contained(path: string): string {
    const resolved = resolve(path);
    if (
      !isAbsolute(resolved)
      || (resolved !== this.#root && !resolved.startsWith(`${this.#root}${sep}`))
    ) throw corrupt();
    return resolved;
  }

  async #requirePrivateDirectory(path: string): Promise<void> {
    try {
      const entry = await lstat(this.#contained(path));
      if (
        !entry.isDirectory()
        || entry.isSymbolicLink()
        || (entry.mode & 0o777) !== DIRECTORY_MODE
      ) throw corrupt();
    } catch (error) {
      if (error instanceof HybridCatalogError) throw error;
      throw corrupt();
    }
  }

  async #readPrivateFile(
    path: string,
    maximumBytes: number,
    minimumBytes = 1,
  ): Promise<Buffer> {
    const contained = this.#contained(path);
    let handle: FileHandle | undefined;
    try {
      const initial = await lstat(contained);
      if (
        !initial.isFile()
        || initial.isSymbolicLink()
        || (initial.mode & 0o777) !== FILE_MODE
        || initial.size < minimumBytes
        || initial.size > maximumBytes
      ) throw corrupt();
      handle = await open(contained, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!sameFile(initial, opened)) throw corrupt();
      const content = await handle.readFile();
      const completed = await handle.stat();
      const completedPath = await lstat(contained);
      if (!sameFile(initial, completed) || !sameFile(initial, completedPath)) throw corrupt();
      return content;
    } catch (error) {
      if (error instanceof HybridCatalogError) throw error;
      throw corrupt();
    } finally {
      if (handle !== undefined) {
        try {
          await handle.close();
        } catch {
          // Read-only cleanup cannot expose native details.
        }
      }
    }
  }

  async #verifyCandidates(
    path: string,
    expectedCount: number,
    expectedSha256: string,
  ): Promise<void> {
    await this.#verifyCandidateGroups(path, expectedCount, expectedSha256, new Set());
  }

  async #verifyCandidateGroups(
    path: string,
    expectedCount: number,
    expectedSha256: string,
    selectedGroupKeys: ReadonlySet<string> | null,
  ): Promise<readonly TxtCandidateRecordV1[]> {
    if (
      !Number.isSafeInteger(expectedCount)
      || expectedCount < 1
      || !HASH_PATTERN.test(expectedSha256)
    ) throw corrupt();
    const contained = this.#contained(path);
    const records: TxtCandidateRecordV1[] = [];
    let count = 0;
    let handle: FileHandle | undefined;
    const hasher = createHash("sha256");
    const decoder = new StringDecoder("utf8");
    let carry = "";
    const consume = (line: string): void => {
      if (line.length === 0) throw corrupt();
      const groupKey = selectedGroupKeys === null
        ? null
        : CANDIDATE_GROUP_FIELD_PATTERN.exec(line)?.[1] ?? null;
      if (selectedGroupKeys === null || (groupKey !== null && selectedGroupKeys.has(groupKey))) {
        const decoded = decodeTxtCandidateRecord(line);
        if (`${line}\n` !== encodeTxtCandidateRecordLine(decoded)) throw corrupt();
        records.push(decoded);
      }
      count += 1;
      if (count > expectedCount) throw corrupt();
    };
    try {
      const initial = await lstat(contained);
      if (
        !initial.isFile()
        || initial.isSymbolicLink()
        || (initial.mode & 0o777) !== FILE_MODE
        || initial.size < 1
        || initial.size > MAX_CANDIDATE_BYTES
      ) throw corrupt();
      handle = await open(contained, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!sameFile(initial, opened)) throw corrupt();
      const chunk = Buffer.allocUnsafe(64 * 1024);
      while (true) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        const bytes = chunk.subarray(0, bytesRead);
        hasher.update(bytes);
        const text = carry + decoder.write(bytes);
        let offset = 0;
        while (true) {
          const end = text.indexOf("\n", offset);
          if (end < 0) break;
          consume(text.slice(offset, end));
          offset = end + 1;
        }
        carry = text.slice(offset);
      }
      carry += decoder.end();
      if (carry.length !== 0 || count !== expectedCount || hasher.digest("hex") !== expectedSha256) {
        throw corrupt();
      }
      const completed = await handle.stat();
      const completedPath = await lstat(contained);
      if (!sameFile(initial, completed) || !sameFile(initial, completedPath)) throw corrupt();
    } catch {
      throw corrupt();
    } finally {
      if (handle !== undefined) {
        try {
          await handle.close();
        } catch {
          // Read-only cleanup cannot expose native details.
        }
      }
    }
    return records;
  }

  #compareUnified(left: UnifiedCatalogRecordV1, right: UnifiedCatalogRecordV1): number {
    if (left.relativePath < right.relativePath) return -1;
    if (left.relativePath > right.relativePath) return 1;
    if (left.catalogId < right.catalogId) return -1;
    if (left.catalogId > right.catalogId) return 1;
    return 0;
  }

  #compareDifference(
    left: CatalogDifferenceRecordV1,
    right: CatalogDifferenceRecordV1,
  ): number {
    if (left.catalogId < right.catalogId) return -1;
    if (left.catalogId > right.catalogId) return 1;
    if (left.kind < right.kind) return -1;
    if (left.kind > right.kind) return 1;
    return 0;
  }

  async #verifyUnifiedRecords(
    path: string,
    expectedCount: number,
    expectedSha256: string,
  ): Promise<readonly UnifiedCatalogRecordV1[]> {
    if (
      !Number.isSafeInteger(expectedCount)
      || expectedCount < 0
      || expectedCount > MAX_UNIFIED_CATALOG_PDF_COUNT
      || !HASH_PATTERN.test(expectedSha256)
    ) throw corrupt();
    const content = await this.#readPrivateFile(path, MAX_UNIFIED_BYTES, expectedCount === 0 ? 0 : 1);
    if (sha256(content) !== expectedSha256) throw corrupt();
    if (expectedCount === 0) {
      if (content.length !== 0) throw corrupt();
      return [];
    }
    const raw = content.toString("utf8");
    if (!raw.endsWith("\n")) throw corrupt();
    const lines = raw.slice(0, -1).split("\n");
    if (lines.length !== expectedCount || lines.some((line) => line.length === 0)) throw corrupt();
    const records: UnifiedCatalogRecordV1[] = [];
    const ids = new Set<string>();
    for (const line of lines) {
      const decoded = decodeUnifiedCatalogRecord(line);
      const prior = records.at(-1);
      if (
        `${line}\n` !== encodeUnifiedCatalogRecordLine(decoded)
        || ids.has(decoded.catalogId)
        || (prior !== undefined && this.#compareUnified(prior, decoded) >= 0)
      ) throw corrupt();
      ids.add(decoded.catalogId);
      records.push(decoded);
    }
    return records;
  }

  async #verifyDifferences(
    path: string,
    expectedCount: number,
    expectedSha256: string,
  ): Promise<readonly CatalogDifferenceRecordV1[]> {
    if (
      !Number.isSafeInteger(expectedCount)
      || expectedCount < 0
      || expectedCount > MAX_DIFFERENCE_COUNT
      || !HASH_PATTERN.test(expectedSha256)
    ) throw corrupt();
    const content = await this.#readPrivateFile(path, MAX_UNIFIED_BYTES, expectedCount === 0 ? 0 : 1);
    if (sha256(content) !== expectedSha256) throw corrupt();
    if (expectedCount === 0) {
      if (content.length !== 0) throw corrupt();
      return [];
    }
    const raw = content.toString("utf8");
    if (!raw.endsWith("\n")) throw corrupt();
    const lines = raw.slice(0, -1).split("\n");
    if (lines.length !== expectedCount || lines.some((line) => line.length === 0)) throw corrupt();
    const differences: CatalogDifferenceRecordV1[] = [];
    const keys = new Set<string>();
    for (const line of lines) {
      const decoded = decodeCatalogDifferenceRecord(line);
      const key = `${decoded.catalogId}\u0000${decoded.kind}`;
      const prior = differences.at(-1);
      if (
        `${line}\n` !== encodeCatalogDifferenceRecordLine(decoded)
        || keys.has(key)
        || (prior !== undefined && this.#compareDifference(prior, decoded) >= 0)
      ) throw corrupt();
      keys.add(key);
      differences.push(decoded);
    }
    return differences;
  }

  async #verifySupersededCatalogIds(
    path: string,
    expectedCount: number,
    expectedSha256: string,
  ): Promise<readonly string[]> {
    if (
      !Number.isSafeInteger(expectedCount)
      || expectedCount < 0
      || expectedCount > MAX_UNIFIED_CATALOG_PDF_COUNT
      || !HASH_PATTERN.test(expectedSha256)
    ) throw corrupt();
    const content = await this.#readPrivateFile(path, MAX_UNIFIED_BYTES, expectedCount === 0 ? 0 : 1);
    if (sha256(content) !== expectedSha256) throw corrupt();
    if (expectedCount === 0) {
      if (content.length !== 0) throw corrupt();
      return [];
    }
    const raw = content.toString("utf8");
    if (!raw.endsWith("\n")) throw corrupt();
    const lines = raw.slice(0, -1).split("\n");
    if (lines.length !== expectedCount || lines.some((line) => line.length === 0)) throw corrupt();
    const catalogIds: string[] = [];
    for (const line of lines) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw corrupt();
      }
      const prior = catalogIds.at(-1);
      if (
        typeof value !== "string"
        || !CATALOG_ID_PATTERN.test(value)
        || line !== JSON.stringify(value)
        || (prior !== undefined && prior >= value)
      ) throw corrupt();
      catalogIds.push(value);
    }
    return catalogIds;
  }

  #validateOverlayConsistency(
    topLevelGroupId: string,
    records: readonly UnifiedCatalogRecordV1[],
    differences: readonly CatalogDifferenceRecordV1[],
  ): void {
    const recordsById = new Map(records.map((record) => [record.catalogId, record] as const));
    const activeKindsById = new Map<string, Set<string>>();
    for (const record of records) {
      if (record.topLevelGroupId !== topLevelGroupId) throw corrupt();
    }
    for (const difference of differences) {
      if (difference.topLevelGroupId !== topLevelGroupId) throw corrupt();
      if (difference.acknowledgedAt !== null) continue;
      const record = recordsById.get(difference.catalogId);
      if (record === undefined || !record.differenceKinds.includes(difference.kind)) throw corrupt();
      const kinds = activeKindsById.get(difference.catalogId) ?? new Set<string>();
      kinds.add(difference.kind);
      activeKindsById.set(difference.catalogId, kinds);
    }
    for (const record of records) {
      const activeKinds = activeKindsById.get(record.catalogId) ?? new Set<string>();
      if (
        activeKinds.size !== record.differenceKinds.length
        || record.differenceKinds.some((kind) => !activeKinds.has(kind))
      ) throw corrupt();
    }
  }

  async #writeAtomic(destinationInput: string, content: string): Promise<void> {
    const destination = this.#contained(destinationInput);
    await this.#requirePrivateDirectory(dirname(destination));
    const temporary = this.#contained(join(
      dirname(destination),
      `.${basename(destination)}.${randomUUID()}.tmp`,
    ));
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporary, "wx", FILE_MODE);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temporary, FILE_MODE);
      await this.renames.rename(temporary, destination);
      const completed = await lstat(destination);
      if (
        !completed.isFile()
        || completed.isSymbolicLink()
        || (completed.mode & 0o777) !== FILE_MODE
      ) throw corrupt();
    } catch (error) {
      if (handle !== undefined) {
        try {
          await handle.close();
        } catch {
          // Cleanup remains best effort.
        }
      }
      try {
        await rm(temporary, { force: true });
      } catch {
        // Preserve the fixed write failure.
      }
      if (error instanceof HybridCatalogError) throw error;
      throw corrupt();
    }
  }
}
