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
  decodeLargeCatalogActiveCheckpointPointer,
  decodeLargeCatalogBatchCheckpoint,
  decodeLargeCatalogBatchCheckpointV4,
  decodeLargeCatalogBatchClaim,
  decodeLargeCatalogBatchOperationJournal,
  decodeLargeCatalogBatchPageEnvelopeV3,
  decodeLargeCatalogBatchStagingManifest,
  decodeLargeCatalogRunReceipt,
  decodeLargeCatalogRunReceiptV4,
  decodeTxtCandidateRecord,
  decodeUnifiedCatalogDescriptor,
  decodeUnifiedCatalogRecord,
  encodeCatalogDifferenceRecordLine,
  encodeCatalogOverlayDescriptor,
  encodeLargeCatalogActiveCheckpointPointer,
  encodeLargeCatalogBatchCheckpoint,
  encodeLargeCatalogBatchCheckpointV4,
  encodeLargeCatalogBatchClaim,
  encodeLargeCatalogBatchOperationJournal,
  encodeLargeCatalogBatchPageEnvelopeV3,
  encodeLargeCatalogBatchStagingManifest,
  encodeLargeCatalogRunReceipt,
  encodeLargeCatalogRunReceiptV4,
  encodeTxtCandidateRecordLine,
  encodeUnifiedCatalogDescriptor,
  encodeUnifiedCatalogRecordLine,
} from "../catalog/hybrid-catalog-codec";
import { isbnCandidatesFromFilename } from "../catalog/catalog-codec";
import { normalizeCloudAbsolutePath } from "../catalog/catalog-path";
import type { CloudCatalogRecord } from "../catalog/catalog-types";
import type {
  ActiveCandidateCatalogSummary,
  ActiveUnifiedCatalogQueryResult,
  ActiveUnifiedCatalogSummary,
  CandidateImportWriter,
  HybridCatalogActivationSnapshot,
  HybridCatalogStorePort,
  LargeCatalogPageIdentity,
  LoadedLargeCatalogBatch,
  LoadedLargeCatalogBatchV4,
} from "../catalog/hybrid-catalog-ports";
import {
  cloudVerificationScopesEqual,
  decodeCloudVerificationAuthority,
  decodeCloudVerificationScope,
  type CloudVerificationAuthority,
  type CloudVerificationScope,
} from "../catalog/cloud-verification-scope";
import {
  createUnifiedCatalogSearchPredicate,
  type UnifiedCatalogSearchQuery,
} from "../catalog/unified-catalog-search-service";
import {
  CATALOG_TXT_IMPORT_BUDGET,
  MAX_UNIFIED_CATALOG_PDF_COUNT,
  HybridCatalogError,
  type ActiveCatalogOverlay,
  type CandidateCatalogDescriptor,
  type CatalogDifferenceRecordV1,
  type CatalogOverlayDescriptor,
  type CatalogOverlayDescriptorV2,
  type CatalogReconciliationResult,
  type LargeCatalogActiveCheckpointPointerV1,
  type LargeCatalogBatchCheckpointV3,
  type LargeCatalogBatchCheckpointV4,
  type LargeCatalogBatchClaimV1,
  type LargeCatalogBatchOperationJournalV1,
  type LargeCatalogBatchPageEnvelopeV3,
  type LargeCatalogBatchStagingManifestV1,
  type LargeCatalogCheckpointSlot,
  type LargeCatalogRunReceipt,
  type LargeCatalogRunReceiptV3,
  type LargeCatalogRunReceiptV4,
  type TxtCandidateRecordV1,
  type UnifiedCatalogDescriptor,
  type UnifiedCatalogDescriptorV2,
  type UnifiedCatalogRecordV1,
} from "../catalog/hybrid-catalog-types";
import type { LegacyVerificationAdoptionV1 } from "../storage/legacy-verification-adoption";

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

const sameErrorCodeCounts = (left: object, right: object): boolean => JSON.stringify(
  Object.entries(left).sort(([leftCode], [rightCode]) => leftCode.localeCompare(rightCode)),
) === JSON.stringify(
  Object.entries(right).sort(([leftCode], [rightCode]) => leftCode.localeCompare(rightCode)),
);

const firstRelativeSegment = (value: string): string => value.split("/")[0] ?? "";
const candidateGroupLabel = (record: TxtCandidateRecordV1): string => (
  record.topLevelGroupId === "txt-root-items" ? "Root items" : firstRelativeSegment(record.relativePath)
);
const unifiedGroupLabel = (record: UnifiedCatalogRecordV1): string => {
  if (record.topLevelGroupId === "txt-root-items") return "Root items";
  const topTag = record.hierarchyTags[0];
  if (topTag?.startsWith("folder/") === true) return topTag.slice("folder/".length);
  return firstRelativeSegment(record.relativePath) || record.topLevelGroupId;
};

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
  readonly schemaVersion: 1 | 2 | 3;
  readonly records: readonly CloudCatalogRecord[];
  readonly identities: readonly LargeCatalogPageIdentity[];
  readonly identitiesComplete: boolean;
  readonly nextCheckpoint: LargeCatalogBatchCheckpointV3 | LargeCatalogBatchCheckpointV4;
}

interface LoadedV4State {
  readonly root: string;
  readonly pointer: LargeCatalogActiveCheckpointPointerV1;
  readonly pointerRaw: string;
  readonly checkpoint: LargeCatalogBatchCheckpointV4;
  readonly checkpointRaw: string;
  readonly checkpointSha256: string;
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
): UnifiedCatalogDescriptor => descriptor.schemaVersion === 2
  ? {
      ...descriptor,
      verificationScope: descriptor.verificationScope === null
        ? null
        : { ...descriptor.verificationScope },
    }
  : { ...descriptor };

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

