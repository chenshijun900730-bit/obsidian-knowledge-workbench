import {
  Modal,
  PluginSettingTab,
  type App,
  type Plugin,
  type SettingDefinitionItem,
} from "obsidian";
import { createKnowledgeWorkbenchPluginClass } from "./plugin/knowledge-workbench-plugin";
import type { ArtifactExpectation } from "./runtime/artifact-binding";
import {
  READ_ONLY_QUICK_CAPTURE_PORT,
  READ_ONLY_VAULT_WRITE_PORT,
} from "./runtime/read-only-ports";
import type { RuntimeComposition } from "./runtime/runtime-composition";
import { policyFor } from "./runtime/safety-policy";
import { createChangePreviewModalClass } from "./ui/change-preview-modal";
import { DISABLED_CLOUD_CATALOG_RUNTIME } from "./catalog/disabled-cloud-catalog-runtime";
import {
  createWorkbenchI18n,
  type WorkbenchLocaleProvider,
} from "./i18n/workbench-i18n";

if (
  __KNOWLEDGE_WORKBENCH_BUILD_MODE__ !== "read-only-acceptance"
  || __KNOWLEDGE_WORKBENCH_MANIFEST_NAME__
    !== "Knowledge Workbench (Read-only acceptance)"
) {
  throw new Error("Acceptance entry point requires read-only-acceptance mode");
}

const policy = policyFor(__KNOWLEDGE_WORKBENCH_BUILD_MODE__);
const artifact: ArtifactExpectation = Object.freeze({
  mode: "read-only-acceptance",
  pluginVersion: __KNOWLEDGE_WORKBENCH_PLUGIN_VERSION__,
  manifestName: __KNOWLEDGE_WORKBENCH_MANIFEST_NAME__,
  artifactBinding: __KNOWLEDGE_WORKBENCH_ARTIFACT_BINDING__,
});
class ReadOnlyAcceptanceSettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: Plugin,
    private readonly getLocale: WorkbenchLocaleProvider,
  ) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const i18n = createWorkbenchI18n(this.getLocale());
    return [{
      name: i18n.t("acceptance.settings.name"),
      desc: i18n.t("acceptance.settings.notice"),
    }];
  }

  display(): void {
    const i18n = createWorkbenchI18n(this.getLocale());
    const doc = this.containerEl.ownerDocument;
    this.containerEl.replaceChildren();
    const heading = doc.createElement("h2");
    heading.textContent = i18n.t("acceptance.settings.title");
    const notice = doc.createElement("p");
    notice.className = "knowledge-workbench__locked";
    notice.textContent = i18n.t("acceptance.settings.notice");
    this.containerEl.append(heading, notice);
  }
}

// The acceptance composition intentionally omits the normal-only directory picker factory.
const runtime = Object.freeze({
  policy,
  artifact,
  selectVaultWrites: () => READ_ONLY_VAULT_WRITE_PORT,
  createQuickCapture: (_app, getLocale) => {
    void getLocale;
    return {
    capture: () => READ_ONLY_QUICK_CAPTURE_PORT.capture(),
    dispose: () => undefined,
    };
  },
  createChangePreview: (app, plans, getLocale) => {
    const ConcreteChangePreviewModal = createChangePreviewModalClass(Modal, policy, getLocale);
    return {
      request: (preview) => new ConcreteChangePreviewModal(app, plans).request(preview),
      requestSample: () => new ConcreteChangePreviewModal(app, plans).requestSample(),
    };
  },
  createHistoryConfirmation: (_app, getLocale) => {
    void getLocale;
    return { request: async () => false };
  },
  createSettingsTab: (app, plugin, _controller, getLocale) => new ReadOnlyAcceptanceSettingsTab(
    app,
    plugin,
    getLocale,
  ),
  cloudVerificationRootHasher: () => null,
  createCatalog: () => DISABLED_CLOUD_CATALOG_RUNTIME,
  createCatalogConfirmation: (_app, getLocale) => {
    void getLocale;
    return { request: async () => false };
  },
} satisfies RuntimeComposition);

export default createKnowledgeWorkbenchPluginClass(runtime);
