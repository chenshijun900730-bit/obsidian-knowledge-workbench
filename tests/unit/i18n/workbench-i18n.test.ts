import { describe, expect, it } from "vitest";
import {
  createWorkbenchI18n,
  isWorkbenchLocale,
  WORKBENCH_LOCALES,
} from "../../../src/i18n/workbench-i18n";

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
});
