// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import {
  NORMAL_RUNTIME_POLICY,
  READ_ONLY_ACCEPTANCE_POLICY,
} from "../../src/runtime/safety-policy";
import {
  createSettingsTabClass,
  type PluginSettingTabConstructor,
} from "../../src/ui/settings-tab";

class SettingsSurface {
  readonly containerEl = document.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
}
class SecretSurface {
  private change: ((value: string) => void) | null = null;
  readonly select: HTMLSelectElement;
  value = "";
  constructor(readonly app: App, container: HTMLElement) {
    this.select = container.ownerDocument.createElement("select");
    this.select.dataset.secretComponent = "true";
    container.append(this.select);
  }
  setValue(value: string): this { this.value = value; this.select.dataset.value = value; return this; }
  onChange(callback: (value: string) => void): this { this.change = callback; return this; }
  emit(value: string): void { this.change?.(value); }
}

const makeTab = (options: Readonly<{ fail?: Error }> = {}) => {
  const saves: unknown[] = [];
  const sessions: boolean[] = [];
  const controller = {
    settings: () => ({
      writeEnabled: false, writePreviewAcknowledged: false, openAtStartup: false,
      folderRules: [], excludedPrefixes: [], aiEnabled: true,
      aiEndpoint: "https://example.test/v1", aiModel: "model", secretId: "",
    }),
    folderRuleProposals: () => [],
    previewSampleChange: () => undefined,
    setOpenAtStartup: async () => undefined,
    setWriteEnabled: async () => undefined,
    applyFolderRules: async () => undefined,
    setExcludedPrefixes: async () => undefined,
    saveAiSettings: async (value: unknown) => {
      if (options.fail !== undefined) throw options.fail;
      saves.push(structuredClone(value));
    },
    setSessionAiSecret: (value: string) => { sessions.push(value === "sk-session-private"); },
  };
  const SettingsTab = createSettingsTabClass(
    SettingsSurface as unknown as PluginSettingTabConstructor,
    SecretSurface,
    NORMAL_RUNTIME_POLICY,
  );
  const tab = new SettingsTab({} as App, {} as never, controller);
  (tab as unknown as { display(): void }).display();
  return { tab, saves, sessions };
};

describe("AI settings", () => {
  it("renders fixed acceptance notices without constructing secrets or write and AI controls", () => {
    let secretConstructions = 0;
    class CountedSecretSurface extends SecretSurface {
      constructor(app: App, container: HTMLElement) {
        super(app, container);
        secretConstructions += 1;
      }
    }
    const calls = {
      sample: vi.fn(),
      write: vi.fn(async () => undefined),
      saveAi: vi.fn(async () => undefined),
      session: vi.fn(),
    };
    const controller = {
      settings: () => ({
        writeEnabled: true, writePreviewAcknowledged: true, openAtStartup: false,
        folderRules: [], excludedPrefixes: [], aiEnabled: true,
        aiEndpoint: "https://example.test/v1", aiModel: "model", secretId: "secret-id",
      }),
      folderRuleProposals: () => [],
      previewSampleChange: calls.sample,
      setOpenAtStartup: async () => undefined,
      setWriteEnabled: calls.write,
      applyFolderRules: async () => undefined,
      setExcludedPrefixes: async () => undefined,
      saveAiSettings: calls.saveAi,
      setSessionAiSecret: calls.session,
    };
    const SettingsTab = createSettingsTabClass(
      SettingsSurface as unknown as PluginSettingTabConstructor,
      CountedSecretSurface,
      READ_ONLY_ACCEPTANCE_POLICY,
    );
    const tab = new SettingsTab({} as App, {} as never, controller);
    (tab as unknown as { display(): void }).display();

    expect(tab.containerEl.classList.contains("knowledge-workbench__settings--read-only")).toBe(true);
    expect(tab.containerEl.textContent).toContain(
      "Organization writes are unavailable in the read-only acceptance build.",
    );
    expect(tab.containerEl.textContent).toContain(
      "AI configuration and requests are unavailable in the read-only acceptance build.",
    );
    expect(tab.containerEl.textContent).toContain("Open the workbench at startup");
    expect(tab.containerEl.textContent).toContain("Folder rule proposals");
    expect(tab.containerEl.textContent).toContain("Excluded folders");
    expect(tab.containerEl.querySelector('[data-write-enabled="true"]')).toBeNull();
    expect(tab.containerEl.querySelector('[data-ai-enabled="true"]')).toBeNull();
    expect(tab.containerEl.querySelector('[data-ai-endpoint="true"]')).toBeNull();
    expect(tab.containerEl.querySelector('[data-ai-model="true"]')).toBeNull();
    expect(tab.containerEl.querySelector('[data-session-ai-secret="true"]')).toBeNull();
    expect(secretConstructions).toBe(0);
    expect(calls.sample).not.toHaveBeenCalled();
    expect(calls.write).not.toHaveBeenCalled();
    expect(calls.saveAi).not.toHaveBeenCalled();
    expect(calls.session).not.toHaveBeenCalled();
  });

  it("associates the host SecretComponent control with its persistent label", () => {
    const fixture = makeTab();
    const select = fixture.tab.containerEl.querySelector<HTMLSelectElement>('[data-secret-component="true"]')!;
    const label = select.closest("label");
    expect(label).not.toBeNull();
    expect(label?.textContent ?? "").toContain("Secret storage ID");
  });

  it("stores only the SecretStorage ID selected by SecretComponent", async () => {
    const fixture = makeTab();
    (fixture.tab as unknown as { secretComponent: SecretSurface }).secretComponent.emit("my-secret-id");
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.saves.at(-1)).toEqual({
      enabled: true,
      endpoint: "https://example.test/v1",
      model: "model",
      secretId: "my-secret-id",
    });
    expect(JSON.stringify(fixture.saves)).not.toContain("sk-private");
  });

  it("hands a raw session secret to memory only and immediately clears the password DOM", () => {
    const fixture = makeTab();
    const password = fixture.tab.containerEl.querySelector<HTMLInputElement>('input[type="password"]')!;
    password.value = "sk-session-private";
    fixture.tab.containerEl.querySelector<HTMLButtonElement>('[data-action="use-session-secret"]')!.click();
    expect(fixture.sessions).toEqual([true]);
    expect(password.value).toBe("");
    expect(fixture.tab.containerEl.textContent).not.toContain("sk-session-private");
    expect(JSON.stringify(fixture.saves)).not.toContain("sk-session-private");
  });

  it("uses fixed safe status text for AI setting failures", async () => {
    const fixture = makeTab({ fail: new Error("sk-private storage failure") });
    const enabled = fixture.tab.containerEl.querySelector<HTMLInputElement>('[data-ai-enabled="true"]')!;
    enabled.checked = false;
    enabled.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    const status = fixture.tab.containerEl.querySelector('[role="status"]')?.textContent ?? "";
    expect(status).toContain("AI settings unavailable");
    expect(status).not.toContain("sk-private");
  });

  it("rolls SecretComponent selection back after a save failure without exposing the cause", async () => {
    const fixture = makeTab({ fail: new Error("sk-private persistence detail") });
    const secret = (fixture.tab as unknown as { secretComponent: SecretSurface }).secretComponent;
    secret.emit("new-secret-id");
    await Promise.resolve();
    await Promise.resolve();
    expect(secret.value).toBe("");
    expect(fixture.tab.containerEl.querySelector('[role="status"]')?.textContent).toBe("AI settings unavailable");
    expect(fixture.tab.containerEl.textContent).not.toContain("sk-private");
  });
});
