// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createWorkbenchViewClass, renderWorkbench, type ItemViewConstructor } from "../../src/ui/workbench-view";
import { createQuickCaptureModalClass, type ModalConstructor } from "../../src/ui/quick-capture-modal";
import { createSettingsTabClass, type PluginSettingTabConstructor } from "../../src/ui/settings-tab";
import {
  activateWorkbench,
  activateWorkbenchWithRetry,
  initializeIndexForLayout,
  initializeRecoveredLayout,
  LifecycleEpoch,
  requireActivatedWorkbench,
  RetryableAsyncGate,
  runVisibleHostAction,
  SurfacedHostError,
  surfaceVisibleHostError,
  WorkbenchViewActivationError,
} from "../../src/adapters/obsidian-workspace-adapter";
import type { App, WorkspaceLeaf } from "obsidian";
import {
  NORMAL_RUNTIME_POLICY,
  READ_ONLY_ACCEPTANCE_POLICY,
} from "../../src/runtime/safety-policy";
import {
  controllerFixture,
  manualProjectionScheduler,
  metadataAdapterFixture,
  noOpWorkbenchActions,
  populatedWorkbenchModel,
  quickCaptureFixture,
  type ProjectionSchedulerDependency,
} from "../helpers/ui-fixtures";

const createTestDiv = (): HTMLDivElement => document.createElementNS(
  "http://www.w3.org/1999/xhtml",
  "div",
) as HTMLDivElement;

