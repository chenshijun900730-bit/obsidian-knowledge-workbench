// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { App } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanPreview, ChangePlanService } from "../../src/plans/change-plan-service";
import { READ_ONLY_ACCEPTANCE_POLICY } from "../../src/runtime/safety-policy";
import type { PluginSettings } from "../../src/storage/plugin-data";
import {
  createChangePreviewModalClass,
  type ModalConstructor,
} from "../../src/ui/change-preview-modal";
import { renderHistory, type HistoryViewModel } from "../../src/ui/history-tab";
import {
  createSettingsTabClass,
  type PluginSettingTabConstructor,
  type SettingsController,
} from "../../src/ui/settings-tab";
import {
  renderWorkbench,
  type WorkbenchActions,
  type WorkbenchTab,
  type WorkbenchViewModel,
} from "../../src/ui/workbench-view";

const ACCEPTANCE_BANNER = "Read-only acceptance build. Quick Capture, organization writes, Undo, and AI are unavailable. Derived index data is stored in the plugin's data file.";

const suggestion = {
  operation: {
    id: "acceptance-suggestion",
    kind: "set-owned-field" as const,
    path: "Generated/A.md",
    field: "knowledge-workbench-kind" as const,
    before: { present: false } as const,
    after: { present: true, value: "note" } as const,
  },
  localRationale: {
    source: "local" as const,
    summary: "Synthetic folder classification",
    signals: ["folder-rule:Generated"],
    confidence: "high" as const,
    impact: 80,
  },
  rationale: {
    source: "local" as const,
    summary: "Synthetic folder classification",
    signals: ["folder-rule:Generated"],
    confidence: "high" as const,
    impact: 80,
  },
};

const previewOperation = {
  id: "acceptance-preview-rename",
  kind: "rename" as const,
  sourcePath: "Generated/A.md",
  targetPath: "Generated/B.md",
};

const modelFor = (activeTab: WorkbenchTab): WorkbenchViewModel => ({
  status: "ready",
  activeTab,
  todayFilter: "all",
  today: {
    newItems: [{
      id: "generated-a",
      path: "Generated/A.md",
      title: "Generated A",
      kind: "note",
      reason: "unclassified",
      explanation: "Synthetic fixture note",
      actionLabel: "Review note",
      score: 100,
      activityAt: 1,
    }],
    continueItems: [],
    nextItems: [],
  },
  suggestions: [suggestion],
  history: { entries: [] },
  map: {
    nodes: [{
      id: "generated-a",
      nodeType: "document",
      path: "Generated/A.md",
      title: "Generated A",
      kind: "note",
      shape: "circle",
    }],
    edges: [],
    selected: {
      nodeId: "generated-a",
      path: "Generated/A.md",
      topics: [],
      connectedNodeIds: [],
      relations: [],
    },
    truncated: false,
  },
  mapFilter: "all",
  searchQuery: "",
  searchResults: [],
  scanProgress: { status: "idle", completed: 0, label: "Index" },
  mapProgress: { status: "idle", completed: 0, label: "Map" },
  aiSuggestion: { action: "summarize", text: "stale AI output must remain hidden" },
});

const workbenchActions = (
  overrides: Partial<WorkbenchActions> = {},
): WorkbenchActions => ({
  onSelectTab: vi.fn(),
  onSelectTodayFilter: vi.fn(),
  onSelectMapFilter: vi.fn(),
  onOpenNote: vi.fn(),
  onQuickCapture: vi.fn(),
  onCancelScan: vi.fn(),
  onCancelMap: vi.fn(),
  onPin: vi.fn(),
  onDismiss: vi.fn(),
  onSearchMap: vi.fn(),
  onSelectCenter: vi.fn(),
  onPreviewSuggestion: vi.fn(),
  onPreviewSuggestionIds: vi.fn(),
  onRetryScan: vi.fn(),
  onUndoHistory: vi.fn(),
  onViewRecovery: vi.fn(),
  onClearHistory: vi.fn(),
  onExportHistory: vi.fn(),
  onSummarize: vi.fn(),
  onNameCluster: vi.fn(),
  onExplainRelation: vi.fn(),
  onSuggestLabels: vi.fn(),
  onSuggestionSelectionChange: vi.fn(),
  ...overrides,
});

