import { describe, expect, it, vi } from "vitest";
import {
  validateCloudDirectorySelection,
  type CloudDirectorySelection,
} from "../../../src/catalog/cloud-directory-selection";
import {
  validateVerificationLaunchRequest,
  type VerificationLaunchGroup,
  type VerificationLaunchRequest,
  type VerificationLaunchSelectionValidator,
} from "../../../src/catalog/verification-launch-request";

const GROUP_KEYS = ["a", "b", "c", "d", "e"].map(
  (value) => `group:${value.repeat(64)}`,
);

type StartLaunchRequest = Extract<VerificationLaunchRequest, { kind: "start" }>;
type ResumeLaunchRequest = Extract<VerificationLaunchRequest, { kind: "resume" }>;

const group = (index = 0): VerificationLaunchGroup => ({
  groupKey: GROUP_KEYS[index]!,
  rootRelativePath: `Group-${index + 1}`,
  label: `Group ${index + 1}`,
  pdfCount: index + 1,
});

const startRequest = (
  groups: readonly VerificationLaunchGroup[] = [group()],
): StartLaunchRequest => ({
  kind: "start",
  cloudRoot: "/Synthetic/library",
  groups,
});

const resumeRequest = (
  groups: readonly VerificationLaunchGroup[] = [group()],
): ResumeLaunchRequest => ({
  kind: "resume",
  cloudRoot: "/Synthetic/library",
  groups,
});

const invalid = (
  input: VerificationLaunchRequest,
  validator: VerificationLaunchSelectionValidator | undefined = validateCloudDirectorySelection,
): void => {
  expect(() => validateVerificationLaunchRequest(input, validator))
    .toThrow("invalid-large-catalog-selection");
};

