// @vitest-environment jsdom
import type { App } from "obsidian";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CloudDirectoryCandidate,
  CloudDirectoryCandidateRuntime,
} from "../../src/catalog/cloud-directory-candidates";
import {
  CLOUD_DIRECTORY_LOCATOR_BUDGET,
  type CloudDirectoryLocatorRuntime,
  type CloudDirectoryLocatorSummary,
  type CloudDirectoryLocatorStopReason,
} from "../../src/catalog/cloud-directory-locator";
import { createWorkbenchI18n, type WorkbenchLocale } from "../../src/i18n/workbench-i18n";
import {
  createCloudDirectoryPickerModalClass,
  type CloudDirectoryPickerModalConstructor,
} from "../../src/ui/cloud-directory-picker";

class ModalSurface {
  readonly contentEl = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as HTMLDivElement;
  title = "";
  closeCalls = 0;
  constructor(readonly app: App) {}
  setTitle(value: string): void { this.title = value; }
  open(): void {
    document.body.append(this.contentEl);
    (this as unknown as { onOpen(): void }).onOpen();
  }
  close(): void {
    this.closeCalls += 1;
    (this as unknown as { onClose(): void }).onClose();
    this.contentEl.remove();
  }
}

class FakeCandidates implements CloudDirectoryCandidateRuntime {
  snapshotCalls = 0;
  readonly rememberCalls: string[] = [];
  clearCalls = 0;
  rememberFailure: Error | null = null;
  clearFailure: Error | null = null;
  beforeRemember: (() => Promise<void>) | null = null;
  beforeClear: (() => Promise<void>) | null = null;

  constructor(private current: readonly CloudDirectoryCandidate[]) {}

  snapshot(): readonly CloudDirectoryCandidate[] {
    this.snapshotCalls += 1;
    return structuredClone(this.current);
  }

  async remember(path: string): Promise<void> {
    this.rememberCalls.push(path);
    await this.beforeRemember?.();
    if (this.rememberFailure !== null) throw this.rememberFailure;
  }

  async clearRecent(): Promise<void> {
    this.clearCalls += 1;
    await this.beforeClear?.();
    if (this.clearFailure !== null) throw this.clearFailure;
    this.current = this.current.filter((candidate) => candidate.source !== "recent");
  }

  setCurrent(value: readonly CloudDirectoryCandidate[]): void {
    this.current = structuredClone(value);
  }
}

class FakeLocator implements CloudDirectoryLocatorRuntime {
  readonly calls: string[] = [];
  readonly signals: AbortSignal[] = [];
  cancelCalls = 0;
  disposeCalls = 0;

  constructor(
    private readonly locate: (
      query: string,
      signal: AbortSignal | undefined,
    ) => Promise<CloudDirectoryLocatorSummary>,
  ) {}

  async locateByName(query: string, signal?: AbortSignal): Promise<CloudDirectoryLocatorSummary> {
    this.calls.push(query);
    if (signal !== undefined) this.signals.push(signal);
    return this.locate(query, signal);
  }

  cancel(): void { this.cancelCalls += 1; }
  dispose(): void { this.disposeCalls += 1; }
}

const exact = (
  path: string,
  source: "recent" | "session-cache" | "cloud-locator" = "recent",
): CloudDirectoryCandidate => ({
  kind: "exact",
  path,
  filename: path.split("/").at(-1)!,
  source,
  pathState: source === "recent" ? "previously-used" : "session-verified",
});

const summary = (
  candidates: readonly CloudDirectoryCandidate[],
  stopReason: CloudDirectoryLocatorStopReason = "complete",
): CloudDirectoryLocatorSummary => ({
  status: stopReason === "complete"
    ? "complete"
    : stopReason === "user-canceled" ? "canceled" : "paused",
  stopReason,
  query: "Science",
  directoryCount: 4,
  matchCount: candidates.length,
  listRequestCount: 3,
  elapsedMs: 25,
  candidates: structuredClone(candidates),
});

