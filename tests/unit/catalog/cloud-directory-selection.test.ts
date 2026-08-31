import { describe, expect, it } from "vitest";
import {
  resolveCloudDirectorySelection,
  validateCloudDirectorySelection,
  type CloudDirectoryPickerPurpose,
  type CloudDirectorySelection,
} from "../../../src/catalog/cloud-directory-selection";

const GROUP_A = `group:${"a".repeat(64)}`;
const GROUP_B = `group:${"b".repeat(64)}`;

type VerificationPurpose = Extract<CloudDirectoryPickerPurpose, { kind: "verification" }>;

const verificationPurpose = (
  groups: VerificationPurpose["groups"],
): VerificationPurpose => ({ kind: "verification", groups });

describe("cloud directory selection", () => {
  it("resolves a directory as its own effective root", () => {
    expect(resolveCloudDirectorySelection({
      selectionKind: "directory",
      purpose: { kind: "scan" },
      currentPath: "/科学文库",
      selectedPath: "/科学文库/资料",
    })).toEqual({
      kind: "directory",
      selectedPath: "/科学文库/资料",
      effectiveRoot: "/科学文库/资料",
    });
  });

  it("allows the cloud root only as an internal parent for a non-root directory", () => {
    expect(resolveCloudDirectorySelection({
      selectionKind: "directory",
      purpose: { kind: "scan" },
      currentPath: "/",
      selectedPath: "/科学文库",
    })).toEqual({
      kind: "directory",
      selectedPath: "/科学文库",
      effectiveRoot: "/科学文库",
    });
  });

  it("resolves one verified direct-child category to its parent root", () => {
    expect(resolveCloudDirectorySelection({
      selectionKind: "category",
      purpose: verificationPurpose([{
        groupKey: GROUP_A,
        rootRelativePath: "6-经济类",
        label: "6-经济类",
      }]),
      currentPath: "/科学文库",
      selectedPath: "/科学文库/6-经济类",
    })).toEqual({
      kind: "category",
      selectedPath: "/科学文库/6-经济类",
      effectiveRoot: "/科学文库",
      groupKey: GROUP_A,
    });
  });

  it("does not allow category semantics for scan purpose", () => {
    expect(() => resolveCloudDirectorySelection({
      selectionKind: "category",
      purpose: { kind: "scan" },
      currentPath: "/科学文库",
      selectedPath: "/科学文库/6-经济类",
    })).toThrow("cloud-directory-selection-invalid");
  });

  it.each([
    {
      selectionKind: "directory" as const,
      purpose: { kind: "scan" as const },
      currentPath: "/",
      selectedPath: "/",
    },
    {
      selectionKind: "category" as const,
      purpose: verificationPurpose([{
        groupKey: GROUP_A,
        rootRelativePath: "科学文库",
        label: "科学文库",
      }]),
      currentPath: "/",
      selectedPath: "/科学文库",
    },
  ])("rejects a root output for $selectionKind selection", (input) => {
    expect(() => resolveCloudDirectorySelection(input)).toThrow();
  });

  it("requires a category to be a direct child of the current non-root parent", () => {
    const purpose = verificationPurpose([{
      groupKey: GROUP_A,
      rootRelativePath: "6-经济类",
      label: "6-经济类",
    }]);

    expect(() => resolveCloudDirectorySelection({
      selectionKind: "category",
      purpose,
      currentPath: "/科学文库",
      selectedPath: "/科学文库/中间层/6-经济类",
    })).toThrow("cloud-directory-category-ambiguous");
  });

  it("rejects zero or multiple category matches without guessing", () => {
    expect(() => resolveCloudDirectorySelection({
      selectionKind: "category",
      purpose: verificationPurpose([{
        groupKey: GROUP_A,
        rootRelativePath: "9-文学",
        label: "9-文学",
      }]),
      currentPath: "/科学文库",
      selectedPath: "/科学文库/6-经济类",
    })).toThrow("cloud-directory-category-ambiguous");

    expect(() => resolveCloudDirectorySelection({
      selectionKind: "category",
      purpose: verificationPurpose([
        { groupKey: GROUP_A, rootRelativePath: "6-经济类", label: "经济一" },
        { groupKey: GROUP_B, rootRelativePath: "6-经济类", label: "经济二" },
      ]),
      currentPath: "/科学文库",
      selectedPath: "/科学文库/6-经济类",
    })).toThrow("cloud-directory-category-ambiguous");
  });

  it.each([
    {
      name: "txt root items",
      groupKey: "txt-root-items",
      rootRelativePath: "",
      label: "Root items",
    },
    {
      name: "malformed group key",
      groupKey: "group:not-a-digest",
      rootRelativePath: "6-经济类",
      label: "6-经济类",
    },
    {
      name: "control character",
      groupKey: GROUP_A,
      rootRelativePath: "6-经济\u0000类",
      label: "6-经济类",
    },
    {
      name: "decomposed path",
      groupKey: GROUP_A,
      rootRelativePath: "e\u0301",
      label: "é",
    },
    {
      name: "parent escape",
      groupKey: GROUP_A,
      rootRelativePath: "../6-经济类",
      label: "6-经济类",
    },
  ])("rejects unsafe category metadata: $name", ({ groupKey, rootRelativePath, label }) => {
    expect(() => resolveCloudDirectorySelection({
      selectionKind: "category",
      purpose: verificationPurpose([{ groupKey, rootRelativePath, label }]),
      currentPath: "/科学文库",
      selectedPath: "/科学文库/6-经济类",
    })).toThrow();
  });

  it.each([
    { currentPath: "/科学文库/e\u0301", selectedPath: "/科学文库/e\u0301/资料" },
    { currentPath: "/科学文库", selectedPath: "/科学文库/e\u0301" },
  ])("rejects non-NFC browse paths", ({ currentPath, selectedPath }) => {
    expect(() => resolveCloudDirectorySelection({
      selectionKind: "directory",
      purpose: { kind: "scan" },
      currentPath,
      selectedPath,
    })).toThrow("cloud-directory-selection-invalid");
  });

  it("returns detached whitelisted data without cloud identity fields", () => {
    const mutableGroup = {
      groupKey: GROUP_A,
      rootRelativePath: "6-经济类",
      label: "6-经济类",
      fsId: "must-not-escape",
    };
    const mutableSelection: CloudDirectorySelection = {
      kind: "category",
      selectedPath: "/科学文库/6-经济类",
      effectiveRoot: "/科学文库",
      groupKey: GROUP_A,
    };
    const purpose = verificationPurpose([mutableGroup]);
    const validated = validateCloudDirectorySelection(mutableSelection, purpose);

    expect(validated).toEqual(mutableSelection);
    expect(validated).not.toBe(mutableSelection);
    expect(JSON.stringify(validated)).not.toContain("fsId");

    mutableGroup.rootRelativePath = "9-文学";
    mutableGroup.fsId = "changed";
    expect(validated).toEqual({
      kind: "category",
      selectedPath: "/科学文库/6-经济类",
      effectiveRoot: "/科学文库",
      groupKey: GROUP_A,
    });
  });
});
