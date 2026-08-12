import type { App, Plugin, PluginSettingTab } from "obsidian";
import type { FolderRule, FolderRuleProposal, PluginSettings } from "../storage/plugin-data";
import type { AiSettingsInput } from "./workbench-controller";
import type { RuntimeSafetyPolicy } from "../runtime/safety-policy";

export interface SettingsController {
  settings(): PluginSettings;
  folderRuleProposals(): readonly FolderRuleProposal[];
  previewSampleChange(): void;
  setOpenAtStartup(value: boolean): Promise<void>;
  setWriteEnabled(value: boolean): Promise<void>;
  applyFolderRules(rules: readonly FolderRule[]): Promise<void>;
  setExcludedPrefixes(prefixes: readonly string[]): Promise<void>;
  saveAiSettings?(settings: AiSettingsInput): Promise<void>;
  setSessionAiSecret?(secret: string): void;
}

export type PluginSettingTabConstructor = abstract new (app: App, plugin: Plugin) => PluginSettingTab;
export interface SecretComponentLike {
  setValue(value: string): this;
  onChange(callback: (value: string) => void): this;
}
export type SecretComponentConstructor = new (app: App, containerEl: HTMLElement) => SecretComponentLike;

const heading = (doc: Document, level: 2 | 3, text: string): HTMLHeadingElement => {
  const value = doc.createElement(`h${level}`);
  value.textContent = text;
  return value;
};

const actionButton = (doc: Document, label: string, action: () => void): HTMLButtonElement => {
  const button = doc.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
};

