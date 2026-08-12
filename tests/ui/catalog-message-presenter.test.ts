import { describe, expect, it } from "vitest";
import { createWorkbenchI18n } from "../../src/i18n/workbench-i18n";
import { presentCatalogMessage } from "../../src/ui/catalog-message-presenter";

describe("catalog message presenter", () => {
  it("presents a safe cause, preservation statement, and next action for a missing Baidu path", () => {
    const privateFailure = {
      message: "secret-token /private/customer/library",
      credentials: { accessToken: "private-access-token" },
    };
    const result = Reflect.apply(presentCatalogMessage, null, [
      "baidu-not-found",
      createWorkbenchI18n("zh-CN"),
      privateFailure,
    ]) as ReturnType<typeof presentCatalogMessage>;

    expect(result.title).toContain("路径不存在");
    expect(result.preservation).toContain("本地目录");
    expect(result.nextAction).toContain("父目录");
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain("private-access-token");
    expect(JSON.stringify(result)).not.toContain("/private/customer/library");
  });

  it("maps authorization and local validation codes without accepting arbitrary text", () => {
    const i18n = createWorkbenchI18n("zh-CN");

    const credentials = presentCatalogMessage("credentials-unavailable", i18n);
    expect(credentials.title).toContain("凭据");
    expect(credentials.nextAction).toContain("设置");
    const invalidRoot = presentCatalogMessage("invalid-large-catalog-root", i18n);
    expect(invalidRoot.title).toContain("父目录");
    expect(invalidRoot.nextAction).toContain("修正父目录格式后重试");
    expect(presentCatalogMessage("verification-group-required", i18n).title)
      .toContain("分类");
    const mismatch = presentCatalogMessage("hybrid-cloud-root-mismatch", i18n);
    expect(mismatch.title).toContain("恢复根目录不匹配");
    expect(mismatch.nextAction).toContain("修改候选父目录后再次恢复");
    expect(mismatch.nextAction).not.toContain("开始新的核验");
    const corrupt = presentCatalogMessage("hybrid-batch-invalid", i18n);
    expect(corrupt.title).toContain("检查点不可用");
    expect(corrupt.nextAction).toContain("开始新的核验");
    expect(corrupt.nextAction).not.toContain("修改候选父目录");
  });
});