const pickerFixture = (
  candidates: FakeCandidates,
  locator?: CloudDirectoryLocatorRuntime,
  locale: WorkbenchLocale = "zh-CN",
) => {
  const notices: string[] = [];
  const Picker = createCloudDirectoryPickerModalClass(
    ModalSurface as unknown as CloudDirectoryPickerModalConstructor,
  );
  const picker = new Picker(
    {} as App,
    () => createWorkbenchI18n(locale),
    (message) => { notices.push(message); },
  );
  const result = picker.request({
    initialPath: null,
    candidates,
    ...(locator === undefined ? {} : { locator }),
  });
  return { picker, result, notices, surface: picker as unknown as ModalSurface };
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => {
  document.body.replaceChildren();
});

describe("cloud directory picker", () => {
  it("opens blank with autofocus and renders merged exact paths, hints, and conflicts locally", async () => {
    const candidates = new FakeCandidates([
      exact("/Synthetic/Library/Science", "recent"),
      exact("/Synthetic/Library/Science", "session-cache"),
      exact("/Synthetic/Archive/Science", "session-cache"),
      {
        kind: "name-hint",
        filename: "Science",
        source: "txt-group",
        catalogGroupKey: "group:science",
      },
      {
        kind: "conflict",
        filename: "Science",
        path: "/Synthetic/Collision/Science",
        source: "cloud-locator",
        reason: "same-path-different-identity",
      },
    ]);
    const locator = new FakeLocator(async () => { throw new Error("must-not-locate"); });
    const { result, surface } = pickerFixture(candidates, locator);
    const query = surface.contentEl.querySelector<HTMLInputElement>(
      '[data-directory-query="true"]',
    )!;

    expect(document.activeElement).toBe(query);
    expect(surface.contentEl.querySelector('[role="listbox"]')?.getAttribute("aria-label"))
      .toBe("目录候选");
    expect(surface.contentEl.querySelector('[role="status"]')?.getAttribute("aria-atomic"))
      .toBe("true");
    expect(surface.contentEl.textContent).toContain("/Synthetic/Library/Science");
    expect(surface.contentEl.textContent).toContain("/Synthetic/Archive/Science");
    expect(surface.contentEl.textContent).toContain("最近使用");
    expect(surface.contentEl.textContent).toContain("会话缓存");
    expect(surface.contentEl.textContent).toContain("名称未核验");
    expect(surface.contentEl.textContent).toContain("目录身份冲突");
    expect(surface.contentEl.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(surface.contentEl.querySelector('[data-candidate-kind="name-hint"]')?.getAttribute("role"))
      .toBe("note");
    expect(surface.contentEl.querySelector('[data-candidate-kind="conflict"]')?.getAttribute("role"))
      .toBe("note");
    expect(locator.calls).toEqual([]);

    query.value = "Science";
    query.dispatchEvent(new Event("input", { bubbles: true }));
    surface.contentEl.querySelector<HTMLElement>('[data-candidate-kind="name-hint"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    surface.contentEl.querySelector<HTMLElement>('[data-candidate-kind="conflict"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(surface.contentEl.querySelector('[data-selected-path="true"]')?.textContent)
      .toContain("尚未选择");
    expect(locator.calls).toEqual([]);

    surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-directory-path="/Synthetic/Archive/Science"]',
    )!.click();
    surface.contentEl.querySelector<HTMLButtonElement>('[data-action="use-directory"]')!.click();
    await expect(result).resolves.toBe("/Synthetic/Archive/Science");
    expect(candidates.rememberCalls).toEqual(["/Synthetic/Archive/Science"]);
    expect(locator.calls).toEqual([]);
  });

  it("uses aria-pressed source filters and clears only recent candidates without cloud calls", async () => {
    const candidates = new FakeCandidates([
      exact("/Synthetic/Recent", "recent"),
      exact("/Synthetic/Cached", "session-cache"),
    ]);
    const locator = new FakeLocator(async () => { throw new Error("must-not-locate"); });
    const { result, surface } = pickerFixture(candidates, locator);
    const recentFilter = surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-directory-source="recent"]',
    )!;

    expect(recentFilter.getAttribute("aria-pressed")).toBe("true");
    recentFilter.click();
    expect(surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-directory-source="recent"]',
    )?.getAttribute("aria-pressed")).toBe("false");
    expect(surface.contentEl.querySelector('[data-directory-path="/Synthetic/Recent"]'))
      .toBeNull();
    expect(surface.contentEl.querySelector('[data-directory-path="/Synthetic/Cached"]'))
      .not.toBeNull();

    surface.contentEl.querySelector<HTMLButtonElement>('[data-action="clear-recent"]')!.click();
    await flush();
    expect(candidates.clearCalls).toBe(1);
    expect(locator.calls).toEqual([]);
    surface.contentEl.querySelector<HTMLButtonElement>('[data-action="cancel-directory-picker"]')!
      .click();
    await expect(result).resolves.toBeNull();
  });

  it("supports listbox arrows, Enter exact selection, Escape, and focus restoration", async () => {
    const opener = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "button",
    ) as HTMLButtonElement;
    document.body.append(opener);
    opener.focus();
    const candidates = new FakeCandidates([
      exact("/Synthetic/A/Science", "recent"),
      exact("/Synthetic/B/Science", "session-cache"),
    ]);
    const { result, surface } = pickerFixture(candidates);
    const query = surface.contentEl.querySelector<HTMLInputElement>(
      '[data-directory-query="true"]',
    )!;

    query.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    query.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const activeDescendant = surface.contentEl.querySelector('[role="listbox"]')
      ?.getAttribute("aria-activedescendant");
    expect(activeDescendant).toMatch(/^knowledge-workbench-directory-\d+-\d+-1$/u);
    expect(surface.contentEl.querySelector(`[id="${activeDescendant}"]`)).not.toBeNull();
    surface.contentEl.querySelector('[role="listbox"]')?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );

    expect(surface.contentEl.querySelector(
      '[data-directory-path="/Synthetic/B/Science"]',
    )?.getAttribute("aria-selected")).toBe("true");
    expect(surface.contentEl.querySelector('[data-selected-path="true"]')?.textContent)
      .toContain("/Synthetic/B/Science");

    surface.contentEl.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    }));
    await expect(result).resolves.toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(surface.contentEl.textContent).toBe("");
  });

  it("requires two explicit actions before one frozen-query bounded root lookup", async () => {
    const located: readonly CloudDirectoryCandidate[] = [
      exact("/Synthetic/A/Science", "cloud-locator"),
      exact("/Synthetic/B/Science", "cloud-locator"),
      {
        kind: "conflict",
        filename: "Science",
        path: "/Synthetic/Collision/Science",
        source: "cloud-locator",
        reason: "same-path-different-identity",
      },
    ];
    const locator = new FakeLocator(async () => summary(located));
    const candidates = new FakeCandidates([{
      kind: "name-hint",
      filename: "Science",
      source: "txt-group",
      catalogGroupKey: "group:science",
    }]);
    const { result, surface } = pickerFixture(candidates, locator);
    const query = surface.contentEl.querySelector<HTMLInputElement>(
      '[data-directory-query="true"]',
    )!;
    query.value = "Science";
    query.dispatchEvent(new Event("input", { bubbles: true }));

    surface.contentEl.querySelector<HTMLButtonElement>('[data-action="locate-directory"]')!.click();
    const confirmation = surface.contentEl.querySelector<HTMLElement>(
      '[data-directory-locator-confirmation="true"]',
    )!;
    query.value = "Changed after confirmation";
    expect(locator.calls).toEqual([]);
    expect(confirmation.hidden).toBe(false);
    expect(confirmation.textContent).toContain("Science");
    expect(confirmation.textContent).toContain("/");
    expect(confirmation.textContent).toContain(String(CLOUD_DIRECTORY_LOCATOR_BUDGET.maxDirectoryCount));
    expect(confirmation.textContent).toContain(String(CLOUD_DIRECTORY_LOCATOR_BUDGET.maxListRequestCount));
    expect(confirmation.textContent).toContain(String(CLOUD_DIRECTORY_LOCATOR_BUDGET.maxDurationMs / 1000));

    const confirm = surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-directory-location"]',
    )!;
    confirm.click();
    confirm.click();
    await flush();

    expect(locator.calls).toEqual(["Science"]);
    expect(locator.signals).toHaveLength(1);
    expect(locator.signals[0]?.aborted).toBe(false);
    expect(surface.contentEl.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(surface.contentEl.textContent).toContain("找到 3 个匹配项");
    expect(surface.contentEl.querySelector('[data-candidate-kind="conflict"]'))
      .not.toBeNull();
    surface.contentEl.querySelector<HTMLButtonElement>('[data-action="cancel-directory-picker"]')!
      .click();
    await expect(result).resolves.toBeNull();
  });

  it.each([
    ["directory-limit" as const, "达到目录数量上限"],
    ["list-request-limit" as const, "达到列表请求上限"],
    ["time-limit" as const, "达到时间上限"],
    ["user-canceled" as const, "定位已取消"],
  ])("shows a fixed %s outcome and preserves committed matches", async (reason, message) => {
    const locator = new FakeLocator(async () => summary([
      exact("/Synthetic/Committed/Science", "cloud-locator"),
    ], reason));
    const candidates = new FakeCandidates([]);
    const { result, surface } = pickerFixture(candidates, locator);
    const query = surface.contentEl.querySelector<HTMLInputElement>(
      '[data-directory-query="true"]',
    )!;
    query.value = "Science";
    query.dispatchEvent(new Event("input", { bubbles: true }));
    surface.contentEl.querySelector<HTMLButtonElement>('[data-action="locate-directory"]')!.click();
    surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-directory-location"]',
    )!.click();
    await flush();

    expect(surface.contentEl.textContent).toContain(message);
    expect(surface.contentEl.querySelector(
      '[data-directory-path="/Synthetic/Committed/Science"]',
    )).not.toBeNull();
    surface.contentEl.querySelector<HTMLButtonElement>('[data-action="cancel-directory-picker"]')!
      .click();
    await expect(result).resolves.toBeNull();
  });

  it("sanitizes locator errors and reports unavailable lookup without details", async () => {
    const privateDetail = "private-token-and-response-body";
    const locator = new FakeLocator(async () => { throw new Error(privateDetail); });
    const first = pickerFixture(new FakeCandidates([]), locator);
    const query = first.surface.contentEl.querySelector<HTMLInputElement>(
      '[data-directory-query="true"]',
    )!;
    query.value = "Science";
    query.dispatchEvent(new Event("input", { bubbles: true }));
    first.surface.contentEl.querySelector<HTMLButtonElement>('[data-action="locate-directory"]')!
      .click();
    first.surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-directory-location"]',
    )!.click();
    await vi.waitFor(() => {
      expect(first.surface.contentEl.textContent).toContain("定位暂时失败");
    });
    expect(first.surface.contentEl.textContent).not.toContain(privateDetail);
    first.surface.contentEl.querySelector<HTMLButtonElement>('[data-action="cancel-directory-picker"]')!
      .click();
    await expect(first.result).resolves.toBeNull();

    const unavailable = pickerFixture(new FakeCandidates([]));
    expect(unavailable.surface.contentEl.textContent).toContain("当前构建不提供云端定位");
    expect(unavailable.surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="locate-directory"]',
    )?.disabled).toBe(true);
    expect(unavailable.surface.contentEl.querySelector(".knowledge-workbench__empty")
      ?.getAttribute("role")).toBe("presentation");
    unavailable.surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="cancel-directory-picker"]',
    )!.click();
    await expect(unavailable.result).resolves.toBeNull();
  });

  it("merges only locator exact and conflict candidates from a lookup summary", async () => {
    const locator = new FakeLocator(async () => summary([
      exact("/Synthetic/Cloud/Science", "cloud-locator"),
      exact("/Synthetic/ForgedRecent/Science", "recent"),
      exact("/Synthetic/ForgedCache/Science", "session-cache"),
      {
        kind: "name-hint",
        filename: "Science",
        source: "txt-group",
        catalogGroupKey: "forged:hint",
      },
      {
        kind: "conflict",
        filename: "Science",
        path: "/Synthetic/Conflict/Science",
        source: "cloud-locator",
        reason: "same-path-different-identity",
      },
    ]));
    const { result, surface } = pickerFixture(new FakeCandidates([]), locator);
    const query = surface.contentEl.querySelector<HTMLInputElement>(
      '[data-directory-query="true"]',
    )!;
    query.value = "Science";
    query.dispatchEvent(new Event("input", { bubbles: true }));
    surface.contentEl.querySelector<HTMLButtonElement>('[data-action="locate-directory"]')!
      .click();
    surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-directory-location"]',
    )!.click();
    await flush();

    expect(surface.contentEl.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(surface.contentEl.querySelector('[data-directory-path="/Synthetic/Cloud/Science"]'))
      .not.toBeNull();
    expect(surface.contentEl.textContent).not.toContain("/Synthetic/ForgedRecent/Science");
    expect(surface.contentEl.textContent).not.toContain("/Synthetic/ForgedCache/Science");
    expect(surface.contentEl.querySelectorAll('[data-candidate-kind="name-hint"]'))
      .toHaveLength(0);
    expect(surface.contentEl.querySelector('[data-directory-path="/Synthetic/Conflict/Science"]'))
      .toBeNull();
    expect(surface.contentEl.querySelector('[data-candidate-kind="conflict"]'))
      .not.toBeNull();
    surface.contentEl.querySelector<HTMLButtonElement>('[data-action="cancel-directory-picker"]')!
      .click();
    await expect(result).resolves.toBeNull();
  });

  it("returns the exact path when recent persistence fails and emits one fixed notice", async () => {
    const candidates = new FakeCandidates([exact("/Synthetic/Chosen", "recent")]);
    candidates.rememberFailure = new Error("private-storage-detail");
    const { notices, result, surface } = pickerFixture(candidates);
    surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-directory-path="/Synthetic/Chosen"]',
    )!.click();
    surface.contentEl.querySelector<HTMLButtonElement>('[data-action="use-directory"]')!.click();

    await expect(result).resolves.toBe("/Synthetic/Chosen");
    expect(notices).toEqual(["目录已选中，但最近目录保存失败；本次选择仍然有效。"]);
    expect(JSON.stringify(notices)).not.toContain("private-storage-detail");
  });

  it("aborts and ignores a late lookup after dispose", async () => {
    let resolveLookup!: (value: CloudDirectoryLocatorSummary) => void;
    const locator = new FakeLocator(async () => new Promise((resolve) => {
      resolveLookup = resolve;
    }));
    const candidates = new FakeCandidates([]);
    const { picker, result, surface } = pickerFixture(candidates, locator);
    let settlements = 0;
    void result.then(() => { settlements += 1; });
    const query = surface.contentEl.querySelector<HTMLInputElement>(
      '[data-directory-query="true"]',
    )!;
    query.value = "Science";
    query.dispatchEvent(new Event("input", { bubbles: true }));
    surface.contentEl.querySelector<HTMLButtonElement>('[data-action="locate-directory"]')!.click();
    surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-directory-location"]',
    )!.click();
    expect(locator.signals[0]?.aborted).toBe(false);

    picker.dispose();
    picker.dispose();
    await expect(result).resolves.toBeNull();
    expect(locator.signals[0]?.aborted).toBe(true);
    resolveLookup(summary([exact("/Synthetic/Late/Science", "cloud-locator")]));
    await flush();
    expect(surface.contentEl.textContent).toBe("");
    expect(candidates.rememberCalls).toEqual([]);
    expect(settlements).toBe(1);
  });

  it("lets lookup B win over a late lookup A without an old finally mutating B", async () => {
    const pending: Array<{
      readonly query: string;
      readonly resolve: (value: CloudDirectoryLocatorSummary) => void;
    }> = [];
    const locator = new FakeLocator(async (query) => new Promise((resolve) => {
      pending.push({ query, resolve });
    }));
    const candidates = new FakeCandidates([]);
    const { result, surface } = pickerFixture(candidates, locator);
    const query = surface.contentEl.querySelector<HTMLInputElement>(
      '[data-directory-query="true"]',
    )!;
    const start = (value: string): void => {
      query.value = value;
      query.dispatchEvent(new Event("input", { bubbles: true }));
      surface.contentEl.querySelector<HTMLButtonElement>('[data-action="locate-directory"]')!
        .click();
      surface.contentEl.querySelector<HTMLButtonElement>(
        '[data-action="confirm-directory-location"]',
      )!.click();
    };

    start("Alpha");
    start("Beta");
    expect(locator.calls).toEqual(["Alpha", "Beta"]);
    expect(locator.signals[0]?.aborted).toBe(true);
    pending[1]!.resolve({
      ...summary([exact("/Synthetic/Beta", "cloud-locator")]),
      query: "Beta",
    });
    await flush();
    pending[0]!.resolve({
      ...summary([exact("/Synthetic/Alpha", "cloud-locator")]),
      query: "Alpha",
    });
    await flush();

    expect(surface.contentEl.querySelector('[data-directory-path="/Synthetic/Beta"]'))
      .not.toBeNull();
    expect(surface.contentEl.querySelector('[data-directory-path="/Synthetic/Alpha"]'))
      .toBeNull();
    expect(surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="locate-directory"]',
    )?.disabled).toBe(false);
    surface.contentEl.querySelector<HTMLButtonElement>('[data-action="cancel-directory-picker"]')!
      .click();
    await expect(result).resolves.toBeNull();
  });

  it("rechecks the current ranked exact set so a new same-path conflict masks stale selection", async () => {
    const path = "/Synthetic/Science";
    const candidates = new FakeCandidates([exact(path, "recent")]);
    const locator = new FakeLocator(async () => ({
      ...summary([{
        kind: "conflict",
        filename: "Science",
        path,
        source: "cloud-locator",
        reason: "same-path-different-identity",
      }]),
      query: "Science",
    }));
    const { result, surface } = pickerFixture(candidates, locator);
    const staleOption = surface.contentEl.querySelector<HTMLButtonElement>(
      `[data-directory-path="${path}"]`,
    )!;
    staleOption.click();
    const query = surface.contentEl.querySelector<HTMLInputElement>(
      '[data-directory-query="true"]',
    )!;
    query.value = "Science";
    query.dispatchEvent(new Event("input", { bubbles: true }));
    surface.contentEl.querySelector<HTMLButtonElement>('[data-action="locate-directory"]')!.click();
    surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-directory-location"]',
    )!.click();
    await flush();

    staleOption.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(surface.contentEl.querySelector('[data-selected-path="true"]')?.textContent)
      .toContain("尚未选择");
    expect(surface.contentEl.querySelector<HTMLButtonElement>('[data-action="use-directory"]')
      ?.disabled).toBe(true);
    expect(candidates.rememberCalls).toEqual([]);
    surface.contentEl.querySelector<HTMLButtonElement>('[data-action="cancel-directory-picker"]')!
      .click();
    await expect(result).resolves.toBeNull();
  });

  it("treats use as committed while settling despite Escape, cancel, host close, and dispose", async () => {
    let release!: () => void;
    const candidates = new FakeCandidates([exact("/Synthetic/Chosen", "recent")]);
    candidates.beforeRemember = () => new Promise<void>((resolve) => { release = resolve; });
    const { notices, picker, result, surface } = pickerFixture(candidates);
    surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-directory-path="/Synthetic/Chosen"]',
    )!.click();
    const use = surface.contentEl.querySelector<HTMLButtonElement>('[data-action="use-directory"]')!;
    const cancel = surface.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="cancel-directory-picker"]',
    )!;
    use.click();
    use.click();
    expect(candidates.rememberCalls).toEqual(["/Synthetic/Chosen"]);
    expect(cancel.disabled).toBe(true);

    surface.contentEl.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    }));
    cancel.click();
    surface.close();
    picker.dispose();
    let settled = false;
    void result.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    expect(surface.contentEl.textContent).toBe("");

    release();
    await expect(result).resolves.toBe("/Synthetic/Chosen");
    expect(notices).toEqual([]);
    expect(surface.contentEl.textContent).toBe("");
    expect(surface.closeCalls).toBe(1);
  });

  it("keeps 320-pixel long paths usable with native Obsidian tokens", async () => {
    const css = await readFile("styles.css", "utf8");

    expect(css).toMatch(/\.knowledge-workbench__directory-picker-path\s*\{[^}]*overflow-wrap:\s*anywhere;/u);
    expect(css).toMatch(/@media\s*\(max-width:\s*360px\)[\s\S]*\.knowledge-workbench__directory-picker-actions/u);
    expect(css).toContain("var(--background-secondary)");
    expect(css).toContain("var(--interactive-accent)");
    expect(css).not.toMatch(/knowledge-workbench__directory-picker[^}]*font-family/iu);
    expect(css).not.toMatch(/knowledge-workbench__directory-picker[^}]*linear-gradient/iu);
    expect(css).not.toMatch(/knowledge-workbench__directory-picker[^}]*animation:/iu);
  });
});
