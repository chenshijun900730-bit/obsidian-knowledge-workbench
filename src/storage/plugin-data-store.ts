import { PLUGIN_DATA_SCHEMA_VERSION } from "../constants";
import { normalizeAiEndpoint, normalizeAiModel, normalizeAiSecretId } from "../ai/ai-config";
import { sha256 } from "../core/hash";
import type { PluginDataPort } from "../core/ports";
import { OWNED_FIELDS, type DocumentKind, type DocumentRecord, type OwnedFieldValue } from "../core/types";
import { effectiveSettings, type RuntimeSafetyPolicy } from "../runtime/safety-policy";
import { isWorkbenchLocale } from "../i18n/workbench-i18n";
import { MAX_INDEX_HEADINGS, MAX_INDEX_TOKENS } from "../indexing/index-record-limits";
import { decodeBoundCloudLibrary } from "./cloud-library-binding";
import { decodeLegacyVerificationAdoption } from "./legacy-verification-adoption";
import type {
  ActiveIndex,
  CloudVerificationSettings,
  CloudVerificationTransitionIntent,
  FolderRule,
  OperationalState,
  PluginData,
  PluginSettings,
  ScanCheckpoint,
} from "./plugin-data";
import {
  EMPTY_RECENT_CLOUD_DIRECTORIES,
  decodeRecentCloudDirectories,
} from "./recent-cloud-directories";
import {
  decodeVerificationBatchTombstones,
  repairVerificationBatchTombstones,
} from "./verification-batch-tombstones";

const ACTIVE_JOURNAL_STATUSES = new Set(["planned", "executing", "rolling-back", "recovery-required"]);
const MAX_JOURNALS = 100;
const OWNED_FIELD_NAMES = new Set<string>(OWNED_FIELDS);

const clone = <T>(value: T): T => structuredClone(value);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isDocumentKind = (value: unknown): value is DocumentKind => value === "note" || value === "reference" || value === "unclassified";
const isActiveJournal = (value: unknown): boolean => isObject(value) && typeof value.status === "string" && ACTIVE_JOURNAL_STATUSES.has(value.status);
const isLegacySettledJournal = (value: unknown): boolean => isObject(value)
  && value.status === "settled"
  && !isObject(value.prepared);

const capJournalsPreservingActive = (journals: readonly unknown[]): unknown[] => {
  const capped = [...journals];
  while (capped.length > MAX_JOURNALS) {
    const disposable = capped.findIndex(isLegacySettledJournal);
    if (disposable < 0) break;
    capped.splice(disposable, 1);
  }
  return capped;
};

const assertFiniteTimestamp = (value: number, label: string): void => {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
};

const defaultSettings = (): PluginSettings => ({
  locale: "zh-CN",
  writeEnabled: false,
  writePreviewAcknowledged: false,
  openAtStartup: false,
  folderRules: [],
  excludedPrefixes: [],
  aiEnabled: false,
  aiEndpoint: "",
  aiModel: "",
  secretId: "",
  recentCloudDirectories: EMPTY_RECENT_CLOUD_DIRECTORIES,
  boundCloudLibrary: null,
  cloudVerificationGeneration: 0,
  verificationBatchTombstones: { schemaVersion: 1, state: "valid", batchIds: [] },
  legacyVerificationAdoption: { schemaVersion: 1, state: "none" },
});

const defaultOperational = (): OperationalState => ({
  pins: {},
  dismissals: {},
  lastOpened: {},
  journals: [],
});

const malformedJournalSentinel = (reason: string): unknown => ({
  id: "knowledge-workbench:malformed-journal-container",
  status: "malformed-journal-container",
  reason,
});

const freshData = (): PluginData => ({
  schemaVersion: PLUGIN_DATA_SCHEMA_VERSION,
  settings: defaultSettings(),
  activeIndex: null,
  staging: null,
  operational: defaultOperational(),
});

const decodeFolderRules = (value: unknown): FolderRule[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((rule) => {
    if (!isObject(rule) || typeof rule.prefix !== "string" || (rule.kind !== "note" && rule.kind !== "reference")) return [];
    return [{ prefix: rule.prefix, kind: rule.kind }];
  });
};

const decodeStringList = (value: unknown, limit = Number.POSITIVE_INFINITY): string[] | null => {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) return null;
  return value.slice(0, limit);
};

