// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS } from "../../src/catalog/hybrid-catalog-types";
import { createWorkbenchI18n, type WorkbenchLocale } from "../../src/i18n/workbench-i18n";
import {
  renderVerificationProgress,
  type VerificationProgressModel,
} from "../../src/ui/verification-progress";

const progressModel = (locale: WorkbenchLocale): VerificationProgressModel => ({
  active: {
    importedAt: 1,
    pdfCount: 68_959,
    coveredCandidatePdfCount: 11_870,
    unverifiedCount: 57_089,
    verifiedCount: 10_000,
    differenceCount: 1_870,
    cloudMissingCount: 0,
    groupCount: 24,
    verifiedGroupCount: 7,
    groups: [],
  },
  batch: {
    batchId: "batch-progress",
    status: "scanning",
    stopReason: null,
    resumeAvailable: false,
    runOrdinal: 2,
    selectedGroupCount: 1,
    completedGroupCount: 0,
    remainingGroupCount: 1,
    currentGroupIndex: 0,
    currentGroupKey: `group:${"1".repeat(64)}`,
    pdfCount: 9_500,
    directoryCount: 120,
    ignoredFileCount: 3,
    listRequestCount: 27,
    cumulativeListRequestCount: 427,
    committedPdfCount: 11_870,
    committedPageCount: 14,
    completedDirectoryCount: 112,
    pendingDirectoryCount: 8,
    autoResumeState: "running",
    autoSegmentIndex: 2,
    autoSegmentLimit: LARGE_CATALOG_AUTO_CHAIN_MAX_SEGMENTS,
  },
  busy: true,
  currentGroupLabel: locale === "zh-CN" ? "文学" : "Literature",
  detailsOpen: false,
  i18n: createWorkbenchI18n(locale),
});

const render = (model: VerificationProgressModel): HTMLDivElement => {
  const root = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as HTMLDivElement;
  root.append(renderVerificationProgress(document, model));
  return root;
};

describe("verification progress", () => {
  it.each([
    ["zh-CN", "云端总量尚未知", "本段安全配额"],
    ["en", "Cloud total is unknown", "This segment's safety quota"],
  ] as const)("renders truthful progress semantics in %s", (locale, unknownText, quotaText) => {
    const root = render(progressModel(locale));
    expect(root.querySelector<HTMLProgressElement>(
      "[data-verification-overall-progress]",
    )?.value).toBe(11_870);
    expect(root.querySelector<HTMLProgressElement>(
      "[data-verification-overall-progress]",
    )?.max).toBe(68_959);

    const current = root.querySelector<HTMLElement>("[data-verification-current-progress]")!;
    expect(current.getAttribute("role")).toBe("progressbar");
    expect(current.hasAttribute("aria-valuenow")).toBe(false);
    expect(current.hasAttribute("aria-valuemax")).toBe(false);
    expect(root.textContent).toContain(unknownText);

    const segment = root.querySelector<HTMLProgressElement>(
      "[data-verification-segment-budget]",
    )!;
    expect(segment.value).toBe(9_500);
    expect(segment.max).toBe(10_000);
    expect(root.textContent).toContain(quotaText);

    const details = root.querySelector<HTMLDetailsElement>(
      "details[data-verification-run-details]",
    )!;
    expect(details.open).toBe(false);
    expect(details.querySelector("[data-verification-run-requests]")?.textContent)
      .toContain("427");
    expect(details.querySelector("[data-verification-run-queue]")?.textContent)
      .toContain("8");
  });

  it("clamps invalid coverage without rendering fake numbers", () => {
    const base = progressModel("en");
    const root = render({
      ...base,
      active: { ...base.active, pdfCount: 0, coveredCandidatePdfCount: 99 },
    });
    const progress = root.querySelector<HTMLProgressElement>(
      "[data-verification-overall-progress]",
    )!;
    expect(progress.value).toBe(0);
    expect(progress.value).toBeLessThanOrEqual(progress.max);
    expect(root.textContent).not.toMatch(/NaN|Infinity|-\d/u);
  });
});