const testDiv = (): HTMLDivElement => document.createElementNS(
  "http://www.w3.org/1999/xhtml",
  "div",
) as HTMLDivElement;

class ModalSurface {
  readonly contentEl = testDiv();
  readonly titleEl = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "h2",
  ) as HTMLHeadingElement;
  closed = false;

  constructor(readonly app: App) {}
  setTitle(value: string): this { this.titleEl.textContent = value; return this; }
  open(): void { document.body.append(this.titleEl, this.contentEl); this.onOpen(); }
  close(): void {
    this.closed = true;
    this.onClose();
    this.titleEl.remove();
    this.contentEl.remove();
  }
  onOpen(): void {}
  onClose(): void {}
}

const previewFixture = (): PlanPreview => ({
  plan: {
    id: "acceptance-preview",
    fingerprint: "synthetic-preview-fingerprint",
    operations: [previewOperation],
    preconditions: [{
      path: "Generated/A.md",
      exists: true,
      mtime: 1,
      contentHash: "synthetic-content",
    }, {
      path: "Generated/B.md",
      exists: false,
    }],
    rationales: { [previewOperation.id]: suggestion.rationale },
    localRationales: { [previewOperation.id]: suggestion.localRationale },
  },
  conflicts: [],
  affectedFiles: ["Generated/A.md", "Generated/B.md"],
  undoableOperationIds: [previewOperation.id],
});

class SettingsSurface {
  readonly containerEl = testDiv();
}