const isAlreadyExists = (error: unknown): boolean => (
  typeof error === "object"
  && error !== null
  && "code" in error
  && (error as { code?: unknown }).code === "EEXIST"
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

  async #loadActiveCandidateReference(
    authorityInput?: CloudVerificationAuthority | null,
  ): Promise<Readonly<{
    descriptor: CandidateCatalogDescriptor;
    candidatesPath: string;
    activeManifestSha256: string;
    descriptorSha256: string;
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
    const reference = {
      descriptor,
      candidatesPath: join(importDirectory, "candidates.ndjson"),
      activeManifestSha256: sha256(activeRaw),
      descriptorSha256: sha256(receiptRaw),
    };
    const authority = this.#decodeAuthority(authorityInput);
    if (authority?.kind === "legacy-local-only") {
      if (
        authority.sourceImportSha256 !== descriptor.sourceSha256
        || authority.activeManifestSha256 !== reference.activeManifestSha256
      ) throw corrupt();
    } else if (authority?.kind === "scoped") {
      if (authority.scope.sourceImportSha256 !== descriptor.sourceSha256) throw corrupt();
      const fingerprint = authority.legacyAllowlist?.candidate;
      if (
        fingerprint !== undefined
        && (
          fingerprint.importId !== descriptor.importId
          || fingerprint.manifestSha256 !== reference.activeManifestSha256
          || fingerprint.descriptorSha256 !== reference.descriptorSha256
        )
      ) throw corrupt();
    }
    return reference;
  }

  async loadLegacyLocalAuthority(): Promise<Extract<
    CloudVerificationAuthority,
    Readonly<{ kind: "legacy-local-only" }>
  > | null> {
    const active = await this.#loadActiveCandidateReference();
    if (active === null) return null;
    await this.#verifyCandidates(
      active.candidatesPath,
      active.descriptor.pdfCount,
      active.descriptor.candidateSha256,
    );
    return {
      kind: "legacy-local-only",
      sourceImportSha256: active.descriptor.sourceSha256,
      activeManifestSha256: active.activeManifestSha256,
    };
  }

  async prepareLegacyVerificationAdoption(
    scopeInput: CloudVerificationScope,
  ): Promise<LegacyVerificationAdoptionV1 | null> {
    let scope: CloudVerificationScope;
    try {
      scope = decodeCloudVerificationScope(scopeInput);
    } catch {
      throw corrupt();
    }
    const candidate = await this.#loadActiveCandidateReference();
    if (candidate === null) return null;
    await this.#verifyCandidates(
      candidate.candidatesPath,
      candidate.descriptor.pdfCount,
      candidate.descriptor.candidateSha256,
    );
    if (candidate.descriptor.sourceSha256 !== scope.sourceImportSha256) {
      throw new HybridCatalogError("hybrid-cloud-root-mismatch");
    }

    const overlays = (await this.loadActiveOverlays()).flatMap((overlay) => {
      if (overlay.descriptor.schemaVersion !== 1) return [];
      const reference = {
        overlayId: overlay.descriptor.overlayId,
        groupKey: overlay.descriptor.topLevelGroupId,
        descriptorSha256: "",
      };
      return [reference];
    });
    const overlayReferences = await this.#readActiveOverlayReferences();
    for (const overlay of overlays) {
      const reference = overlayReferences.find((item) => (
        item.overlayId === overlay.overlayId && item.topLevelGroupId === overlay.groupKey
      ));
      if (reference === undefined) throw corrupt();
      overlay.descriptorSha256 = reference.descriptorSha256;
    }

    const unifiedReference = await this.#loadActiveUnifiedReference();
    let unified: Extract<LegacyVerificationAdoptionV1, Readonly<{ state: "adopted" }>>["unified"] = null;
    if (unifiedReference?.descriptor.schemaVersion === 1) {
      const activeRaw = (await this.#readPrivateFile(
        this.#activeUnifiedPath,
        64 * 1024,
      )).toString("utf8");
      const active = decodeActiveUnifiedManifest(activeRaw);
      unified = {
        snapshotId: unifiedReference.descriptor.snapshotId,
        descriptorSha256: active.descriptorSha256,
      };
    }

    let resumableBatch: Extract<
      LegacyVerificationAdoptionV1,
      Readonly<{ state: "adopted" }>
    >["resumableBatch"] = null;
    const latest = await this.loadLatestBatch();
    if (latest?.kind === "legacy-v3") {
      if (
        latest.checkpoint.sourceImportSha256 !== scope.sourceImportSha256
        || latest.checkpoint.cloudRootSha256 !== scope.cloudRootSha256
      ) throw new HybridCatalogError("hybrid-cloud-root-mismatch");
      await this.#validateLegacyReceiptPrefix(
        this.#batchDirectory(latest.checkpoint.batchId),
        latest.checkpoint,
      );
      resumableBatch = {
        batchId: latest.checkpoint.batchId,
        checkpointSha256: latest.checkpointSha256,
        sourceImportSha256: latest.checkpoint.sourceImportSha256,
        cloudRootSha256: latest.checkpoint.cloudRootSha256,
      };
    }

    return {
      schemaVersion: 1,
      state: "adopted",
      verificationGeneration: scope.generation,
      sourceImportSha256: scope.sourceImportSha256,
      cloudRootSha256: scope.cloudRootSha256,
      candidate: {
        importId: candidate.descriptor.importId,
        manifestSha256: candidate.activeManifestSha256,
        descriptorSha256: candidate.descriptorSha256,
      },
      overlays: overlays.map((overlay) => ({ ...overlay })),
      unified,
      resumableBatch,
    };
  }

  async revalidatePreparedLegacyAdoption(
    prepared: LegacyVerificationAdoptionV1 | null,
  ): Promise<void> {
    if (prepared === null) {
      if (await this.loadLegacyArtifactSetSha256() !== null) throw corrupt();
      return;
    }
    if (prepared.state !== "adopted") throw corrupt();
    const current = await this.prepareLegacyVerificationAdoption({
      generation: prepared.verificationGeneration,
      sourceImportSha256: prepared.sourceImportSha256,
      cloudRootSha256: prepared.cloudRootSha256,
    });
    if (JSON.stringify(current) !== JSON.stringify(prepared)) throw corrupt();
  }

  async loadLegacyArtifactSetSha256(): Promise<string | null> {
    await this.#ensureLayout();
    const inventory: string[] = [];
    const addFile = async (label: string, path: string, maximumBytes: number): Promise<void> => {
      try {
        const raw = await this.#readPrivateFile(path, maximumBytes, 0);
        inventory.push(`${label}:${sha256(raw)}`);
      } catch {
        inventory.push(`${label}:invalid`);
      }
    };
    if (await this.#pathExists(this.#activeCandidatePath)) {
      await addFile("candidate-active", this.#activeCandidatePath, 64 * 1024);
      try {
        const activeRaw = (await this.#readPrivateFile(
          this.#activeCandidatePath,
          64 * 1024,
        )).toString("utf8");
        const active = decodeActiveManifest(activeRaw);
        await addFile(
          `candidate-descriptor:${active.importId}`,
          join(this.#importsRoot, active.importId, "receipt.json"),
          64 * 1024,
        );
      } catch {
        inventory.push("candidate-descriptor:invalid");
      }
    }
    if (await this.#pathExists(this.#activeOverlaysPath)) {
      try {
        const references = await this.#readActiveOverlayReferences();
        if (references.length > 128) inventory.push("overlays:overflow");
        for (const reference of references.slice(0, 128)) {
          const descriptorPath = join(this.#overlaysRoot, reference.overlayId, "descriptor.json");
          try {
            const raw = (await this.#readPrivateFile(descriptorPath, 64 * 1024)).toString("utf8");
            const descriptor = decodeCatalogOverlayDescriptor(raw.slice(0, -1));
            if (descriptor.schemaVersion === 1) {
              inventory.push(`overlay:${reference.overlayId}:${reference.topLevelGroupId}:${sha256(raw)}`);
            }
          } catch {
            inventory.push(`overlay:${reference.overlayId}:invalid`);
          }
        }
      } catch {
        inventory.push("overlays-active:invalid");
      }
    }
    if (await this.#pathExists(this.#activeUnifiedPath)) {
      try {
        const activeRaw = (await this.#readPrivateFile(
          this.#activeUnifiedPath,
          64 * 1024,
        )).toString("utf8");
        const active = decodeActiveUnifiedManifest(activeRaw);
        const descriptorPath = join(this.#unifiedRoot, active.snapshotId, "descriptor.json");
        const descriptorRaw = (await this.#readPrivateFile(descriptorPath, 64 * 1024)).toString("utf8");
        const descriptor = decodeUnifiedCatalogDescriptor(descriptorRaw.slice(0, -1));
        if (descriptor.schemaVersion === 1) {
          inventory.push(`unified:${active.snapshotId}:${sha256(descriptorRaw)}`);
        }
      } catch {
        inventory.push("unified-active:invalid");
      }
    }
    await this.#ensureBatchLayout();
    const batchEntries = await readdir(this.#batchesRoot, { withFileTypes: true });
    const legacyBatchIds = batchEntries
      .filter((entry) => entry.isDirectory() && SAFE_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    if (legacyBatchIds.length > 128) inventory.push("batches:overflow");
    for (const batchId of legacyBatchIds.slice(0, 128)) {
      const directory = this.#batchDirectory(batchId);
      if (!await this.#pathExists(join(directory, "checkpoint.json"))) continue;
      await addFile(`batch:${batchId}:checkpoint`, join(directory, "checkpoint.json"), MAX_BATCH_CHECKPOINT_BYTES);
      for (const child of ["pages", "receipts"]) {
        try {
          const entries = (await readdir(join(directory, child), { withFileTypes: true }))
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name)
            .sort();
          if (entries.length > 10_000) inventory.push(`batch:${batchId}:${child}:overflow`);
          for (const name of entries.slice(0, 10_000)) {
            await addFile(
              `batch:${batchId}:${child}:${name}`,
              join(directory, child, name),
              child === "pages" ? MAX_BATCH_PAGE_BYTES : 1024 * 1024,
            );
          }
        } catch {
          inventory.push(`batch:${batchId}:${child}:invalid`);
        }
      }
    }
    if (inventory.length === 0) return null;
    inventory.sort();
    return sha256(`${JSON.stringify(inventory)}\n`);
  }

  async loadActiveCandidateDescriptor(
    authority?: CloudVerificationAuthority | null,
  ): Promise<CandidateCatalogDescriptor | null> {
    const active = await this.#loadActiveCandidateReference(authority);
    return active === null ? null : cloneDescriptor(active.descriptor);
  }

  async loadActiveCandidateSummary(
    authority?: CloudVerificationAuthority | null,
  ): Promise<ActiveCandidateCatalogSummary | null> {
    const active = await this.#loadActiveCandidateReference(authority);
    if (active === null) return null;
    return {
      descriptor: cloneDescriptor(active.descriptor),
      groups: await this.#summarizeCandidateGroups(
        active.candidatesPath,
        active.descriptor.pdfCount,
        active.descriptor.candidateSha256,
      ),
    };
  }

  async loadActiveCandidateGroups(
    groupKeys: readonly string[],
    authority?: CloudVerificationAuthority | null,
  ): Promise<Readonly<{
    descriptor: CandidateCatalogDescriptor;
    records: readonly TxtCandidateRecordV1[];
  }> | null> {
    const selected = new Set(groupKeys);
    if (
      selected.size !== groupKeys.length
      || groupKeys.some((groupKey) => !GROUP_PATTERN.test(groupKey))
    ) throw corrupt();
    const active = await this.#loadActiveCandidateReference(authority);
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

  async loadActiveCandidates(
    authority?: CloudVerificationAuthority | null,
  ): Promise<Readonly<{
    descriptor: CandidateCatalogDescriptor;
    records: readonly TxtCandidateRecordV1[];
  }> | null> {
    const active = await this.#loadActiveCandidateReference(authority);
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

  async createBatch(checkpointInput: LargeCatalogBatchCheckpointV4): Promise<void> {
    await this.#ensureBatchLayout();
    const checkpoint = this.#validatedBatchCheckpointV4(checkpointInput);
    const candidate = await this.loadActiveCandidateDescriptor();
    if (
      candidate === null
      || candidate.sourceSha256 !== checkpoint.verificationScope.sourceImportSha256
      || checkpoint.legacyCheckpointSha256 !== null
      || checkpoint.latestReceipt !== null
      || checkpoint.runOrdinal !== 1
      || checkpoint.listRequestCount !== 0
      || checkpoint.cumulativeListRequestCount !== 0
      || checkpoint.status !== "scanning"
      || checkpoint.stopReason !== null
    ) throw new HybridCatalogError("hybrid-batch-invalid");

    const nonce = safeImportId(randomUUID());
    const stagingDirectory = this.#contained(join(this.#batchesRoot, `.batch-staging-${nonce}`));
    const finalDirectory = this.#batchDirectory(checkpoint.batchId);
    let claimed = false;
    try {
      await mkdir(stagingDirectory, { mode: DIRECTORY_MODE });
      await chmod(stagingDirectory, DIRECTORY_MODE);
      await this.#requirePrivateDirectory(stagingDirectory);
      for (const child of ["pages", "receipts"]) {
        const path = this.#contained(join(stagingDirectory, child));
        await mkdir(path, { mode: DIRECTORY_MODE });
        await chmod(path, DIRECTORY_MODE);
        await this.#requirePrivateDirectory(path);
      }
      const checkpointRaw = this.#checkpointV4Raw(checkpoint);
      const checkpointSha256 = sha256(checkpointRaw);
      await this.#writeAtomic(join(stagingDirectory, "checkpoint-v4-a.json"), checkpointRaw);
      const pointer: LargeCatalogActiveCheckpointPointerV1 = {
        schemaVersion: 1,
        batchId: checkpoint.batchId,
        activeSlot: "a",
        activeCheckpointSha256: checkpointSha256,
        legacyCheckpointSha256: null,
        verificationScope: { ...checkpoint.verificationScope },
      };
      const pointerRaw = this.#pointerRaw(pointer);
      await this.#writeAtomic(join(stagingDirectory, "active-checkpoint.json"), pointerRaw);
      const manifest: LargeCatalogBatchStagingManifestV1 = {
        schemaVersion: 1,
        batchId: checkpoint.batchId,
        nonce,
        activeCheckpointSha256: checkpointSha256,
        activePointerSha256: sha256(pointerRaw),
        verificationScope: { ...checkpoint.verificationScope },
      };
      const manifestRaw = this.#stagingManifestRaw(manifest);
      await this.#writeAtomic(join(stagingDirectory, "staging-manifest.json"), manifestRaw);
      await this.#syncDirectory(stagingDirectory);

      await mkdir(finalDirectory, { mode: DIRECTORY_MODE });
      claimed = true;
      await chmod(finalDirectory, DIRECTORY_MODE);
      await this.#requirePrivateDirectory(finalDirectory);
      const claim: LargeCatalogBatchClaimV1 = {
        schemaVersion: 1,
        batchId: checkpoint.batchId,
        nonce,
        stagingManifestSha256: sha256(manifestRaw),
      };
      await this.#writeExclusive(join(finalDirectory, "claim.json"), this.#claimRaw(claim));
      await this.#syncDirectory(finalDirectory);
      await this.#syncDirectory(this.#batchesRoot);
      await this.renames.rename(stagingDirectory, join(finalDirectory, "published"));
      await this.#syncDirectory(finalDirectory);
      await this.#syncDirectory(this.#batchesRoot);
    } catch (error) {
      if (!claimed) {
        try { await rm(stagingDirectory, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      if (error instanceof HybridCatalogError) {
        throw new HybridCatalogError("hybrid-batch-invalid");
      }
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
  }

  async resumeBatch(checkpointInput: LargeCatalogBatchCheckpointV4): Promise<void> {
    const next = this.#validatedBatchCheckpointV4(checkpointInput);
    const loaded = await this.loadBatch(next.batchId);
    if (loaded === null) throw new HybridCatalogError("hybrid-batch-unavailable");
    if (loaded.kind !== "scoped-v4") throw new HybridCatalogError("hybrid-batch-invalid");
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
      || !this.#sameBatchStructureV4(prior, next, { allowRunFields: true })
    ) throw new HybridCatalogError("hybrid-batch-invalid");
    await this.#swapCheckpointV4(next.batchId, next);
  }

  async loadBatch(batchIdInput: string): Promise<LoadedLargeCatalogBatch | null> {
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
    const storage = await this.#resolveBatchStorage(batchId, directory);
    if (storage === null) return null;
    return storage.kind === "legacy-v3"
      ? this.#loadLegacyBatch(batchId, directory)
      : this.#loadScopedBatch(batchId, storage.root);
  }

  async loadLatestBatch(): Promise<LoadedLargeCatalogBatch | null> {
    await this.#ensureBatchLayout();
    let entries;
    try {
      entries = await readdir(this.#batchesRoot, { withFileTypes: true });
    } catch {
      throw new HybridCatalogError("hybrid-batch-unavailable");
    }
    const batchIds = entries.flatMap((entry) => {
      if (entry.name.startsWith(".batch-staging-")) return [];
      if (!entry.isDirectory() || !SAFE_ID_PATTERN.test(entry.name)) {
        throw new HybridCatalogError("hybrid-batch-invalid");
      }
      return [entry.name];
    }).sort();
    let latest: LoadedLargeCatalogBatch | null = null;
    for (const batchId of batchIds) {
      const loaded = await this.loadBatch(batchId);
      if (loaded === null) continue;
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

  async saveBatchPermit(checkpointInput: LargeCatalogBatchCheckpointV4): Promise<void> {
    const next = this.#validatedBatchCheckpointV4(checkpointInput);
    const state = await this.#loadV4State(next.batchId);
    const prior = state.checkpoint;
    const expected = this.#validatedBatchCheckpointV4({
      ...prior,
      listRequestCount: prior.listRequestCount + 1,
      cumulativeListRequestCount: prior.cumulativeListRequestCount + 1,
    });
    if (
      prior.status !== "scanning"
      || next.status !== "scanning"
      || encodeLargeCatalogBatchCheckpointV4(next) !== encodeLargeCatalogBatchCheckpointV4(expected)
    ) throw new HybridCatalogError("hybrid-batch-invalid");
    await this.#swapLoadedCheckpointV4(state, next);
  }

  async advanceBatchGroup(checkpointInput: LargeCatalogBatchCheckpointV4): Promise<void> {
    const next = this.#validatedBatchCheckpointV4(checkpointInput);
    const loaded = await this.loadBatch(next.batchId);
    if (loaded === null) throw new HybridCatalogError("hybrid-batch-unavailable");
    if (loaded.kind !== "scoped-v4") throw new HybridCatalogError("hybrid-batch-invalid");
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
      || !this.#sameBatchStructureV4(prior, next, { allowGroupAdvance: true })
    ) throw new HybridCatalogError("hybrid-batch-invalid");
    await this.#swapCheckpointV4(next.batchId, next);
  }

  async commitBatchPage(input: Readonly<{
    batchId: string;
    pageKey: string;
    records: readonly CloudCatalogRecord[];
    identities: readonly LargeCatalogPageIdentity[];
    nextCheckpoint: LargeCatalogBatchCheckpointV4;
  }>): Promise<void> {
    let batchId: string;
    try {
      batchId = safeImportId(input.batchId);
    } catch {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    if (!HASH_PATTERN.test(input.pageKey)) throw new HybridCatalogError("hybrid-batch-invalid");
    const next = this.#validatedBatchCheckpointV4(input.nextCheckpoint);
    if (next.batchId !== batchId) throw new HybridCatalogError("hybrid-batch-invalid");
    const records = input.records.map((record) => this.#validatedCloudRecord(record));
    const identities = this.#validatedPageIdentities(input.identities);
    const identityPairs = new Set(identities.map((identity) => (
      `${identity.fsId}\u0000${identity.path}`
    )));
    if (records.some((record) => !identityPairs.has(`${record.fsId}\u0000${record.path}`))) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    const loaded = await this.loadBatch(batchId);
    if (loaded === null) throw new HybridCatalogError("hybrid-batch-unavailable");
    if (loaded.kind !== "scoped-v4") throw new HybridCatalogError("hybrid-batch-invalid");
    const prior = loaded.checkpoint;
    const alreadyCommitted = encodeLargeCatalogBatchCheckpointV4(prior)
      === encodeLargeCatalogBatchCheckpointV4(next);
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
      this.#validateBatchPageTransitionV4(
        prior,
        next,
        input.pageKey,
        records.length,
        identities.length,
      );
    }

    if (alreadyCommitted || previouslyCommitted) {
      const state = await this.#loadV4State(batchId);
      const envelope = await this.#readBatchPage(state.root, input.pageKey);
      if (
        envelope.schemaVersion !== 3
        || envelope.nextCheckpoint.schemaVersion !== 4
        || encodeLargeCatalogBatchCheckpointV4(envelope.nextCheckpoint)
          !== encodeLargeCatalogBatchCheckpointV4(next)
        || JSON.stringify(envelope.records) !== JSON.stringify(records)
        || JSON.stringify(envelope.identities) !== JSON.stringify(identities)
      ) throw new HybridCatalogError("hybrid-batch-invalid");
      return;
    }

    const state = await this.#loadV4State(batchId);
    const envelope: LargeCatalogBatchPageEnvelopeV3 = {
      schemaVersion: 3,
      pageKey: input.pageKey,
      verificationScope: { ...next.verificationScope },
      legacyCheckpointSha256: next.legacyCheckpointSha256,
      priorCheckpointSha256: state.checkpointSha256,
      nextCheckpointSha256: this.#checkpointV4Sha256(next),
      records,
      identities,
      nextCheckpoint: next,
    };
    await this.#commitJournaledOperation({
      state,
      nextCheckpoint: next,
      operationKind: "page",
      pageKey: input.pageKey,
      payloadRaw: `${encodeLargeCatalogBatchPageEnvelopeV3(envelope)}\n`,
    });
  }

  async finalizeBatchRun(input: Readonly<{
    checkpoint: LargeCatalogBatchCheckpointV4;
    endedAt: number;
  }>): Promise<LargeCatalogRunReceiptV4> {
    const terminal = this.#validatedBatchCheckpointV4(input.checkpoint);
    if (!Number.isSafeInteger(input.endedAt) || input.endedAt < terminal.startedAt) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    const loaded = await this.loadBatch(terminal.batchId);
    if (loaded === null) throw new HybridCatalogError("hybrid-batch-unavailable");
    if (loaded.kind !== "scoped-v4") throw new HybridCatalogError("hybrid-batch-invalid");
    const prior = loaded.checkpoint;
    const receipt = this.#receiptForV4(terminal, input.endedAt);
    const receiptRaw = `${encodeLargeCatalogRunReceiptV4(receipt)}\n`;
    const receiptSha256 = sha256(receiptRaw);
    if (
      prior.latestReceipt?.runOrdinal === terminal.runOrdinal
      && prior.latestReceipt.receiptSha256 === receiptSha256
    ) {
      const state = await this.#loadV4State(terminal.batchId);
      const existing = await this.#readBatchReceiptV4(
        this.#batchReceiptPathV4(state.root, terminal.runOrdinal),
      );
      if (encodeLargeCatalogRunReceiptV4(existing) !== encodeLargeCatalogRunReceiptV4(receipt)) {
        throw new HybridCatalogError("hybrid-batch-invalid");
      }
      return existing;
    }
    this.#validateBatchFinalizationV4(prior, terminal);
    const nextCheckpoint = this.#validatedBatchCheckpointV4({
      ...terminal,
      latestReceipt: { runOrdinal: terminal.runOrdinal, receiptSha256 },
    });
    const state = await this.#loadV4State(terminal.batchId);
    await this.#commitJournaledOperation({
      state,
      nextCheckpoint,
      operationKind: "finalize",
      pageKey: null,
      payloadRaw: receiptRaw,
    });
    return receipt;
  }

  async loadBatchReceipt(batchIdInput: string): Promise<LargeCatalogRunReceipt | null> {
    const loaded = await this.loadBatch(batchIdInput);
    if (loaded === null) return null;
    if (loaded.kind === "scoped-v4") {
      const current = loaded.checkpoint.latestReceipt;
      if (current !== null && current.runOrdinal === loaded.checkpoint.runOrdinal) {
        const state = await this.#loadV4State(loaded.checkpoint.batchId);
        return this.#readBatchReceiptV4(
          this.#batchReceiptPathV4(state.root, current.runOrdinal),
        );
      }
      if (loaded.checkpoint.legacyCheckpointSha256 === null) return null;
    }
    const path = this.#batchReceiptPathV3(
      this.#batchDirectory(loaded.checkpoint.batchId),
      loaded.checkpoint.runOrdinal,
    );
    try {
      return await this.#readBatchReceiptV3(path);
    } catch (error) {
      if (error instanceof HybridCatalogError && error.code === "hybrid-batch-unavailable") {
        return null;
      }
      throw error;
    }
  }

  async promoteAdoptedLegacyBatch(input: Readonly<{
    verificationScope: CloudVerificationScope;
    legacyBatch: Readonly<{
      batchId: string;
      checkpointSha256: string;
      sourceImportSha256: string;
      cloudRootSha256: string;
    }>;
  }>): Promise<LoadedLargeCatalogBatchV4> {
    await this.#ensureBatchLayout();
    let scope: CloudVerificationScope;
    try {
      scope = decodeCloudVerificationScope(input.verificationScope);
    } catch {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    const batchId = safeImportId(input.legacyBatch.batchId);
    if (
      !HASH_PATTERN.test(input.legacyBatch.checkpointSha256)
      || input.legacyBatch.sourceImportSha256 !== scope.sourceImportSha256
      || input.legacyBatch.cloudRootSha256 !== scope.cloudRootSha256
    ) throw new HybridCatalogError("hybrid-batch-invalid");
    const directory = this.#batchDirectory(batchId);
    await this.#requirePrivateDirectory(directory);

    const existingPointer = await this.#pathExists(join(directory, "active-checkpoint.json"));
    const sidecar = {
      schemaVersion: 1,
      verificationScope: scope,
      legacyBatch: { ...input.legacyBatch },
    } as const;
    const sidecarRaw = `${JSON.stringify(sidecar)}\n`;
    const sidecarPath = join(directory, "legacy-adoption.json");
    if (existingPointer) {
      const existingSidecar = (await this.#readPrivateFile(sidecarPath, 64 * 1024)).toString("utf8");
      if (existingSidecar !== sidecarRaw) throw new HybridCatalogError("hybrid-batch-invalid");
      const loaded = await this.loadBatch(batchId);
      if (loaded?.kind !== "scoped-v4") throw new HybridCatalogError("hybrid-batch-invalid");
      return loaded;
    }

    const checkpointRaw = await this.#readCanonicalLegacyCheckpointRaw(directory);
    if (sha256(checkpointRaw) !== input.legacyBatch.checkpointSha256) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    const legacy = decodeLargeCatalogBatchCheckpoint(checkpointRaw.slice(0, -1));
    if (
      legacy.batchId !== batchId
      || legacy.sourceImportSha256 !== input.legacyBatch.sourceImportSha256
      || legacy.cloudRootSha256 !== input.legacyBatch.cloudRootSha256
    ) throw new HybridCatalogError("hybrid-batch-invalid");
    await this.#validateLegacyReceiptPrefix(directory, legacy);
    await this.#loadLegacyBatch(batchId, directory);

    const promoted = this.#validatedBatchCheckpointV4({
      schemaVersion: 4,
      batchId,
      verificationScope: scope,
      legacyCheckpointSha256: input.legacyBatch.checkpointSha256,
      latestReceipt: null,
      startedAt: legacy.startedAt,
      runOrdinal: legacy.runOrdinal,
      budget: legacy.budget,
      selectedGroupCount: legacy.selectedGroupCount,
      currentGroupIndex: legacy.currentGroupIndex,
      groups: legacy.groups,
      pdfCount: legacy.pdfCount,
      directoryCount: legacy.directoryCount,
      ignoredFileCount: legacy.ignoredFileCount,
      listRequestCount: legacy.listRequestCount,
      cumulativeListRequestCount: legacy.cumulativeListRequestCount,
      status: legacy.status,
      stopReason: legacy.stopReason,
      errorCodeCounts: legacy.errorCodeCounts,
    });
    const checkpointV4Raw = this.#checkpointV4Raw(promoted);
    const pointer: LargeCatalogActiveCheckpointPointerV1 = {
      schemaVersion: 1,
      batchId,
      activeSlot: "a",
      activeCheckpointSha256: sha256(checkpointV4Raw),
      legacyCheckpointSha256: input.legacyBatch.checkpointSha256,
      verificationScope: scope,
    };
    await this.#writeExclusive(sidecarPath, sidecarRaw);
    await this.#writeAtomic(join(directory, "checkpoint-v4-a.json"), checkpointV4Raw);
    await this.#writeAtomic(join(directory, "active-checkpoint.json"), this.#pointerRaw(pointer));
    await this.#syncDirectory(directory);
    const loaded = await this.loadBatch(batchId);
    if (loaded?.kind !== "scoped-v4") throw new HybridCatalogError("hybrid-batch-invalid");
    return loaded;
  }

  #decodeAuthority(
    authority: CloudVerificationAuthority | null | undefined,
  ): CloudVerificationAuthority | null | undefined {
    if (authority === undefined || authority === null) return authority;
    try {
      return decodeCloudVerificationAuthority(authority);
    } catch {
      throw corrupt();
    }
  }

  #legacyCandidateMatches(
    authority: Extract<CloudVerificationAuthority, Readonly<{ kind: "scoped" }>>,
    candidate: Readonly<{
      descriptor: CandidateCatalogDescriptor;
      activeManifestSha256: string;
      descriptorSha256: string;
    }>,
  ): boolean {
    const fingerprint = authority.legacyAllowlist?.candidate;
    return fingerprint !== undefined
      && fingerprint.importId === candidate.descriptor.importId
      && fingerprint.manifestSha256 === candidate.activeManifestSha256
      && fingerprint.descriptorSha256 === candidate.descriptorSha256;
  }

  #authorityAllowsOverlay(
    descriptor: CatalogOverlayDescriptor,
    descriptorSha256: string,
    authority: CloudVerificationAuthority | null | undefined,
    candidate: Readonly<{
      descriptor: CandidateCatalogDescriptor;
      activeManifestSha256: string;
      descriptorSha256: string;
    }>,
  ): boolean {
    if (authority === undefined) return true;
    if (authority === null) return false;
    if (authority.kind === "legacy-local-only") {
      return descriptor.schemaVersion === 1
        && descriptor.sourceImportSha256 === authority.sourceImportSha256
        && candidate.activeManifestSha256 === authority.activeManifestSha256;
    }
    if (descriptor.schemaVersion === 2) {
      return descriptor.sourceImportSha256 === authority.scope.sourceImportSha256
        && descriptor.verificationGeneration === authority.scope.generation
        && descriptor.cloudRootSha256 === authority.scope.cloudRootSha256;
    }
    if (!this.#legacyCandidateMatches(authority, candidate)) return false;
    return authority.legacyAllowlist?.overlays.some((item) => (
      item.overlayId === descriptor.overlayId
      && item.groupKey === descriptor.topLevelGroupId
      && item.descriptorSha256 === descriptorSha256
    )) === true;
  }

  #authorityAllowsUnified(
    descriptor: UnifiedCatalogDescriptor,
    descriptorSha256: string,
    authority: CloudVerificationAuthority | null | undefined,
    candidate: Readonly<{
      descriptor: CandidateCatalogDescriptor;
      activeManifestSha256: string;
      descriptorSha256: string;
    }>,
  ): boolean {
    if (authority === undefined) return true;
    if (authority === null) {
      return descriptor.schemaVersion === 2 && descriptor.verificationScope === null;
    }
    if (authority.kind === "legacy-local-only") {
      return descriptor.schemaVersion === 1
        && descriptor.sourceImportSha256 === authority.sourceImportSha256
        && candidate.activeManifestSha256 === authority.activeManifestSha256;
    }
    if (descriptor.schemaVersion === 2) {
      return cloudVerificationScopesEqual(descriptor.verificationScope, authority.scope);
    }
    if (!this.#legacyCandidateMatches(authority, candidate)) return false;
    const fingerprint = authority.legacyAllowlist?.unified;
    return fingerprint !== null
      && fingerprint !== undefined
      && fingerprint.snapshotId === descriptor.snapshotId
      && fingerprint.descriptorSha256 === descriptorSha256;
  }

  async loadActiveOverlayDescriptors(
    authorityInput?: CloudVerificationAuthority | null,
  ): Promise<readonly CatalogOverlayDescriptor[]> {
    await this.#ensureOverlayLayout();
    const authority = this.#decodeAuthority(authorityInput);
    const references = await this.#readActiveOverlayReferences();
    const activeCandidate = await this.#loadActiveCandidateReference();
    if (activeCandidate === null) return [];
    const descriptors: CatalogOverlayDescriptor[] = [];
    for (const reference of references) {
      if (reference.sourceImportSha256 !== activeCandidate.descriptor.sourceSha256) continue;
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
      if (!this.#authorityAllowsOverlay(
        descriptor,
        reference.descriptorSha256,
        authority,
        activeCandidate,
      )) continue;
      descriptors.push(cloneOverlayDescriptor(descriptor));
    }
    return descriptors;
  }

  async loadActiveOverlays(
    authorityInput?: CloudVerificationAuthority | null,
  ): Promise<readonly ActiveCatalogOverlay[]> {
    await this.#ensureOverlayLayout();
    const authority = this.#decodeAuthority(authorityInput);
    const references = await this.#readActiveOverlayReferences();
    const activeCandidate = await this.#loadActiveCandidateReference();
    if (activeCandidate === null) return [];
    const overlays: ActiveCatalogOverlay[] = [];
    for (const reference of references) {
      if (reference.sourceImportSha256 !== activeCandidate.descriptor.sourceSha256) continue;
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
      if (!this.#authorityAllowsOverlay(
        descriptor,
        reference.descriptorSha256,
        authority,
        activeCandidate,
      )) continue;
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
  ): Promise<CatalogOverlayDescriptorV2> {
    await this.#ensureOverlayLayout();
    let verificationScope: CloudVerificationScope;
    try {
      verificationScope = decodeCloudVerificationScope(input.verificationScope);
    } catch {
      throw corrupt();
    }
    const activeCandidate = await this.loadActiveCandidateDescriptor();
    if (
      activeCandidate === null
      || activeCandidate.sourceSha256 !== input.sourceImportSha256
      || verificationScope.sourceImportSha256 !== input.sourceImportSha256
      || !HASH_PATTERN.test(input.sourceImportSha256)
      || !GROUP_PATTERN.test(input.topLevelGroupId)
      || !Number.isSafeInteger(input.completedAt)
      || input.completedAt < 0
      || input.records.length > MAX_UNIFIED_CATALOG_PDF_COUNT
      || input.differences.length > MAX_DIFFERENCE_COUNT
      || input.supersededCatalogIds.length > MAX_UNIFIED_CATALOG_PDF_COUNT
    ) throw corrupt();
    const priorOverlay = (await this.loadActiveOverlays({
      kind: "scoped",
      scope: verificationScope,
      legacyAllowlist: null,
    })).find((overlay) => (
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
        schemaVersion: 2,
        overlayId,
        sourceImportSha256: input.sourceImportSha256,
        verificationGeneration: verificationScope.generation,
        cloudRootSha256: verificationScope.cloudRootSha256,
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
      if (descriptor.schemaVersion !== 2) throw corrupt();
      return cloneOverlayDescriptor(descriptor) as CatalogOverlayDescriptorV2;
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
    verificationScope?: CloudVerificationScope | null;
    records: readonly UnifiedCatalogRecordV1[];
    differences: readonly CatalogDifferenceRecordV1[];
    completedAt: number;
    signal?: AbortSignal;
  }>): Promise<UnifiedCatalogDescriptorV2> {
    const assertNotAborted = (): void => {
      if (input.signal?.aborted === true) throw corrupt();
    };
    assertNotAborted();
    await this.#ensureUnifiedLayout();
    assertNotAborted();
    let verificationScope: CloudVerificationScope | null;
    try {
      verificationScope = input.verificationScope == null
        ? null
        : decodeCloudVerificationScope(input.verificationScope);
    } catch {
      throw corrupt();
    }
    const candidate = await this.loadActiveCandidateDescriptor();
    if (
      candidate === null
      || !HASH_PATTERN.test(input.sourceImportSha256)
      || candidate.sourceSha256 !== input.sourceImportSha256
      || (
        verificationScope !== null
        && verificationScope.sourceImportSha256 !== input.sourceImportSha256
      )
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
        schemaVersion: 2,
        snapshotId,
        sourceImportSha256: input.sourceImportSha256,
        verificationScope,
        completedAt: input.completedAt,
        recordCount: records.length,
        differenceCount: differences.length,
        catalogSha256: sha256(catalogRaw),
        differencesSha256: sha256(differencesRaw),
      }));
      if (descriptor.schemaVersion !== 2) throw corrupt();
      const descriptorRaw = `${encodeUnifiedCatalogDescriptor(descriptor)}\n`;
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
      return cloneUnifiedDescriptor(descriptor) as UnifiedCatalogDescriptorV2;
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

  async writeUnifiedGroupSnapshot(
    input: CatalogReconciliationResult & Readonly<{ signal?: AbortSignal }>,
  ): Promise<UnifiedCatalogDescriptorV2> {
    const assertNotAborted = (): void => {
      if (input.signal?.aborted === true) throw corrupt();
    };
    assertNotAborted();
    await this.#ensureUnifiedLayout();
    let verificationScope: CloudVerificationScope;
    try {
      verificationScope = decodeCloudVerificationScope(input.verificationScope);
    } catch {
      throw corrupt();
    }
    const candidate = await this.loadActiveCandidateDescriptor();
    const active = await this.#loadActiveUnifiedReference();
    if (
      candidate === null
      || active === null
      || active.descriptor.schemaVersion !== 2
      || (
        active.descriptor.verificationScope !== null
        && !cloudVerificationScopesEqual(
          active.descriptor.verificationScope,
          verificationScope,
        )
      )
      || !GROUP_PATTERN.test(input.topLevelGroupId)
      || !HASH_PATTERN.test(input.sourceImportSha256)
      || candidate.sourceSha256 !== input.sourceImportSha256
      || verificationScope.sourceImportSha256 !== input.sourceImportSha256
      || active.descriptor.sourceImportSha256 !== input.sourceImportSha256
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
      if (record.topLevelGroupId !== input.topLevelGroupId || recordIds.has(record.catalogId)) {
        throw corrupt();
      }
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
      if (
        difference.topLevelGroupId !== input.topLevelGroupId
        || !recordIds.has(difference.catalogId)
        || differenceKeys.has(key)
      ) throw corrupt();
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
      const catalog = await this.#mergeCanonicalGroupFile({
        sourcePath: active.catalogPath,
        destinationPath: join(stagingDirectory, "catalog.ndjson"),
        expectedCount: active.descriptor.recordCount,
        expectedSha256: active.descriptor.catalogSha256,
        maximumCount: MAX_UNIFIED_CATALOG_PDF_COUNT,
        maximumBytes: MAX_UNIFIED_BYTES,
        groupKey: input.topLevelGroupId,
        replacements: records,
        decode: decodeUnifiedCatalogRecord,
        encode: encodeUnifiedCatalogRecordLine,
        compare: (left, right) => this.#compareUnified(left, right),
        groupOf: (record) => record.topLevelGroupId,
        signal: input.signal,
      });
      assertNotAborted();
      const difference = await this.#mergeCanonicalGroupFile({
        sourcePath: active.differencesPath,
        destinationPath: join(stagingDirectory, "differences.ndjson"),
        expectedCount: active.descriptor.differenceCount,
        expectedSha256: active.descriptor.differencesSha256,
        maximumCount: MAX_DIFFERENCE_COUNT,
        maximumBytes: MAX_UNIFIED_BYTES,
        groupKey: input.topLevelGroupId,
        replacements: differences,
        decode: decodeCatalogDifferenceRecord,
        encode: encodeCatalogDifferenceRecordLine,
        compare: (left, right) => this.#compareDifference(left, right),
        groupOf: (record) => record.topLevelGroupId,
        signal: input.signal,
      });
      assertNotAborted();
      const descriptor = decodeUnifiedCatalogDescriptor(JSON.stringify({
        schemaVersion: 2,
        snapshotId,
        sourceImportSha256: input.sourceImportSha256,
        verificationScope,
        completedAt: input.completedAt,
        recordCount: catalog.count,
        differenceCount: difference.count,
        catalogSha256: catalog.sha256,
        differencesSha256: difference.sha256,
      }));
      if (descriptor.schemaVersion !== 2) throw corrupt();
      const descriptorRaw = `${encodeUnifiedCatalogDescriptor(descriptor)}\n`;
      await this.#writeAtomic(join(stagingDirectory, "descriptor.json"), descriptorRaw);
      await this.#scanUnifiedRecords(
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
      const nextActive: ActiveUnifiedManifestV2 = {
        schemaVersion: 2,
        snapshotId,
        sourceImportSha256: descriptor.sourceImportSha256,
        candidateImportId: candidate.importId,
        descriptorSha256: sha256(descriptorRaw),
        recordCount: descriptor.recordCount,
        differenceCount: descriptor.differenceCount,
      };
      const priorActiveRaw = (await this.#readPrivateFile(
        this.#activeUnifiedPath,
        64 * 1024,
      )).toString("utf8");
      assertNotAborted();
      await this.#writeAtomic(this.#activeUnifiedPath, `${JSON.stringify(nextActive)}\n`);
      if (input.signal?.aborted === true) {
        await this.#writeAtomic(this.#activeUnifiedPath, priorActiveRaw);
        throw corrupt();
      }
      return cloneUnifiedDescriptor(descriptor) as UnifiedCatalogDescriptorV2;
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

  async #loadActiveUnifiedReference(
    authorityInput?: CloudVerificationAuthority | null,
  ): Promise<Readonly<{
    descriptor: UnifiedCatalogDescriptor;
    catalogPath: string;
    differencesPath: string;
  }> | null> {
    await this.#ensureUnifiedLayout();
    const authority = this.#decodeAuthority(authorityInput);
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
    const candidate = await this.#loadActiveCandidateReference();
    if (
      candidate === null
      || candidate.descriptor.sourceSha256 !== active.sourceImportSha256
      || (
        active.schemaVersion === 2
        && candidate.descriptor.importId !== active.candidateImportId
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
      descriptorRaw !== `${encodeUnifiedCatalogDescriptor(descriptor)}\n`
      || descriptor.snapshotId !== active.snapshotId
      || descriptor.sourceImportSha256 !== active.sourceImportSha256
      || descriptor.recordCount !== active.recordCount
      || descriptor.differenceCount !== active.differenceCount
    ) throw corrupt();
    if (!this.#authorityAllowsUnified(
      descriptor,
      active.descriptorSha256,
      authority,
      candidate,
    )) return null;
    return {
      descriptor: cloneUnifiedDescriptor(descriptor),
      catalogPath: join(snapshotDirectory, "catalog.ndjson"),
      differencesPath: join(snapshotDirectory, "differences.ndjson"),
    };
  }

  async loadActiveUnifiedSummary(
    authority?: CloudVerificationAuthority | null,
  ): Promise<ActiveUnifiedCatalogSummary | null> {
    const active = await this.#loadActiveUnifiedReference(authority);
    if (active === null) return null;
    const scanned = await this.#scanUnifiedRecords(
      active.catalogPath,
      active.descriptor.recordCount,
      active.descriptor.catalogSha256,
    );
    await this.#verifyDifferenceFile(
      active.differencesPath,
      active.descriptor.differenceCount,
      active.descriptor.differencesSha256,
    );
    return {
      descriptor: cloneUnifiedDescriptor(active.descriptor),
      aggregate: scanned.aggregate,
    };
  }

  async queryActiveUnified(
    query: UnifiedCatalogSearchQuery,
    authorityOrSignal?: CloudVerificationAuthority | AbortSignal | null,
    signal?: AbortSignal,
  ): Promise<ActiveUnifiedCatalogQueryResult | null> {
    const authority = authorityOrSignal instanceof AbortSignal
      ? undefined
      : authorityOrSignal;
    const effectiveSignal = authorityOrSignal instanceof AbortSignal
      ? authorityOrSignal
      : signal;
    const active = await this.#loadActiveUnifiedReference(authority);
    if (active === null) return null;
    const scanned = await this.#scanUnifiedRecords(
      active.catalogPath,
      active.descriptor.recordCount,
      active.descriptor.catalogSha256,
      query,
      effectiveSignal,
    );
    return {
      descriptor: cloneUnifiedDescriptor(active.descriptor),
      aggregate: scanned.aggregate,
      page: scanned.page!,
    };
  }

  async loadActiveUnified(
    authority?: CloudVerificationAuthority | null,
  ): Promise<Readonly<{
    descriptor: UnifiedCatalogDescriptor;
    records: readonly UnifiedCatalogRecordV1[];
    differences: readonly CatalogDifferenceRecordV1[];
  }> | null> {
    const active = await this.#loadActiveUnifiedReference(authority);
    if (active === null) return null;
    const records = await this.#verifyUnifiedRecords(
      active.catalogPath,
      active.descriptor.recordCount,
      active.descriptor.catalogSha256,
    );
    const differences = await this.#verifyDifferences(
      active.differencesPath,
      active.descriptor.differenceCount,
      active.descriptor.differencesSha256,
    );
    const recordIds = new Set(records.map((record) => record.catalogId));
    if (differences.some((difference) => !recordIds.has(difference.catalogId))) throw corrupt();
    return {
      descriptor: cloneUnifiedDescriptor(active.descriptor),
      records: records.map(cloneUnifiedRecord),
      differences: differences.map(cloneDifference),
    };
  }

  #validatedBatchCheckpointV4(
    checkpoint: LargeCatalogBatchCheckpointV4,
  ): LargeCatalogBatchCheckpointV4 {
    return decodeLargeCatalogBatchCheckpointV4(encodeLargeCatalogBatchCheckpointV4(checkpoint));
  }

  #checkpointV4Raw(checkpoint: LargeCatalogBatchCheckpointV4): string {
    return `${encodeLargeCatalogBatchCheckpointV4(checkpoint)}\n`;
  }

  #checkpointV4Sha256(checkpoint: LargeCatalogBatchCheckpointV4): string {
    return sha256(this.#checkpointV4Raw(checkpoint));
  }

  #pointerRaw(pointer: LargeCatalogActiveCheckpointPointerV1): string {
    return `${encodeLargeCatalogActiveCheckpointPointer(pointer)}\n`;
  }

  #stagingManifestRaw(manifest: LargeCatalogBatchStagingManifestV1): string {
    return `${encodeLargeCatalogBatchStagingManifest(manifest)}\n`;
  }

  #claimRaw(claim: LargeCatalogBatchClaimV1): string {
    return `${encodeLargeCatalogBatchClaim(claim)}\n`;
  }

  async #pathExists(path: string): Promise<boolean> {
    try {
      await lstat(this.#contained(path));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
  }

  async #resolveBatchStorage(
    batchId: string,
    directory: string,
  ): Promise<Readonly<{ kind: "legacy-v3" } | { kind: "scoped-v4"; root: string }> | null> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      throw new HybridCatalogError("hybrid-batch-unavailable");
    }
    const names = new Set(entries.map((entry) => entry.name));
    if (names.has("published")) {
      if (
        entries.length !== 2
        || !names.has("claim.json")
        || entries.some((entry) => (
          entry.name === "published" ? !entry.isDirectory() : !entry.isFile()
        ))
      ) throw new HybridCatalogError("hybrid-batch-invalid");
      return { kind: "scoped-v4", root: await this.#validateNativePublished(batchId, directory) };
    }
    if (names.has("claim.json")) {
      if (entries.length !== 1 || !entries[0]?.isFile()) return null;
      const recovered = await this.#recoverUnpublishedNative(batchId, directory);
      return recovered === null ? null : { kind: "scoped-v4", root: recovered };
    }
    if (!names.has("checkpoint.json")) return null;
    const pointerExists = names.has("active-checkpoint.json");
    return pointerExists
      ? { kind: "scoped-v4", root: directory }
      : { kind: "legacy-v3" };
  }

  async #readCanonicalClaim(path: string): Promise<Readonly<{
    claim: LargeCatalogBatchClaimV1;
    raw: string;
  }>> {
    const raw = (await this.#readPrivateFile(path, 64 * 1024)).toString("utf8");
    if (!raw.endsWith("\n")) throw new HybridCatalogError("hybrid-batch-invalid");
    const claim = decodeLargeCatalogBatchClaim(raw.slice(0, -1));
    if (raw !== this.#claimRaw(claim)) throw new HybridCatalogError("hybrid-batch-invalid");
    return { claim, raw };
  }

  async #readCanonicalStagingManifest(path: string): Promise<Readonly<{
    manifest: LargeCatalogBatchStagingManifestV1;
    raw: string;
  }>> {
    const raw = (await this.#readPrivateFile(path, 64 * 1024)).toString("utf8");
    if (!raw.endsWith("\n")) throw new HybridCatalogError("hybrid-batch-invalid");
    const manifest = decodeLargeCatalogBatchStagingManifest(raw.slice(0, -1));
    if (raw !== this.#stagingManifestRaw(manifest)) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    return { manifest, raw };
  }

  async #validateNativePublished(batchId: string, directory: string): Promise<string> {
    const { claim } = await this.#readCanonicalClaim(join(directory, "claim.json"));
    if (claim.batchId !== batchId) throw new HybridCatalogError("hybrid-batch-invalid");
    const published = this.#contained(join(directory, "published"));
    await this.#requirePrivateDirectory(published);
    let entries;
    try {
      entries = await readdir(published, { withFileTypes: true });
    } catch {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    const mandatoryFiles = new Set([
      "active-checkpoint.json",
      "staging-manifest.json",
    ]);
    const optionalFiles = /^(?:checkpoint-v4-[ab]\.json|operation-journal\.json|\.operation-[A-Za-z0-9][A-Za-z0-9._-]{0,127}-(?:checkpoint|payload)\.json)$/u;
    const abandonedAtomicTemporary = /^\.(?:active-checkpoint\.json|checkpoint-v4-[ab]\.json|operation-journal\.json|\.operation-[A-Za-z0-9][A-Za-z0-9._-]{0,127}-(?:checkpoint|payload)\.json)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u;
    const names = new Set(entries.map((entry) => entry.name));
    if (
      [...mandatoryFiles].some((name) => !names.has(name))
      || (!names.has("checkpoint-v4-a.json") && !names.has("checkpoint-v4-b.json"))
      || !names.has("pages")
      || !names.has("receipts")
      || entries.some((entry) => {
        if (entry.name === "pages" || entry.name === "receipts") return !entry.isDirectory();
        if (
          mandatoryFiles.has(entry.name)
          || optionalFiles.test(entry.name)
          || abandonedAtomicTemporary.test(entry.name)
        ) return !entry.isFile();
        return true;
      })
    ) throw new HybridCatalogError("hybrid-batch-invalid");
    await this.#requirePrivateDirectory(join(published, "pages"));
    await this.#requirePrivateDirectory(join(published, "receipts"));
    const { manifest, raw } = await this.#readCanonicalStagingManifest(
      join(published, "staging-manifest.json"),
    );
    if (
      sha256(raw) !== claim.stagingManifestSha256
      || manifest.batchId !== batchId
      || manifest.nonce !== claim.nonce
    ) throw new HybridCatalogError("hybrid-batch-invalid");
    return published;
  }

  async #recoverUnpublishedNative(batchId: string, directory: string): Promise<string | null> {
    let claim: LargeCatalogBatchClaimV1;
    try {
      ({ claim } = await this.#readCanonicalClaim(join(directory, "claim.json")));
    } catch {
      return null;
    }
    if (claim.batchId !== batchId) return null;
    const staging = this.#contained(join(this.#batchesRoot, `.batch-staging-${claim.nonce}`));
    try {
      await this.#requirePrivateDirectory(staging);
      const names = (await readdir(staging)).sort();
      if (JSON.stringify(names) !== JSON.stringify([
        "active-checkpoint.json",
        "checkpoint-v4-a.json",
        "pages",
        "receipts",
        "staging-manifest.json",
      ])) return null;
      await this.#requirePrivateDirectory(join(staging, "pages"));
      await this.#requirePrivateDirectory(join(staging, "receipts"));
      const { manifest, raw: manifestRaw } = await this.#readCanonicalStagingManifest(
        join(staging, "staging-manifest.json"),
      );
      if (
        manifest.batchId !== batchId
        || manifest.nonce !== claim.nonce
        || sha256(manifestRaw) !== claim.stagingManifestSha256
      ) return null;
      const pointerRaw = (await this.#readPrivateFile(
        join(staging, "active-checkpoint.json"),
        64 * 1024,
      )).toString("utf8");
      if (!pointerRaw.endsWith("\n") || sha256(pointerRaw) !== manifest.activePointerSha256) {
        return null;
      }
      const pointer = decodeLargeCatalogActiveCheckpointPointer(pointerRaw.slice(0, -1));
      if (
        pointerRaw !== this.#pointerRaw(pointer)
        || pointer.batchId !== batchId
        || pointer.activeSlot !== "a"
        || pointer.activeCheckpointSha256 !== manifest.activeCheckpointSha256
        || !cloudVerificationScopesEqual(pointer.verificationScope, manifest.verificationScope)
      ) return null;
      const checkpointRaw = (await this.#readPrivateFile(
        join(staging, "checkpoint-v4-a.json"),
        MAX_BATCH_CHECKPOINT_BYTES,
      )).toString("utf8");
      if (sha256(checkpointRaw) !== pointer.activeCheckpointSha256) return null;
      const checkpoint = decodeLargeCatalogBatchCheckpointV4(checkpointRaw.slice(0, -1));
      if (
        checkpointRaw !== this.#checkpointV4Raw(checkpoint)
        || checkpoint.batchId !== batchId
        || !cloudVerificationScopesEqual(checkpoint.verificationScope, pointer.verificationScope)
      ) return null;
      await this.renames.rename(staging, join(directory, "published"));
      await this.#syncDirectory(directory);
      await this.#syncDirectory(this.#batchesRoot);
      return this.#validateNativePublished(batchId, directory);
    } catch {
      return null;
    }
  }

  async #readV4State(batchId: string, root: string): Promise<LoadedV4State> {
    await this.#recoverBatchJournal(batchId, root);
    let pointerRaw: string;
    try {
      pointerRaw = (await this.#readPrivateFile(
        join(root, "active-checkpoint.json"),
        64 * 1024,
      )).toString("utf8");
    } catch {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    if (!pointerRaw.endsWith("\n")) throw new HybridCatalogError("hybrid-batch-invalid");
    const pointer = decodeLargeCatalogActiveCheckpointPointer(pointerRaw.slice(0, -1));
    if (pointerRaw !== this.#pointerRaw(pointer) || pointer.batchId !== batchId) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    const checkpointPath = join(root, `checkpoint-v4-${pointer.activeSlot}.json`);
    const checkpointRaw = (await this.#readPrivateFile(
      checkpointPath,
      MAX_BATCH_CHECKPOINT_BYTES,
    )).toString("utf8");
    const checkpointSha256 = sha256(checkpointRaw);
    if (!checkpointRaw.endsWith("\n") || checkpointSha256 !== pointer.activeCheckpointSha256) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    const checkpoint = decodeLargeCatalogBatchCheckpointV4(checkpointRaw.slice(0, -1));
    if (
      checkpointRaw !== this.#checkpointV4Raw(checkpoint)
      || checkpoint.batchId !== batchId
      || checkpoint.legacyCheckpointSha256 !== pointer.legacyCheckpointSha256
      || !cloudVerificationScopesEqual(checkpoint.verificationScope, pointer.verificationScope)
    ) throw new HybridCatalogError("hybrid-batch-invalid");
    await this.#validatePersistedLatestReceipt(root, checkpoint);
    return { root, pointer, pointerRaw, checkpoint, checkpointRaw, checkpointSha256 };
  }

  async #loadV4State(batchId: string): Promise<LoadedV4State> {
    try {
      const root = await lstat(this.#root);
      if (!root.isDirectory() || root.isSymbolicLink()) {
        throw new HybridCatalogError("hybrid-batch-invalid");
      }
      await this.#requirePrivateDirectory(this.#hybridRoot);
      await this.#requirePrivateDirectory(this.#batchesRoot);
    } catch (error) {
      if (error instanceof HybridCatalogError) throw error;
      throw new HybridCatalogError("hybrid-batch-unavailable");
    }
    const directory = this.#batchDirectory(batchId);
    let entry;
    try {
      entry = await lstat(directory);
    } catch {
      throw new HybridCatalogError("hybrid-batch-unavailable");
    }
    if (
      !entry.isDirectory()
      || entry.isSymbolicLink()
      || (entry.mode & 0o777) !== DIRECTORY_MODE
    ) throw new HybridCatalogError("hybrid-batch-invalid");
    const storage = await this.#resolveBatchStorage(batchId, directory);
    if (storage?.kind !== "scoped-v4") throw new HybridCatalogError("hybrid-batch-invalid");
    return this.#readV4State(batchId, storage.root);
  }

  async #validatePersistedLatestReceipt(
    root: string,
    checkpoint: LargeCatalogBatchCheckpointV4,
  ): Promise<void> {
    const reference = checkpoint.latestReceipt;
    if (reference === null) {
      if (
        checkpoint.legacyCheckpointSha256 === null
        && !(checkpoint.status === "scanning" && checkpoint.runOrdinal === 1)
      ) throw new HybridCatalogError("hybrid-batch-invalid");
      return;
    }
    const expectedOrdinal = checkpoint.status === "scanning"
      ? checkpoint.runOrdinal - 1
      : checkpoint.runOrdinal;
    if (reference.runOrdinal !== expectedOrdinal || expectedOrdinal < 1) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    const path = this.#batchReceiptPathV4(root, reference.runOrdinal);
    const raw = (await this.#readPrivateFile(path, 1024 * 1024)).toString("utf8");
    if (sha256(raw) !== reference.receiptSha256) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    const receipt = decodeLargeCatalogRunReceiptV4(raw.slice(0, -1));
    if (
      raw !== `${encodeLargeCatalogRunReceiptV4(receipt)}\n`
      || receipt.batchId !== checkpoint.batchId
      || receipt.runOrdinal !== reference.runOrdinal
      || receipt.legacyCheckpointSha256 !== checkpoint.legacyCheckpointSha256
      || !cloudVerificationScopesEqual(receipt.verificationScope, checkpoint.verificationScope)
    ) throw new HybridCatalogError("hybrid-batch-invalid");
  }

  #batchDirectory(batchId: string): string {
    return this.#contained(join(this.#batchesRoot, safeImportId(batchId)));
  }

  #batchReceiptPathV3(directory: string, runOrdinal: number): string {
    if (!Number.isSafeInteger(runOrdinal) || runOrdinal < 1) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    return this.#contained(join(directory, "receipts", `run-${runOrdinal}.json`));
  }

  #batchReceiptPathV4(directory: string, runOrdinal: number): string {
    if (!Number.isSafeInteger(runOrdinal) || runOrdinal < 1) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    return this.#contained(join(directory, "receipts", `run-v4-${runOrdinal}.json`));
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

  async #readCanonicalLegacyCheckpointRaw(directory: string): Promise<string> {
    const checkpoint = await this.#readBatchCheckpoint(directory);
    return `${encodeLargeCatalogBatchCheckpoint(checkpoint)}\n`;
  }

  async #loadLegacyBatch(
    batchId: string,
    directory: string,
  ): Promise<Extract<LoadedLargeCatalogBatch, Readonly<{ kind: "legacy-v3" }>>> {
    await this.#requirePrivateDirectory(join(directory, "pages"));
    await this.#requirePrivateDirectory(join(directory, "receipts"));
    const checkpointRaw = await this.#readCanonicalLegacyCheckpointRaw(directory);
    const checkpoint = decodeLargeCatalogBatchCheckpoint(checkpointRaw.slice(0, -1));
    if (checkpoint.batchId !== batchId) throw new HybridCatalogError("hybrid-batch-invalid");
    const loaded = await this.#loadBatchPages(directory, checkpoint, null);
    return {
      kind: "legacy-v3",
      checkpoint,
      checkpointSha256: sha256(checkpointRaw),
      ...loaded,
    };
  }

  async #loadScopedBatch(batchId: string, root: string): Promise<LoadedLargeCatalogBatchV4> {
    await this.#requirePrivateDirectory(join(root, "pages"));
    await this.#requirePrivateDirectory(join(root, "receipts"));
    const state = await this.#readV4State(batchId, root);
    const loaded = await this.#loadBatchPages(root, state.checkpoint, state.checkpoint);
    if (!loaded.identitiesComplete) throw new HybridCatalogError("hybrid-batch-invalid");
    return {
      kind: "scoped-v4",
      checkpoint: this.#validatedBatchCheckpointV4(state.checkpoint),
      checkpointSha256: state.checkpointSha256,
      records: loaded.records,
      identities: loaded.identities,
      identitiesComplete: true,
    };
  }

  async #loadBatchPages(
    directory: string,
    checkpoint: LargeCatalogBatchCheckpointV3 | LargeCatalogBatchCheckpointV4,
    scopedCheckpoint: LargeCatalogBatchCheckpointV4 | null,
  ): Promise<Readonly<{
    records: readonly CloudCatalogRecord[];
    identities: readonly LargeCatalogPageIdentity[];
    identitiesComplete: boolean;
  }>> {
    const records: CloudCatalogRecord[] = [];
    const identities: LargeCatalogPageIdentity[] = [];
    const fsIds = new Set<string>();
    const paths = new Set<string>();
    let identitiesComplete = true;
    for (const group of checkpoint.groups) {
      for (const pageKey of group.committedPageKeys) {
        const envelope = await this.#readBatchPage(directory, pageKey);
        if (
          envelope.nextCheckpoint.batchId !== checkpoint.batchId
          || !envelope.nextCheckpoint.groups.some((value) => (
            value.committedPageKeys.includes(pageKey)
          ))
        ) throw new HybridCatalogError("hybrid-batch-invalid");
        if (scopedCheckpoint !== null) {
          if (envelope.schemaVersion === 3) {
            if (
              envelope.nextCheckpoint.schemaVersion !== 4
              || envelope.nextCheckpoint.legacyCheckpointSha256
                !== scopedCheckpoint.legacyCheckpointSha256
              || !cloudVerificationScopesEqual(
                envelope.nextCheckpoint.verificationScope,
                scopedCheckpoint.verificationScope,
              )
            ) throw new HybridCatalogError("hybrid-batch-invalid");
          } else if (scopedCheckpoint.legacyCheckpointSha256 === null) {
            throw new HybridCatalogError("hybrid-batch-invalid");
          }
        } else if (envelope.schemaVersion === 3) {
          throw new HybridCatalogError("hybrid-batch-invalid");
        }
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
    return { records, identities, identitiesComplete };
  }

  async #swapCheckpointV4(batchId: string, checkpoint: LargeCatalogBatchCheckpointV4): Promise<void> {
    const state = await this.#loadV4State(batchId);
    await this.#swapLoadedCheckpointV4(state, checkpoint);
  }

  async #swapLoadedCheckpointV4(
    state: LoadedV4State,
    checkpoint: LargeCatalogBatchCheckpointV4,
  ): Promise<void> {
    const batchId = state.checkpoint.batchId;
    if (
      checkpoint.batchId !== batchId
      || checkpoint.legacyCheckpointSha256 !== state.checkpoint.legacyCheckpointSha256
      || !cloudVerificationScopesEqual(
        checkpoint.verificationScope,
        state.checkpoint.verificationScope,
      )
    ) throw new HybridCatalogError("hybrid-batch-invalid");
    const targetSlot: LargeCatalogCheckpointSlot = state.pointer.activeSlot === "a" ? "b" : "a";
    const checkpointRaw = this.#checkpointV4Raw(checkpoint);
    await this.#writeAtomic(join(state.root, `checkpoint-v4-${targetSlot}.json`), checkpointRaw);
    const pointer: LargeCatalogActiveCheckpointPointerV1 = {
      ...state.pointer,
      activeSlot: targetSlot,
      activeCheckpointSha256: sha256(checkpointRaw),
    };
    await this.#writeAtomic(join(state.root, "active-checkpoint.json"), this.#pointerRaw(pointer));
  }

  #batchJournalPath(root: string): string {
    return this.#contained(join(root, "operation-journal.json"));
  }

  #stagedCheckpointPath(root: string, operationId: string): string {
    return this.#contained(join(root, `.operation-${safeImportId(operationId)}-checkpoint.json`));
  }

  #stagedPayloadPath(root: string, operationId: string): string {
    return this.#contained(join(root, `.operation-${safeImportId(operationId)}-payload.json`));
  }

  async #commitJournaledOperation(input: Readonly<{
    state: LoadedV4State;
    nextCheckpoint: LargeCatalogBatchCheckpointV4;
    operationKind: "page" | "finalize";
    pageKey: string | null;
    payloadRaw: string;
  }>): Promise<void> {
    const next = this.#validatedBatchCheckpointV4(input.nextCheckpoint);
    if (
      next.batchId !== input.state.checkpoint.batchId
      || next.legacyCheckpointSha256 !== input.state.checkpoint.legacyCheckpointSha256
      || !cloudVerificationScopesEqual(next.verificationScope, input.state.checkpoint.verificationScope)
    ) throw new HybridCatalogError("hybrid-batch-invalid");
    const operationId = safeImportId(randomUUID());
    const targetSlot: LargeCatalogCheckpointSlot = input.state.pointer.activeSlot === "a" ? "b" : "a";
    const checkpointRaw = this.#checkpointV4Raw(next);
    const payloadSha256 = sha256(input.payloadRaw);
    await this.#writeAtomic(
      this.#stagedCheckpointPath(input.state.root, operationId),
      checkpointRaw,
    );
    await this.#writeAtomic(
      this.#stagedPayloadPath(input.state.root, operationId),
      input.payloadRaw,
    );
    const journal: LargeCatalogBatchOperationJournalV1 = {
      schemaVersion: 1,
      state: "prepared",
      operationId,
      operationKind: input.operationKind,
      batchId: next.batchId,
      verificationScope: { ...next.verificationScope },
      legacyCheckpointSha256: next.legacyCheckpointSha256,
      runOrdinal: next.runOrdinal,
      priorActivePointerSha256: sha256(input.state.pointerRaw),
      targetSlot,
      targetCheckpointSha256: sha256(checkpointRaw),
      pageKey: input.operationKind === "page" ? input.pageKey : null,
      pageEnvelopeSha256: input.operationKind === "page" ? payloadSha256 : null,
      receiptSha256: input.operationKind === "finalize" ? payloadSha256 : null,
    };
    await this.#writeAtomic(
      this.#batchJournalPath(input.state.root),
      `${encodeLargeCatalogBatchOperationJournal(journal)}\n`,
    );
    try {
      await this.#finishPreparedJournal(input.state.root, journal);
    } catch {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
  }

  async #recoverBatchJournal(batchId: string, root: string): Promise<void> {
    const path = this.#batchJournalPath(root);
    if (!await this.#pathExists(path)) return;
    let raw: string;
    try {
      raw = (await this.#readPrivateFile(path, 64 * 1024)).toString("utf8");
    } catch {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    if (!raw.endsWith("\n")) throw new HybridCatalogError("hybrid-batch-invalid");
    const journal = decodeLargeCatalogBatchOperationJournal(raw.slice(0, -1));
    if (
      raw !== `${encodeLargeCatalogBatchOperationJournal(journal)}\n`
      || journal.batchId !== batchId
    ) throw new HybridCatalogError("hybrid-batch-invalid");
    if (journal.state === "settled") {
      await this.#cleanupBatchJournal(root, journal.operationId);
      return;
    }
    await this.#finishPreparedJournal(root, journal);
  }

  async #finishPreparedJournal(
    root: string,
    journal: LargeCatalogBatchOperationJournalV1,
  ): Promise<void> {
    const checkpointRaw = (await this.#readPrivateFile(
      this.#stagedCheckpointPath(root, journal.operationId),
      MAX_BATCH_CHECKPOINT_BYTES,
    )).toString("utf8");
    if (sha256(checkpointRaw) !== journal.targetCheckpointSha256) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    const checkpoint = decodeLargeCatalogBatchCheckpointV4(checkpointRaw.slice(0, -1));
    if (
      checkpointRaw !== this.#checkpointV4Raw(checkpoint)
      || checkpoint.batchId !== journal.batchId
      || checkpoint.runOrdinal !== journal.runOrdinal
      || checkpoint.legacyCheckpointSha256 !== journal.legacyCheckpointSha256
      || !cloudVerificationScopesEqual(checkpoint.verificationScope, journal.verificationScope)
    ) throw new HybridCatalogError("hybrid-batch-invalid");

    const payloadRaw = (await this.#readPrivateFile(
      this.#stagedPayloadPath(root, journal.operationId),
      MAX_BATCH_PAGE_BYTES,
    )).toString("utf8");
    const expectedPayloadHash = journal.operationKind === "page"
      ? journal.pageEnvelopeSha256
      : journal.receiptSha256;
    if (expectedPayloadHash === null || sha256(payloadRaw) !== expectedPayloadHash) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    let canonicalPath: string;
    if (journal.operationKind === "page") {
      if (journal.pageKey === null) throw new HybridCatalogError("hybrid-batch-invalid");
      const envelope = decodeLargeCatalogBatchPageEnvelopeV3(payloadRaw.slice(0, -1));
      if (
        payloadRaw !== `${encodeLargeCatalogBatchPageEnvelopeV3(envelope)}\n`
        || envelope.pageKey !== journal.pageKey
        || envelope.nextCheckpointSha256 !== journal.targetCheckpointSha256
      ) throw new HybridCatalogError("hybrid-batch-invalid");
      canonicalPath = join(root, "pages", `${journal.pageKey}.json`);
    } else {
      const receipt = decodeLargeCatalogRunReceiptV4(payloadRaw.slice(0, -1));
      if (
        payloadRaw !== `${encodeLargeCatalogRunReceiptV4(receipt)}\n`
        || receipt.batchId !== journal.batchId
        || receipt.runOrdinal !== journal.runOrdinal
        || receipt.legacyCheckpointSha256 !== journal.legacyCheckpointSha256
        || !cloudVerificationScopesEqual(receipt.verificationScope, journal.verificationScope)
        || checkpoint.latestReceipt?.runOrdinal !== receipt.runOrdinal
        || checkpoint.latestReceipt.receiptSha256 !== journal.receiptSha256
      ) throw new HybridCatalogError("hybrid-batch-invalid");
      canonicalPath = this.#batchReceiptPathV4(root, receipt.runOrdinal);
    }
    await this.#writeExclusive(canonicalPath, payloadRaw);
    await this.#writeAtomic(
      join(root, `checkpoint-v4-${journal.targetSlot}.json`),
      checkpointRaw,
    );

    const currentPointerRaw = (await this.#readPrivateFile(
      join(root, "active-checkpoint.json"),
      64 * 1024,
    )).toString("utf8");
    const currentPointer = decodeLargeCatalogActiveCheckpointPointer(
      currentPointerRaw.slice(0, -1),
    );
    const alreadySwapped = currentPointer.activeSlot === journal.targetSlot
      && currentPointer.activeCheckpointSha256 === journal.targetCheckpointSha256;
    if (!alreadySwapped && sha256(currentPointerRaw) !== journal.priorActivePointerSha256) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    const targetPointer: LargeCatalogActiveCheckpointPointerV1 = {
      schemaVersion: 1,
      batchId: journal.batchId,
      activeSlot: journal.targetSlot,
      activeCheckpointSha256: journal.targetCheckpointSha256,
      legacyCheckpointSha256: journal.legacyCheckpointSha256,
      verificationScope: { ...journal.verificationScope },
    };
    const targetPointerRaw = this.#pointerRaw(targetPointer);
    if (alreadySwapped) {
      if (currentPointerRaw !== targetPointerRaw) {
        throw new HybridCatalogError("hybrid-batch-invalid");
      }
    } else {
      await this.#writeAtomic(join(root, "active-checkpoint.json"), targetPointerRaw);
    }
    const settled: LargeCatalogBatchOperationJournalV1 = { ...journal, state: "settled" };
    await this.#writeAtomic(
      this.#batchJournalPath(root),
      `${encodeLargeCatalogBatchOperationJournal(settled)}\n`,
    );
    await this.#cleanupBatchJournal(root, journal.operationId);
  }

  async #cleanupBatchJournal(root: string, operationId: string): Promise<void> {
    for (const path of [
      this.#stagedCheckpointPath(root, operationId),
      this.#stagedPayloadPath(root, operationId),
      this.#batchJournalPath(root),
    ]) {
      await rm(path, { force: true });
    }
    await this.#syncDirectory(root);
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
    if (record.schemaVersion === 3) {
      const envelope = decodeLargeCatalogBatchPageEnvelopeV3(raw.slice(0, -1));
      if (
        raw !== `${encodeLargeCatalogBatchPageEnvelopeV3(envelope)}\n`
        || envelope.pageKey !== pageKey
      ) throw new HybridCatalogError("hybrid-batch-invalid");
      return {
        schemaVersion: 3,
        records: envelope.records.map(cloneCloudRecord),
        identities: envelope.identities.map((identity) => ({ ...identity })),
        identitiesComplete: true,
        nextCheckpoint: envelope.nextCheckpoint,
      };
    }
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
    if (
      records.length > 1000
      || new Set(records.map((item) => item.fsId)).size !== records.length
      || new Set(records.map((item) => item.path)).size !== records.length
    ) throw new HybridCatalogError("hybrid-batch-invalid");
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
      schemaVersion: current ? 2 : 1,
      records,
      identities,
      identitiesComplete: current,
      nextCheckpoint,
    };
  }

  #sameBatchStructureV4(
    left: LargeCatalogBatchCheckpointV4,
    right: LargeCatalogBatchCheckpointV4,
    options: Readonly<{
      allowRunFields?: boolean;
      allowGroupAdvance?: boolean;
    }>,
  ): boolean {
    const normalized = (value: LargeCatalogBatchCheckpointV4): LargeCatalogBatchCheckpointV4 => ({
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
        groups: value.groups.map((group, index) => ({
          ...group,
          status: index === 0 ? "scanning" as const : "pending" as const,
        })),
      } : {}),
    });
    return encodeLargeCatalogBatchCheckpointV4(normalized(left))
      === encodeLargeCatalogBatchCheckpointV4(normalized(right));
  }

  #validateBatchPageTransitionV4(
    prior: LargeCatalogBatchCheckpointV4,
    next: LargeCatalogBatchCheckpointV4,
    pageKey: string,
    recordCount: number,
    identityCount: number,
  ): void {
    const priorGroup = prior.groups[prior.currentGroupIndex];
    const nextGroup = next.groups[next.currentGroupIndex];
    const immutableMatches = (
      prior.batchId === next.batchId
      && cloudVerificationScopesEqual(prior.verificationScope, next.verificationScope)
      && prior.legacyCheckpointSha256 === next.legacyCheckpointSha256
      && JSON.stringify(prior.latestReceipt) === JSON.stringify(next.latestReceipt)
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
      && sameErrorCodeCounts(prior.errorCodeCounts, next.errorCodeCounts)
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

  #validateBatchFinalizationV4(
    prior: LargeCatalogBatchCheckpointV4,
    terminal: LargeCatalogBatchCheckpointV4,
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
      || !cloudVerificationScopesEqual(prior.verificationScope, terminal.verificationScope)
      || prior.legacyCheckpointSha256 !== terminal.legacyCheckpointSha256
      || JSON.stringify(prior.latestReceipt) !== JSON.stringify(terminal.latestReceipt)
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
      if (!sameErrorCodeCounts(expected, terminal.errorCodeCounts)) {
        throw new HybridCatalogError("hybrid-batch-invalid");
      }
    } else if (!sameErrorCodeCounts(prior.errorCodeCounts, terminal.errorCodeCounts)) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
  }

  #receiptForV4(
    checkpoint: LargeCatalogBatchCheckpointV4,
    endedAt: number,
  ): LargeCatalogRunReceiptV4 {
    if (checkpoint.status === "scanning" || checkpoint.stopReason === null) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    return decodeLargeCatalogRunReceiptV4(JSON.stringify({
      schemaVersion: 4,
      batchId: checkpoint.batchId,
      runOrdinal: checkpoint.runOrdinal,
      verificationScope: checkpoint.verificationScope,
      legacyCheckpointSha256: checkpoint.legacyCheckpointSha256,
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

  async #readBatchReceiptV3(path: string): Promise<LargeCatalogRunReceiptV3> {
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

  async #readBatchReceiptV4(path: string): Promise<LargeCatalogRunReceiptV4> {
    let raw: string;
    try {
      raw = (await this.#readPrivateFile(path, 1024 * 1024)).toString("utf8");
    } catch {
      throw new HybridCatalogError("hybrid-batch-unavailable");
    }
    if (!raw.endsWith("\n")) throw new HybridCatalogError("hybrid-batch-invalid");
    const decoded = decodeLargeCatalogRunReceiptV4(raw.slice(0, -1));
    if (raw !== `${encodeLargeCatalogRunReceiptV4(decoded)}\n`) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    return {
      ...decoded,
      verificationScope: { ...decoded.verificationScope },
      budget: { ...decoded.budget },
      errorCodeCounts: { ...decoded.errorCodeCounts },
    };
  }

  async #validateLegacyReceiptPrefix(
    directory: string,
    checkpoint: LargeCatalogBatchCheckpointV3,
  ): Promise<void> {
    const expectedLast = checkpoint.status === "scanning"
      ? Math.max(0, checkpoint.runOrdinal - 1)
      : checkpoint.runOrdinal;
    let entries;
    try {
      entries = await readdir(join(directory, "receipts"), { withFileTypes: true });
    } catch {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    const ordinals = entries.map((entry) => {
      const match = /^run-([1-9]\d*)\.json$/u.exec(entry.name);
      if (!entry.isFile() || match === null) throw new HybridCatalogError("hybrid-batch-invalid");
      const ordinal = Number(match[1]);
      if (!Number.isSafeInteger(ordinal)) throw new HybridCatalogError("hybrid-batch-invalid");
      return ordinal;
    }).sort((left, right) => left - right);
    const expected = Array.from({ length: expectedLast }, (_, index) => index + 1);
    if (JSON.stringify(ordinals) !== JSON.stringify(expected)) {
      throw new HybridCatalogError("hybrid-batch-invalid");
    }
    for (const ordinal of expected) {
      const receipt = await this.#readBatchReceiptV3(this.#batchReceiptPathV3(directory, ordinal));
      if (ordinal === checkpoint.runOrdinal && (
        receipt.startedAt !== checkpoint.startedAt
        || receipt.status !== checkpoint.status
        || receipt.stopReason !== checkpoint.stopReason
        || receipt.selectedGroupCount !== checkpoint.selectedGroupCount
        || receipt.listRequestCount !== checkpoint.listRequestCount
        || receipt.cumulativeListRequestCount !== checkpoint.cumulativeListRequestCount
        || receipt.directoryCount !== checkpoint.directoryCount
        || receipt.pdfCount !== checkpoint.pdfCount
        || receipt.ignoredFileCount !== checkpoint.ignoredFileCount
        || !sameErrorCodeCounts(receipt.errorCodeCounts, checkpoint.errorCodeCounts)
      )) throw new HybridCatalogError("hybrid-batch-invalid");
    }
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

  async #summarizeCandidateGroups(
    path: string,
    expectedCount: number,
    expectedSha256: string,
  ): Promise<ActiveCandidateCatalogSummary["groups"]> {
    if (
      !Number.isSafeInteger(expectedCount)
      || expectedCount < 1
      || !HASH_PATTERN.test(expectedSha256)
    ) throw corrupt();
    const contained = this.#contained(path);
    const groups = new Map<string, {
      label: string;
      rootRelativePath: string;
      pdfCount: number;
      mode: "recursive" | "direct-files-only";
    }>();
    let count = 0;
    let handle: FileHandle | undefined;
    const hasher = createHash("sha256");
    const decoder = new StringDecoder("utf8");
    let carry = "";
    const consume = (line: string): void => {
      if (line.length === 0) throw corrupt();
      const record = decodeTxtCandidateRecord(line);
      if (`${line}\n` !== encodeTxtCandidateRecordLine(record)) throw corrupt();
      const rootRelativePath = record.topLevelGroupId === "txt-root-items"
        ? ""
        : firstRelativeSegment(record.relativePath);
      if (
        !GROUP_PATTERN.test(record.topLevelGroupId)
        || (record.topLevelGroupId === "txt-root-items" && record.relativePath.includes("/"))
        || (record.topLevelGroupId !== "txt-root-items" && rootRelativePath.length === 0)
      ) throw corrupt();
      const prior = groups.get(record.topLevelGroupId);
      if (prior !== undefined && prior.rootRelativePath !== rootRelativePath) throw corrupt();
      groups.set(record.topLevelGroupId, {
        label: prior?.label ?? candidateGroupLabel(record),
        rootRelativePath,
        pdfCount: (prior?.pdfCount ?? 0) + 1,
        mode: record.topLevelGroupId === "txt-root-items" ? "direct-files-only" : "recursive",
      });
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
        try { await handle.close(); } catch { /* Fixed read-only cleanup. */ }
      }
    }
    return [...groups.entries()].map(([groupKey, group]) => ({ groupKey, ...group })).sort((left, right) => {
      if (left.groupKey === "txt-root-items" && right.groupKey !== "txt-root-items") return -1;
      if (right.groupKey === "txt-root-items" && left.groupKey !== "txt-root-items") return 1;
      if (left.label < right.label) return -1;
      if (left.label > right.label) return 1;
      return left.groupKey.localeCompare(right.groupKey, "en-US");
    });
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

  async #mergeCanonicalGroupFile<T>(input: Readonly<{
    sourcePath: string;
    destinationPath: string;
    expectedCount: number;
    expectedSha256: string;
    maximumCount: number;
    maximumBytes: number;
    groupKey: string;
    replacements: readonly T[];
    decode: (raw: string) => T;
    encode: (record: T) => string;
    compare: (left: T, right: T) => number;
    groupOf: (record: T) => string;
    signal?: AbortSignal;
  }>): Promise<Readonly<{ count: number; sha256: string }>> {
    if (
      !Number.isSafeInteger(input.expectedCount)
      || input.expectedCount < 0
      || input.expectedCount > input.maximumCount
      || !HASH_PATTERN.test(input.expectedSha256)
      || !GROUP_PATTERN.test(input.groupKey)
    ) throw corrupt();
    const sourcePath = this.#contained(input.sourcePath);
    const destinationPath = this.#contained(input.destinationPath);
    let source: FileHandle | undefined;
    let destination: FileHandle | undefined;
    const sourceHasher = createHash("sha256");
    const outputHasher = createHash("sha256");
    const decoder = new StringDecoder("utf8");
    let carry = "";
    let sourceCount = 0;
    let outputCount = 0;
    let outputBytes = 0;
    let replacementIndex = 0;
    let priorSource: T | undefined;
    let priorOutput: T | undefined;
    let pending = "";
    const assertNotAborted = (): void => {
      if (input.signal?.aborted === true) throw corrupt();
    };
    const emit = (record: T): void => {
      if (priorOutput !== undefined && input.compare(priorOutput, record) >= 0) throw corrupt();
      const line = input.encode(record);
      const decoded = input.decode(line.slice(0, -1));
      if (line !== input.encode(decoded)) throw corrupt();
      priorOutput = decoded;
      pending += line;
      outputHasher.update(line);
      outputBytes += Buffer.byteLength(line, "utf8");
      outputCount += 1;
      if (outputCount > input.maximumCount || outputBytes > input.maximumBytes) throw corrupt();
    };
    const mergeBefore = (record: T): void => {
      while (replacementIndex < input.replacements.length) {
        const replacement = input.replacements[replacementIndex]!;
        const compared = input.compare(replacement, record);
        if (compared > 0) break;
        if (compared === 0) throw corrupt();
        emit(replacement);
        replacementIndex += 1;
      }
    };
    const consume = (line: string): void => {
      assertNotAborted();
      if (line.length === 0) throw corrupt();
      const record = input.decode(line);
      if (
        `${line}\n` !== input.encode(record)
        || (priorSource !== undefined && input.compare(priorSource, record) >= 0)
      ) throw corrupt();
      priorSource = record;
      sourceCount += 1;
      if (sourceCount > input.expectedCount) throw corrupt();
      if (input.groupOf(record) === input.groupKey) return;
      mergeBefore(record);
      emit(record);
    };
    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      await destination!.write(pending);
      pending = "";
    };
    try {
      assertNotAborted();
      const initial = await lstat(sourcePath);
      if (
        !initial.isFile()
        || initial.isSymbolicLink()
        || (initial.mode & 0o777) !== FILE_MODE
        || initial.size < (input.expectedCount === 0 ? 0 : 1)
        || initial.size > input.maximumBytes
      ) throw corrupt();
      source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      destination = await open(destinationPath, "wx", FILE_MODE);
      await chmod(destinationPath, FILE_MODE);
      const opened = await source.stat();
      if (!sameFile(initial, opened)) throw corrupt();
      const chunk = Buffer.allocUnsafe(64 * 1024);
      while (true) {
        assertNotAborted();
        const { bytesRead } = await source.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        const bytes = chunk.subarray(0, bytesRead);
        sourceHasher.update(bytes);
        const text = carry + decoder.write(bytes);
        let offset = 0;
        while (true) {
          const end = text.indexOf("\n", offset);
          if (end < 0) break;
          consume(text.slice(offset, end));
          offset = end + 1;
        }
        carry = text.slice(offset);
        await flush();
      }
      carry += decoder.end();
      if (
        carry.length !== 0
        || sourceCount !== input.expectedCount
        || sourceHasher.digest("hex") !== input.expectedSha256
      ) throw corrupt();
      while (replacementIndex < input.replacements.length) {
        emit(input.replacements[replacementIndex]!);
        replacementIndex += 1;
      }
      await flush();
      const completed = await source.stat();
      const completedPath = await lstat(sourcePath);
      if (!sameFile(initial, completed) || !sameFile(initial, completedPath)) throw corrupt();
      await destination.sync();
      assertNotAborted();
      return { count: outputCount, sha256: outputHasher.digest("hex") };
    } catch (error) {
      if (error instanceof HybridCatalogError) throw error;
      throw corrupt();
    } finally {
      if (source !== undefined) {
        try { await source.close(); } catch { /* Fixed read-only cleanup. */ }
      }
      if (destination !== undefined) {
        try { await destination.close(); } catch { /* Fixed write cleanup. */ }
      }
    }
  }

  async #scanUnifiedRecords(
    path: string,
    expectedCount: number,
    expectedSha256: string,
    query?: UnifiedCatalogSearchQuery,
    signal?: AbortSignal,
  ): Promise<Readonly<{
    aggregate: ActiveUnifiedCatalogSummary["aggregate"];
    page?: ActiveUnifiedCatalogQueryResult["page"];
  }>> {
    if (
      !Number.isSafeInteger(expectedCount)
      || expectedCount < 0
      || expectedCount > MAX_UNIFIED_CATALOG_PDF_COUNT
      || !HASH_PATTERN.test(expectedSha256)
    ) throw corrupt();
    const predicate = query === undefined ? undefined : createUnifiedCatalogSearchPredicate(query);
    const contained = this.#contained(path);
    const counts = { unverified: 0, verified: 0, difference: 0, cloudMissing: 0 };
    const differenceKindCounts = { "cloud-added": 0, "cloud-missing": 0, renamed: 0, moved: 0 };
    const differenceGroupKeys = new Set<string>();
    const groups = new Map<string, { label: string; count: number }>();
    const tags = new Map<string, { label: string; count: number }>();
    const pageRecords: UnifiedCatalogRecordV1[] = [];
    let matchCount = 0;
    let count = 0;
    let prior: UnifiedCatalogRecordV1 | undefined;
    let handle: FileHandle | undefined;
    const hasher = createHash("sha256");
    const decoder = new StringDecoder("utf8");
    let carry = "";
    const assertNotAborted = (): void => {
      if (signal?.aborted === true) {
        const error = new Error("catalog-query-aborted");
        error.name = "AbortError";
        throw error;
      }
    };
    const consume = (line: string): void => {
      assertNotAborted();
      if (line.length === 0) throw corrupt();
      const record = decodeUnifiedCatalogRecord(line);
      if (
        `${line}\n` !== encodeUnifiedCatalogRecordLine(record)
        || (prior !== undefined && this.#compareUnified(prior, record) >= 0)
      ) throw corrupt();
      prior = record;
      count += 1;
      if (count > expectedCount) throw corrupt();
      counts[record.verificationStatus] += 1;
      if (record.verificationStatus === "difference") differenceGroupKeys.add(record.topLevelGroupId);
      for (const kind of record.differenceKinds) {
        differenceKindCounts[kind] += 1;
        if (kind === "cloud-missing") counts.cloudMissing += 1;
      }
      const group = groups.get(record.topLevelGroupId);
      groups.set(record.topLevelGroupId, {
        label: group?.label ?? unifiedGroupLabel(record),
        count: (group?.count ?? 0) + 1,
      });
      for (const tag of record.hierarchyTags) {
        const existing = tags.get(tag);
        tags.set(tag, {
          label: tag.startsWith("folder/") ? tag.slice("folder/".length) : tag,
          count: (existing?.count ?? 0) + 1,
        });
      }
      if (query !== undefined && predicate?.(record) === true) {
        if (matchCount >= query.offset && pageRecords.length < query.limit) {
          pageRecords.push(cloneUnifiedRecord(record));
        }
        matchCount += 1;
      }
    };
    try {
      assertNotAborted();
      const initial = await lstat(contained);
      if (
        !initial.isFile()
        || initial.isSymbolicLink()
        || (initial.mode & 0o777) !== FILE_MODE
        || initial.size < (expectedCount === 0 ? 0 : 1)
        || initial.size > MAX_UNIFIED_BYTES
      ) throw corrupt();
      handle = await open(contained, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!sameFile(initial, opened)) throw corrupt();
      const chunk = Buffer.allocUnsafe(64 * 1024);
      while (true) {
        assertNotAborted();
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
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw corrupt();
    } finally {
      if (handle !== undefined) {
        try { await handle.close(); } catch { /* Fixed read-only cleanup. */ }
      }
    }
    const fixedOptionCompare = (
      left: Readonly<{ label: string }>,
      right: Readonly<{ label: string }>,
    ): number => left.label < right.label ? -1 : left.label > right.label ? 1 : 0;
    const aggregate: ActiveUnifiedCatalogSummary["aggregate"] = {
      verificationCounts: counts,
      differenceGroupKeys: [...differenceGroupKeys].sort(),
      groups: [...groups.entries()]
        .map(([groupKey, group]) => ({ groupKey, ...group }))
        .sort(fixedOptionCompare),
      hierarchyTags: [...tags.entries()]
        .map(([tag, value]) => ({ tag, ...value }))
        .sort(fixedOptionCompare),
      differenceKindCounts,
    };
    return {
      aggregate,
      ...(query === undefined ? {} : {
        page: {
          items: pageRecords,
          total: matchCount,
          offset: query.offset,
          limit: query.limit,
        },
      }),
    };
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

  async #verifyDifferenceFile(
    path: string,
    expectedCount: number,
    expectedSha256: string,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(expectedCount)
      || expectedCount < 0
      || expectedCount > MAX_DIFFERENCE_COUNT
      || !HASH_PATTERN.test(expectedSha256)
    ) throw corrupt();
    const contained = this.#contained(path);
    let count = 0;
    let prior: CatalogDifferenceRecordV1 | undefined;
    let handle: FileHandle | undefined;
    const hasher = createHash("sha256");
    const decoder = new StringDecoder("utf8");
    let carry = "";
    const consume = (line: string): void => {
      if (line.length === 0) throw corrupt();
      const decoded = decodeCatalogDifferenceRecord(line);
      if (
        `${line}\n` !== encodeCatalogDifferenceRecordLine(decoded)
        || (prior !== undefined && this.#compareDifference(prior, decoded) >= 0)
      ) throw corrupt();
      prior = decoded;
      count += 1;
      if (count > expectedCount) throw corrupt();
    };
    try {
      const initial = await lstat(contained);
      if (
        !initial.isFile()
        || initial.isSymbolicLink()
        || (initial.mode & 0o777) !== FILE_MODE
        || initial.size < (expectedCount === 0 ? 0 : 1)
        || initial.size > MAX_UNIFIED_BYTES
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
        try { await handle.close(); } catch { /* Fixed read-only cleanup. */ }
      }
    }
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

  async #syncDirectory(path: string): Promise<void> {
    const directory = this.#contained(path);
    await this.#requirePrivateDirectory(directory);
    let handle: FileHandle | undefined;
    try {
      handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      await handle.sync();
    } catch (error) {
      if (error instanceof HybridCatalogError) throw error;
      throw corrupt();
    } finally {
      if (handle !== undefined) {
        try { await handle.close(); } catch { /* fixed cleanup */ }
      }
    }
  }

  async #writeExclusive(destinationInput: string, content: string): Promise<void> {
    const destination = this.#contained(destinationInput);
    await this.#requirePrivateDirectory(dirname(destination));
    let handle: FileHandle | undefined;
    try {
      handle = await open(destination, "wx", FILE_MODE);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(destination, FILE_MODE);
      await this.#syncDirectory(dirname(destination));
    } catch (error) {
      if (handle !== undefined) {
        try { await handle.close(); } catch { /* fixed cleanup */ }
      }
      if (isAlreadyExists(error)) {
        const existing = (await this.#readPrivateFile(
          destination,
          Math.max(Buffer.byteLength(content, "utf8"), 1),
          content.length === 0 ? 0 : 1,
        )).toString("utf8");
        if (existing === content) return;
      }
      if (error instanceof HybridCatalogError) throw error;
      throw corrupt();
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
      await this.#syncDirectory(dirname(destination));
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