const decodeCloudVerificationGeneration = (value: unknown): number => (
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0
);

const cloudVerificationSettings = (settings: PluginSettings): CloudVerificationSettings => ({
  boundCloudLibrary: clone(settings.boundCloudLibrary),
  cloudVerificationGeneration: settings.cloudVerificationGeneration,
  verificationBatchTombstones: clone(settings.verificationBatchTombstones),
  legacyVerificationAdoption: clone(settings.legacyVerificationAdoption),
});

const preserveCloudVerificationSettings = (
  settings: PluginSettings,
  authority: CloudVerificationSettings,
): PluginSettings => ({
  ...settings,
  ...clone(authority),
});

const sameCloudVerificationValue = (left: unknown, right: unknown): boolean => (
  JSON.stringify(left) === JSON.stringify(right)
);

const checkedNextGeneration = (generation: number): number => {
  if (generation >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Cloud verification generation cannot be incremented");
  }
  return generation + 1;
};

const assertExpectedTombstones = (
  current: CloudVerificationSettings,
  next: CloudVerificationSettings,
  currentWorkflowBatchId: string | null,
): void => {
  const expected = repairVerificationBatchTombstones(
    current.verificationBatchTombstones,
    currentWorkflowBatchId,
  );
  if (!sameCloudVerificationValue(next.verificationBatchTombstones, expected)) {
    throw new RangeError("Cloud verification tombstone batch transition is invalid");
  }
};

const assertAdoptedScopeMatchesBinding = async (
  next: CloudVerificationSettings,
): Promise<void> => {
  const adoption = next.legacyVerificationAdoption;
  if (adoption.state !== "adopted") return;
  if (
    next.boundCloudLibrary === null
    || adoption.verificationGeneration !== next.cloudVerificationGeneration
    || adoption.sourceImportSha256 !== next.boundCloudLibrary.sourceImportSha256
    || adoption.cloudRootSha256 !== await sha256(next.boundCloudLibrary.path)
  ) {
    throw new RangeError("Legacy adoption does not match the bound cloud library generation");
  }
};

const assertLibraryBindingTransition = (
  current: CloudVerificationSettings,
  next: CloudVerificationSettings,
  currentWorkflowBatchId: string | null,
): Promise<void> => {
  if (next.boundCloudLibrary === null) {
    throw new RangeError("A library-binding transition requires a bound cloud library");
  }
  const rootChanged = current.boundCloudLibrary !== null
    && current.boundCloudLibrary.path !== next.boundCloudLibrary.path;
  const rotatesGeneration = current.cloudVerificationGeneration === 0 || rootChanged;
  const expectedGeneration = rotatesGeneration
    ? checkedNextGeneration(current.cloudVerificationGeneration)
    : current.cloudVerificationGeneration;
  if (
    next.cloudVerificationGeneration !== expectedGeneration
    || next.boundCloudLibrary.verificationGeneration !== expectedGeneration
  ) {
    throw new RangeError("Cloud verification generation transition is invalid");
  }

  const currentAdoption = current.legacyVerificationAdoption;
  const nextAdoption = next.legacyVerificationAdoption;
  if (currentAdoption.state === "invalid") {
    if (nextAdoption.state !== "ineligible") {
      throw new RangeError("Invalid legacy adoption requires an explicit fresh binding");
    }
  } else if (current.cloudVerificationGeneration > 0) {
    if (!sameCloudVerificationValue(nextAdoption, currentAdoption)) {
      throw new RangeError("Legacy adoption cannot be created or replaced after generation zero");
    }
  } else if (currentAdoption.state === "pending") {
    if (!["adopted", "none", "ineligible"].includes(nextAdoption.state)) {
      throw new RangeError("Pending legacy adoption must be resolved by the first binding");
    }
  } else if (!sameCloudVerificationValue(nextAdoption, currentAdoption)) {
    throw new RangeError("Legacy adoption transition is invalid");
  }

  assertExpectedTombstones(current, next, currentWorkflowBatchId);
  return currentAdoption.state === "pending" && nextAdoption.state === "adopted"
    ? assertAdoptedScopeMatchesBinding(next)
    : Promise.resolve();
};

