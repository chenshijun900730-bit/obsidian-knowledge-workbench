import {
  normalizeCatalogScanRoot,
  normalizeCloudAbsolutePath,
} from "./catalog-path";

export type CloudDirectoryPickerPurpose =
  | Readonly<{ kind: "scan" }>
  | Readonly<{
      kind: "verification";
      groups: readonly Readonly<{
        groupKey: string;
        rootRelativePath: string;
        label: string;
      }>[];
    }>;

export type CloudDirectorySelection =
  | Readonly<{
      kind: "directory";
      selectedPath: string;
      effectiveRoot: string;
    }>
  | Readonly<{
      kind: "category";
      selectedPath: string;
      effectiveRoot: string;
      groupKey: string;
    }>;

type VerificationGroup = Extract<
  CloudDirectoryPickerPurpose,
  { kind: "verification" }
>["groups"][number];

const GROUP_PATTERN = /^group:[a-f0-9]{64}$/u;
const CONTROL_PATTERN = /\p{Cc}/u;

const invalidSelection = (): never => {
  throw new RangeError("cloud-directory-selection-invalid");
};

const ambiguousCategory = (): never => {
  throw new RangeError("cloud-directory-category-ambiguous");
};

const requireNfc = (value: string): void => {
  if (value !== value.normalize("NFC")) invalidSelection();
};

const normalizedBrowsePath = (value: string): string => {
  if (typeof value !== "string") return invalidSelection();
  requireNfc(value);
  return normalizeCloudAbsolutePath(value);
};

const normalizedOutputPath = (value: string): string => {
  if (typeof value !== "string") return invalidSelection();
  requireNfc(value);
  return normalizeCatalogScanRoot(value);
};

const normalizedLabel = (value: string): string => {
  if (
    typeof value !== "string"
    || value.length === 0
    || CONTROL_PATTERN.test(value)
  ) return invalidSelection();
  requireNfc(value);
  return value;
};

const normalizedRelativeRoot = (value: string): string => {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.startsWith("/")
    || value.includes("/")
    || value.includes("\\")
    || CONTROL_PATTERN.test(value)
    || value === "."
    || value === ".."
  ) return invalidSelection();
  requireNfc(value);
  return normalizeCatalogScanRoot(`/${value}`).slice(1);
};

const normalizedVerificationGroups = (
  purpose: Extract<CloudDirectoryPickerPurpose, { kind: "verification" }>,
): readonly VerificationGroup[] => {
  const rawGroups: unknown = purpose.groups;
  if (!Array.isArray(rawGroups)) return invalidSelection();
  return rawGroups.map((rawGroup: unknown): VerificationGroup => {
    if (rawGroup === null || typeof rawGroup !== "object") return invalidSelection();
    const group = rawGroup as Readonly<Record<string, unknown>>;
    if (
      typeof group.groupKey !== "string"
      || typeof group.rootRelativePath !== "string"
      || typeof group.label !== "string"
    ) return invalidSelection();
    const label = normalizedLabel(group.label);
    if (group.groupKey === "txt-root-items") {
      if (group.rootRelativePath !== "") return invalidSelection();
      return { groupKey: "txt-root-items", rootRelativePath: "", label };
    }
    if (!GROUP_PATTERN.test(group.groupKey)) return invalidSelection();
    return {
      groupKey: group.groupKey,
      rootRelativePath: normalizedRelativeRoot(group.rootRelativePath),
      label,
    };
  });
};

const verificationGroups = (
  purpose: CloudDirectoryPickerPurpose,
): readonly VerificationGroup[] => {
  if (purpose === null || typeof purpose !== "object") return invalidSelection();
  if (purpose.kind === "scan") return [];
  if (purpose.kind !== "verification") return invalidSelection();
  return normalizedVerificationGroups(purpose);
};

const isDirectChild = (parentPath: string, childPath: string): boolean => {
  const prefix = parentPath === "/" ? "/" : `${parentPath}/`;
  if (!childPath.startsWith(prefix)) return false;
  const remainder = childPath.slice(prefix.length);
  return remainder.length > 0 && !remainder.includes("/");
};

const childPath = (parentPath: string, rootRelativePath: string): string => (
  normalizeCatalogScanRoot(parentPath === "/"
    ? `/${rootRelativePath}`
    : `${parentPath}/${rootRelativePath}`)
);

const resolveCategoryMatch = (
  selectedPath: string,
  effectiveRoot: string,
  groups: readonly VerificationGroup[],
): VerificationGroup => {
  if (!isDirectChild(effectiveRoot, selectedPath)) return ambiguousCategory();
  const matches = groups.filter((group) => (
    group.groupKey !== "txt-root-items"
    && childPath(effectiveRoot, group.rootRelativePath) === selectedPath
  ));
  if (matches.length !== 1) return ambiguousCategory();
  const match = matches[0];
  if (match === undefined) return ambiguousCategory();
  return match;
};

export function resolveCloudDirectorySelection(input: Readonly<{
  selectionKind: "directory" | "category";
  purpose: CloudDirectoryPickerPurpose;
  currentPath: string;
  selectedPath: string;
}>): CloudDirectorySelection {
  const currentPath = normalizedBrowsePath(input.currentPath);
  const selectedPath = normalizedOutputPath(input.selectedPath);
  const groups = verificationGroups(input.purpose);

  if (input.selectionKind === "directory") {
    if (selectedPath !== currentPath && !isDirectChild(currentPath, selectedPath)) {
      return invalidSelection();
    }
    return validateCloudDirectorySelection({
      kind: "directory",
      selectedPath,
      effectiveRoot: selectedPath,
    }, input.purpose);
  }

  if (input.selectionKind !== "category" || input.purpose.kind !== "verification") {
    return invalidSelection();
  }
  if (currentPath === "/") return invalidSelection();
  const match = resolveCategoryMatch(selectedPath, currentPath, groups);
  return validateCloudDirectorySelection({
    kind: "category",
    selectedPath,
    effectiveRoot: normalizedOutputPath(currentPath),
    groupKey: match.groupKey,
  }, input.purpose);
}

export function validateCloudDirectorySelection(
  selection: CloudDirectorySelection,
  purpose: CloudDirectoryPickerPurpose,
): CloudDirectorySelection {
  if (selection === null || typeof selection !== "object") return invalidSelection();
  const groups = verificationGroups(purpose);
  const selectedPath = normalizedOutputPath(selection.selectedPath);
  const effectiveRoot = normalizedOutputPath(selection.effectiveRoot);

  if (selection.kind === "directory") {
    if (selectedPath !== effectiveRoot) return invalidSelection();
    return { kind: "directory", selectedPath, effectiveRoot };
  }

  if (
    selection.kind !== "category"
    || purpose.kind !== "verification"
    || !GROUP_PATTERN.test(selection.groupKey)
  ) return invalidSelection();
  const match = resolveCategoryMatch(selectedPath, effectiveRoot, groups);
  if (match.groupKey !== selection.groupKey) return invalidSelection();
  return {
    kind: "category",
    selectedPath,
    effectiveRoot,
    groupKey: selection.groupKey,
  };
}