const acceptanceSettings = (): PluginSettings => Object.defineProperties({
  openAtStartup: true,
  folderRules: [],
  excludedPrefixes: ["Generated/Archive"],
}, {
  writeEnabled: { get: () => { throw new Error("must not inspect writeEnabled"); } },
  writePreviewAcknowledged: {
    get: () => { throw new Error("must not inspect writePreviewAcknowledged"); },
  },
  aiEnabled: { get: () => { throw new Error("must not inspect aiEnabled"); } },
  aiEndpoint: { get: () => { throw new Error("must not inspect aiEndpoint"); } },
  aiModel: { get: () => { throw new Error("must not inspect aiModel"); } },
  secretId: { get: () => { throw new Error("must not inspect secretId"); } },
}) as unknown as PluginSettings;

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("read-only acceptance surfaces", () => {
  it("keeps a persistent non-color-only banner and only read-safe Workbench actions", () => {
    const root = testDiv();
    const quickCapture = vi.fn();
    const ai = vi.fn();
    const previewSelected = vi.fn();
    const actions = workbenchActions({
      onQuickCapture: quickCapture,
      onPreviewSuggestionIds: previewSelected,
      onSummarize: ai,
      onNameCluster: ai,
      onExplainRelation: ai,
      onSuggestLabels: ai,
    });

    for (const tab of ["workbench", "suggestions", "history", "settings"] as const) {
      renderWorkbench(root, modelFor(tab), actions, READ_ONLY_ACCEPTANCE_POLICY);
      const banners = root.querySelectorAll<HTMLElement>('[data-acceptance-banner="true"]');
      expect(banners).toHaveLength(1);
      expect(banners[0]?.textContent).toBe(ACCEPTANCE_BANNER);
      expect(banners[0]?.getAttribute("role")).toBe("status");
      expect(banners[0]?.getAttribute("aria-label")).toBe(
        "Read-only acceptance mode is active",
      );
      expect(Array.from(root.children).map((child) => child.className)).toEqual([
        "knowledge-workbench__tabs",
        "knowledge-workbench__acceptance-banner",
        "knowledge-workbench__status",
        "knowledge-workbench__progress-row",
        "",
      ]);
    }

    const css = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");
    expect(css).toMatch(/\.knowledge-workbench__acceptance-banner\s*\{[^}]*border:\s*2px solid/su);
    expect(css).toMatch(/\.knowledge-workbench__acceptance-banner\s*\{[^}]*border-left-width:\s*0\.5rem/su);
    expect(css).toMatch(/\.knowledge-workbench__acceptance-banner\s*\{[^}]*font-weight:\s*600/su);
    expect(css).toMatch(/\.knowledge-workbench--read-only-acceptance button:disabled/u);

    renderWorkbench(root, modelFor("workbench"), actions, READ_ONLY_ACCEPTANCE_POLICY);
    const capture = root.querySelector<HTMLButtonElement>('[data-action="quick-capture"]');
    expect(capture?.textContent).toBe("Quick capture");
    expect(capture?.disabled).toBe(true);
    expect(capture?.getAttribute("aria-label")).toBe(
      "Quick Capture creates Markdown and is unavailable in read-only acceptance mode",
    );
    expect(capture?.title).toBe("Unavailable in read-only acceptance mode");
    if (capture !== null) {
      capture.disabled = false;
      capture.click();
    }
    expect(quickCapture).not.toHaveBeenCalled();
    expect(root.textContent).not.toContain("stale AI output must remain hidden");
    expect(root.querySelector(".knowledge-workbench__ai-actions")).toBeNull();
    expect(ai).not.toHaveBeenCalled();

    renderWorkbench(root, modelFor("suggestions"), actions, READ_ONLY_ACCEPTANCE_POLICY);
    const checkbox = root.querySelector<HTMLInputElement>(
      'input[value="acceptance-suggestion"]',
    );
    expect(checkbox).not.toBeNull();
    if (checkbox !== null) {
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const preview = Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Preview selected");
    expect(preview?.disabled).toBe(false);
    preview?.click();
    expect(previewSelected).toHaveBeenCalledWith(["acceptance-suggestion"]);
    expect(Array.from(root.querySelectorAll("button")).some(
      (button) => button.textContent === "Explain selected relation with AI",
    )).toBe(false);
  });

  it("keeps Change Preview readable but unreachable from click and submit bypasses", async () => {
    const confirm = vi.fn(async () => { throw new Error("confirmation must remain unreachable"); });
    const plans = { confirm } as unknown as ChangePlanService;
    const Concrete = createChangePreviewModalClass(
      ModalSurface as unknown as ModalConstructor,
      READ_ONLY_ACCEPTANCE_POLICY,
    );
    const modal = new Concrete({} as App, plans);
    const result = modal.request(previewFixture());

    expect(modal.titleEl.textContent).toBe("Change plan preview (read-only)");
    expect(modal.contentEl.textContent).toContain("Generated/A.md");
    expect(modal.contentEl.textContent).toContain(
      "Preview only. This build cannot confirm or execute changes.",
    );
    expect(modal.contentEl.classList.contains(
      "knowledge-workbench__change-preview--read-only",
    )).toBe(true);
    const unavailable = modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm"]',
    );
    expect(unavailable).not.toBeNull();
    if (unavailable === null) throw new Error("Expected acceptance confirmation control");
    expect(unavailable.type).toBe("button");
    expect(unavailable.textContent).toBe("Confirmation unavailable");
    expect(unavailable.disabled).toBe(true);
    expect(unavailable.getAttribute("aria-label")).toBe(
      "Confirmation unavailable in read-only acceptance mode",
    );
    expect(unavailable.title).toBe("Unavailable in read-only acceptance mode");

    const checkbox = modal.contentEl.querySelector<HTMLInputElement>(
      'input[value="acceptance-preview-rename"]',
    );
    expect(checkbox).not.toBeNull();
    if (checkbox === null) throw new Error("Expected acceptance preview selection control");
    checkbox.click();
    checkbox.click();
    expect(unavailable.disabled).toBe(true);
    unavailable.disabled = false;
    unavailable.click();
    const form = modal.contentEl.querySelector("form");
    expect(form).not.toBeNull();
    if (form === null) throw new Error("Expected acceptance preview form");
    form.dispatchEvent(new Event("submit", {
      bubbles: true,
      cancelable: true,
    }));
    await Promise.resolve();
    expect(confirm).not.toHaveBeenCalled();

    const cancel = Array.from(modal.contentEl.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Cancel");
    expect(cancel).toBeDefined();
    if (cancel === undefined) throw new Error("Expected acceptance preview cancel control");
    cancel.click();
    await expect(result).resolves.toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(modal.contentEl.isConnected).toBe(false);
    expect(modal.contentEl.childElementCount).toBe(0);
  });

  it("rejects acceptance sample review without opening or retaining modal state", async () => {
    const plans = { confirm: vi.fn() } as unknown as ChangePlanService;
    const Concrete = createChangePreviewModalClass(
      ModalSurface as unknown as ModalConstructor,
      READ_ONLY_ACCEPTANCE_POLICY,
    );
    const modal = new Concrete({} as App, plans);
    const open = vi.spyOn(modal, "open");

    await expect(modal.requestSample()).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(modal.contentEl.isConnected).toBe(false);
    expect(modal.contentEl.childElementCount).toBe(0);
  });

  it("renders aggregate History while every path-bearing action remains inert", () => {
    const history = {
      entries: [{
        id: "acceptance-recovery-id",
        status: "recovery-required",
        createdAt: 2,
        plan: {} as never,
        prepared: null,
        completed: [],
        rolledBackOperationIds: [],
      }, {
        id: "acceptance-completed-id",
        status: "completed",
        createdAt: 1,
        plan: {} as never,
        prepared: null,
        completed: [{} as never],
        rolledBackOperationIds: [],
      }],
      recoveryReport: {
        journalId: "acceptance-recovery-id",
        issues: [{
          operationId: "rename:Generated/A.md->Generated/B.md",
          comparison: "differs",
          originalPaths: ["Generated/A.md"],
          currentPaths: ["Generated/B.md"],
        }],
      },
    } satisfies HistoryViewModel;
    const actions = {
      onUndo: vi.fn(),
      onViewRecovery: vi.fn(),
      onClear: vi.fn(),
      onExport: vi.fn(),
    };
    const root = testDiv();

    renderHistory(root, history, actions, READ_ONLY_ACCEPTANCE_POLICY);

    expect(root.textContent).toContain("Recovery required · 0 completed");
    expect(root.textContent).toContain("Completed · 1 completed");
    expect(root.textContent).not.toContain("acceptance-recovery-id");
    expect(root.textContent).not.toContain("acceptance-completed-id");
    expect(root.textContent).not.toContain("Generated/A.md");
    expect(root.textContent).not.toContain("rename:");
    expect(root.querySelector('[aria-label="Recovery report"]')).toBeNull();
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons.map((button) => button.textContent)).toEqual([
      "View recovery",
      "Undo",
      "Clear history",
      "Export history",
    ]);
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("aria-label")).toBe(
        `${button.textContent} unavailable in read-only acceptance mode`,
      );
      expect(button.title).toBe("Unavailable in read-only acceptance mode");
      button.disabled = false;
      button.click();
    }
    expect(actions.onUndo).not.toHaveBeenCalled();
    expect(actions.onViewRecovery).not.toHaveBeenCalled();
    expect(actions.onClear).not.toHaveBeenCalled();
    expect(actions.onExport).not.toHaveBeenCalled();
  });

  it("renders only acceptance Settings notices while plugin-local review controls remain usable", async () => {
    let secretConstructions = 0;
    class PoisonSecretSurface {
      constructor() {
        secretConstructions += 1;
        throw new Error("SecretComponent must not be constructed");
      }
      setValue(): this { return this; }
      onChange(): this { return this; }
    }
    const blocked = {
      sample: vi.fn(),
      write: vi.fn(async () => undefined),
      saveAi: vi.fn(async () => undefined),
      session: vi.fn(),
    };
    const allowed = {
      startup: vi.fn(async () => undefined),
      rules: vi.fn(async () => undefined),
      exclusions: vi.fn(async () => undefined),
    };
    const controller: SettingsController = {
      settings: acceptanceSettings,
      folderRuleProposals: () => [{
        prefix: "Generated",
        kind: "reference",
        noteCount: 2,
        unclassifiedCount: 2,
        samplePaths: ["Generated/A.md"],
      }],
      previewSampleChange: blocked.sample,
      setOpenAtStartup: allowed.startup,
      setWriteEnabled: blocked.write,
      applyFolderRules: allowed.rules,
      setExcludedPrefixes: allowed.exclusions,
      saveAiSettings: blocked.saveAi,
      setSessionAiSecret: blocked.session,
    };
    const Concrete = createSettingsTabClass(
      SettingsSurface as unknown as PluginSettingTabConstructor,
      PoisonSecretSurface,
      READ_ONLY_ACCEPTANCE_POLICY,
    );
    const tab = new Concrete({} as App, {} as never, controller);
    const display = tab as unknown as { display(): void };

    expect(() => display.display()).not.toThrow();
    expect(tab.containerEl.classList.contains(
      "knowledge-workbench__settings--read-only",
    )).toBe(true);
    expect(tab.containerEl.textContent).toContain("Open the workbench at startup");
    expect(tab.containerEl.textContent).toContain("Folder rule proposals");
    expect(tab.containerEl.textContent).toContain("Excluded folders");
    expect(tab.containerEl.textContent).toContain(
      "Organization writes are unavailable in the read-only acceptance build.",
    );
    expect(tab.containerEl.textContent).toContain(
      "AI configuration and requests are unavailable in the read-only acceptance build.",
    );
    expect(tab.containerEl.textContent).not.toContain("Review a sample change");
    expect(tab.containerEl.querySelector('[data-write-enabled="true"]')).toBeNull();
    expect(tab.containerEl.querySelector('[data-ai-enabled="true"]')).toBeNull();
    expect(tab.containerEl.querySelector('[data-ai-endpoint="true"]')).toBeNull();
    expect(tab.containerEl.querySelector('[data-ai-model="true"]')).toBeNull();
    expect(tab.containerEl.querySelector('[data-session-ai-secret="true"]')).toBeNull();
    expect(secretConstructions).toBe(0);
    expect(tab.secretComponent).toBeNull();

    const startup = Array.from(tab.containerEl.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    )).find((input) => input.closest("label")?.textContent?.includes(
      "Open the workbench at startup",
    ));
    expect(startup).toBeDefined();
    if (startup !== undefined) {
      startup.checked = false;
      startup.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const folderRule = tab.containerEl.querySelector<HTMLInputElement>(
      '[data-folder-rule="Generated"]',
    );
    expect(folderRule).not.toBeNull();
    if (folderRule !== null) {
      folderRule.checked = true;
      folderRule.dispatchEvent(new Event("change", { bubbles: true }));
    }
    Array.from(tab.containerEl.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Confirm selected rules")?.click();
    const exclusion = tab.containerEl.querySelector<HTMLInputElement>(
      '[data-excluded-prefix="Generated"]',
    );
    expect(exclusion).not.toBeNull();
    if (exclusion !== null) {
      exclusion.checked = true;
      exclusion.dispatchEvent(new Event("change", { bubbles: true }));
    }
    Array.from(tab.containerEl.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Apply exclusions")?.click();

    await vi.waitFor(() => {
      expect(allowed.startup).toHaveBeenCalledWith(false);
      expect(allowed.rules).toHaveBeenCalledWith([{
        prefix: "Generated",
        kind: "reference",
      }]);
      expect(allowed.exclusions).toHaveBeenCalledWith([
        "Generated",
        "Generated/Archive",
      ]);
    });
    expect(blocked.sample).not.toHaveBeenCalled();
    expect(blocked.write).not.toHaveBeenCalled();
    expect(blocked.saveAi).not.toHaveBeenCalled();
    expect(blocked.session).not.toHaveBeenCalled();
  });
});