const assertIdentityReplacementTransition = (
  current: CloudVerificationSettings,
  next: CloudVerificationSettings,
  currentWorkflowBatchId: string | null,
): void => {
  const expectedGeneration = checkedNextGeneration(current.cloudVerificationGeneration);
  if (next.cloudVerificationGeneration !== expectedGeneration || next.boundCloudLibrary !== null) {
    throw new RangeError("Identity replacement must rotate the generation and clear the binding");
  }
  const expectedAdoption = ["pending", "invalid"].includes(
    current.legacyVerificationAdoption.state,
  )
    ? { schemaVersion: 1 as const, state: "ineligible" as const }
    : current.legacyVerificationAdoption;
  if (!sameCloudVerificationValue(next.legacyVerificationAdoption, expectedAdoption)) {
    throw new RangeError("Identity replacement legacy adoption transition is invalid");
  }
  assertExpectedTombstones(current, next, currentWorkflowBatchId);
};

const assertTxtSourceReplacementTransition = (
  current: CloudVerificationSettings,
  next: CloudVerificationSettings,
): void => {
  if (
    next.cloudVerificationGeneration !== current.cloudVerificationGeneration
    || next.boundCloudLibrary !== null
    || !sameCloudVerificationValue(
      next.verificationBatchTombstones,
      current.verificationBatchTombstones,
    )
    || !sameCloudVerificationValue(
      next.legacyVerificationAdoption,
      current.legacyVerificationAdoption,
    )
  ) {
    throw new RangeError("TXT source replacement may only clear the cloud library binding");
  }
};

const assertCloudVerificationTransition = (
  current: CloudVerificationSettings,
  next: CloudVerificationSettings,
  transition: CloudVerificationTransitionIntent | undefined,
): Promise<void> => {
  if (transition === undefined) {
    throw new RangeError("Cloud verification authority transition intent is required");
  }
  if (transition.kind === "library-binding") {
    return assertLibraryBindingTransition(current, next, transition.currentWorkflowBatchId);
  }
  if (transition.kind === "identity-replacement") {
    assertIdentityReplacementTransition(current, next, transition.currentWorkflowBatchId);
    return Promise.resolve();
  }
  if (transition.kind === "txt-source-replacement") {
    if (transition.currentWorkflowBatchId !== null) {
      throw new RangeError("TXT source replacement cannot supersede a workflow batch");
    }
    assertTxtSourceReplacementTransition(current, next);
    return Promise.resolve();
  }
  throw new RangeError("Cloud verification authority transition intent is invalid");
};

const decodeSettings = (
  value: unknown,
  missingLegacyAdoptionState: "pending" | "invalid" = "pending",
): PluginSettings => {
  if (!isObject(value)) return defaultSettings();
  const writePreviewAcknowledged = value.writePreviewAcknowledged === true;
  let aiEndpoint = "";
  let aiModel = "";
  let secretId = "";
  let aiConfigurationValid = true;
  if (typeof value.aiEndpoint === "string" && value.aiEndpoint.length > 0) {
    try { aiEndpoint = normalizeAiEndpoint(value.aiEndpoint); } catch { aiConfigurationValid = false; }
  } else if (value.aiEnabled === true) aiConfigurationValid = false;
  if (typeof value.aiModel === "string" && value.aiModel.trim().length > 0) {
    try { aiModel = normalizeAiModel(value.aiModel); } catch { aiConfigurationValid = false; }
  } else if (value.aiEnabled === true) aiConfigurationValid = false;
  if (typeof value.secretId === "string") {
    try { secretId = normalizeAiSecretId(value.secretId); } catch { aiConfigurationValid = false; }
  } else if (value.secretId !== undefined) aiConfigurationValid = false;
  const cloudVerificationGeneration = decodeCloudVerificationGeneration(
    value.cloudVerificationGeneration,
  );
  const decodedBinding = decodeBoundCloudLibrary(value.boundCloudLibrary);
  const boundCloudLibrary = decodedBinding?.verificationGeneration === cloudVerificationGeneration
    ? decodedBinding
    : null;
  return {
    locale: isWorkbenchLocale(value.locale) ? value.locale : "zh-CN",
    writeEnabled: value.writeEnabled === true && writePreviewAcknowledged,
    writePreviewAcknowledged,
    openAtStartup: value.openAtStartup === true,
    folderRules: decodeFolderRules(value.folderRules),
    excludedPrefixes: decodeStringList(value.excludedPrefixes) ?? [],
    aiEnabled: value.aiEnabled === true && aiConfigurationValid && aiEndpoint.length > 0 && aiModel.length > 0,
    aiEndpoint,
    aiModel,
    secretId,
    recentCloudDirectories: decodeRecentCloudDirectories(value.recentCloudDirectories),
    boundCloudLibrary,
    cloudVerificationGeneration,
    verificationBatchTombstones: decodeVerificationBatchTombstones(
      value.verificationBatchTombstones,
    ),
    legacyVerificationAdoption: decodeLegacyVerificationAdoption(
      value.legacyVerificationAdoption,
      missingLegacyAdoptionState,
    ),
  };
};

