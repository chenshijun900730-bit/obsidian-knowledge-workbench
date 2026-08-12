import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const SOURCE_PATH = "Generated/00000/note-00000-3db92208.md";
const TARGET_PATH = "Generated/00001/note-00001-752cddc7.md";
const OPERATION_ID = "synthetic-acceptance-rename";
const CONTENT_HASH = "9ebdaff407368399fd20c3f82fa4452accb78680440e4d4d258844ca42080aea";
const EXPECTED_FINGERPRINT = "d7d8fb5af0c70b57feee26368f1279aa1c4125fdd19884d8d781db8cd22776ba";
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const KNOWN_SETTING_KEYS = new Set([
  "writeEnabled",
  "writePreviewAcknowledged",
  "openAtStartup",
  "folderRules",
  "excludedPrefixes",
  "aiEnabled",
  "aiEndpoint",
  "aiModel",
  "secretId",
]);
const TOP_LEVEL_KEYS = ["schemaVersion", "settings", "activeIndex", "staging", "operational"];
const ACTIVE_INDEX_KEYS = ["builtAt", "records"];
const STAGING_KEYS = ["scanId", "completedPaths", "records"];
const OPERATIONAL_KEYS = new Set(["pins", "dismissals", "lastOpened", "journals"]);
const OPERATIONAL_REQUIRED_KEYS = ["pins", "dismissals", "lastOpened"];
const DISMISSAL_KEYS = ["dismissedAt", "mtime"];
const DOCUMENT_RECORD_KEYS = [
  "id",
  "path",
  "basename",
  "kind",
  "title",
  "aliases",
  "headings",
  "tags",
  "ownedFields",
  "relationFields",
  "outgoingLinks",
  "tokens",
  "mtime",
  "size",
  "contentHash",
];
const OWNED_FIELD_KEYS = new Set([
  "knowledge-workbench-kind",
  "knowledge-workbench-topics",
  "knowledge-workbench-related",
]);
const SENSITIVE_SETTING_KEY = /(?:endpoint|url|uri|host|model|secret|token|password|credential|authori[sz]ation|bearer|cookie|session|certificate|(?:api|access|private|client|encryption|signing)[-_]?key)/iu;
const SENSITIVE_SETTING_VALUE = /(?:https?|wss?|file):|(?:^|[^a-z])(?:endpoint|model|secret|token|password|credential)(?:[^a-z]|$)|-----BEGIN [A-Z ]*PRIVATE KEY-----/iu;

function codePointCompare(left, right) {
  const leftPoints = left[Symbol.iterator]();
  const rightPoints = right[Symbol.iterator]();
  while (true) {
    const leftPoint = leftPoints.next();
    const rightPoint = rightPoints.next();
    if (leftPoint.done || rightPoint.done) {
      if (leftPoint.done && rightPoint.done) return 0;
      return leftPoint.done ? -1 : 1;
    }
    const difference = leftPoint.value.codePointAt(0) - rightPoint.value.codePointAt(0);
    if (difference !== 0) return difference;
  }
}

function canonicalizeForHash(value) {
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => codePointCompare(left, right))
      .map(([key, item]) => [key, canonicalizeForHash(item)]));
  }
  return value;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function frozenClone(value) {
  return deepFreeze(structuredClone(value));
}