describe("verification launch request", () => {
  it.each([1, 5])("accepts and detaches a start with %i unique groups", (count) => {
    const groups = Array.from({ length: count }, (_, index) => group(index));
    const input: VerificationLaunchRequest = {
      kind: "start",
      cloudRoot: "/Cafe\u0301",
      groups: groups.map((item, index) => index === 0
        ? { ...item, label: " e\u0301 " }
        : item),
    };

    const result = validateVerificationLaunchRequest(input, validateCloudDirectorySelection);

    expect(result).toEqual({
      kind: "start",
      cloudRoot: "/Café",
      groups: groups.map((item, index) => index === 0
        ? { ...item, label: "é" }
        : item),
    });
    expect(result).not.toBe(input);
    expect(result.groups).not.toBe(input.groups);
    for (let index = 0; index < count; index += 1) {
      expect(result.groups[index]).not.toBe(input.groups[index]);
    }
  });

  it.each([1, 5])("accepts a resume with exactly %i stored groups without selection validation", (count) => {
    const groups = Array.from({ length: count }, (_, index) => group(index));

    const result = validateVerificationLaunchRequest(resumeRequest(groups), undefined);

    expect(result).toEqual(resumeRequest(groups));
    expect(result.groups).not.toBe(groups);
  });

  it.each(["start", "resume"] as const)(
    "requires one to five unique groups for %s",
    (kind) => {
      const makeRequest = kind === "start" ? startRequest : resumeRequest;
      invalid(makeRequest([]));
      invalid(makeRequest(Array.from({ length: 6 }, (_, index) => ({
        groupKey: `group:${String(index).repeat(64)}`,
        rootRelativePath: `Group-${index}`,
        label: `Group ${index}`,
        pdfCount: 1,
      }))));
      invalid(makeRequest([group(), { ...group(), label: "Duplicate key" }]));
    },
  );

  it.each([
    { name: "cloud root", cloudRoot: "/" },
    { name: "relative path", cloudRoot: "Synthetic" },
    { name: "empty segment", cloudRoot: "/Synthetic//library" },
    { name: "parent segment", cloudRoot: "/Synthetic/../library" },
    { name: "backslash", cloudRoot: "/Synthetic\\library" },
    { name: "control character", cloudRoot: "/Synthetic\u0000library" },
  ])("rejects an invalid or root parent: $name", ({ cloudRoot }) => {
    invalid({ ...startRequest(), cloudRoot });
    invalid({ ...resumeRequest(), cloudRoot }, undefined);
  });

  it.each([
    {
      name: "malformed group key",
      value: { ...group(), groupKey: "group:not-a-digest" },
    },
    {
      name: "duplicate root marker path",
      value: { ...group(), groupKey: "txt-root-items", rootRelativePath: "Root" },
    },
    {
      name: "empty category path",
      value: { ...group(), rootRelativePath: "" },
    },
    {
      name: "nested category path",
      value: { ...group(), rootRelativePath: "Parent/Child" },
    },
    {
      name: "parent category path",
      value: { ...group(), rootRelativePath: ".." },
    },
    {
      name: "decomposed category path",
      value: { ...group(), rootRelativePath: "e\u0301" },
    },
    {
      name: "empty label",
      value: { ...group(), label: "  " },
    },
    {
      name: "control label",
      value: { ...group(), label: "Group\u0000" },
    },
    {
      name: "zero count",
      value: { ...group(), pdfCount: 0 },
    },
    {
      name: "fractional count",
      value: { ...group(), pdfCount: 1.5 },
    },
    {
      name: "unsafe count",
      value: { ...group(), pdfCount: Number.MAX_SAFE_INTEGER + 1 },
    },
  ])("rejects unsafe group metadata: $name", ({ value }) => {
    invalid(startRequest([value]));
    invalid(resumeRequest([value]), undefined);
  });

  it("accepts the one valid TXT root-items group", () => {
    const rootItems: VerificationLaunchGroup = {
      groupKey: "txt-root-items",
      rootRelativePath: "",
      label: "Root items",
      pdfCount: 2,
    };

    expect(validateVerificationLaunchRequest(
      startRequest([rootItems]),
      validateCloudDirectorySelection,
    )).toEqual(startRequest([rootItems]));
    expect(validateVerificationLaunchRequest(
      resumeRequest([rootItems]),
      undefined,
    )).toEqual(resumeRequest([rootItems]));
  });

  it("fails a start closed when no structured selection validator is injected", () => {
    for (const input of [startRequest(), {
      ...startRequest(),
      directorySelection: {
        kind: "directory" as const,
        selectedPath: "/Synthetic/library",
        effectiveRoot: "/Synthetic/library",
      },
    }]) {
      expect(() => validateVerificationLaunchRequest(input, undefined))
        .toThrow("invalid-large-catalog-selection");
    }
  });

  it("revalidates start context against a detached verification purpose", () => {
    const mutableGroup = { ...group(), label: " Group 1 " };
    const selection: CloudDirectorySelection = {
      kind: "directory",
      selectedPath: "/Synthetic/library",
      effectiveRoot: "/Synthetic/library",
    };
    const validator = vi.fn(validateCloudDirectorySelection);

    const result = validateVerificationLaunchRequest({
      ...startRequest([mutableGroup]),
      directorySelection: selection,
    }, validator);

    expect(validator).toHaveBeenCalledOnce();
    expect(validator).toHaveBeenCalledWith(selection, {
      kind: "verification",
      groups: [{
        groupKey: mutableGroup.groupKey,
        rootRelativePath: mutableGroup.rootRelativePath,
        label: "Group 1",
      }],
    });
    const purpose = validator.mock.calls[0]![1];
    if (purpose.kind !== "verification") throw new Error("expected verification purpose");
    expect(purpose.groups).not.toBe(result.groups);
    expect(purpose.groups[0]).not.toBe(mutableGroup);
  });

  it("maps selection validation faults to the launch error", () => {
    invalid(startRequest(), () => {
      throw new RangeError("cloud-directory-selection-invalid");
    });
  });

  it("requires the validated selection effective root to equal the launch root", () => {
    invalid({
      ...startRequest(),
      directorySelection: {
        kind: "directory",
        selectedPath: "/Other",
        effectiveRoot: "/Other",
      },
    });
  });

  it("requires a category selection to identify its one matching launch group", () => {
    const selectedGroup = group();
    const selection: CloudDirectorySelection = {
      kind: "category",
      selectedPath: `/Synthetic/library/${selectedGroup.rootRelativePath}`,
      effectiveRoot: "/Synthetic/library",
      groupKey: selectedGroup.groupKey,
    };

    expect(validateVerificationLaunchRequest({
      ...startRequest([selectedGroup]),
      directorySelection: selection,
    }, validateCloudDirectorySelection)).toEqual({
      ...startRequest([selectedGroup]),
      directorySelection: selection,
    });
    invalid({
      ...startRequest([selectedGroup, group(1)]),
      directorySelection: selection,
    });
    invalid({
      ...startRequest([group(1)]),
      directorySelection: selection,
    });
  });

  it("rejects a forged directory selection on resume without invoking a validator", () => {
    const validator = vi.fn(validateCloudDirectorySelection);
    const forged = {
      ...resumeRequest(),
      directorySelection: {
        kind: "directory",
        selectedPath: "/Synthetic/library",
        effectiveRoot: "/Synthetic/library",
      },
    } as unknown as VerificationLaunchRequest;

    invalid(forged, validator);
    expect(validator).not.toHaveBeenCalled();
  });

  it("returns whitelisted detached groups and selection", () => {
    const mutableGroup = {
      ...group(),
      fsId: "must-not-escape",
    };
    const mutableSelection = {
      kind: "directory" as const,
      selectedPath: "/Synthetic/library",
      effectiveRoot: "/Synthetic/library",
      accountId: "must-not-escape",
    };
    const validator: VerificationLaunchSelectionValidator = (selection) => selection;
    const input = {
      kind: "start" as const,
      cloudRoot: "/Synthetic/library",
      groups: [mutableGroup],
      directorySelection: mutableSelection,
      accessToken: "must-not-escape",
    };

    const result = validateVerificationLaunchRequest(input, validator);
    mutableGroup.label = "Changed";
    mutableSelection.selectedPath = "/Changed";

    expect(result).toEqual({
      kind: "start",
      cloudRoot: "/Synthetic/library",
      groups: [group()],
      directorySelection: {
        kind: "directory",
        selectedPath: "/Synthetic/library",
        effectiveRoot: "/Synthetic/library",
      },
    });
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
    if (result.kind !== "start") throw new Error("expected start request");
    expect(result.directorySelection).not.toBe(mutableSelection);
  });
});