const tryClone = (value: unknown): { readonly ok: true; readonly value: unknown } | { readonly ok: false } => {
  try {
    return { ok: true, value: clone(value) };
  } catch {
    return { ok: false };
  }
};

const decodeOwnedFields = (value: unknown): Record<string, unknown> | null => {
  if (!isObject(value)) return null;
  const entries: [string, unknown][] = [];
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!OWNED_FIELD_NAMES.has(key)) continue;
    const cloned = tryClone(fieldValue);
    if (!cloned.ok) return null;
    entries.push([key, cloned.value]);
  }
  return Object.fromEntries(entries);
};

const decodeOwnedFieldValue = (value: unknown): OwnedFieldValue | null => {
  if (typeof value === "string") return value;
  return decodeStringList(value);
};

const decodeRelationFields = (value: unknown): Record<string, OwnedFieldValue> | null => {
  if (!isObject(value)) return null;
  const entries: [string, OwnedFieldValue][] = [];
  for (const [key, fieldValue] of Object.entries(value)) {
    const decoded = decodeOwnedFieldValue(fieldValue);
    if (decoded === null) return null;
    entries.push([key, decoded]);
  }
  return Object.fromEntries(entries);
};

const decodeDocumentRecord = (value: unknown): DocumentRecord | null => {
  if (!isObject(value)) return null;
  const aliases = decodeStringList(value.aliases);
  const headings = decodeStringList(value.headings, MAX_INDEX_HEADINGS);
  const tags = decodeStringList(value.tags);
  const ownedFields = decodeOwnedFields(value.ownedFields);
  const relationFields = decodeRelationFields(value.relationFields);
  const outgoingLinks = decodeStringList(value.outgoingLinks);
  const tokens = decodeStringList(value.tokens, MAX_INDEX_TOKENS);
  if (
    typeof value.id !== "string"
    || typeof value.path !== "string"
    || typeof value.basename !== "string"
    || !isDocumentKind(value.kind)
    || typeof value.title !== "string"
    || aliases === null
    || headings === null
    || tags === null
    || ownedFields === null
    || relationFields === null
    || outgoingLinks === null
    || tokens === null
    || !isFiniteNumber(value.mtime)
    || !isFiniteNumber(value.size)
    || typeof value.contentHash !== "string"
  ) return null;
  return {
    id: value.id,
    path: value.path,
    basename: value.basename,
    kind: value.kind,
    title: value.title,
    aliases,
    headings,
    tags,
    ownedFields,
    relationFields,
    outgoingLinks,
    tokens,
    mtime: value.mtime,
    size: value.size,
    contentHash: value.contentHash,
  };
};

const decodeRecords = (value: unknown): DocumentRecord[] | null => {
  if (!Array.isArray(value)) return null;
  const records: DocumentRecord[] = [];
  for (const entry of value) {
    const record = decodeDocumentRecord(entry);
    if (record === null) return null;
    records.push(record);
  }
  return records;
};

const decodeActiveIndex = (value: unknown): ActiveIndex | null => {
  if (!isObject(value) || !isFiniteNumber(value.builtAt)) return null;
  const records = decodeRecords(value.records);
  return records === null ? null : { builtAt: value.builtAt, records };
};

const decodeCheckpoint = (value: unknown): ScanCheckpoint | null => {
  if (!isObject(value) || typeof value.scanId !== "string") return null;
  const completedPaths = decodeStringList(value.completedPaths);
  const records = decodeRecords(value.records);
  return completedPaths === null || records === null ? null : { scanId: value.scanId, completedPaths, records };
};

const decodeFiniteNumberMap = (value: unknown): Record<string, number> => {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => isFiniteNumber(entry[1])));
};