export function createSettingsTabClass(
  PluginSettingTabBase: PluginSettingTabConstructor,
  PrivateCredentialInputBase: SecretComponentConstructor | undefined,
  policy: RuntimeSafetyPolicy,
) {
  return class KnowledgeWorkbenchSettingsTab extends PluginSettingTabBase {
    secretComponent: SecretComponentLike | null = null;
    constructor(private readonly appRef: App, plugin: Plugin, private readonly controller: SettingsController) {
      super(appRef, plugin);
    }

    display(): void {
      const doc = this.containerEl.ownerDocument;
      const settings = this.controller.settings();
      this.secretComponent = null;
      this.containerEl.replaceChildren();
      this.containerEl.classList.add("knowledge-workbench", "knowledge-workbench__settings");
      this.containerEl.classList.toggle(
        "knowledge-workbench__settings--read-only",
        policy.configuration === "read-only",
      );
      this.containerEl.append(heading(doc, 2, "Knowledge Workbench"));
      const status = doc.createElement("div");
      status.className = "knowledge-workbench__settings-status";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      status.textContent = "Ready";
      this.containerEl.append(status);
      const run = async (
        label: string,
        operation: () => Promise<void>,
        near: HTMLElement,
        onError?: () => void,
        safeError?: string,
      ): Promise<void> => {
        near.insertAdjacentElement("afterend", status);
        status.textContent = `${label}…`;
        try {
          await operation();
          status.textContent = `Saved: ${label}`;
        } catch (error) {
          onError?.();
          status.textContent = safeError ?? `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      };

      const startup = doc.createElement("label");
      startup.className = "knowledge-workbench__settings-row";
      const startupInput = doc.createElement("input");
      startupInput.type = "checkbox";
      startupInput.checked = settings.openAtStartup;
      startupInput.addEventListener("change", () => {
        void run(
          "Startup preference",
          () => this.controller.setOpenAtStartup(startupInput.checked),
          startup,
          () => { startupInput.checked = this.controller.settings().openAtStartup; },
        );
      });
      const startupText = doc.createElement("span");
      startupText.textContent = "Open the workbench at startup";
      startup.append(startupInput, startupText);
      this.containerEl.append(startup);

      const safety = doc.createElement("section");
      safety.append(heading(doc, 3, "Write safety"));
      if (policy.configuration === "read-only") {
        const locked = doc.createElement("p");
        locked.className = "knowledge-workbench__locked";
        locked.textContent = "Organization writes are unavailable in the read-only acceptance build.";
        safety.append(locked);
      } else if (!settings.writePreviewAcknowledged) {
        const locked = doc.createElement("p");
        locked.className = "knowledge-workbench__locked";
        locked.textContent = "Write operations are locked. Review a sample before any future opt-in.";
        const review = actionButton(doc, "Review a sample change", () => this.controller.previewSampleChange());
        safety.append(locked, review);
      } else {
        const writeLabel = doc.createElement("label");
        writeLabel.className = "knowledge-workbench__settings-row";
        const writeEnabled = doc.createElement("input");
        writeEnabled.type = "checkbox";
        writeEnabled.checked = settings.writeEnabled;
        writeEnabled.dataset.writeEnabled = "true";
        writeEnabled.addEventListener("change", () => {
          void run(
            "Write operations",
            () => this.controller.setWriteEnabled(writeEnabled.checked),
            safety,
            () => { writeEnabled.checked = this.controller.settings().writeEnabled; },
          );
        });
        const writeText = doc.createElement("span");
        writeText.textContent = "Enable confirmed write operations";
        writeLabel.append(writeEnabled, writeText);
        safety.append(writeLabel);
      }
      this.containerEl.append(safety);

      const organization = doc.createElement("section");
      organization.append(heading(doc, 3, "Folder rule proposals"));
      const selected = new Map<string, FolderRule>();
      const proposals = this.controller.folderRuleProposals();
      if (proposals.length === 0) {
        const empty = doc.createElement("p");
        empty.textContent = "No folder rule proposals yet.";
        organization.append(empty);
      }
      for (const proposal of proposals) {
        const row = doc.createElement("label");
        row.className = "knowledge-workbench__settings-row";
        const checkbox = doc.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = false;
        checkbox.dataset.folderRule = proposal.prefix;
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) selected.set(proposal.prefix, { prefix: proposal.prefix, kind: proposal.kind });
          else selected.delete(proposal.prefix);
        });
        const description = doc.createElement("span");
        description.textContent = `${proposal.prefix} — ${proposal.noteCount} notes; samples: ${proposal.samplePaths.join(", ")}`;
        row.append(checkbox, description);
        organization.append(row);
      }
      organization.append(actionButton(doc, "Confirm selected rules", () => {
        if (selected.size === 0) return;
        const merged = new Map(settings.folderRules.map((rule) => [rule.prefix, rule]));
        for (const [prefix, rule] of selected) merged.set(prefix, rule);
        void run("Folder rules", () => this.controller.applyFolderRules([...merged.values()]), organization);
      }));
      this.containerEl.append(organization);

      const exclusions = doc.createElement("section");
      exclusions.append(heading(doc, 3, "Excluded folders"));
      const existing = new Set(settings.excludedPrefixes);
      const proposalPrefixes = new Set(proposals.map((proposal) => proposal.prefix));
      const exclusionRows: HTMLInputElement[] = [];
      const appendExclusion = (prefix: string, descriptionText: string): void => {
        const row = doc.createElement("label");
        row.className = "knowledge-workbench__settings-row";
        const checkbox = doc.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = existing.has(prefix);
        checkbox.dataset.excludedPrefix = prefix;
        const description = doc.createElement("span");
        description.textContent = descriptionText;
        row.append(checkbox, description);
        exclusionRows.push(checkbox);
        exclusions.append(row);
      };
      for (const proposal of proposals) {
        appendExclusion(
          proposal.prefix,
          `${proposal.prefix} — ${proposal.noteCount} notes; samples: ${proposal.samplePaths.join(", ")}`,
        );
      }
      for (const prefix of settings.excludedPrefixes.filter((value) => !proposalPrefixes.has(value)).sort()) {
        appendExclusion(prefix, `${prefix} — Existing exclusion; no current proposal`);
      }
      if (exclusionRows.length === 0) {
        const empty = doc.createElement("p");
        empty.textContent = "No exclusion candidates yet.";
        exclusions.append(empty);
      }
      exclusions.append(actionButton(doc, "Apply exclusions", () => {
        const prefixes = exclusionRows.filter((checkbox) => checkbox.checked)
          .map((checkbox) => checkbox.dataset.excludedPrefix!);
        void run("Exclusions", () => this.controller.setExcludedPrefixes(prefixes), exclusions);
      }));
      this.containerEl.append(exclusions);

      if (policy.ai === "blocked") {
        const ai = doc.createElement("section");
        ai.className = "knowledge-workbench__ai-settings";
        ai.append(heading(doc, 3, "Optional private AI"));
        const locked = doc.createElement("p");
        locked.className = "knowledge-workbench__locked";
        locked.textContent = "AI configuration and requests are unavailable in the read-only acceptance build.";
        ai.append(locked);
        this.containerEl.append(ai);
      } else if (this.controller.saveAiSettings !== undefined && this.controller.setSessionAiSecret !== undefined) {
        const ai = doc.createElement("section");
        ai.className = "knowledge-workbench__ai-settings";
        ai.append(heading(doc, 3, "Optional private AI"));
        const description = doc.createElement("p");
        description.textContent = "Disabled by default. Note text is sent only after an explicit payload preview.";
        ai.append(description);

        let secretId = settings.secretId;
        const enabledLabel = doc.createElement("label");
        enabledLabel.className = "knowledge-workbench__settings-row";
        const enabled = doc.createElement("input");
        enabled.type = "checkbox";
        enabled.checked = settings.aiEnabled;
        enabled.dataset.aiEnabled = "true";
        const enabledText = doc.createElement("span");
        enabledText.textContent = "Enable explicit AI suggestions";
        enabledLabel.append(enabled, enabledText);

        const endpointLabel = doc.createElement("label");
        endpointLabel.textContent = "API base endpoint";
        const endpoint = doc.createElement("input");
        endpoint.type = "url";
        endpoint.value = settings.aiEndpoint;
        endpoint.dataset.aiEndpoint = "true";
        endpointLabel.append(endpoint);

        const modelLabel = doc.createElement("label");
        modelLabel.textContent = "Model";
        const model = doc.createElement("input");
        model.type = "text";
        model.value = settings.aiModel;
        model.dataset.aiModel = "true";
        modelLabel.append(model);

        const save = (): Promise<void> => this.controller.saveAiSettings!({
          enabled: enabled.checked,
          endpoint: endpoint.value,
          model: model.value,
          secretId,
        });
        const saveAi = (near: HTMLElement, onError?: () => void): void => {
          void run("AI settings", save, near, onError, "AI settings unavailable");
        };
        enabled.addEventListener("change", () => saveAi(enabledLabel));
        endpoint.addEventListener("change", () => saveAi(endpointLabel));
        model.addEventListener("change", () => saveAi(modelLabel));
        ai.append(enabledLabel, endpointLabel, modelLabel);

        if (PrivateCredentialInputBase !== undefined) {
          const persistent = doc.createElement("label");
          persistent.className = "knowledge-workbench__settings-row";
          const persistentLabel = doc.createElement("span");
          persistentLabel.textContent = "Secret storage ID";
          const host = doc.createElement("div");
          persistent.append(persistentLabel, host);
          this.secretComponent = new PrivateCredentialInputBase(this.appRef, host)
            .setValue(secretId)
            .onChange((value) => {
              const previous = secretId;
              secretId = value;
              saveAi(persistent, () => {
                secretId = previous;
                this.secretComponent?.setValue(previous);
              });
            });
          ai.append(persistent);
        }

        const sessionLabel = doc.createElement("label");
        sessionLabel.textContent = "Session-only secret (never persisted)";
        const session = doc.createElement("input");
        session.type = "password";
        session.autocomplete = "off";
        session.dataset.sessionAiSecret = "true";
        sessionLabel.append(session);
        const useSession = actionButton(doc, "Use for this session", () => {
          const value = session.value;
          session.value = "";
          if (value.length === 0 || secretId.length > 0) return;
          this.controller.setSessionAiSecret!(value);
          status.textContent = "Session-only AI secret accepted";
        });
        useSession.dataset.action = "use-session-secret";
        ai.append(sessionLabel, useSession);
        this.containerEl.append(ai);
      }
    }
  };
}