function isPlainRecord(value) {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function requirePlainRecord(value, label) {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}

function hasExactKeys(value, keys) {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length
    && actual.every((key) => typeof key === "string" && keys.includes(key));
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isFiniteNumberMap(value) {
  return isPlainRecord(value)
    && Object.values(value).every((item) => typeof item === "number" && Number.isFinite(item));
}

function isOwnedFieldValue(value) {
  return typeof value === "string" || isStringArray(value);
}

function isDocumentRecord(value) {
  if (!isPlainRecord(value) || !hasExactKeys(value, DOCUMENT_RECORD_KEYS)) return false;
  if (!isPlainRecord(value.ownedFields)
    || Object.keys(value.ownedFields).some((key) => !OWNED_FIELD_KEYS.has(key))
    || !isPlainRecord(value.relationFields)
    || !Object.values(value.relationFields).every(isOwnedFieldValue)) return false;
  return typeof value.id === "string"
    && typeof value.path === "string"
    && typeof value.basename === "string"
    && (value.kind === "note" || value.kind === "reference" || value.kind === "unclassified")
    && typeof value.title === "string"
    && isStringArray(value.aliases)
    && isStringArray(value.headings)
    && isStringArray(value.tags)
    && isStringArray(value.outgoingLinks)
    && isStringArray(value.tokens)
    && typeof value.mtime === "number"
    && Number.isFinite(value.mtime)
    && typeof value.size === "number"
    && Number.isFinite(value.size)
    && typeof value.contentHash === "string";
}

function validateDerivedState(pluginData) {
  if (!hasExactKeys(pluginData, TOP_LEVEL_KEYS) || pluginData.schemaVersion !== 1) {
    throw new Error("Post-host plugin data must use the exact schemaVersion 1 root keys");
  }
  if (pluginData.activeIndex !== null) {
    const activeIndex = requirePlainRecord(pluginData.activeIndex, "Post-host active index");
    if (!hasExactKeys(activeIndex, ACTIVE_INDEX_KEYS)
      || typeof activeIndex.builtAt !== "number"
      || !Number.isFinite(activeIndex.builtAt)
      || !Array.isArray(activeIndex.records)
      || !activeIndex.records.every(isDocumentRecord)) {
      throw new Error("Post-host active index has an invalid shape");
    }
  }
  if (pluginData.staging !== null) {
    const staging = requirePlainRecord(pluginData.staging, "Post-host staging");
    if (!hasExactKeys(staging, STAGING_KEYS)
      || typeof staging.scanId !== "string"
      || !isStringArray(staging.completedPaths)
      || !Array.isArray(staging.records)
      || !staging.records.every(isDocumentRecord)) {
      throw new Error("Post-host staging has an invalid shape");
    }
  }
  const operational = requirePlainRecord(pluginData.operational, "Post-host operational data");
  const operationalKeys = Reflect.ownKeys(operational);
  if (operationalKeys.some((key) => typeof key !== "string" || !OPERATIONAL_KEYS.has(key))
    || OPERATIONAL_REQUIRED_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(operational, key))
    || !isFiniteNumberMap(operational.pins)
    || !isFiniteNumberMap(operational.lastOpened)
    || !isPlainRecord(operational.dismissals)
    || !Object.values(operational.dismissals).every((value) => isPlainRecord(value)
      && hasExactKeys(value, DISMISSAL_KEYS)
      && typeof value.dismissedAt === "number"
      && Number.isFinite(value.dismissedAt)
      && typeof value.mtime === "number"
      && Number.isFinite(value.mtime))) {
    throw new Error("Post-host operational data has an invalid shape");
  }
}

function requireBytes(value, label) {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${label} must be a Uint8Array`);
  }
  try {
    return Buffer.from(value);
  } catch (error) {
    throw new TypeError(`${label} must be readable bytes`, { cause: error });
  }
}

function decodeJson(bytes, label) {
  const input = requireBytes(bytes, label);
  let text;
  try {
    text = UTF8.decode(input);
  } catch (error) {
    throw new Error(`${label} must be valid UTF-8`, { cause: error });
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} must be valid JSON`, { cause: error });
  }
  return { input, value: requirePlainRecord(value, label) };
}