const decodeDismissals = (value: unknown): Record<string, { dismissedAt: number; mtime: number }> => {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, dismissal]) => {
    if (!isObject(dismissal) || !isFiniteNumber(dismissal.dismissedAt) || !isFiniteNumber(dismissal.mtime)) return [];
    return [[key, { dismissedAt: dismissal.dismissedAt, mtime: dismissal.mtime }]];
  }));
};

const decodeJournals = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) return [malformedJournalSentinel("journals is not an array")];
  const journals = value.flatMap((entry) => {
    const cloned = tryClone(entry);
    return cloned.ok ? [cloned.value] : [malformedJournalSentinel("journal entry is not cloneable")];
  });
  return capJournalsPreservingActive(journals);
};

const decodeOperational = (value: unknown): OperationalState => {
  if (!isObject(value)) return defaultOperational();
  return {
    pins: decodeFiniteNumberMap(value.pins),
    dismissals: decodeDismissals(value.dismissals),
    lastOpened: decodeFiniteNumberMap(value.lastOpened),
    journals: Object.prototype.hasOwnProperty.call(value, "journals") ? decodeJournals(value.journals) : [],
  };
};

const decodeData = (value: unknown): PluginData => {
  if (!isObject(value)) return freshData();
  const settings = decodeSettings(
    value.settings,
    value.schemaVersion === PLUGIN_DATA_SCHEMA_VERSION ? "pending" : "invalid",
  );
  if (value.schemaVersion !== PLUGIN_DATA_SCHEMA_VERSION) {
    const operational = isObject(value.operational) ? value.operational : null;
    const journals = operational !== null && Object.prototype.hasOwnProperty.call(operational, "journals")
      ? decodeJournals(operational.journals)
      : [];
    return {
      ...freshData(),
      settings: {
        ...settings,
        writeEnabled: false,
        writePreviewAcknowledged: false,
        aiEnabled: false,
      },
      operational: { ...defaultOperational(), journals },
    };
  }
  return {
    schemaVersion: PLUGIN_DATA_SCHEMA_VERSION,
    settings,
    activeIndex: decodeActiveIndex(value.activeIndex),
    staging: decodeCheckpoint(value.staging),
    operational: decodeOperational(value.operational),
  };
};

const recordNeedsSearchFieldCompaction = (value: unknown): boolean => isObject(value) && (
  (Array.isArray(value.headings) && value.headings.length > MAX_INDEX_HEADINGS)
  || (Array.isArray(value.tokens) && value.tokens.length > MAX_INDEX_TOKENS)
);

const indexNeedsSearchFieldCompaction = (value: unknown): boolean => isObject(value)
  && Array.isArray(value.records)
  && value.records.some(recordNeedsSearchFieldCompaction);

const dataNeedsSearchFieldCompaction = (value: unknown): boolean => isObject(value) && (
  indexNeedsSearchFieldCompaction(value.activeIndex)
  || indexNeedsSearchFieldCompaction(value.staging)
);

const isJournalId = (value: unknown, id: string): value is { readonly id: string } => isObject(value) && typeof value.id === "string" && value.id === id;
const removeKey = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> => Object.fromEntries(
  Object.entries(record).filter(([entryKey]) => entryKey !== key),
);

export class PluginDataStore {
  private data: PluginData = freshData();
  private tail: Promise<void> = Promise.resolve();
  private loaded = false;
  private poison: Error | null = null;

  constructor(private readonly port: PluginDataPort) {}

  private async loadCompacted(): Promise<void> {
    const persisted = await this.port.load();
    const decoded = decodeData(persisted);
    if (dataNeedsSearchFieldCompaction(persisted)) await this.port.save(clone(decoded));
    this.data = decoded;
    this.loaded = true;
    this.poison = null;
  }

  async load(): Promise<void> {
    try {
      await this.loadCompacted();
    } catch (cause) {
      this.loaded = false;
      const detail = cause instanceof Error ? cause.message : String(cause);
      this.poison = new Error(`Plugin data store is unavailable after a read failure: ${detail}`);
      throw cause;
    }
  }

  async reload(): Promise<void> {
    const operation = this.tail.catch(() => undefined).then(async () => {
      try {
        await this.loadCompacted();
      } catch (cause) {
        this.loaded = false;
        const detail = cause instanceof Error ? cause.message : String(cause);
        this.poison = new Error(`Plugin data store is unavailable after a read failure: ${detail}`);
        throw cause;
      }
    });
    this.tail = operation;
    await operation;
  }

