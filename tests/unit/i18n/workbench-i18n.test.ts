import { describe, expect, it } from "vitest";
import {
  createWorkbenchI18n,
  isWorkbenchLocale,
  WORKBENCH_LOCALES,
  type WorkbenchMessageKey,
} from "../../../src/i18n/workbench-i18n";
import { createDirectoryPickerI18n } from "../../../src/i18n/workbench-directory-picker-i18n";

describe("workbench i18n", () => {
  it("supports exactly Simplified Chinese and English", () => {
    expect(WORKBENCH_LOCALES).toEqual(["zh-CN", "en"]);
    expect(isWorkbenchLocale("zh-CN")).toBe(true);
    expect(isWorkbenchLocale("en")).toBe(true);
    expect(isWorkbenchLocale("zh")).toBe(false);
  });

  it("formats translated navigation and counts", () => {
    const zh = createWorkbenchI18n("zh-CN");
    const en = createWorkbenchI18n("en");
    expect(zh.t("nav.catalog")).toBe("我的目录");
    expect(en.t("nav.catalog")).toBe("My catalog");
    expect(zh.t("catalog.pdfCount", { count: zh.number(68_959) }))
      .toBe("68,959 本 PDF");
    expect(en.t("catalog.pdfCount", { count: en.number(68_959) }))
      .toBe("68,959 PDFs");
  });

  it("rejects missing interpolation values", () => {
    expect(() => createWorkbenchI18n("zh-CN").t("catalog.pdfCount"))
      .toThrow("i18n-interpolation-missing:count");
  });

  it("provides symmetric directory-picker sources, ARIA, conflicts, and lookup budgets", () => {
    const zh = createDirectoryPickerI18n("zh-CN");
    const en = createDirectoryPickerI18n("en");

    expect(zh.t("directoryPicker.filters.recent")).toBe("最近使用");
    expect(en.t("directoryPicker.filters.recent")).toBe("Recent");
    expect(zh.t("directoryPicker.aria.results")).toBe("目录候选");
    expect(en.t("directoryPicker.aria.results")).toBe("Directory candidates");
    expect(zh.t("directoryPicker.result.conflict")).toContain("目录身份冲突");
    expect(en.t("directoryPicker.result.conflict")).toContain("identity conflict");
    expect(zh.t("directoryPicker.lookup.confirmation.budget", {
      directories: 500,
      requests: 50,
      seconds: 120,
    })).toContain("120 秒");
    expect(en.t("directoryPicker.lookup.confirmation.budget", {
      directories: 500,
      requests: 50,
      seconds: 120,
    })).toContain("120 seconds");
  });

  it("provides paired Chinese and English verification progress messages", () => {
    const zh = createWorkbenchI18n("zh-CN");
    const en = createWorkbenchI18n("en");
    const params = {
      percent: "17.2",
      covered: "11,870",
      total: "68,959",
      completed: "7",
      groups: "24",
      label: "文学",
      segment: "2",
      current: "2",
      maximum: "12",
      cumulative: "427",
      minutes: "30",
      count: "8",
      reason: "—",
    };
    const messages: readonly [WorkbenchMessageKey, string, string][] = [
      ["verification.action.pause", "暂停核验", "Pause verification"],
      ["verification.progress.overall.title", "全库核验覆盖率", "Whole-library verification coverage"],
      ["verification.progress.overall.value", "17.2% · 11,870 / 68,959 个候选项 · 7 / 24 个分类", "17.2% · 11,870 / 68,959 candidates · 7 / 24 categories"],
      ["verification.progress.current.title", "正在核验：文学 · 第 2 段", "Verifying 文学 · segment 2"],
      ["verification.progress.current.unknown", "云端总量尚未知，正在递归发现目录", "Cloud total is unknown while directories are still being discovered."],
      ["verification.progress.current.aria", "当前分类核验活动；云端总量未知", "Current category verification activity; cloud total unknown"],
      ["verification.progress.segment.title", "本段安全配额", "This segment's safety quota"],
      ["verification.progress.segment.value", "2 / 12 个 PDF；这是安全配额，不是完成度。", "2 / 12 PDFs; this is a safety quota, not completion."],
      ["verification.auto.inactive", "当前未自动续跑。", "Automatic continuation is not active."],
      ["verification.auto.running", "正在自动续跑 · 第 2 / 12 段", "Automatic continuation is running · segment 2 / 12"],
      ["verification.auto.next", "检查点已保存，正在开始下一段。", "Checkpoint saved; starting the next segment."],
      ["verification.auto.noProgress", "因没有持久进展，已停止自动续跑。", "Automatic continuation stopped because no durable progress was made."],
      ["verification.auto.limit", "已达到 12 段自动续跑安全上限。", "Automatic continuation stopped at the 12-segment safety limit."],
      ["verification.details.title", "运行详情", "Run details"],
      ["verification.details.segment", "自动片段", "Automatic segment"],
      ["verification.details.segmentValue", "2 / 12", "2 / 12"],
      ["verification.details.requests", "列表请求", "List requests"],
      ["verification.details.requestsValue", "本段 2 / 12 · 累计 427", "2 / 12 this segment · 427 cumulative"],
      ["verification.details.segmentPdfs", "本段 PDF", "PDFs in this segment"],
      ["verification.details.segmentDirectories", "本段发现目录", "Directories discovered in this segment"],
      ["verification.details.segmentDirectoriesValue", "2 / 12", "2 / 12"],
      ["verification.details.timeBudget", "时间预算", "Time budget"],
      ["verification.details.timeBudgetValue", "每段 30 分钟", "30 minutes per segment"],
      ["verification.details.ignored", "本段忽略文件", "Ignored files in this segment"],
      ["verification.details.committedPdfs", "批次累计已提交 PDF", "Committed PDFs in this batch"],
      ["verification.details.pages", "已提交页面", "Committed pages"],
      ["verification.details.directories", "已完成目录", "Completed directories"],
      ["verification.details.queue", "待处理目录队列", "Pending directory queue"],
      ["verification.details.groups", "已完成 / 已选择分类", "Completed / selected categories"],
      ["verification.details.stop", "停止原因", "Stop reason"],
      ["verification.details.checkpoint", "检查点状态", "Checkpoint state"],
      ["verification.details.checkpointSaved", "已保存", "Saved"],
      ["settings.surface.batchQueue", "待处理目录队列：8", "Pending directory queue: 8"],
      ["settings.surface.batchStop", "停止原因：—", "Stop reason: —"],
    ];

    for (const [key, expectedZh, expectedEn] of messages) {
      expect(zh.t(key, params), `${key} zh-CN`).toBe(expectedZh);
      expect(en.t(key, params), `${key} en`).toBe(expectedEn);
    }
  });
});
