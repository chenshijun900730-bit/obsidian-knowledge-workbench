import { describe, expect, it, vi } from "vitest";
import {
  createCaseSensitiveArtifactPort,
  runStartupGate,
} from "../../src/runtime/startup-gate";
import {
  closeObsidianSettingsIfSupported,
  handoffFromObsidianSettings,
} from "../../src/adapters/obsidian-workspace-adapter";
import type { App } from "obsidian";

describe("plugin startup gate", () => {
  it("finishes binding and durable normalization before composition", async () => {
    const order: string[] = [];
    const store = { id: "store" };

    const result = await runStartupGate({
      verifyArtifact: async () => { order.push("verify"); },
      loadStore: async () => { order.push("load"); return store; },
      enforcePolicy: async (value) => {
        expect(value).toBe(store);
        order.push("normalize");
      },
    });
    order.push("compose");

    expect(result).toBe(store);
    expect(order).toEqual(["verify", "load", "normalize", "compose"]);
  });

  it.each(["verify", "load", "normalize"] as const)(
    "does not reach composition after %s failure",
    async (failure) => {
      const compose = vi.fn();

      await expect(runStartupGate({
        verifyArtifact: async () => {
          if (failure === "verify") throw new Error("blocked");
        },
        loadStore: async () => {
          if (failure === "load") throw new Error("blocked");
          return {};
        },
        enforcePolicy: async () => {
          if (failure === "normalize") throw new Error("blocked");
        },
      }).then(compose)).rejects.toThrow("blocked");

      expect(compose).not.toHaveBeenCalled();
    },
  );

  it("checks installed artifact paths case-sensitively", async () => {
    const exists = vi.fn(async () => true);
    const read = vi.fn(async () => "metadata");
    const port = createCaseSensitiveArtifactPort({ exists, read });

    await expect(port.exists("Config/plugins/knowledge-workbench/main.js"))
      .resolves.toBe(true);
    await expect(port.read("Config/plugins/knowledge-workbench/acceptance-build.json"))
      .resolves.toBe("metadata");

    expect(exists).toHaveBeenCalledWith(
      "Config/plugins/knowledge-workbench/main.js",
      true,
    );
    expect(read).toHaveBeenCalledWith(
      "Config/plugins/knowledge-workbench/acceptance-build.json",
    );
  });

  it("feature-checks the host Settings close capability without DOM guessing", () => {
    const close = vi.fn();
    expect(closeObsidianSettingsIfSupported({ setting: { close } } as never)).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(closeObsidianSettingsIfSupported({} as never)).toBe(false);
    expect(() => closeObsidianSettingsIfSupported({
      setting: { close: () => { throw new Error("host close unavailable"); } },
    } as never)).toThrow("host close unavailable");
  });

  it("runs the plugin's real Settings handoff sequence for existing and new focused leaves", async () => {
    const expected = {};
    const existingLeaf = { view: expected };
    const existingWorkspace = {
      getLeavesOfType: () => [existingLeaf],
      getLeaf: () => { throw new Error("existing leaf must be reused"); },
      revealLeaf: vi.fn(async () => undefined),
      setActiveLeaf: vi.fn(),
    };
    const existingNotices: string[] = [];
    await handoffFromObsidianSettings({
      app: { setting: { close: vi.fn() }, workspace: existingWorkspace } as unknown as App,
      isExpectedView: (view) => view === expected,
      reportUnavailable: vi.fn(),
      notify: (message) => existingNotices.push(message),
    });
    expect(existingWorkspace.revealLeaf).toHaveBeenCalledWith(existingLeaf);
    expect(existingWorkspace.setActiveLeaf).toHaveBeenCalledWith(existingLeaf, { focus: true });
    expect(existingNotices).toEqual([]);

    const newLeaf: { view: unknown; setViewState: () => Promise<void> } = {
      view: null,
      async setViewState(): Promise<void> { this.view = expected; },
    };
    const newLeaves: typeof newLeaf[] = [];
    const newWorkspace = {
      getLeavesOfType: () => newLeaves,
      getLeaf: () => { newLeaves.push(newLeaf); return newLeaf; },
      revealLeaf: vi.fn(async () => undefined),
      setActiveLeaf: vi.fn(),
    };
    const newNotices: string[] = [];
    await handoffFromObsidianSettings({
      app: { workspace: newWorkspace } as unknown as App,
      isExpectedView: (view) => view === expected,
      reportUnavailable: vi.fn(),
      notify: (message) => newNotices.push(message),
    });
    expect(newWorkspace.revealLeaf).toHaveBeenCalledWith(newLeaf);
    expect(newWorkspace.setActiveLeaf).toHaveBeenCalledWith(newLeaf, { focus: true });
    expect(newNotices).toEqual(["close-guidance"]);
  });

  it("reports fixed handoff feedback when Settings close or Workbench activation fails", async () => {
    const expected = {};
    const closeNotices: string[] = [];
    const leaf = { view: expected };
    await handoffFromObsidianSettings({
      app: {
        setting: { close: () => { throw new Error("private host failure"); } },
        workspace: {
          getLeavesOfType: () => [leaf], getLeaf: () => leaf,
          revealLeaf: async () => undefined, setActiveLeaf: vi.fn(),
        },
      } as unknown as App,
      isExpectedView: (view) => view === expected,
      reportUnavailable: vi.fn(),
      notify: (message) => closeNotices.push(message),
    });
    expect(closeNotices).toEqual(["handoff-failed", "close-guidance"]);

    const activationNotices: string[] = [];
    const reportUnavailable = vi.fn();
    await expect(handoffFromObsidianSettings({
      app: {
        setting: { close: vi.fn() },
        workspace: {
          getLeavesOfType: () => [leaf], getLeaf: () => leaf,
          revealLeaf: async () => { throw new Error("private host failure"); },
          setActiveLeaf: vi.fn(),
        },
      } as unknown as App,
      isExpectedView: (view) => view === expected,
      reportUnavailable,
      notify: (message) => activationNotices.push(message),
    })).rejects.toThrow("private host failure");
    expect(reportUnavailable).not.toHaveBeenCalled();
    expect(activationNotices).toEqual(["handoff-failed"]);
  });
});