  async enforceRuntimePolicy(policy: RuntimeSafetyPolicy): Promise<void> {
    if (policy.mode === "normal") return;
    try {
      await this.saveSettings(effectiveSettings(policy, this.settings()));
      await this.reload();
    } catch {
      throw new Error("Acceptance safety settings could not be verified");
    }
    const verified = this.settings();
    if (verified.writeEnabled || verified.aiEnabled) {
      throw new Error("Acceptance safety settings could not be verified");
    }
  }

  settings(): PluginSettings {
    return clone(this.data.settings);
  }

  activeIndex(): ActiveIndex | null {
    return clone(this.data.activeIndex);
  }

  hasActiveIndex(): boolean {
    return this.data.activeIndex !== null;
  }

  forEachActiveIndexRecord(visitor: (record: DocumentRecord) => void): void {
    for (const record of this.data.activeIndex?.records ?? []) visitor(record);
  }

  staging(): ScanCheckpoint | null {
    return clone(this.data.staging);
  }

  operational(): OperationalState {
    return clone(this.data.operational);
  }

  readJournals(): readonly unknown[] {
    if (!this.loaded || this.poison !== null) {
      throw this.poison ?? new Error("Plugin data store must be loaded before reading journals");
    }
    return clone(this.data.operational.journals);
  }

  private update(change: (current: PluginData) => PluginData | Promise<PluginData>): Promise<void> {
    const operation = this.tail.catch(() => undefined).then(async () => {
      if (!this.loaded || this.poison !== null) {
        throw this.poison ?? new Error("Plugin data store must be loaded before mutation");
      }
      const changed = await change(clone(this.data));
      const next = clone(changed);
      try {
        await this.port.save(clone(next));
      } catch (saveError) {
        try {
          this.data = decodeData(await this.port.load());
          this.loaded = true;
        } catch (reloadError) {
          const detail = reloadError instanceof Error ? reloadError.message : String(reloadError);
          this.poison = new Error(`Plugin data store is poisoned because durable state could not be reloaded: ${detail}`);
        }
        throw saveError;
      }
      this.data = clone(next);
    });
    this.tail = operation;
    return operation;
  }

  saveSettings(settings: PluginSettings): Promise<void> {
    const requested = clone(settings);
    return this.update((data) => ({
      ...data,
      settings: preserveCloudVerificationSettings(
        decodeSettings(requested),
        cloudVerificationSettings(data.settings),
      ),
    }));
  }

  updateSettings(change: (settings: PluginSettings) => PluginSettings): Promise<void> {
    return this.update((data) => {
      const authority = cloudVerificationSettings(data.settings);
      return {
        ...data,
        settings: preserveCloudVerificationSettings(
          decodeSettings(change(clone(data.settings))),
          authority,
        ),
      };
    });
  }

  updateCloudVerificationSettings(
    settings: CloudVerificationSettings,
    transition: CloudVerificationTransitionIntent,
  ): Promise<void> {
    const expectedCurrent = cloudVerificationSettings(this.data.settings);
    const requestedSettings = clone(settings);
    const requestedTransition = clone(transition);
    return this.update(async (data) => {
      const current = cloudVerificationSettings(data.settings);
      if (!sameCloudVerificationValue(current, expectedCurrent)) {
        throw new RangeError("Cloud verification authority changed before the transaction committed");
      }
      const decoded = decodeSettings({ ...data.settings, ...requestedSettings });
      const next = cloudVerificationSettings(decoded);
      await assertCloudVerificationTransition(current, next, requestedTransition);
      return {
        ...data,
        settings: {
          ...data.settings,
          ...next,
        },
      };
    });
  }

  saveCheckpoint(staging: ScanCheckpoint): Promise<void> {
    const snapshot = clone(staging);
    return this.update((data) => ({ ...data, staging: snapshot }));
  }

  promoteStaging(scanId: string, builtAt: number): Promise<void> {
    return this.update((data) => {
      if (data.staging?.scanId !== scanId) throw new Error("Staging scan ID does not match");
      return { ...data, activeIndex: { builtAt, records: data.staging.records }, staging: null };
    });
  }