describe("workbench", () => {
  it("renders the exact acceptance banner before status and removes every AI and Quick Capture path", () => {
    const root = createTestDiv();
    const quickCapture = vi.fn();
    const ai = vi.fn();
    const model = {
      ...populatedWorkbenchModel(),
      aiSuggestion: { action: "summarize" as const, text: "stale private AI result" },
    };

    renderWorkbench(root, model, noOpWorkbenchActions({
      onQuickCapture: quickCapture,
      onSummarize: ai,
      onNameCluster: ai,
      onExplainRelation: ai,
      onSuggestLabels: ai,
    }), READ_ONLY_ACCEPTANCE_POLICY);

    expect(root.classList.contains("knowledge-workbench--read-only-acceptance")).toBe(true);
    expect(Array.from(root.children).map((child) => child.className)).toEqual([
      "knowledge-workbench__tabs",
      "knowledge-workbench__acceptance-banner",
      "knowledge-workbench__status",
      "knowledge-workbench__progress-row",
      "",
    ]);
    const banner = root.querySelector<HTMLElement>('[data-acceptance-banner="true"]');
    expect(banner?.getAttribute("role")).toBe("status");
    expect(banner?.textContent).toBe(
      "Read-only acceptance build. Quick Capture, organization writes, Undo, and AI are unavailable. Derived index data is stored in the plugin's data file.",
    );
    const capture = root.querySelector<HTMLButtonElement>('[data-action="quick-capture"]')!;
    expect(capture.disabled).toBe(true);
    expect(capture.getAttribute("aria-label")).toContain("creates Markdown");
    capture.disabled = false;
    capture.click();
    expect(quickCapture).not.toHaveBeenCalled();
    expect(root.textContent).not.toContain("stale private AI result");
    expect(root.querySelector(".knowledge-workbench__ai-actions")).toBeNull();

    renderWorkbench(root, model, noOpWorkbenchActions(), NORMAL_RUNTIME_POLICY);
    expect(root.classList.contains("knowledge-workbench--read-only-acceptance")).toBe(false);
    expect(root.querySelector('[data-acceptance-banner="true"]')).toBeNull();
    expect(root.textContent).toContain("stale private AI result");
  });

  it("omits the suggestions AI explanation control in acceptance mode", () => {
    const root = createTestDiv();
    const suggestion = {
      operation: { id: "set-kind", kind: "set-owned-field" as const, path: "Notes/Alpha.md", field: "knowledge-workbench-kind" as const, before: { present: false } as const, after: { present: true, value: "note" } as const },
      localRationale: { source: "local" as const, summary: "Folder-derived note kind", signals: ["folder-rule:Notes"], confidence: "high" as const, impact: 80 },
      rationale: { source: "local" as const, summary: "Folder-derived note kind", signals: ["folder-rule:Notes"], confidence: "high" as const, impact: 80 },
    };
    const model = { ...populatedWorkbenchModel(), activeTab: "suggestions" as const, suggestions: [suggestion] };
    renderWorkbench(root, model, noOpWorkbenchActions({
      onExplainRelation: vi.fn(),
    }), READ_ONLY_ACCEPTANCE_POLICY);
    expect(Array.from(root.querySelectorAll("button")).some((button) => button.textContent === "Explain selected relation with AI")).toBe(false);
    expect(Array.from(root.querySelectorAll("button")).some((button) => button.textContent === "Preview selected")).toBe(true);
  });

  it("renders every AI result as text-only under the exact AI suggestion label", () => {
    const root = createTestDiv();
    renderWorkbench(root, {
      ...populatedWorkbenchModel(),
      aiSuggestion: { action: "summarize", text: '<img src=x onerror="globalThis.pwned=true">' },
    }, noOpWorkbenchActions());
    expect(root.textContent).toContain("AI suggestion");
    expect(root.textContent).toContain("<img");
    expect(root.querySelector("img")).toBeNull();
  });

  it("routes explicit map AI actions using selected paths rather than note bodies", () => {
    const root = createTestDiv();
    const calls: unknown[] = [];
    renderWorkbench(root, populatedWorkbenchModel(), noOpWorkbenchActions({
      onSummarize: (paths) => { calls.push(["summarize", [...paths]]); },
      onNameCluster: (paths) => { calls.push(["name-cluster", [...paths]]); },
      onExplainRelation: (paths, id) => { calls.push(["explain-relation", [...paths], id]); },
      onSuggestLabels: (paths) => { calls.push(["suggest-labels", [...paths]]); },
    }));
    Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Summarize with AI")?.click();
    Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Explain relation with AI")?.click();
    expect(calls).toEqual([
      ["summarize", ["Notes/Alpha.md"]],
      ["explain-relation", ["Notes/Alpha.md"], undefined],
    ]);
  });
  it("renders equal Today and map regions with accessible labels", () => {
    const root = createTestDiv();
    renderWorkbench(root, {
      status: "ready",
      activeTab: "workbench",
      todayFilter: "all",
      today: { newItems: [], continueItems: [], nextItems: [] },
      map: { nodes: [], edges: [], selected: null, truncated: false },
      mapFilter: "all",
      searchQuery: "",
      searchResults: [],
      scanProgress: { status: "idle", completed: 0, label: "Index" },
      mapProgress: { status: "idle", completed: 0, label: "Map" },
    }, {
      onSelectTab: () => undefined,
      onSelectTodayFilter: () => undefined,
      onSelectMapFilter: () => undefined,
      onOpenNote: () => undefined,
      onQuickCapture: () => undefined,
      onCancelScan: () => undefined,
      onCancelMap: () => undefined,
      onPin: () => undefined,
      onDismiss: () => undefined,
      onSearchMap: () => undefined,
      onSelectCenter: () => undefined,
      onPreviewSuggestion: () => undefined,
      onRetryScan: () => undefined,
    });
    expect(Array.from(root.querySelectorAll('[role="tab"]')).map((value) => value.textContent)).toEqual([
      "Workbench",
      "Organization suggestions",
      "Operation history",
      "Settings",
    ]);
    expect(root.querySelector('[aria-label="Today"]')).not.toBeNull();
    expect(root.querySelector('[aria-label="Knowledge map"]')).not.toBeNull();
    expect(root.querySelector('[role="status"]')?.textContent).toContain("Ready");
  });

  it("points every ARIA tab control at a real stable tabpanel", () => {
    const root = createTestDiv();
    renderWorkbench(root, populatedWorkbenchModel(), noOpWorkbenchActions());
    for (const tab of Array.from(root.querySelectorAll<HTMLElement>('[role="tab"][aria-controls]'))) {
      const controlled = tab.getAttribute("aria-controls")!;
      expect(root.querySelector(`#${controlled}`), `${tab.textContent} controls ${controlled}`).not.toBeNull();
    }
  });

  it("keeps actions as native buttons with visible labels", () => {
    const root = createTestDiv();
    renderWorkbench(root, populatedWorkbenchModel(), noOpWorkbenchActions());
    expect(root.querySelector(".knowledge-workbench__split")).not.toBeNull();
    for (const button of Array.from(root.querySelectorAll("button"))) {
      expect(button.textContent?.trim() || button.getAttribute("aria-label")).toBeTruthy();
      if (button.getAttribute("role") !== "tab") expect(button.tabIndex).toBeGreaterThanOrEqual(0);
    }
    expect(root.querySelector(".knowledge-workbench__node--circle")?.textContent).toBe("Alpha");
    expect(root.querySelector(".knowledge-workbench__node--square")?.textContent).toBe("Beta");
    expect(root.querySelector(".knowledge-workbench__node--diamond")?.textContent).toBe("Systems");
    expect(root.querySelector(".knowledge-workbench__relation--confirmed")?.textContent).toContain("Confirmed");
    expect(root.querySelector(".knowledge-workbench__relation--inferred")?.textContent).toContain("Inferred");
    expect(root.querySelector(".knowledge-workbench__details")?.textContent).toContain("Topics");
    expect(root.querySelector(".knowledge-workbench__details")?.textContent).toContain("Connected nodes");
  });

  it("supports complete keyboard tabs and preserves focused tab across rendering", () => {
    const selected: string[] = [];
    const root = createTestDiv();
    const model = populatedWorkbenchModel();
    const actions = noOpWorkbenchActions({ onSelectTab: (tab) => selected.push(tab) });
    document.body.append(root);
    renderWorkbench(root, model, actions);
    const first = root.querySelector<HTMLButtonElement>('[role="tab"][data-tab="workbench"]')!;
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(selected).toEqual(["settings"]);
    expect(document.activeElement?.textContent).toBe("Settings");
    renderWorkbench(root, { ...model, activeTab: "settings" }, actions);
    expect(document.activeElement?.textContent).toBe("Settings");
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(selected).toEqual(["settings", "workbench"]);
    root.remove();
  });

  it("preserves map-search focus and selection across synchronous controller rerenders", async () => {
    class ItemViewSurface {
      readonly contentEl = createTestDiv();
    }
    const fixture = controllerFixture();
    const ConcreteWorkbenchView = createWorkbenchViewClass(ItemViewSurface as unknown as ItemViewConstructor, NORMAL_RUNTIME_POLICY);
    const view = new ConcreteWorkbenchView({} as WorkspaceLeaf, fixture.controller);
    document.body.append(view.contentEl);
    await view.onOpen();

    const first = view.contentEl.querySelector<HTMLInputElement>('input[type="search"]')!;
    first.focus();
    first.value = "a";
    first.setSelectionRange(1, 1, "none");
    first.dispatchEvent(new Event("input", { bubbles: true }));
    const second = view.contentEl.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(document.activeElement).toBe(second);
    expect([second.selectionStart, second.selectionEnd]).toEqual([1, 1]);

    second.value = "al";
    second.setSelectionRange(2, 2, "none");
    second.dispatchEvent(new Event("input", { bubbles: true }));
    const third = view.contentEl.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(document.activeElement).toBe(third);
    expect([third.selectionStart, third.selectionEnd]).toEqual([2, 2]);
    expect(fixture.controller.snapshot().searchQuery).toBe("al");
    await view.onClose();
    view.contentEl.remove();
  });

  it("shows named cancel controls only while running and announces terminal state", () => {
    const root = createTestDiv();
    const model = populatedWorkbenchModel();
    renderWorkbench(root, {
      ...model,
      scanProgress: { status: "running", completed: 3, total: 10, label: "Index" },
      mapProgress: { status: "running", completed: 500, label: "Map" },
    }, noOpWorkbenchActions());
    expect(Array.from(root.querySelectorAll("button")).map((button) => button.textContent)).toContain("Cancel Index");
    expect(Array.from(root.querySelectorAll("button")).map((button) => button.textContent)).toContain("Cancel Map");
    expect(root.querySelector('[role="status"]')?.textContent).toContain("Index running");
    renderWorkbench(root, {
      ...model,
      scanProgress: { status: "canceled", completed: 3, total: 10, label: "Index" },
    }, noOpWorkbenchActions());
    expect(root.querySelector('[role="status"]')?.textContent).toContain("Index Canceled");
    expect(Array.from(root.querySelectorAll("button")).some((button) => button.textContent?.startsWith("Cancel"))).toBe(false);
    expect(Array.from(root.querySelectorAll("button")).some((button) => button.textContent === "Retry Index")).toBe(true);
  });

  it("announces simultaneous running and terminal scan/map states without hiding either", () => {
    const root = createTestDiv();
    const model = populatedWorkbenchModel();
    renderWorkbench(root, {
      ...model,
      scanProgress: { status: "running", completed: 2, total: 4, label: "Index" },
      mapProgress: { status: "canceled", completed: 500, label: "Map" },
    }, noOpWorkbenchActions());
    expect(root.querySelector('[role="status"]')?.textContent).toContain("Index running");
    expect(root.querySelector('[role="status"]')?.textContent).toContain("Map Canceled");
    expect(root.querySelector(".knowledge-workbench__progress-row")?.textContent).toContain("Map Canceled");

    renderWorkbench(root, {
      ...model,
      scanProgress: { status: "error", completed: 2, total: 4, label: "Index" },
      mapProgress: { status: "running", completed: 1_000, label: "Map" },
    }, noOpWorkbenchActions());
    expect(root.querySelector('[role="status"]')?.textContent).toContain("Index Error");
    expect(root.querySelector('[role="status"]')?.textContent).toContain("Map running");
    expect(root.querySelector(".knowledge-workbench__progress-row")?.textContent).toContain("Index Error");

    renderWorkbench(root, {
      ...model,
      scanProgress: { status: "complete", completed: 4, total: 4, label: "Index" },
      mapProgress: { status: "idle", completed: 0, label: "Map" },
    }, noOpWorkbenchActions());
    expect(root.querySelector(".knowledge-workbench__progress-row")?.textContent).toContain("Index Complete");
  });

  it("routes map search input and result selection through actions", () => {
    const root = createTestDiv();
    const searches: string[] = [];
    const selected: string[] = [];
    renderWorkbench(root, populatedWorkbenchModel(), noOpWorkbenchActions({
      onSearchMap: (query) => searches.push(query),
      onSelectCenter: (center) => selected.push(center.id),
    }));
    const input = root.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = "beta";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLButtonElement>(".knowledge-workbench__search li button")!.click();
    expect(searches).toEqual(["beta"]);
    expect(selected).toEqual(["a"]);
  });

  it("windows future result lists beyond 100 rows without losing later entries", () => {
    const root = createTestDiv();
    const model = populatedWorkbenchModel();
    const searchResults = Array.from({ length: 150 }, (_, index) => ({
      documentId: `id-${index}`,
      path: `Notes/${index}.md`,
      title: `Result ${index}`,
      matchedBy: ["title"] as const,
    }));
    renderWorkbench(root, { ...model, searchResults }, noOpWorkbenchActions());
    const list = root.querySelector<HTMLElement>('.knowledge-workbench__search [data-total-rows="150"]')!;
    expect(list.textContent).toContain("Result 0");
    expect(list.textContent).not.toContain("Result 149");
    list.scrollTop = 10_000;
    list.dispatchEvent(new Event("scroll"));
    expect(list.textContent).toContain("Result 149");
    expect(list.querySelectorAll("li").length).toBeLessThanOrEqual(101);
  });

  it("routes a suggestion's primary action to preview without opening its note", () => {
    const root = createTestDiv();
    const model = populatedWorkbenchModel();
    const previews: string[] = [];
    const opens: string[] = [];
    renderWorkbench(root, {
      ...model,
      today: {
        ...model.today,
        nextItems: [{
          ...model.today.newItems[0]!,
          reason: "high-confidence-suggestion",
          suggestionId: "suggestion-1",
          actionLabel: "Review suggestion",
        }],
      },
    }, noOpWorkbenchActions({
      onPreviewSuggestion: (id) => previews.push(id),
      onOpenNote: (path) => opens.push(path),
    }));
    Array.from(root.querySelectorAll<HTMLButtonElement>(".knowledge-workbench__today-item button"))
      .find((button) => button.textContent === "Review suggestion")?.click();
    expect(previews).toEqual(["suggestion-1"]);
    expect(opens).toEqual([]);
  });

  it("renders accessible organization suggestions and previews the selected subset", () => {
    const root = createTestDiv();
    const previews: string[][] = [];
    let selectionChanges = 0;
    const suggestion = {
      operation: { id: "set-kind", kind: "set-owned-field" as const, path: "Notes/Alpha.md", field: "knowledge-workbench-kind" as const, before: { present: false } as const, after: { present: true, value: "note" } as const },
      localRationale: { source: "local" as const, summary: "Confirm the folder-derived note kind", signals: ["folder-rule:Notes"], confidence: "high" as const, impact: 80 },
      rationale: { source: "local" as const, summary: "Confirm the folder-derived note kind", signals: ["folder-rule:Notes"], confidence: "high" as const, impact: 80 },
    };
    renderWorkbench(root, {
      ...populatedWorkbenchModel(),
      activeTab: "suggestions",
      suggestions: [suggestion],
    }, noOpWorkbenchActions({
      onPreviewSuggestionIds: (ids) => previews.push([...ids]),
      onSuggestionSelectionChange: () => { selectionChanges += 1; },
    }));
    expect(root.querySelector('[aria-label="Organization suggestions"]')).not.toBeNull();
    const preview = Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Preview selected")!;
    expect(preview.disabled).toBe(true);
    const checkbox = root.querySelector<HTMLInputElement>('input[value="set-kind"]')!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(selectionChanges).toBe(1);
    expect(preview.disabled).toBe(false);
    preview.click();
    expect(previews).toEqual([["set-kind"]]);
  });

  it("keeps passive snapshots coherent and coalesces index publications on one macrotask", () => {
    const scheduler = manualProjectionScheduler();
    const fixture = controllerFixture({ projectionScheduler: scheduler.dependency });
    const before = fixture.controller.snapshot();
    const suggestionCalls = fixture.projection.suggestionCalls;
    let notifications = 0;
    fixture.controller.subscribe(() => { notifications += 1; });
    const first = fixture.index.activeRecords()[0]!;

    fixture.index.publishRecords([{ ...first, path: "Notes/Latest.md", title: "Latest" }]);
    fixture.index.publishRecords([{ ...first, path: "Notes/Newest.md", title: "Newest" }]);

    expect(fixture.controller.snapshot()).toEqual(before);
    expect(notifications).toBe(0);
    expect(scheduler.pendingCount).toBe(2);
    scheduler.drain();
    expect(notifications).toBe(1);
    expect(fixture.projection.suggestionCalls).toBe(suggestionCalls + 1);
    expect(fixture.controller.snapshot().today.newItems).toContainEqual(expect.objectContaining({
      id: first.id,
      path: "Notes/Newest.md",
    }));
  });

  it("leaves an unobserved projection dirty until a freshness-barrier command", () => {
    const scheduler = manualProjectionScheduler();
    const fixture = controllerFixture({ projectionScheduler: scheduler.dependency });
    const suggestionCalls = fixture.projection.suggestionCalls;
    const first = fixture.index.activeRecords()[0]!;

    fixture.index.publishRecords([{ ...first, path: "Notes/Newest.md", title: "Newest" }]);

    expect(scheduler.pendingCount).toBe(0);
    expect(fixture.projection.suggestionCalls).toBe(suggestionCalls);
    fixture.controller.searchMap("Newest");
    expect(fixture.projection.suggestionCalls).toBe(suggestionCalls + 1);
    expect(fixture.controller.snapshot().searchResults).toEqual([expect.objectContaining({
      documentId: first.id,
      path: "Notes/Newest.md",
    })]);
  });

  it("uses a quiet debounce with a 500 ms maximum wait", () => {
    const scheduler = manualProjectionScheduler();
    const fixture = controllerFixture({ projectionScheduler: scheduler.dependency });
    let notifications = 0;
    fixture.controller.subscribe(() => { notifications += 1; });
    const first = fixture.index.activeRecords()[0]!;

    for (let index = 0; index < 10; index += 1) {
      fixture.index.publishRecords([{ ...first, path: `Notes/Burst-${index}.md`, title: `Burst ${index}` }]);
      scheduler.advanceBy(49);
    }
    fixture.index.publishRecords([{ ...first, path: "Notes/Burst-final.md", title: "Burst final" }]);
    scheduler.advanceBy(9);
    expect(notifications).toBe(0);
    scheduler.advanceBy(1);

    expect(notifications).toBe(1);
    expect(scheduler.pendingCount).toBe(0);
    expect(fixture.controller.snapshot().today.newItems).toContainEqual(expect.objectContaining({
      path: "Notes/Burst-final.md",
    }));
  });

  it("repeats an atomic projection when an index publication is synchronously re-entrant", () => {
    const scheduler = manualProjectionScheduler();
    const fixture = controllerFixture({ projectionScheduler: scheduler.dependency });
    const first = fixture.index.activeRecords()[0]!;
    const suggestionCalls = fixture.projection.suggestionCalls;
    let notifications = 0;
    fixture.controller.subscribe(() => { notifications += 1; });
    fixture.projection.beforeNextSuggestion = () => {
      fixture.index.publishRecords([{ ...first, path: "Notes/Reentrant-latest.md", title: "Reentrant latest" }]);
    };

    fixture.index.publishRecords([{ ...first, path: "Notes/Reentrant-intermediate.md", title: "Reentrant intermediate" }]);
    scheduler.drain();

    expect(notifications).toBe(1);
    expect(fixture.projection.suggestionCalls).toBe(suggestionCalls + 2);
    expect(fixture.controller.snapshot().today.newItems).toContainEqual(expect.objectContaining({
      path: "Notes/Reentrant-latest.md",
    }));
  });

  it("preserves the last coherent snapshot when projection fails and retries at a later barrier", () => {
    const scheduler = manualProjectionScheduler();
    const fixture = controllerFixture({ projectionScheduler: scheduler.dependency });
    const before = fixture.controller.snapshot();
    const first = fixture.index.activeRecords()[0]!;
    fixture.controller.subscribe(() => undefined);
    fixture.projection.failNext = new Error("private projection detail");

    expect(() => fixture.index.publishRecords([
      { ...first, path: "Notes/Retry-current.md", title: "Retry current" },
    ])).not.toThrow();
    expect(() => scheduler.drain()).not.toThrow();

    const failed = fixture.controller.snapshot();
    expect(failed.today).toEqual(before.today);
    expect(failed.suggestions).toEqual(before.suggestions);
    expect(failed.statusMessage).toBe("Workbench projection refresh failed");
    fixture.controller.searchMap("Retry current");
    expect(fixture.controller.snapshot().searchResults).toEqual([expect.objectContaining({
      path: "Notes/Retry-current.md",
    })]);
  });

  it("isolates a throwing projection scheduler from index publication", () => {
    const scheduler: ProjectionSchedulerDependency = {
      now: () => 0,
      schedule: () => { throw new Error("scheduler unavailable"); },
      cancel: () => undefined,
    };
    const fixture = controllerFixture({ projectionScheduler: scheduler });
    const before = fixture.controller.snapshot();
    let notifications = 0;
    fixture.controller.subscribe(() => { notifications += 1; });
    const first = fixture.index.activeRecords()[0]!;

    expect(() => fixture.index.publishRecords([
      { ...first, path: "Notes/Scheduler-current.md", title: "Scheduler current" },
    ])).not.toThrow();
    expect(fixture.controller.snapshot()).toEqual(before);
    expect(notifications).toBe(0);
    fixture.controller.searchMap("Scheduler current");
    expect(fixture.controller.snapshot().searchResults).toHaveLength(1);
  });

  it("cancels owned projection timers and ignores callbacks that arrive after disposal", () => {
    const callbacks: (() => void)[] = [];
    let cancelCalls = 0;
    const scheduler: ProjectionSchedulerDependency = {
      now: () => 0,
      schedule(callback) {
        callbacks.push(callback);
        return callback;
      },
      cancel: () => { cancelCalls += 1; },
    };
    const fixture = controllerFixture({ projectionScheduler: scheduler });
    const suggestionCalls = fixture.projection.suggestionCalls;
    let notifications = 0;
    fixture.controller.subscribe(() => { notifications += 1; });
    const first = fixture.index.activeRecords()[0]!;

    fixture.index.publishRecords([{ ...first, path: "Notes/Disposed.md", title: "Disposed" }]);
    expect(callbacks).toHaveLength(2);
    fixture.controller.dispose();
    expect(cancelCalls).toBe(2);
    for (const callback of callbacks) callback();
    expect(fixture.projection.suggestionCalls).toBe(suggestionCalls);
    expect(notifications).toBe(0);
  });

  it("refreshes a stale visible suggestion before allowing its preview action", async () => {
    const scheduler = manualProjectionScheduler();
    const fixture = controllerFixture({ activeIndex: true, projectionScheduler: scheduler.dependency });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      folderRules: [{ prefix: "Notes", kind: "note" }],
      writePreviewAcknowledged: true,
      writeEnabled: true,
    });
    const stale = fixture.controller.refreshSuggestions().find((suggestion) => (
      "path" in suggestion.operation && suggestion.operation.path === "Notes/Alpha.md"
    ))!;
    let notifications = 0;
    fixture.controller.subscribe(() => { notifications += 1; });
    const records = fixture.index.activeRecords().map((record) => record.id === "a"
      ? { ...record, kind: "note" as const, ownedFields: { "knowledge-workbench-kind": "note" as const } }
      : record);

    fixture.index.publishRecords(records);
    expect(notifications).toBe(0);
    expect((fixture.controller.snapshot().suggestions ?? []).map((value) => value.operation.id)).toContain(stale.operation.id);
    await fixture.controller.previewSuggestionIds([stale.operation.id]);

    expect(notifications).toBe(1);
    expect(fixture.changePreview.planCalls).toBe(0);
    expect((fixture.controller.snapshot().suggestions ?? []).map((value) => value.operation.id)).not.toContain(stale.operation.id);
  });

  it("invalidates a pending map immediately and refocuses only after deferred projection", async () => {
    const scheduler = manualProjectionScheduler();
    const fixture = controllerFixture({ pauseMap: true, projectionScheduler: scheduler.dependency });
    const firstRecord = fixture.index.activeRecords()[0]!;
    const firstMap = fixture.controller.selectCenter({ kind: "document", id: firstRecord.id });
    const updated = [{ ...firstRecord, path: "Notes/Map-current.md", title: "Map current" }];

    fixture.index.publishRecords(updated);
    expect(fixture.map.inputs).toHaveLength(1);
    await firstMap;
    expect(fixture.controller.snapshot().map.selected).toBeNull();
    scheduler.drain();
    expect(fixture.map.inputs).toHaveLength(2);
    expect(fixture.map.inputs[1]?.records.map((record) => record.path)).toEqual(["Notes/Map-current.md"]);
    fixture.map.resolve(1, firstRecord.id);
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.controller.snapshot().map.selected?.path).toBe("Notes/Map-current.md");
  });

  it("terminates invalidated map progress when deferred projection fails and remains usable", async () => {
    const scheduler = manualProjectionScheduler();
    const fixture = controllerFixture({ pauseMap: true, projectionScheduler: scheduler.dependency });
    const [firstRecord, secondRecord] = fixture.index.activeRecords();
    const firstMap = fixture.controller.selectCenter({ kind: "document", id: firstRecord!.id });
    fixture.map.progress(0, 500);
    fixture.projection.failNext = new Error("private projection detail");

    fixture.index.publishRecords(fixture.index.activeRecords().map((record) => record.id === firstRecord!.id
      ? { ...record, path: "Notes/Projection-fails.md", title: "Projection fails" }
      : record));
    await firstMap;
    expect(() => scheduler.drain()).not.toThrow();

    const failed = fixture.controller.snapshot();
    expect(failed.statusMessage).toBe("Workbench projection refresh failed");
    expect(failed.statusMessage).not.toContain("private");
    const nextMap = fixture.controller.selectCenter({ kind: "document", id: secondRecord!.id });
    expect(fixture.map.inputs.at(-1)?.center).toEqual({ kind: "document", id: secondRecord!.id });
    fixture.controller.cancelMap();
    await nextMap;
    expect(fixture.controller.snapshot().mapProgress.status).toBe("canceled");
    expect(failed.mapProgress).toMatchObject({ status: "canceled", completed: 500 });
  });

  it("consumes pending projection timers at a freshness barrier and refocuses the current center once", async () => {
    const scheduler = manualProjectionScheduler();
    const fixture = controllerFixture({ pauseMap: true, projectionScheduler: scheduler.dependency });
    const firstRecord = fixture.index.activeRecords()[0]!;
    const firstMap = fixture.controller.selectCenter({ kind: "document", id: firstRecord.id });
    const updated = [{ ...firstRecord, path: "Notes/Barrier-current.md", title: "Barrier current" }];

    fixture.index.publishRecords(updated);
    expect(fixture.map.inputs).toHaveLength(1);
    expect(scheduler.pendingCount).toBe(2);
    fixture.controller.searchMap("current");

    expect(scheduler.pendingCount).toBe(0);
    expect(fixture.map.inputs).toHaveLength(2);
    expect(fixture.map.inputs[1]?.records.map((record) => record.path)).toEqual(["Notes/Barrier-current.md"]);
    scheduler.drain();
    expect(fixture.map.inputs).toHaveLength(2);
    await firstMap;
    fixture.map.resolve(1, firstRecord.id);
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.controller.snapshot().map.selected?.path).toBe("Notes/Barrier-current.md");
  });

  it("projects unresolved suggestions into Today and removes them after confirmation", async () => {
    const fixture = controllerFixture({ activeIndex: true });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      folderRules: [{ prefix: "Notes", kind: "note" }],
      writePreviewAcknowledged: true,
      writeEnabled: true,
    });
    const suggestions = fixture.controller.refreshSuggestions();
    expect(suggestions.map((value) => value.operation.kind)).toContain("set-owned-field");
    expect(fixture.controller.snapshot().today.nextItems[0]).toMatchObject({
      suggestionId: suggestions[0]?.operation.id,
      actionLabel: "Review property",
    });
    await fixture.controller.previewSuggestionIds([suggestions[0]!.operation.id]);
    expect(fixture.changePreview.planCalls).toBe(1);
    expect(fixture.controller.snapshot().suggestions).toEqual([]);
    expect(fixture.controller.snapshot().today.nextItems).toEqual([]);
    expect(fixture.controller.snapshot().statusMessage).toBe("Changes completed");
    expect(fixture.transactions.calls).toHaveLength(1);
    expect(fixture.vault.writeCalls).toEqual([]);
  });

  it("persists sample acknowledgement without enabling writes", async () => {
    const fixture = controllerFixture();
    await fixture.controller.previewSampleChange();
    expect(fixture.changePreview.sampleCalls).toBe(1);
    expect(fixture.store.settings()).toMatchObject({ writePreviewAcknowledged: true, writeEnabled: false });
  });

  it("carries AI display wording with an immutable local plan-safety baseline", async () => {
    const fixture = controllerFixture({
      activeIndex: true,
      rationaleEnhancer: () => ({
        source: "ai-assisted",
        summary: "AI display wording",
        signals: ["invented"],
        confidence: "high",
        impact: Number.POSITIVE_INFINITY,
      }),
    });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      folderRules: [{ prefix: "Notes", kind: "note" }],
      writePreviewAcknowledged: true,
      writeEnabled: true,
    });
    const suggestion = fixture.controller.refreshSuggestions()[0]!;
    expect(suggestion.rationale).toMatchObject({ source: "ai-assisted", summary: "AI display wording", impact: 80 });
    expect(suggestion.localRationale).toMatchObject({ source: "local", impact: 80 });
    await fixture.controller.previewSuggestionIds([suggestion.operation.id]);
    expect(fixture.changePreview.lastPreview?.plan.rationales[suggestion.operation.id]).toEqual(suggestion.localRationale);
    expect(fixture.changePreview.lastPreview?.plan.localRationales[suggestion.operation.id]).toMatchObject({
      source: "local",
      impact: 80,
    });
    expect(fixture.controller.snapshot().today.nextItems).toEqual([]);
  });

  it("delegates quick capture without changing plugin data", async () => {
    const fixture = controllerFixture();
    const before = fixture.store.operational();
    await fixture.controller.startQuickCapture();
    expect(fixture.quickCapture.calls).toBe(1);
    expect(fixture.store.operational()).toEqual(before);
  });

  it("refreshes once after pin or dismissal persistence succeeds", async () => {
    const fixture = controllerFixture();
    let emissions = 0;
    fixture.controller.subscribe(() => { emissions += 1; });
    await fixture.controller.pin("a");
    await fixture.controller.dismiss("b", 10);
    expect(emissions).toBe(2);
  });

  it("keeps snapshot and emissions unchanged when pin or dismissal persistence fails", async () => {
    const fixture = controllerFixture();
    let emissions = 0;
    fixture.controller.subscribe(() => { emissions += 1; });
    const before = fixture.controller.snapshot();
    fixture.store.failNext = new Error("save failed");
    await expect(fixture.controller.pin("a")).rejects.toThrow("save failed");
    fixture.store.failNext = new Error("save failed");
    await expect(fixture.controller.dismiss("b", 10)).rejects.toThrow("save failed");
    expect(emissions).toBe(0);
    expect(fixture.controller.snapshot()).toEqual(before);
  });

  it("uses one initial scan promise and resumes only after successful promotion", async () => {
    const fixture = controllerFixture({ pauseScan: true });
    const first = fixture.controller.startInitialScan();
    const duplicate = fixture.controller.startInitialScan();
    expect(first).toBe(duplicate);
    await Promise.resolve();
    expect(fixture.index.buildCalls).toBe(1);
    expect(fixture.queue.pauseCalls).toBe(1);
    fixture.index.resolveScan();
    await first;
    expect(fixture.queue.resumeCalls).toBe(1);
    expect(fixture.controller.snapshot().scanProgress.status).toBe("complete");
  });

  it("keeps initial scan single-flight even when a subscriber retries reentrantly", async () => {
    const fixture = controllerFixture({ pauseScan: true });
    let nested: Promise<void> | null = null;
    fixture.controller.subscribe(() => {
      if (nested === null && fixture.controller.snapshot().scanProgress.status === "running") {
        nested = fixture.controller.startInitialScan();
      }
    });
    const first = fixture.controller.startInitialScan();
    expect(nested).toBe(first);
    await Promise.resolve();
    expect(fixture.index.buildCalls).toBe(1);
    fixture.index.resolveScan();
    await first;
  });

  it("announces and cancels long scan and map calculations", async () => {
    const fixture = controllerFixture({ pauseScan: true, pauseMap: true });
    const scan = fixture.controller.startInitialScan();
    expect(fixture.controller.snapshot().scanProgress.status).toBe("running");
    fixture.controller.cancelScan();
    await scan;
    expect(fixture.controller.snapshot().scanProgress.status).toBe("canceled");
    expect(fixture.queue.resumeCalls).toBe(0);
    const map = fixture.controller.selectCenter({ kind: "document", id: "a" });
    fixture.controller.cancelMap();
    await map;
    expect(fixture.controller.snapshot().mapProgress.status).toBe("canceled");
  });

  it("resumes buffered events after canceled or failed scans only with a prior active index", async () => {
    const canceled = controllerFixture({ pauseScan: true, activeIndex: true });
    const scan = canceled.controller.startInitialScan();
    canceled.controller.cancelScan();
    await scan;
    expect(canceled.queue.resumeCalls).toBe(1);

    const failed = controllerFixture({ scanError: new Error("scan failed"), activeIndex: true });
    await failed.controller.startInitialScan();
    expect(failed.controller.snapshot().scanProgress.status).toBe("error");
    expect(failed.queue.resumeCalls).toBe(1);

    const empty = controllerFixture({ scanError: new Error("scan failed") });
    await empty.controller.startInitialScan();
    expect(empty.queue.resumeCalls).toBe(0);
  });

  it("keeps promoted data active and reports an error when queue flushing fails", async () => {
    const fixture = controllerFixture({ flushError: new Error("flush failed") });
    await fixture.controller.startInitialScan();
    expect(fixture.store.activeIndex()).not.toBeNull();
    expect(fixture.controller.snapshot().scanProgress.status).toBe("error");
  });

  it("lets only the latest map request publish progress, result, and completion", async () => {
    const fixture = controllerFixture({ pauseMap: true });
    const first = fixture.controller.selectCenter({ kind: "document", id: "a" });
    const second = fixture.controller.selectCenter({ kind: "document", id: "b" });
    fixture.map.progress(0, 500);
    fixture.map.progress(1, 1_000);
    fixture.map.resolve(1, "b");
    await second;
    fixture.map.reject(0, new Error("stale failure"));
    await first;
    const snapshot = fixture.controller.snapshot();
    expect(snapshot.map.selected?.nodeId).toBe("b");
    expect(snapshot.mapProgress).toMatchObject({ status: "complete", completed: 1_000 });
  });

  it("publishes only the first and 50,000-delta map checkpoints while isolating listeners", async () => {
    const fixture = controllerFixture({ pauseMap: true });
    const publications: { status: string; completed: number }[] = [];
    fixture.controller.subscribe(() => { throw new Error("listener failed"); });
    fixture.controller.subscribe(() => {
      const progress = fixture.controller.snapshot().mapProgress;
      publications.push({ status: progress.status, completed: progress.completed });
    });
    const map = fixture.controller.selectCenter({ kind: "document", id: "a" });
    publications.length = 0;

    fixture.map.progress(0, 500);
    fixture.map.progress(0, 1_000);
    fixture.map.progress(0, 50_000);
    fixture.map.progress(0, 50_500);
    fixture.map.resolve(0, "a");
    await map;

    expect(publications).toEqual([
      { status: "running", completed: 500 },
      { status: "running", completed: 50_500 },
      { status: "complete", completed: 50_500 },
    ]);
    expect(fixture.controller.snapshot().mapProgress).toMatchObject({
      status: "complete",
      completed: 50_500,
    });
  });

  it.each(["canceled", "error"] as const)(
    "publishes the latest completed count for a %s map and ignores stale callbacks",
    async (terminal) => {
      const fixture = controllerFixture({ pauseMap: true });
      const publications: { status: string; completed: number }[] = [];
      fixture.controller.subscribe(() => { throw new Error("listener failed"); });
      fixture.controller.subscribe(() => {
        const progress = fixture.controller.snapshot().mapProgress;
        publications.push({ status: progress.status, completed: progress.completed });
      });
      const map = fixture.controller.selectCenter({ kind: "document", id: "a" });
      publications.length = 0;

      for (const completed of [500, 1_000, 50_000, 50_500]) {
        fixture.map.progress(0, completed);
      }
      if (terminal === "canceled") fixture.controller.cancelMap();
      else fixture.map.reject(0, new Error("private map detail"));
      await map;

      expect(publications).toEqual([
        { status: "running", completed: 500 },
        { status: "running", completed: 50_500 },
        { status: terminal, completed: 50_500 },
      ]);
      const publicationCount = publications.length;
      fixture.map.progress(0, 100_500);
      expect(publications).toHaveLength(publicationCount);
      const snapshot = fixture.controller.snapshot();
      expect(snapshot.mapProgress).toMatchObject({ status: terminal, completed: 50_500 });
      if (terminal === "error") {
        expect(snapshot.statusMessage).toBe("Map calculation failed");
        expect(snapshot.statusMessage).not.toContain("private");
      }

      const nextMap = fixture.controller.selectCenter({ kind: "document", id: "b" });
      fixture.map.progress(1, 500);
      expect(publications.at(-1)).toEqual({ status: "running", completed: 500 });
      fixture.controller.cancelMap();
      await nextMap;
    },
  );

  it("searches indexed records, refocuses a selected result, and recomputes filters", async () => {
    const fixture = controllerFixture();
    fixture.controller.searchMap("alpha");
    expect(fixture.controller.snapshot().searchResults.map((result) => result.documentId)).toEqual(["a"]);
    await fixture.controller.selectCenter({ kind: "document", id: "a" });
    await fixture.controller.setMapFilter("reference");
    expect(fixture.map.inputs.map((input) => input.filter)).toEqual(["all", "reference"]);
  });

  it("returns detached snapshots and emits nothing after disposal", async () => {
    const fixture = controllerFixture({ pauseMap: true });
    const snapshot = fixture.controller.snapshot() as unknown as { searchResults: unknown[] };
    snapshot.searchResults.push("corruption");
    expect(fixture.controller.snapshot().searchResults).toEqual([]);
    let emissions = 0;
    fixture.controller.subscribe(() => { emissions += 1; });
    const map = fixture.controller.selectCenter({ kind: "document", id: "a" });
    fixture.controller.dispose();
    expect(fixture.quickCapture.disposeCalls).toBe(1);
    fixture.map.resolve(0, "a");
    await map;
    expect(emissions).toBe(1);
  });

  it("aborts scans on disposal without resuming buffered work or emitting afterward", async () => {
    const fixture = controllerFixture({ pauseScan: true, activeIndex: true });
    let emissions = 0;
    fixture.controller.subscribe(() => { emissions += 1; });
    const scan = fixture.controller.startInitialScan();
    await Promise.resolve();
    const beforeDispose = emissions;
    fixture.controller.dispose();
    await scan;
    expect(fixture.queue.resumeCalls).toBe(0);
    expect(emissions).toBe(beforeDispose);
  });

  it("fences exclusion continuation when disposal happens while it awaits a scan", async () => {
    const fixture = controllerFixture({ pauseScan: true, activeIndex: true });
    const scan = fixture.controller.startInitialScan();
    await Promise.resolve();
    const pauseCalls = fixture.queue.pauseCalls;
    const update = fixture.controller.setExcludedPrefixes(["Archive"]);
    fixture.controller.dispose();
    await update;
    await scan;
    expect(fixture.queue.pauseCalls).toBe(pauseCalls);
    expect(fixture.index.reconcileCalls).toBe(0);
    expect(fixture.store.settings().excludedPrefixes).toEqual([]);
  });

  it("recovers a prior active queue and exposes retryable errors when exclusion persistence fails", async () => {
    const prior = controllerFixture({ activeIndex: true });
    prior.store.failNext = new Error("settings unavailable");
    await expect(prior.controller.setExcludedPrefixes(["Archive"])).rejects.toThrow("settings unavailable");
    expect(prior.queue.resumeCalls).toBe(1);
    expect(prior.controller.snapshot()).toMatchObject({ status: "error" });

    const empty = controllerFixture();
    empty.store.failNext = new Error("settings unavailable");
    await expect(empty.controller.setExcludedPrefixes(["Archive"])).rejects.toThrow("settings unavailable");
    expect(empty.queue.resumeCalls).toBe(0);
    expect(empty.controller.snapshot()).toMatchObject({ status: "error" });
  });

  it("recovers a prior active queue when exclusion reconciliation fails", async () => {
    const fixture = controllerFixture({ activeIndex: true, reconcileError: new Error("reconcile failed") });
    await expect(fixture.controller.setExcludedPrefixes(["Archive"])).rejects.toThrow("reconcile failed");
    expect(fixture.queue.resumeCalls).toBe(1);
    expect(fixture.controller.snapshot()).toMatchObject({ status: "error" });
  });

  it("aborts an old-record map and recomputes the current center after index records change", async () => {
    const scheduler = manualProjectionScheduler();
    const fixture = controllerFixture({ pauseMap: true, projectionScheduler: scheduler.dependency });
    const first = fixture.controller.selectCenter({ kind: "document", id: "a" });
    const updated = [{
      ...fixture.index.activeRecords()[0]!,
      path: "Notes/Alpha moved.md",
      title: "Alpha moved",
    }];
    fixture.index.publishRecords(updated);
    expect(fixture.map.inputs).toHaveLength(1);
    await first;
    scheduler.drain();
    expect(fixture.map.inputs).toHaveLength(2);
    expect(fixture.map.inputs[1]?.records.map((record) => record.path)).toEqual(["Notes/Alpha moved.md"]);
    fixture.map.resolve(1, "a");
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.controller.snapshot().map.selected?.path).toBe("Notes/Alpha moved.md");
  });

  it("persists folder rules, file-open time, and exclusions only through controller safety paths", async () => {
    const fixture = controllerFixture();
    await fixture.controller.applyFolderRules([{ prefix: "References", kind: "reference" }]);
    expect(fixture.store.settings().folderRules).toEqual([{ prefix: "References", kind: "reference" }]);
    expect(fixture.store.settings()).toMatchObject({ writeEnabled: false, writePreviewAcknowledged: false });
    expect(fixture.index.reconcileCalls).toBe(0);
    await fixture.controller.recordFileOpen("Notes/Alpha.md");
    expect(fixture.store.operational().lastOpened).toEqual({ a: 100 });
    await fixture.controller.setExcludedPrefixes(["Archive"]);
    expect(fixture.store.settings().excludedPrefixes).toEqual(["Archive"]);
    expect(fixture.index.reconcileCalls).toBe(1);
    expect(fixture.queue.pauseCalls).toBe(2);
    expect(fixture.queue.resumeCalls).toBe(1);
  });

  it("records a Markdown file-open before initial promotion and projects it when the record arrives", async () => {
    const fixture = controllerFixture();
    await fixture.controller.recordFileOpen(".\\Notes\\New.md");
    expect(fixture.store.operational().lastOpened).toEqual({ "Notes/New.md": 100 });
    const before = fixture.controller.snapshot();
    fixture.index.publishRecords([{
      ...fixture.index.activeRecords()[0]!,
      id: "Notes/New.md",
      path: "Notes/New.md",
      basename: "New",
      title: "New",
      mtime: 10,
      ownedFields: { "knowledge-workbench-kind": "note" },
    }]);
    expect(fixture.controller.snapshot()).toEqual(before);
    fixture.controller.refreshSuggestions();
    expect(fixture.controller.snapshot().today.continueItems).toContainEqual(expect.objectContaining({
      id: "Notes/New.md",
      reason: "recently-opened",
    }));
  });

  it("bootstraps metadata readiness both before and after the global resolved event", async () => {
    const after = metadataAdapterFixture({ resolved: true });
    after.adapter.startMetadataTracking();
    expect(await after.adapter.inboundLinks("Target.md")).toEqual(["Source.md"]);

    const before = metadataAdapterFixture({ resolved: false });
    before.adapter.startMetadataTracking();
    expect(await before.adapter.inboundLinks("Target.md")).toBeNull();
    before.resolveAll();
    expect(await before.adapter.inboundLinks("Target.md")).toEqual(["Source.md"]);
    expect(before.events).toContainEqual({ kind: "modify", path: "Source.md" });
  });

  it("resolves headings, aliases, and frontmatter links to destination paths", async () => {
    const fixture = metadataAdapterFixture({
      resolved: true,
      sourceLinks: ["Target#A heading|an alias"],
      frontmatterLinks: ["Different|label", "Missing"],
      destinations: {
        "Target": "Library/Target.md",
        "Different": "Different.md",
      },
    });
    fixture.adapter.startMetadataTracking();
    const note = await fixture.adapter.readNote("Source.md");
    expect(note?.outgoingLinks).toEqual(["Different.md", "Library/Target.md"]);
    expect(note?.basename).toBe("Source");
  });

  it("reindexes changed and resolved metadata without treating unresolved text as a path", async () => {
    const fixture = metadataAdapterFixture({ resolved: true, sourceLinks: ["Missing"] });
    fixture.adapter.startMetadataTracking();
    fixture.change("Source.md", ["Target"]);
    expect(await fixture.adapter.inboundLinks("Target.md")).toBeNull();
    expect((await fixture.adapter.readNote("Source.md"))?.outgoingLinks).toEqual(["Target.md"]);
    fixture.resolve("Source.md");
    expect(await fixture.adapter.inboundLinks("Target.md")).toEqual(["Source.md"]);
    expect(fixture.events.filter((event) => event.kind === "modify" && event.path === "Source.md")).toHaveLength(2);
  });

  it("does not clear a pre-layout changed marker when vault tracking starts", async () => {
    const fixture = metadataAdapterFixture({ resolved: true });
    fixture.adapter.startMetadataTracking();
    fixture.change("Source.md", ["Missing"]);
    fixture.adapter.startVaultTracking();
    expect(await fixture.adapter.inboundLinks("Target.md")).toBeNull();
    fixture.resolve("Source.md");
    expect(await fixture.adapter.inboundLinks("Target.md")).toEqual([]);
  });

  it("cleans old rename pending state and waits for the new path's metadata", async () => {
    const fixture = metadataAdapterFixture({ resolved: true });
    fixture.adapter.startMetadataTracking();
    fixture.adapter.startVaultTracking();
    fixture.rename("Source.md", "Renamed.md");
    expect(await fixture.adapter.inboundLinks("Target.md")).toBeNull();
    fixture.resolve("Renamed.md");
    expect(await fixture.adapter.inboundLinks("Target.md")).toEqual(["Renamed.md"]);
    expect(fixture.events).toContainEqual({ kind: "rename", path: "Renamed.md", oldPath: "Source.md" });
  });

  it("classifies md-to-txt, txt-to-md, and md-to-md renames without leaving stale index paths", async () => {
    const removed = metadataAdapterFixture({ resolved: true });
    removed.adapter.startMetadataTracking();
    removed.adapter.startVaultTracking();
    removed.rename("Source.md", "Source.txt");
    expect(removed.events.at(-1)).toEqual({ kind: "delete", path: "Source.md" });
    expect(await removed.adapter.inboundLinks("Target.md")).toEqual([]);

    removed.events.length = 0;
    removed.rename("Source.txt", "Restored.md");
    expect(removed.events).toEqual([{ kind: "create", path: "Restored.md" }]);
    expect(await removed.adapter.inboundLinks("Target.md")).toBeNull();
    removed.resolve("Restored.md");

    const renamed = metadataAdapterFixture({ resolved: true });
    renamed.adapter.startMetadataTracking();
    renamed.adapter.startVaultTracking();
    renamed.rename("Source.md", "Renamed.md");
    expect(renamed.events.at(-1)).toEqual({ kind: "rename", path: "Renamed.md", oldPath: "Source.md" });
    expect(await renamed.adapter.inboundLinks("Target.md")).toBeNull();
  });

  it("blocks inbound-link safety while even an unrelated Markdown source is pending", async () => {
    const fixture = metadataAdapterFixture({ resolved: true, includeUnrelated: true });
    fixture.adapter.startMetadataTracking();
    fixture.change("Unrelated.md", ["Missing"]);
    expect(await fixture.adapter.inboundLinks("Target.md")).toBeNull();
    fixture.resolve("Unrelated.md");
    expect(await fixture.adapter.inboundLinks("Target.md")).toEqual(["Source.md"]);
  });

  it("registers metadata and vault tracking idempotently and disposes every event ref", () => {
    const fixture = metadataAdapterFixture({ resolved: true });
    fixture.adapter.startMetadataTracking();
    fixture.adapter.startMetadataTracking();
    fixture.adapter.startVaultTracking();
    fixture.adapter.startVaultTracking();
    expect(fixture.listenerCounts()).toEqual({ metadata: 3, vault: 4 });
    fixture.adapter.dispose();
    expect(fixture.listenerCounts()).toEqual({ metadata: 0, vault: 0 });
  });

  it("creates no note when quick capture is canceled, escaped, closed, empty, reserved, or collides", async () => {
    const fixture = quickCaptureFixture();
    for (const action of ["cancel", "escape", "close"] as const) {
      fixture.modal[action]();
      await fixture.adapter.capture();
    }
    for (const title of ["", "CON", "existing", "Existing.md", "existing.MD."]) {
      fixture.modal.submit(title);
      await fixture.adapter.capture();
    }
    expect(fixture.vault.createCalls).toEqual([]);
    expect(fixture.workspace.openCalls).toEqual([]);
  });

  it("normalizes root and nested capture paths and appends .md exactly once", async () => {
    const root = quickCaptureFixture({ parentPath: "" });
    root.modal.submit("Root note.md");
    await expect(root.adapter.capture()).resolves.toBe("Root note.md");
    expect(root.fileManager.parentArgs).toEqual([["Active.md", "Root note.md"]]);

    const nested = quickCaptureFixture({ parentPath: "Inbox/Daily" });
    nested.modal.submit("Nested?.MD");
    await expect(nested.adapter.capture()).resolves.toBe("Inbox/Daily/Nested.md");
    expect(nested.vault.createCalls).toEqual([["Inbox/Daily/Nested.md", ""]]);
    expect(nested.workspace.openCalls).toEqual(["Inbox/Daily/Nested.md"]);
  });

  it("settles double submit once and creates at most one blank Markdown file", async () => {
    const fixture = quickCaptureFixture();
    fixture.modal.doubleSubmit("Only once");
    await fixture.adapter.capture();
    expect(fixture.vault.createCalls).toEqual([["Only once.md", ""]]);
    expect(fixture.workspace.openCalls).toEqual(["Only once.md"]);
  });

  it("rechecks collision immediately before create and never opens a raced file", async () => {
    const fixture = quickCaptureFixture({ createRace: true });
    fixture.modal.submit("Race");
    await expect(fixture.adapter.capture()).rejects.toThrow("File already exists");
    expect(fixture.vault.createCalls).toEqual([["Race.md", ""]]);
    expect(fixture.workspace.openCalls).toEqual([]);
  });

  it("keeps quick capture single-flight across fast double activation", async () => {
    const fixture = quickCaptureFixture();
    const first = fixture.adapter.capture();
    const second = fixture.adapter.capture();
    expect(second).toBe(first);
    fixture.modal.submit("Single modal");
    await expect(first).resolves.toBe("Single modal.md");
    expect(fixture.modal.instances).toBe(1);
    expect(fixture.vault.createCalls).toEqual([["Single modal.md", ""]]);
  });

  it("fences a pending quick capture after adapter disposal", async () => {
    const fixture = quickCaptureFixture();
    const pending = fixture.adapter.capture();
    fixture.adapter.dispose();
    fixture.modal.submit("Too late");
    await expect(pending).resolves.toBeNull();
    expect(fixture.vault.createCalls).toEqual([]);
    expect(fixture.workspace.openCalls).toEqual([]);
  });

  it("allows an in-flight create to finish after disposal but never opens the created note", async () => {
    const fixture = quickCaptureFixture({ pauseCreate: true });
    const pending = fixture.adapter.capture();
    fixture.modal.submit("Creating");
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.vault.createCalls).toEqual([["Creating.md", ""]]);
    fixture.adapter.dispose();
    fixture.vault.resolveCreate();
    await expect(pending).resolves.toBeNull();
    expect(fixture.workspace.openCalls).toEqual([]);
  });

  it("settles the real quick-capture modal exactly once for create, Escape, and ordinary close", async () => {
    class ModalSurface {
      readonly contentEl = createTestDiv();
      closeCalls = 0;
      onOpen(): void {}
      onClose(): void {}
      open(): void { this.onOpen(); }
      close(): void { this.closeCalls += 1; this.onClose(); }
      setTitle(): this { return this; }
    }
    const QuickCaptureModal = createQuickCaptureModalClass(ModalSurface as unknown as ModalConstructor);
    const created = new QuickCaptureModal({} as App);
    const createdResult = created.request();
    const input = created.contentEl.querySelector<HTMLInputElement>("input")!;
    input.value = "One";
    const form = created.contentEl.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await expect(createdResult).resolves.toBe("One");
    expect((created as unknown as ModalSurface).closeCalls).toBe(1);

    const escaped = new QuickCaptureModal({} as App);
    const escapedResult = escaped.request();
    escaped.contentEl.querySelector("form")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect(escapedResult).resolves.toBeNull();

    const canceled = new QuickCaptureModal({} as App);
    const canceledResult = canceled.request();
    canceled.cancel();
    await expect(canceledResult).resolves.toBeNull();

    const closed = new QuickCaptureModal({} as App);
    const closedResult = closed.request();
    closed.close();
    await expect(closedResult).resolves.toBeNull();
  });

  it("restores the quick-capture invoking element's focus after Escape", async () => {
    class ModalSurface {
      readonly contentEl = createTestDiv();
      constructor(readonly app: App) {}
      onOpen(): void {}
      onClose(): void {}
      open(): void { document.body.append(this.contentEl); this.onOpen(); }
      close(): void { this.onClose(); this.contentEl.remove(); }
      setTitle(): this { return this; }
    }
    const trigger = document.createElementNS("http://www.w3.org/1999/xhtml", "button") as HTMLButtonElement;
    trigger.textContent = "Quick capture";
    document.body.append(trigger);
    trigger.focus();
    const QuickCaptureModal = createQuickCaptureModalClass(ModalSurface as unknown as ModalConstructor);
    const modal = new QuickCaptureModal({} as App);
    const result = modal.request();
    modal.contentEl.querySelector("form")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect(result).resolves.toBeNull();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("binds one concrete WorkbenchView class to the injected ItemView base", async () => {
    class ItemViewSurface {
      readonly contentEl = createTestDiv();
    }
    const ConcreteWorkbenchView = createWorkbenchViewClass(ItemViewSurface as unknown as ItemViewConstructor, NORMAL_RUNTIME_POLICY);
    const controller = controllerFixture().controller;
    const instance = new ConcreteWorkbenchView({} as WorkspaceLeaf, controller);
    expect(instance).toBeInstanceOf(ItemViewSurface);
    expect(instance).toBeInstanceOf(ConcreteWorkbenchView);
    await instance.onOpen();
    expect(instance.contentEl.querySelector('[aria-label="Today"]')).not.toBeNull();
    await instance.onClose();
  });

  it("surfaces pin persistence rejection in the concrete workbench status", async () => {
    class ItemViewSurface {
      readonly contentEl = createTestDiv();
    }
    const fixture = controllerFixture();
    fixture.store.failNext = new Error("pin store failed");
    const WorkbenchView = createWorkbenchViewClass(ItemViewSurface as unknown as ItemViewConstructor, NORMAL_RUNTIME_POLICY);
    const view = new WorkbenchView({} as WorkspaceLeaf, fixture.controller);
    await view.onOpen();
    Array.from(view.contentEl.querySelectorAll<HTMLButtonElement>(".knowledge-workbench__today-item button"))
      .find((button) => button.textContent === "Pin")?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(view.contentEl.querySelector('[role="status"]')?.textContent).toContain("Pin failed: pin store failed");
    await view.onClose();
  });

  it("surfaces workspace-open rejection in the concrete workbench status", async () => {
    class ItemViewSurface {
      readonly contentEl = createTestDiv();
    }
    const fixture = controllerFixture({ workspaceError: new Error("leaf unavailable") });
    const WorkbenchView = createWorkbenchViewClass(ItemViewSurface as unknown as ItemViewConstructor, NORMAL_RUNTIME_POLICY);
    const view = new WorkbenchView({} as WorkspaceLeaf, fixture.controller);
    await view.onOpen();
    Array.from(view.contentEl.querySelectorAll<HTMLButtonElement>(".knowledge-workbench__today-item button"))
      .find((button) => button.textContent === "Review note")?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(view.contentEl.querySelector('[role="status"]')?.textContent).toContain("Open note failed: leaf unavailable");
    await view.onClose();
  });

  it("surfaces quick-capture rejection in the concrete workbench status", async () => {
    class ItemViewSurface {
      readonly contentEl = createTestDiv();
    }
    const fixture = controllerFixture({ quickCaptureError: new Error("create failed") });
    const WorkbenchView = createWorkbenchViewClass(ItemViewSurface as unknown as ItemViewConstructor, NORMAL_RUNTIME_POLICY);
    const view = new WorkbenchView({} as WorkspaceLeaf, fixture.controller);
    await view.onOpen();
    Array.from(view.contentEl.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Quick capture")?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(view.contentEl.querySelector('[role="status"]')?.textContent).toContain("Quick capture failed: create failed");
    await view.onClose();
  });

  it("activates one workbench leaf and reveals the same concrete view instance", async () => {
    const view = {};
    const leaf = {
      view,
      setViewStateCalls: 0,
      async setViewState(): Promise<void> { this.setViewStateCalls += 1; },
    };
    const workspace = {
      leaves: [] as typeof leaf[],
      revealCalls: [] as typeof leaf[],
      getLeavesOfType(): typeof leaf[] { return this.leaves; },
      getLeaf(): typeof leaf { this.leaves.push(leaf); return leaf; },
      async revealLeaf(value: typeof leaf): Promise<void> { this.revealCalls.push(value); },
    };
    await activateWorkbench({ workspace } as unknown as App);
    expect(leaf.setViewStateCalls).toBe(1);
    expect(workspace.revealCalls).toEqual([leaf]);
    expect(workspace.getLeavesOfType()[0]?.view).toBe(view);
  });

  it("reports a first-open activation rejection before a workbench view is mounted", async () => {
    const errors: unknown[] = [];
    const leaf = {
      async setViewState(): Promise<void> { throw new Error("view state unavailable"); },
    };
    runVisibleHostAction(
      () => activateWorkbench({
        workspace: {
          getLeavesOfType: () => [],
          getLeaf: () => leaf,
          revealLeaf: async () => undefined,
        },
      } as unknown as App),
      (error) => errors.push(error),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toEqual([expect.objectContaining({ message: "view state unavailable" })]);
  });

  it("surfaces a deferred non-concrete view once through the command host action", async () => {
    const activationStatuses: string[] = [];
    const hostStatuses: string[] = [];
    const notices: string[] = [];
    const errors: unknown[] = [];
    let resolveSurfaced: (() => void) | null = null;
    const surfaced = new Promise<void>((resolve) => { resolveSurfaced = resolve; });
    const leaf = { view: {} };
    let reveals = 0;
    runVisibleHostAction(
      () => requireActivatedWorkbench(
        {
          workspace: {
            getLeavesOfType: () => [leaf],
            getLeaf: () => leaf,
            revealLeaf: async () => { reveals += 1; },
          },
        } as unknown as App,
        () => false,
        (message) => activationStatuses.push(message),
      ),
      (error) => {
        errors.push(error);
        surfaceVisibleHostError(
          "Open workbench failed",
          error,
          () => true,
          (message) => hostStatuses.push(message),
          (message) => notices.push(message),
        );
        resolveSurfaced?.();
      },
    );
    await surfaced;
    expect(reveals).toBe(2);
    expect(errors[0]).toBeInstanceOf(WorkbenchViewActivationError);
    expect(activationStatuses).toHaveLength(1);
    expect(hostStatuses).toHaveLength(1);
    expect(notices).toHaveLength(1);
  });

  it("surfaces one startup layout rejection through the visible host seam", async () => {
    const statuses: string[] = [];
    const notices: string[] = [];
    runVisibleHostAction(
      async () => { throw new Error("inventory unavailable"); },
      (error) => surfaceVisibleHostError(
        "Layout initialization failed",
        error,
        () => true,
        (message) => statuses.push(message),
        (message) => notices.push(message),
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(statuses).toEqual(["Layout initialization failed: inventory unavailable"]);
    expect(notices).toEqual(["Layout initialization failed: inventory unavailable"]);
  });

  it("suppresses host status and Notice after unload invalidates the captured epoch", async () => {
    const lifecycle = new LifecycleEpoch();
    const epoch = lifecycle.begin();
    const statuses: string[] = [];
    const notices: string[] = [];
    const deferred: { reject?: (error: Error) => void } = {};
    runVisibleHostAction(
      () => new Promise<void>((_resolve, reject) => { deferred.reject = reject; }),
      (error) => surfaceVisibleHostError(
        "Layout initialization failed",
        error,
        () => lifecycle.owns(epoch),
        (message) => statuses.push(message),
        (message) => notices.push(message),
      ),
    );
    lifecycle.invalidate();
    deferred.reject?.(new Error("late failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(statuses).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("notifies once when startup and command share one failing layout gate", async () => {
    const gate = new RetryableAsyncGate();
    const notices: string[] = [];
    const runLayout = (): Promise<void> => gate.run(async () => {
      const error = new Error("shared layout failure");
      surfaceVisibleHostError(
        "Layout initialization failed",
        error,
        () => true,
        () => undefined,
        (message) => notices.push(message),
      );
      throw new SurfacedHostError(error);
    });
    void runLayout().catch(() => undefined);
    runVisibleHostAction(runLayout, (error) => {
      if (error instanceof SurfacedHostError) return;
      surfaceVisibleHostError(
        "Open workbench failed",
        error,
        () => true,
        () => undefined,
        (message) => notices.push(message),
      );
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(notices).toEqual(["Layout initialization failed: shared layout failure"]);
  });

  it("invalidates stale async lifecycle continuations before they can assign host state", async () => {
    const lifecycle = new LifecycleEpoch();
    const epoch = lifecycle.begin();
    let assigned = false;
    const continuation = Promise.resolve().then(() => {
      if (lifecycle.owns(epoch)) assigned = true;
    });
    lifecycle.invalidate();
    await continuation;
    expect(assigned).toBe(false);
  });

  it("retries a failed async layout gate and marks complete only after success", async () => {
    const gate = new RetryableAsyncGate();
    let attempts = 0;
    await expect(gate.run(async () => {
      attempts += 1;
      throw new Error("reconcile failed");
    })).rejects.toThrow("reconcile failed");
    expect(gate.isComplete()).toBe(false);
    await gate.run(async () => { attempts += 1; });
    expect(gate.isComplete()).toBe(true);
    expect(attempts).toBe(2);
  });

  it("clears a surfaced layout audit failure after an explicit retry succeeds", async () => {
    const gate = new RetryableAsyncGate();
    const fixture = controllerFixture();
    let auditCalls = 0;
    const operations = {
      auditRecovery: async () => {
        auditCalls += 1;
        if (auditCalls === 1) throw new Error("audit reload unavailable");
      },
      refreshHistory: async () => undefined,
      initializeIndex: async () => undefined,
      reportReady: () => fixture.controller.reportReady(),
    };
    const run = (): Promise<void> => gate.run(() => initializeRecoveredLayout(operations, () => true));

    await expect(run()).rejects.toThrow("audit reload unavailable");
    fixture.controller.reportError("Layout initialization failed: audit reload unavailable");
    expect(fixture.controller.snapshot()).toMatchObject({
      status: "error",
      statusMessage: "Layout initialization failed: audit reload unavailable",
    });
    await run();

    expect(auditCalls).toBe(2);
    expect(fixture.controller.snapshot().status).toBe("ready");
    expect(fixture.controller.snapshot().statusMessage).toBeUndefined();
    expect(gate.isComplete()).toBe(true);
  });

  it("recovers the active queue after reconcile failure and succeeds on the second layout attempt", async () => {
    const gate = new RetryableAsyncGate();
    let reconcileCalls = 0;
    let resumeCalls = 0;
    const operations = {
      hasActiveIndex: () => true,
      startInitialScan: async () => undefined,
      reconcileInventory: async () => {
        reconcileCalls += 1;
        if (reconcileCalls === 1) throw new Error("inventory unavailable");
      },
      resumeAndFlush: async () => { resumeCalls += 1; },
    };
    await expect(gate.run(() => initializeIndexForLayout(operations, () => true)))
      .rejects.toThrow("inventory unavailable");
    expect({ reconcileCalls, resumeCalls, complete: gate.isComplete() }).toEqual({
      reconcileCalls: 1,
      resumeCalls: 1,
      complete: false,
    });
    await gate.run(() => initializeIndexForLayout(operations, () => true));
    expect({ reconcileCalls, resumeCalls, complete: gate.isComplete() }).toEqual({
      reconcileCalls: 2,
      resumeCalls: 2,
      complete: true,
    });
  });

  it("re-reveals once when a deferred workbench view is not yet the expected concrete class", async () => {
    const expected = {};
    const leaf = {
      view: {},
      async setViewState(): Promise<void> {},
    };
    let reveals = 0;
    const workspace = {
      getLeavesOfType: () => [leaf],
      getLeaf: () => leaf,
      revealLeaf: async (): Promise<void> => {
        reveals += 1;
        if (reveals === 2) leaf.view = expected;
      },
    };
    await expect(activateWorkbenchWithRetry(
      { workspace } as unknown as App,
      (view) => view === expected,
    )).resolves.toBe(true);
    expect(reveals).toBe(2);

    leaf.view = {};
    reveals = 0;
    await expect(activateWorkbenchWithRetry(
      { workspace: { ...workspace, revealLeaf: async () => { reveals += 1; } } } as unknown as App,
      (view) => view === expected,
    )).resolves.toBe(false);
    expect(reveals).toBe(2);
  });

  it("keeps writes locked and routes settings actions through the controller", async () => {
    class SettingsSurface {
      readonly containerEl = createTestDiv();
    }
    const calls: string[] = [];
    const controller = {
      settings: () => ({
        writeEnabled: false,
        writePreviewAcknowledged: false,
        openAtStartup: false,
        folderRules: [],
        excludedPrefixes: ["Archive"],
        aiEnabled: false,
        aiEndpoint: "",
        aiModel: "",
        secretId: "",
      }),
      folderRuleProposals: () => [{
        prefix: "References",
        kind: "reference" as const,
        noteCount: 12,
        unclassifiedCount: 11,
        samplePaths: ["References/A.md"],
      }],
      previewSampleChange: () => { calls.push("review"); },
      setOpenAtStartup: async () => { calls.push("startup"); },
      setWriteEnabled: async () => { calls.push("write"); },
      applyFolderRules: async () => { calls.push("rules"); },
      setExcludedPrefixes: async () => { calls.push("exclusions"); },
    };
    const SettingsTab = createSettingsTabClass(SettingsSurface as unknown as PluginSettingTabConstructor, undefined, NORMAL_RUNTIME_POLICY);
    const tab = new SettingsTab({} as App, {} as never, controller);
    (tab as unknown as { display(): void }).display();
    expect(tab.containerEl.textContent).toContain("Write operations are locked");
    const proposal = tab.containerEl.querySelector<HTMLInputElement>('input[data-folder-rule="References"]')!;
    expect(proposal.checked).toBe(false);
    Array.from(tab.containerEl.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Review a sample change")?.click();
    proposal.checked = true;
    proposal.dispatchEvent(new Event("change", { bubbles: true }));
    Array.from(tab.containerEl.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Confirm selected rules")?.click();
    Array.from(tab.containerEl.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Apply exclusions")?.click();
    await Promise.resolve();
    expect(calls).toEqual(["review", "rules", "exclusions"]);
  });

  it("shows write enablement only after preview acknowledgement and routes it through the controller guard", async () => {
    class SettingsSurface {
      readonly containerEl = createTestDiv();
    }
    const baseSettings = {
      writeEnabled: false,
      writePreviewAcknowledged: true,
      openAtStartup: false,
      folderRules: [],
      excludedPrefixes: [],
      aiEnabled: false,
      aiEndpoint: "",
      aiModel: "",
      secretId: "",
    };
    const values: boolean[] = [];
    const controller = {
      settings: () => baseSettings,
      folderRuleProposals: () => [],
      previewSampleChange: () => undefined,
      setOpenAtStartup: async () => undefined,
      setWriteEnabled: async (value: boolean) => { values.push(value); },
      applyFolderRules: async () => undefined,
      setExcludedPrefixes: async () => undefined,
    };
    const SettingsTab = createSettingsTabClass(SettingsSurface as unknown as PluginSettingTabConstructor, undefined, NORMAL_RUNTIME_POLICY);
    const tab = new SettingsTab({} as App, {} as never, controller);
    (tab as unknown as { display(): void }).display();
    expect(tab.containerEl.textContent).not.toContain("Write operations are locked");
    const write = tab.containerEl.querySelector<HTMLInputElement>('input[data-write-enabled="true"]')!;
    expect(write.checked).toBe(false);
    write.checked = true;
    write.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    expect(values).toEqual([true]);

    const fixture = controllerFixture();
    await fixture.controller.setWriteEnabled(true);
    expect(fixture.store.settings().writeEnabled).toBe(false);
    fixture.store.setSettingsForTest({ ...fixture.store.settings(), writePreviewAcknowledged: true });
    await fixture.controller.setWriteEnabled(true);
    expect(fixture.store.settings().writeEnabled).toBe(true);
  });

  it("renders exclusion preview rows from proposals while retaining existing unmatched prefixes", async () => {
    class SettingsSurface {
      readonly containerEl = createTestDiv();
    }
    const applied: string[][] = [];
    const controller = {
      settings: () => ({
        writeEnabled: false,
        writePreviewAcknowledged: false,
        openAtStartup: false,
        folderRules: [],
        excludedPrefixes: ["Archive"],
        aiEnabled: false,
        aiEndpoint: "",
        aiModel: "",
        secretId: "",
      }),
      folderRuleProposals: () => [{
        prefix: "References",
        kind: "reference" as const,
        noteCount: 12,
        unclassifiedCount: 11,
        samplePaths: ["References/A.md", "References/B.md"],
      }],
      previewSampleChange: () => undefined,
      setOpenAtStartup: async () => undefined,
      setWriteEnabled: async () => undefined,
      applyFolderRules: async () => undefined,
      setExcludedPrefixes: async (prefixes: readonly string[]) => { applied.push([...prefixes]); },
    };
    const SettingsTab = createSettingsTabClass(SettingsSurface as unknown as PluginSettingTabConstructor, undefined, NORMAL_RUNTIME_POLICY);
    const tab = new SettingsTab({} as App, {} as never, controller);
    (tab as unknown as { display(): void }).display();
    const rows = Array.from(tab.containerEl.querySelectorAll<HTMLInputElement>("input[data-excluded-prefix]"));
    expect(rows.map((row) => [row.dataset.excludedPrefix, row.checked])).toEqual([
      ["References", false],
      ["Archive", true],
    ]);
    expect(tab.containerEl.textContent).toContain("12 notes");
    expect(tab.containerEl.textContent).toContain("References/A.md");
    expect(tab.containerEl.textContent).toContain("Existing exclusion");
    rows[0]!.checked = true;
    rows[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    Array.from(tab.containerEl.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Apply exclusions")?.click();
    await Promise.resolve();
    expect(applied).toEqual([["References", "Archive"]]);
  });

  it("shows settings action failures in a live status and leaves the action retryable", async () => {
    class SettingsSurface {
      readonly containerEl = createTestDiv();
    }
    let attempts = 0;
    const controller = {
      settings: () => ({
        writeEnabled: false,
        writePreviewAcknowledged: false,
        openAtStartup: false,
        folderRules: [],
        excludedPrefixes: ["Archive"],
        aiEnabled: false,
        aiEndpoint: "",
        aiModel: "",
        secretId: "",
      }),
      folderRuleProposals: () => [],
      previewSampleChange: () => undefined,
      setOpenAtStartup: async () => undefined,
      setWriteEnabled: async () => undefined,
      applyFolderRules: async () => undefined,
      setExcludedPrefixes: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("disk unavailable");
      },
    };
    const SettingsTab = createSettingsTabClass(SettingsSurface as unknown as PluginSettingTabConstructor, undefined, NORMAL_RUNTIME_POLICY);
    const tab = new SettingsTab({} as App, {} as never, controller);
    (tab as unknown as { display(): void }).display();
    const apply = Array.from(tab.containerEl.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Apply exclusions")!;
    apply.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(tab.containerEl.querySelector('[role="status"]')?.textContent).toContain("Error: disk unavailable");
    apply.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(tab.containerEl.querySelector('[role="status"]')?.textContent).toContain("Saved");
    expect(attempts).toBe(2);
  });

  it("restores startup and write checkbox intent after failure so the same intent can be retried", async () => {
    class SettingsSurface {
      readonly containerEl = createTestDiv();
    }
    let persistedStartup = false;
    let persistedWrite = false;
    let startupAttempts = 0;
    let writeAttempts = 0;
    const controller = {
      settings: () => ({
        writeEnabled: persistedWrite,
        writePreviewAcknowledged: true,
        openAtStartup: persistedStartup,
        folderRules: [],
        excludedPrefixes: [],
        aiEnabled: false,
        aiEndpoint: "",
        aiModel: "",
        secretId: "",
      }),
      folderRuleProposals: () => [],
      previewSampleChange: () => undefined,
      setOpenAtStartup: async (value: boolean) => {
        startupAttempts += 1;
        if (startupAttempts === 1) throw new Error("startup failed");
        persistedStartup = value;
      },
      setWriteEnabled: async (value: boolean) => {
        writeAttempts += 1;
        if (writeAttempts === 1) throw new Error("write failed");
        persistedWrite = value;
      },
      applyFolderRules: async () => undefined,
      setExcludedPrefixes: async () => undefined,
    };
    const SettingsTab = createSettingsTabClass(SettingsSurface as unknown as PluginSettingTabConstructor, undefined, NORMAL_RUNTIME_POLICY);
    const tab = new SettingsTab({} as App, {} as never, controller);
    (tab as unknown as { display(): void }).display();
    const startup = Array.from(tab.containerEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))[0]!;
    const write = tab.containerEl.querySelector<HTMLInputElement>('input[data-write-enabled="true"]')!;

    startup.checked = true;
    startup.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(startup.checked).toBe(false);
    expect(tab.containerEl.querySelector('[role="status"]')?.textContent).toContain("Error: startup failed");
    startup.checked = true;
    startup.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(persistedStartup).toBe(true);

    write.checked = true;
    write.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(write.checked).toBe(false);
    expect(tab.containerEl.querySelector('[role="status"]')?.textContent).toContain("Error: write failed");
    write.checked = true;
    write.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(persistedWrite).toBe(true);
    expect({ startupAttempts, writeAttempts }).toEqual({ startupAttempts: 2, writeAttempts: 2 });
  });
});
