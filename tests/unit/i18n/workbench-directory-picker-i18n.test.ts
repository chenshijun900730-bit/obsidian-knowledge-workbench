import { describe, expect, it } from "vitest";
import { createDirectoryPickerI18n } from "../../../src/i18n/workbench-directory-picker-i18n";

const placeholders = (value: string): readonly string[] => (
  [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/gu)].map((match) => match[1]!).sort()
);

describe("workbench directory picker i18n", () => {
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
});