  saveActiveIndex(activeIndex: ActiveIndex): Promise<void> {
    const snapshot = clone(activeIndex);
    return this.update((data) => ({ ...data, activeIndex: snapshot }));
  }

  setPin(id: string, pinnedAt: number | null): Promise<void> {
    return this.update((data) => {
      if (pinnedAt !== null) assertFiniteTimestamp(pinnedAt, "pinnedAt");
      return {
        ...data,
        operational: {
          ...data.operational,
          pins: pinnedAt === null ? removeKey(data.operational.pins, id) : { ...data.operational.pins, [id]: pinnedAt },
        },
      };
    });
  }

  setDismissal(id: string, value: { readonly dismissedAt: number; readonly mtime: number } | null): Promise<void> {
    const snapshot = value === null ? null : clone(value);
    return this.update((data) => {
      if (snapshot !== null) {
        assertFiniteTimestamp(snapshot.dismissedAt, "dismissedAt");
        assertFiniteTimestamp(snapshot.mtime, "mtime");
      }
      return {
        ...data,
        operational: {
          ...data.operational,
          dismissals: snapshot === null
            ? removeKey(data.operational.dismissals, id)
            : { ...data.operational.dismissals, [id]: snapshot },
        },
      };
    });
  }

  setLastOpened(id: string, openedAt: number): Promise<void> {
    return this.update((data) => {
      assertFiniteTimestamp(openedAt, "openedAt");
      return {
        ...data,
        operational: {
          ...data.operational,
          lastOpened: { ...data.operational.lastOpened, [id]: openedAt },
        },
      };
    });
  }

  appendJournal(entry: unknown): Promise<void> {
    const snapshot = clone(entry);
    return this.update((data) => {
      if (data.operational.journals.filter(isActiveJournal).length >= MAX_JOURNALS) {
        throw new Error("Cannot append journal without discarding active recovery state");
      }
      const journals = capJournalsPreservingActive([...data.operational.journals, snapshot]);
      if (journals.length > MAX_JOURNALS && isActiveJournal(snapshot)) {
        throw new Error("Cannot append journal without discarding active recovery state");
      }
      return {
        ...data,
        operational: {
          ...data.operational,
          journals,
        },
      };
    });
  }

  claimJournal(entry: unknown, blocksClaim: (entry: unknown) => boolean): Promise<void> {
    const snapshot = clone(entry);
    return this.update((data) => {
      if (data.operational.journals.some(blocksClaim)) {
        throw new Error("Organization writes are locked by unfinished recovery state");
      }
      const journals = capJournalsPreservingActive([...data.operational.journals, snapshot]);
      if (journals.length > MAX_JOURNALS) {
        throw new Error("Cannot append journal without discarding protected recovery state");
      }
      return {
        ...data,
        operational: {
          ...data.operational,
          journals,
        },
      };
    });
  }

  async mutateJournals<T>(
    change: (journals: readonly unknown[]) => Readonly<{ journals: readonly unknown[]; result: T }> | Promise<Readonly<{ journals: readonly unknown[]; result: T }>>,
  ): Promise<T> {
    let result: T | undefined;
    let hasResult = false;
    await this.update(async (data) => {
      const changed = await change(clone(data.operational.journals));
      result = clone(changed.result);
      hasResult = true;
      return {
        ...data,
        operational: { ...data.operational, journals: clone(changed.journals) },
      };
    });
    if (!hasResult) throw new Error("Journal mutation completed without a result");
    return clone(result as T);
  }

  updateJournal(id: string, change: (entry: unknown) => unknown): Promise<void> {
    return this.update((data) => {
      let found = false;
      const journals = data.operational.journals.map((entry) => {
        if (!isJournalId(entry, id)) return entry;
        found = true;
        return change(entry);
      });
      if (!found) throw new Error(`Journal not found: ${id}`);
      return {
        ...data,
        operational: { ...data.operational, journals: capJournalsPreservingActive(journals) },
      };
    });
  }

  clearSettledJournals(): Promise<void> {
    return this.update((data) => {
      if (data.operational.journals.some(isActiveJournal)) throw new Error("Cannot clear history while a transaction is active");
      return {
        ...data,
        operational: {
          ...data.operational,
          journals: data.operational.journals.filter((entry) => !isLegacySettledJournal(entry)),
        },
      };
    });
  }
}
