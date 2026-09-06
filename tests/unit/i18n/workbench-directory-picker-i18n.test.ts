import { describe, expect, it } from "vitest";
import { createDirectoryPickerI18n } from "../../../src/i18n/workbench-directory-picker-i18n";

const placeholders = (value: string): readonly string[] => (
  [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/gu)].map((match) => match[1]!).sort()
);
const MAIN_FLOW_TECHNICAL_TERMS = /API\s*(?:父目录|parent)|运行片段|\bsegment\b|列表请求|list\s+request|检查点|\bcheckpoint\b/iu;

describe("workbench directory picker i18n", () => {
  it("reports recent-folder persistence failure as a fail-closed selection", () => {
    const zh = createDirectoryPickerI18n("zh-CN");
    const en = createDirectoryPickerI18n("en");

    expect(zh.t("directoryPicker.notice.persistenceFailure")).toBe(
      "最近目录保存失败，因此未应用本次选择；请重试或取消。",
    );
    expect(en.t("directoryPicker.notice.persistenceFailure")).toBe(
      "Saving to Recent failed, so this selection was not applied. Retry or cancel.",
    );
  });

  it("provides paired browse, progress, recovery, and safety messages", () => {
    const zh = createDirectoryPickerI18n("zh-CN");
    const en = createDirectoryPickerI18n("en");
    const samples = [
      ["directoryPicker.browser.rootDisclosure.title", [], "根目录", "root"],
      ["directoryPicker.browser.currentPath", ["path"], "当前路径", "Current path"],
      ["directoryPicker.browser.details.title", [], "运行详情", "Run details"],
      ["directoryPicker.browser.progress.checked", ["checked", "maximum"], "已检查", "Checked"],
      ["directoryPicker.browser.progress.cumulativeChecked", ["checked"], "累计已检查", "Cumulative"],
      ["directoryPicker.browser.progress.requests", ["round", "cumulative"], "列表请求", "List requests"],
      ["directoryPicker.browser.progress.cursor", ["cursor"], "游标", "cursor"],
      ["directoryPicker.browser.stop.entryLimit", [], "条目上限", "entry limit"],
      ["directoryPicker.browser.error.fixed", [], "暂时不可用", "temporarily unavailable"],
      ["directoryPicker.browser.rootNotSelectable", [], "不能选择", "cannot be selected"],
    ] as const;
    for (const [key, names, zhText, enText] of samples) {
      const values = Object.fromEntries(names.map((name) => [name, 1]));
      const zhValue = zh.t(key, values);
      const enValue = en.t(key, values);
      expect(zhValue).toContain(zhText);
      expect(enValue).toContain(enText);
      expect(placeholders(zhValue)).toEqual(placeholders(enValue));
    }
  });

  it("provides paired inline folder-selection and legacy-progress messages", () => {
    const zh = createDirectoryPickerI18n("zh-CN");
    const en = createDirectoryPickerI18n("en");
    const samples = [
      ["folderSelection.title", "选择书库文件夹", "Choose a library folder"],
      ["folderSelection.browseOther", "浏览其他文件夹", "Browse other folders"],
      ["folderSelection.advanced", "更多查找方式", "More ways to find folders"],
      ["folderSelection.willPreserve", "将尝试保留已有核验进度。", "Existing verification progress will be preserved when possible."],
      ["folderSelection.preserved", "已保留已有核验进度。", "Existing verification progress was preserved."],
      ["folderSelection.requiresFresh", "此目录需要重新检查。", "This folder requires a fresh verification."],
      ["folderSelection.useFresh", "使用此文件夹并重新检查", "Use this folder and verify again"],
      ["folderSelection.bindingFailed", "未能使用这个文件夹，请重试。", "Could not use this folder. Please try again."],
      ["folderSelection.selectionInvalid", "这个选择已失效，请重新选择。", "This selection is no longer available. Choose it again."],
      ["folderSelection.queryRequired", "请先输入文件夹名称。", "Enter a folder name first."],
    ] as const;
    for (const [key, zhText, enText] of samples) {
      expect(zh.t(key)).toBe(zhText);
      expect(en.t(key)).toBe(enText);
    }
  });

  it("provides paired fixed lookup summaries including elapsed time", () => {
    const zh = createDirectoryPickerI18n("zh-CN");
    const en = createDirectoryPickerI18n("en");
    const values = {
      reason: "limit",
      directories: 12,
      matches: 3,
      requests: 4,
      milliseconds: 500,
    };
    for (const key of [
      "folderSelection.lookup.complete",
      "folderSelection.lookup.partial",
      "folderSelection.lookup.canceled",
    ] as const) {
      const zhValue = zh.t(key, values);
      const enValue = en.t(key, values);
      expect(zhValue).toContain("500");
      expect(enValue).toContain("500");
      expect(placeholders(zhValue)).toEqual(placeholders(enValue));
    }
  });

  it("keeps the simple folder-selection flow bilingual and non-technical", () => {
    const zh = createDirectoryPickerI18n("zh-CN");
    const en = createDirectoryPickerI18n("en");
    const keys = [
      "folderSelection.title", "folderSelection.browseOther", "folderSelection.advanced",
      "directoryPicker.query.label", "directoryPicker.use", "directoryPicker.selected.title",
    ] as const;
    for (const key of keys) {
      expect(zh.t(key), `${key} zh-CN`).not.toMatch(MAIN_FLOW_TECHNICAL_TERMS);
      expect(en.t(key), `${key} en`).not.toMatch(MAIN_FLOW_TECHNICAL_TERMS);
    }
  });
});
