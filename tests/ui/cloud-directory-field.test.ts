// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createWorkbenchI18n } from "../../src/i18n/workbench-i18n";
import { createCloudDirectoryField } from "../../src/ui/cloud-directory-field";

const validRoot = (value: string): string => {
  const normalized = value.normalize("NFC");
  if (!normalized.startsWith("/") || normalized === "/" || normalized.includes("//")) {
    throw new Error("invalid-root");
  }
  return normalized;
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("cloud directory field", () => {
  it("renders an empty current card and fills it only after an explicit choice", async () => {
    const onManualChange = vi.fn();
    const onChoose = vi.fn(async () => "/Synthetic/Library/Science");
    const field = createCloudDirectoryField(document, createWorkbenchI18n("zh-CN"), {
      path: "",
      disabled: false,
      locked: false,
    }, {
      onChoose,
      onManualChange,
      onValidate: validRoot,
    });

    expect(field.root.textContent).toContain("当前目录");
    expect(field.root.textContent).toContain("尚未选择目录");
    expect(field.root.textContent).toContain("最近目录会保存在本机插件设置中");
    expect(field.chooseButton.textContent).toBe("选择目录");
    expect(field.root.querySelector<HTMLDetailsElement>("details")?.open).toBe(false);
    expect(field.valid()).toBe(false);

    field.chooseButton.click();
    await flush();

    expect(onChoose).toHaveBeenCalledOnce();
    expect(onManualChange).toHaveBeenCalledWith("/Synthetic/Library/Science");
    expect(field.root.querySelector('[data-cloud-directory-name="true"]')?.textContent)
      .toBe("Science");
    expect(field.root.querySelector('[data-cloud-directory-path="true"]')?.textContent)
      .toBe("/Synthetic/Library/Science");
    expect(field.root.textContent).toContain("本次会话已选择");
    expect(field.valid()).toBe(true);
  });

  it("keeps the prior draft when the chooser is canceled", async () => {
    const onManualChange = vi.fn();
    const field = createCloudDirectoryField(document, createWorkbenchI18n("zh-CN"), {
      path: "/Synthetic/Existing",
      disabled: false,
      locked: false,
    }, {
      onChoose: async () => null,
      onManualChange,
      onValidate: validRoot,
    });

    field.chooseButton.click();
    await flush();

    expect(onManualChange).not.toHaveBeenCalled();
    expect(field.manualInput.value).toBe("/Synthetic/Existing");
    expect(field.root.textContent).toContain("/Synthetic/Existing");
  });

  it("locally rejects blank, root, and malformed drafts while accepting a non-root path", () => {
    const onManualChange = vi.fn();
    const field = createCloudDirectoryField(document, createWorkbenchI18n("zh-CN"), {
      path: "",
      disabled: false,
      locked: false,
    }, {
      onChoose: async () => null,
      onManualChange,
      onValidate: validRoot,
    });

    for (const value of ["", "/", "relative", "/Synthetic//Science"]) {
      field.setPath(value);
      expect(field.valid()).toBe(false);
    }
    field.manualInput.value = "/Synthetic/Science";
    field.manualInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onManualChange).toHaveBeenLastCalledWith("/Synthetic/Science");
    expect(field.valid()).toBe(true);
    expect(field.root.textContent).toContain("路径格式有效");
  });

  it.each([
    [{ disabled: true, locked: false }, "disabled"],
    [{ disabled: false, locked: true }, "locked"],
  ] as const)("disables choosing and manual editing when %s", (state, _label) => {
    const onChoose = vi.fn(async () => "/Synthetic/New");
    const onManualChange = vi.fn();
    const field = createCloudDirectoryField(document, createWorkbenchI18n("en"), {
      path: "/Synthetic/Existing",
      ...state,
    }, { onChoose, onManualChange, onValidate: validRoot });

    expect(field.chooseButton.disabled).toBe(true);
    expect(field.manualInput.disabled).toBe(true);
    field.chooseButton.click();
    field.manualInput.value = "/Synthetic/Changed";
    field.manualInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onChoose).not.toHaveBeenCalled();
    expect(onManualChange).not.toHaveBeenCalled();
  });

  it("ignores a late chooser result after disposal", async () => {
    let resolveChoice!: (value: string | null) => void;
    const onManualChange = vi.fn();
    const field = createCloudDirectoryField(document, createWorkbenchI18n("en"), {
      path: "/Synthetic/Existing",
      disabled: false,
      locked: false,
    }, {
      onChoose: async () => new Promise((resolve) => { resolveChoice = resolve; }),
      onManualChange,
      onValidate: validRoot,
    });

    field.chooseButton.click();
    field.dispose();
    resolveChoice("/Synthetic/Late");
    await flush();

    expect(onManualChange).not.toHaveBeenCalled();
    expect(field.manualInput.value).toBe("");
  });

  it("invalidates an in-flight chooser when the host becomes busy and preserves the draft", async () => {
    let resolveChoice!: (value: string | null) => void;
    const onManualChange = vi.fn();
    const field = createCloudDirectoryField(document, createWorkbenchI18n("en"), {
      path: "/Synthetic/Existing",
      disabled: false,
      locked: false,
    }, {
      onChoose: async () => new Promise((resolve) => { resolveChoice = resolve; }),
      onManualChange,
      onValidate: validRoot,
    });

    field.chooseButton.click();
    field.updateState({ disabled: true, locked: false });
    resolveChoice("/Synthetic/Late");
    await flush();

    expect(onManualChange).not.toHaveBeenCalled();
    expect(field.manualInput.value).toBe("/Synthetic/Existing");
    expect(field.chooseButton.disabled).toBe(true);

    field.updateState({ disabled: false, locked: false });
    expect(field.manualInput.value).toBe("/Synthetic/Existing");
    expect(field.chooseButton.disabled).toBe(false);
  });

  it("shows a fixed localized error and keeps the draft when a chooser rejects", async () => {
    const onManualChange = vi.fn();
    const field = createCloudDirectoryField(document, createWorkbenchI18n("zh-CN"), {
      path: "/Synthetic/Existing",
      disabled: false,
      locked: false,
    }, {
      onChoose: async () => { throw new Error("raw transport detail"); },
      onManualChange,
      onValidate: validRoot,
    });

    field.chooseButton.click();
    await flush();

    expect(onManualChange).not.toHaveBeenCalled();
    expect(field.manualInput.value).toBe("/Synthetic/Existing");
    expect(field.root.textContent).toContain("目录未改变");
    expect(field.root.textContent).not.toContain("raw transport detail");
  });

  it("recovers from a synchronous chooser failure without leaking its details", async () => {
    const field = createCloudDirectoryField(document, createWorkbenchI18n("en"), {
      path: "/Synthetic/Existing",
      disabled: false,
      locked: false,
    }, {
      onChoose: () => { throw new Error("synchronous private detail"); },
      onManualChange: vi.fn(),
      onValidate: validRoot,
    });

    expect(() => field.chooseButton.click()).not.toThrow();
    await flush();

    expect(field.chooseButton.disabled).toBe(false);
    expect(field.root.textContent).toContain("The directory was not changed");
    expect(field.root.textContent).not.toContain("synchronous private detail");
  });

  it("invalidates an in-flight chooser when the host replaces the draft", async () => {
    let resolveChoice!: (value: string | null) => void;
    const onManualChange = vi.fn();
    const field = createCloudDirectoryField(document, createWorkbenchI18n("en"), {
      path: "/Synthetic/Existing",
      disabled: false,
      locked: false,
    }, {
      onChoose: async () => new Promise((resolve) => { resolveChoice = resolve; }),
      onManualChange,
      onValidate: validRoot,
    });

    field.chooseButton.click();
    field.setPath("/Synthetic/HostReplacement");
    resolveChoice("/Synthetic/Late");
    await flush();

    expect(onManualChange).not.toHaveBeenCalled();
    expect(field.manualInput.value).toBe("/Synthetic/HostReplacement");
    expect(field.root.textContent).not.toContain("/Synthetic/Late");
  });

  it("connects the card and validation state to accessible field semantics", () => {
    const field = createCloudDirectoryField(document, createWorkbenchI18n("en"), {
      path: "relative",
      disabled: false,
      locked: false,
    }, {
      onChoose: async () => null,
      onManualChange: vi.fn(),
      onValidate: validRoot,
    });
    const card = field.root.querySelector<HTMLElement>('[data-cloud-directory-current="true"]')!;
    const validation = field.root.querySelector<HTMLElement>(
      '[data-cloud-directory-validation="true"]',
    )!;

    expect(card.getAttribute("aria-labelledby")).toBeTruthy();
    expect(field.root.querySelector(`#${card.getAttribute("aria-labelledby")!}`)).not.toBeNull();
    expect(field.manualInput.getAttribute("aria-describedby")).toBe(validation.id);
    expect(field.manualInput.getAttribute("aria-invalid")).toBe("true");

    field.setPath("/Synthetic/Valid");
    expect(field.manualInput.getAttribute("aria-invalid")).toBe("false");

    field.updateState({ disabled: false, locked: true });
    const lockedId = field.chooseButton.getAttribute("aria-describedby")!;
    expect(field.root.querySelector(`#${lockedId}`)?.textContent)
      .toBe("This directory is locked for the current operation.");
    expect(field.manualInput.getAttribute("aria-describedby")?.split(" ")).toContain(lockedId);

    const second = createCloudDirectoryField(document, createWorkbenchI18n("zh-CN"), {
      path: "/Synthetic/Second",
      disabled: false,
      locked: false,
    }, {
      onChoose: async () => null,
      onManualChange: vi.fn(),
      onValidate: validRoot,
    });
    expect(second.root.querySelector('[data-cloud-directory-current="true"]')
      ?.getAttribute("aria-labelledby")).not.toBe(card.getAttribute("aria-labelledby"));
  });

  it("keeps long paths and actions usable at 320 pixels with Obsidian tokens", async () => {
    const css = await readFile("styles.css", "utf8");

    expect(css).toMatch(/\.knowledge-workbench__directory-field-path\s*\{[^}]*overflow-wrap:\s*anywhere;/u);
    expect(css).toMatch(
      /@container\s+knowledge-workbench\s*\(max-width:\s*22\.5rem\)[\s\S]*\.knowledge-workbench__directory-field-actions/u,
    );
    expect(css).toContain("var(--background-secondary)");
  });
});
