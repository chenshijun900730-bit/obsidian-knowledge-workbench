import { normalizeCatalogScanRoot } from "./catalog-path";
import { LARGE_CATALOG_RUN_BUDGET } from "./hybrid-catalog-types";
import type {
  CloudDirectoryPickerPurpose,
  CloudDirectorySelection,
} from "./cloud-directory-selection";

export interface VerificationLaunchGroup {
  readonly groupKey: string;
  readonly rootRelativePath: string;
  readonly label: string;
  readonly pdfCount: number;
}

export type VerificationLaunchRequest =
  | Readonly<{
      kind: "start";
      cloudRoot: string;
      groups: readonly VerificationLaunchGroup[];
      directorySelection?: CloudDirectorySelection;
    }>
  | Readonly<{
      kind: "resume";
      cloudRoot: string;
      groups: readonly VerificationLaunchGroup[];
    }>;

export type VerificationLaunchSelectionValidator = (
  selection: CloudDirectorySelection,
  purpose: CloudDirectoryPickerPurpose,
) => CloudDirectorySelection;

const GROUP_PATTERN = /^(?:txt-root-items|group:[a-f0-9]{64})$/u;
const CONTROL_PATTERN = /\p{Cc}/u;

const invalid = (): never => {
  throw new RangeError("invalid-large-catalog-selection");
};

const checkedRelativePath = (groupKey: string, value: unknown): string => {
  if (typeof value !== "string") return invalid();
  if (groupKey === "txt-root-items") {
    if (value !== "") return invalid();
    return value;
  }
  if (
    value.length === 0
    || value !== value.normalize("NFC")
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
    || CONTROL_PATTERN.test(value)
  ) return invalid();
  return value;
};

const checkedGroups = (value: unknown): readonly VerificationLaunchGroup[] => {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > LARGE_CATALOG_RUN_BUDGET.maxSelectedTopLevelGroups
  ) return invalid();
  const seen = new Set<string>();
  return value.map((candidate: unknown): VerificationLaunchGroup => {
    if (candidate === null || typeof candidate !== "object") return invalid();
    const group = candidate as Readonly<Record<string, unknown>>;
    if (
      typeof group.groupKey !== "string"
      || !GROUP_PATTERN.test(group.groupKey)
      || seen.has(group.groupKey)
      || typeof group.label !== "string"
      || typeof group.pdfCount !== "number"
      || !Number.isSafeInteger(group.pdfCount)
      || group.pdfCount < 1
    ) return invalid();
    const label = group.label.normalize("NFC").trim();
    if (label.length === 0 || CONTROL_PATTERN.test(label)) return invalid();
    const rootRelativePath = checkedRelativePath(group.groupKey, group.rootRelativePath);
    seen.add(group.groupKey);
    return {
      groupKey: group.groupKey,
      rootRelativePath,
      label,
      pdfCount: group.pdfCount,
    };
  });
};

const checkedNormalizedPath = (value: unknown): string => {
  if (typeof value !== "string") return invalid();
  try {
    const normalized = normalizeCatalogScanRoot(value);
    if (normalized !== value) return invalid();
    return normalized;
  } catch {
    return invalid();
  }
};

const detachedSelection = (
  value: CloudDirectorySelection,
  cloudRoot: string,
  groups: readonly VerificationLaunchGroup[],
): CloudDirectorySelection => {
  if (value === null || typeof value !== "object") return invalid();
  const selectedPath = checkedNormalizedPath(value.selectedPath);
  const effectiveRoot = checkedNormalizedPath(value.effectiveRoot);
  if (effectiveRoot !== cloudRoot) return invalid();
  if (value.kind === "directory") {
    if (selectedPath !== effectiveRoot) return invalid();
    return { kind: "directory", selectedPath, effectiveRoot };
  }
  if (
    value.kind !== "category"
    || !GROUP_PATTERN.test(value.groupKey)
    || groups.length !== 1
    || groups[0]?.groupKey !== value.groupKey
  ) return invalid();
  return {
    kind: "category",
    selectedPath,
    effectiveRoot,
    groupKey: value.groupKey,
  };
};

export function validateVerificationLaunchRequest(
  input: VerificationLaunchRequest,
  validateSelection: VerificationLaunchSelectionValidator | undefined,
): VerificationLaunchRequest {
  if (input === null || typeof input !== "object") return invalid();
  if (input.kind !== "start" && input.kind !== "resume") return invalid();
  let cloudRoot: string;
  try {
    if (typeof input.cloudRoot !== "string") return invalid();
    cloudRoot = normalizeCatalogScanRoot(input.cloudRoot);
  } catch {
    return invalid();
  }
  const groups = checkedGroups(input.groups);

  if (input.kind === "resume") {
    if ((input as Readonly<{ directorySelection?: unknown }>).directorySelection !== undefined) {
      return invalid();
    }
    return { kind: "resume", cloudRoot, groups };
  }

  if (validateSelection === undefined) return invalid();
  const purpose: CloudDirectoryPickerPurpose = {
    kind: "verification",
    groups: groups.map(({ groupKey, rootRelativePath, label }) => ({
      groupKey,
      rootRelativePath,
      label,
    })),
  };
  const requestedSelection = input.directorySelection ?? {
    kind: "directory",
    selectedPath: cloudRoot,
    effectiveRoot: cloudRoot,
  };
  let validatedSelection: CloudDirectorySelection;
  try {
    validatedSelection = detachedSelection(
      validateSelection(requestedSelection, purpose),
      cloudRoot,
      groups,
    );
  } catch {
    return invalid();
  }
  return {
    kind: "start",
    cloudRoot,
    groups,
    ...(input.directorySelection === undefined
      ? {}
      : { directorySelection: validatedSelection }),
  };
}
