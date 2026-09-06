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
    expect([
      zh.t("nav.library"), zh.t("nav.task"), zh.t("nav.more"),
    ]).toEqual(["文库", "任务", "更多"]);
    expect([
      en.t("nav.library"), en.t("nav.task"), en.t("nav.more"),
    ]).toEqual(["Library", "Task", "More"]);
    // Keep legacy navigation keys until the final cleanup proves that no callers remain.
    expect(zh.t("nav.catalog")).toBe("我的目录");
    expect(en.t("nav.catalog")).toBe("My catalog");
    expect(zh.t("catalog.pdfCount", { count: zh.number(68_959) }))
      .toBe("68,959 本 PDF");
    expect(en.t("catalog.pdfCount", { count: en.number(68_959) }))
      .toBe("68,959 PDFs");
  });

  it("provides paired concise library-page copy", () => {
    const zh = createWorkbenchI18n("zh-CN");
    const en = createWorkbenchI18n("en");
    const messages: readonly [WorkbenchMessageKey, string, string][] = [
      ["library.title", "在文库里找书", "Find a book in your library"],
      ["library.boundary", "只搜索文件名和目录信息，不下载 PDF。", "Searches filenames and directory information only. PDFs are not downloaded."],
      ["library.taskReminder.title", "有一项文库任务需要处理", "A library task needs attention"],
      ["library.taskReminder.action", "打开任务", "Open task"],
      ["library.recent.title", "最近查看", "Recently viewed"],
      ["library.recent.directory", "目录：合成目录", "Directory: 合成目录"],
      ["library.recent.aria", "最近查看的图书", "Recently viewed books"],
    ];

    for (const [key, expectedZh, expectedEn] of messages) {
      expect(zh.t(key, { directory: "合成目录" }), `${key} zh-CN`).toBe(expectedZh);
      expect(en.t(key, { directory: "合成目录" }), `${key} en`).toBe(expectedEn);
    }
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

  it("provides paired titles and descriptions for every library workflow state", () => {
    const zh = createWorkbenchI18n("zh-CN");
    const en = createWorkbenchI18n("en");
    const messages: readonly [WorkbenchMessageKey, string, string][] = [
      ["workflow.needsTxt.title", "选择目录数据", "Choose catalog data"],
      ["workflow.needsTxt.description", "请选择目录 TXT；不会扫描本机其他文件。", "Choose a catalog TXT file. Other local files will not be scanned."],
      ["workflow.confirmTxtImport.title", "确认新的目录数据", "Confirm new catalog data"],
      ["workflow.confirmTxtImport.description", "导入前，旧活动目录保持可用。", "The current catalog remains available until import completes."],
      ["workflow.needsConnection.title", "连接百度网盘", "Connect Baidu Netdisk"],
      ["workflow.needsConnection.description", "AppKey、SecretKey 和授权码仍由你在本地输入。", "Enter the AppKey, SecretKey, and authorization code locally."],
      ["workflow.needsLibrary.title", "选择科学文库文件夹", "Choose the science library folder"],
      ["workflow.needsLibrary.description", "请准确选择一次书库位置；不会从最近目录自动猜测。", "Choose the exact library location once. Recent folders are never used to guess it."],
      ["workflow.ready.title", "检查推荐分类", "Check the recommended category"],
      ["workflow.ready.description", "只读取目录信息，不下载 PDF，不修改笔记。", "Only directory metadata is read. PDFs are not downloaded and notes are not changed."],
      ["workflow.running.title", "正在检查当前分类", "Checking the current category"],
      ["workflow.running.description", "完整提交的进度会持续保存。", "Durably committed progress is saved continuously."],
      ["workflow.paused.title", "进度已保存", "Progress saved"],
      ["workflow.paused.description", "可以从已保存的位置继续检查。", "Continue checking from the saved position."],
      ["workflow.repairConnection.title", "请重新连接百度网盘", "Reconnect Baidu Netdisk"],
      ["workflow.repairConnection.description", "本地搜索和旧核验结果继续可用。", "Local search and prior verification results remain available."],
      ["workflow.repairLibrary.title", "请重新选择书库", "Choose the library again"],
      ["workflow.repairLibrary.description", "现有活动目录保持不变，不使用手工 API 路径恢复。", "The active catalog remains unchanged. Recovery does not use a manually entered API path."],
      ["workflow.retryLater.title", "任务已安全停止", "Task stopped safely"],
      ["workflow.retryLater.description", "检查点已保存；请稍后继续。", "The checkpoint is saved. Continue later."],
      ["workflow.complete.title", "文库检查完成", "Library check complete"],
      ["workflow.complete.description", "可以返回文库继续搜索。", "Return to the library and continue searching."],
      ["workflow.unavailable.title", "当前版本不提供云端检查", "Cloud checking is unavailable in this build"],
      ["workflow.unavailable.description", "本地文库仍可使用。", "The local library remains available."],
    ];

    for (const [key, expectedZh, expectedEn] of messages) {
      expect(zh.t(key), `${key} zh-CN`).toBe(expectedZh);
      expect(en.t(key), `${key} en`).toBe(expectedEn);
    }
  });

  it("provides fixed bilingual TXT and cloud-authority guidance", () => {
    const zh = createWorkbenchI18n("zh-CN");
    const en = createWorkbenchI18n("en");
    const messages: readonly [WorkbenchMessageKey, string, string][] = [
      ["task.txtContentUnchanged", "目录 TXT 内容没有变化，已保留当前书库绑定。", "The catalog TXT content is unchanged; the current library binding was preserved."],
      ["task.txtImportFailed", "目录 TXT 未导入；现有目录保持不变。", "The catalog TXT was not imported; the current catalog remains unchanged."],
      ["cloudAuthority.repairSameAccount", "请使用原来的百度账号重新授权；如需更换账号，请使用“更换账号”。", "Reconnect with the original Baidu account. To use another account, choose Replace account."],
      ["cloudAuthority.replaceIdentity", "更换账号或凭据后，需要重新选择书库；旧核验结果仅保留为历史。", "After replacing the account or credentials, choose the library again; prior verification results remain history only."],
      ["cloudAuthority.verificationMustPause", "请先暂停当前核验，再执行此操作。", "Pause the current verification before this action."],
      ["cloudAuthority.scanMustCancel", "请先取消当前云端扫描，再执行此操作。", "Cancel the current cloud scan before this action."],
      ["cloudAuthority.operationBusy", "另一项云端安全操作正在进行；请等待完成后重试。", "Another cloud-authority operation is in progress. Try again after it finishes."],
      ["cloudAuthority.authorizationAttemptUnavailable", "本次授权已失效，请从对应的重新连接或更换账号操作重新开始。", "This authorization attempt is no longer valid. Restart the matching reconnect or replace-account action."],
      ["settings.surface.repairSameAccount", "重新连接原账号（请使用原来的百度账号）", "Reconnect the original account (use the original Baidu account)"],
      ["settings.surface.replaceIdentity", "更换账号或 AppKey/SecretKey", "Replace account or AppKey/SecretKey"],
      ["settings.error.verificationMustPause", "请先暂停当前核验，再修改百度网盘授权。", "Pause the current verification before changing Baidu Netdisk authorization."],
      ["settings.error.scanMustCancel", "请先取消当前云端扫描，再修改百度网盘授权。", "Cancel the current cloud scan before changing Baidu Netdisk authorization."],
      ["settings.error.cloudAuthorityBusy", "另一项百度网盘权限操作正在进行，请稍后再试。", "Another Baidu Netdisk authority operation is in progress. Try again later."],
    ];

    for (const [key, expectedZh, expectedEn] of messages) {
      expect(zh.t(key), `${key} zh-CN`).toBe(expectedZh);
      expect(en.t(key), `${key} en`).toBe(expectedEn);
    }
  });
});