function encodeCanonical(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildSeed() {
  const operation = {
    id: OPERATION_ID,
    kind: "rename",
    sourcePath: SOURCE_PATH,
    targetPath: TARGET_PATH,
  };
  const inverse = {
    id: OPERATION_ID,
    kind: "rename",
    sourcePath: TARGET_PATH,
    targetPath: SOURCE_PATH,
  };
  const preconditions = [
    {
      path: SOURCE_PATH,
      exists: true,
      mtime: 1,
      contentHash: CONTENT_HASH,
    },
    {
      path: TARGET_PATH,
      exists: false,
    },
  ];
  const rationale = {
    source: "local",
    summary: "Review rename",
    signals: ["direct-user-selection"],
    confidence: "low",
    impact: 0,
  };
  const fingerprintPayload = {
    operations: [operation],
    preconditions,
    rationales: { [OPERATION_ID]: rationale },
    localRationales: { [OPERATION_ID]: rationale },
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(canonicalizeForHash(fingerprintPayload)))
    .digest("hex");
  if (fingerprint !== EXPECTED_FINGERPRINT) {
    throw new Error("Synthetic acceptance plan fingerprint is inconsistent");
  }
  const planId = fingerprint.slice(0, 16);
  const plan = {
    id: planId,
    fingerprint,
    operations: [operation],
    preconditions,
    rationales: { [OPERATION_ID]: rationale },
    localRationales: { [OPERATION_ID]: rationale },
  };
  const journal = {
    id: `1:${planId}`,
    status: "completed",
    createdAt: 1,
    plan,
    prepared: null,
    completed: [
      {
        operation,
        inverse,
        preconditions,
        postconditions: [
          {
            path: SOURCE_PATH,
            exists: false,
          },
          {
            path: TARGET_PATH,
            exists: true,
            mtime: 1,
            contentHash: CONTENT_HASH,
          },
        ],
      },
    ],
    rolledBackOperationIds: [],
  };
  return {
    schemaVersion: 1,
    settings: {
      writeEnabled: true,
      writePreviewAcknowledged: true,
      openAtStartup: false,
      folderRules: [],
      excludedPrefixes: [],
      aiEnabled: false,
      aiEndpoint: "",
      aiModel: "",
      secretId: "",
    },
    activeIndex: null,
    staging: null,
    operational: {
      pins: {},
      dismissals: {},
      lastOpened: {},
      journals: [journal],
    },
  };
}

const CANONICAL_SEED = deepFreeze(buildSeed());
const CANONICAL_SEED_BYTES = encodeCanonical(CANONICAL_SEED);
const EXPECTED_JOURNAL = CANONICAL_SEED.operational.journals[0];

function settingsEvidence(settingsValue) {
  if (!isPlainRecord(settingsValue)) return "unsafe";
  if (hasSensitiveSettingMaterial(settingsValue, true)) return "unsafe";
  return settingsValue.writeEnabled === false
    && settingsValue.aiEnabled === false
    && settingsValue.aiEndpoint === ""
    && settingsValue.aiModel === ""
    && settingsValue.secretId === ""
    ? "normalized-safe"
    : "unsafe";
}

function hasSensitiveSettingMaterial(value, root = false) {
  if (typeof value === "string") return SENSITIVE_SETTING_VALUE.test(value);
  if (Array.isArray(value)) return value.some((item) => hasSensitiveSettingMaterial(item));
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).some(([key, item]) => (
    !(root && KNOWN_SETTING_KEYS.has(key)) && SENSITIVE_SETTING_KEY.test(key)
  ) || hasSensitiveSettingMaterial(item));
}

function journalValues(pluginData) {
  const operational = pluginData.operational;
  if (
    typeof operational !== "object"
    || operational === null
    || Array.isArray(operational)
    || !Array.isArray(operational.journals)
  ) return [];
  return operational.journals;
}

function hasSeededJournal(journals) {
  return journals.filter((entry) => isDeepStrictEqual(entry, EXPECTED_JOURNAL)).length === 1;
}

function hasRecovery(journals) {
  return journals.some((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    return entry.status === "recovery-required"
      || Object.prototype.hasOwnProperty.call(entry, "recovery");
  });
}

export function createSyntheticPluginDataSeed() {
  return frozenClone(CANONICAL_SEED);
}

export function encodeSyntheticPluginDataSeed() {
  return Buffer.from(CANONICAL_SEED_BYTES);
}

export function decodeSyntheticPluginDataSeed(bytes) {
  const decoded = decodeJson(bytes, "Synthetic plugin-data seed bytes");
  if (
    !decoded.input.equals(CANONICAL_SEED_BYTES)
    || !isDeepStrictEqual(decoded.value, CANONICAL_SEED)
  ) {
    throw new Error("Synthetic plugin-data seed bytes must use the exact canonical seed encoding and final newline");
  }
  return frozenClone(CANONICAL_SEED);
}

export function inspectPostHostPluginData(bytes) {
  const decoded = decodeJson(bytes, "Post-host plugin data bytes");
  validateDerivedState(decoded.value);
  const journals = journalValues(decoded.value);
  const startupNormalizationEvidence = decoded.input.equals(CANONICAL_SEED_BYTES)
    ? "seed-unchanged"
    : settingsEvidence(decoded.value.settings);
  return Object.freeze({
    startupNormalizationEvidence,
    seededJournalPresent: hasSeededJournal(journals),
    recoveryAbsent: !hasRecovery(journals),
  });
}
