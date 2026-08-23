import {
  Modal,
  PluginSettingTab,
  requestUrl,
  SecretComponent,
} from "obsidian";
import { ObsidianAiClient } from "./adapters/obsidian-ai-client";
import { ObsidianQuickCaptureAdapter } from "./adapters/obsidian-quick-capture-adapter";
import type { ArtifactExpectation } from "./runtime/artifact-binding";
import { createKnowledgeWorkbenchPluginClass } from "./plugin/knowledge-workbench-plugin";
import type { RuntimeComposition } from "./runtime/runtime-composition";
import { policyFor } from "./runtime/safety-policy";
import { createAiPayloadPreviewModalClass } from "./ui/ai-payload-preview-modal";
import { createChangePreviewModalClass } from "./ui/change-preview-modal";
import { createHistoryConfirmationModalClass } from "./ui/history-tab";
import { createQuickCaptureModalClass } from "./ui/quick-capture-modal";
import { createSettingsTabClass } from "./ui/settings-tab";
import { createSettingsSectionsSurface } from "./ui/settings-sections";
import {
  createNormalCloudCatalogRuntime,
  resolveCatalogRoot,
} from "./runtime/normal-cloud-catalog-composition";
import { createCatalogScanConfirmationModalClass } from "./ui/catalog-scan-confirmation-modal";
import { presentCatalogProgress } from "./ui/catalog-progress-presenter";
import { createCatalogTxtImportConfirmationModalClass } from "./ui/catalog-txt-import-confirmation-modal";
import { createCatalogLargeScanConfirmationModalClass } from "./ui/catalog-large-scan-confirmation-modal";
import { createCloudDirectoryPickerModalClass } from "./ui/cloud-directory-picker";
import { createWorkbenchI18n } from "./i18n/workbench-i18n";

if (
  __KNOWLEDGE_WORKBENCH_BUILD_MODE__ !== "normal"
  || __KNOWLEDGE_WORKBENCH_MANIFEST_NAME__ !== "Knowledge Workbench"
) {
  throw new Error("Normal entry point requires a normal build mode");
}

const policy = policyFor(__KNOWLEDGE_WORKBENCH_BUILD_MODE__);
const artifact: ArtifactExpectation = Object.freeze({
  mode: "normal",
  pluginVersion: __KNOWLEDGE_WORKBENCH_PLUGIN_VERSION__,
  manifestName: __KNOWLEDGE_WORKBENCH_MANIFEST_NAME__,
  artifactBinding: __KNOWLEDGE_WORKBENCH_ARTIFACT_BINDING__,
});
const ConcreteSettingsTab = createSettingsTabClass(
  PluginSettingTab,
  SecretComponent,
  policy,
  presentCatalogProgress,
);
const ConcreteCloudDirectoryPickerModal = createCloudDirectoryPickerModalClass(Modal);
const openExternalPage = (url: string): void => {
  window.open(url, "_blank", "noopener,noreferrer");
};

const runtime = Object.freeze({
  policy,
  artifact,
  selectVaultWrites: (vault) => vault,
  createQuickCapture: (app, getLocale) => {
    const ConcreteQuickCaptureModal = createQuickCaptureModalClass(Modal, getLocale);
    return new ObsidianQuickCaptureAdapter(
      app,
      () => new ConcreteQuickCaptureModal(app),
    );
  },
  createChangePreview: (app, plans, getLocale) => {
    const ConcreteChangePreviewModal = createChangePreviewModalClass(Modal, policy, getLocale);
    return {
      request: (preview) => new ConcreteChangePreviewModal(app, plans).request(preview),
      requestSample: () => new ConcreteChangePreviewModal(app, plans).requestSample(),
    };
  },
  createHistoryConfirmation: (app, getLocale) => {
    const ConcreteHistoryConfirmationModal = createHistoryConfirmationModalClass(Modal, getLocale);
    return {
      request: () => new ConcreteHistoryConfirmationModal(app).request(),
    };
  },
  createSettingsTab: (app, plugin, controller, getLocale) => {
    void getLocale;
    return new ConcreteSettingsTab(
      app,
      plugin,
      controller,
    );
  },
  createWorkbenchSettingsSurface: (app, controller, getLocale) => {
    void getLocale;
    return createSettingsSectionsSurface({
      app,
      controller,
      policy,
      createSecretComponent: (hostApp, root) => new SecretComponent(hostApp, root),
    }, presentCatalogProgress);
  },
  createCatalog: (app) => createNormalCloudCatalogRuntime({
    catalogRoot: resolveCatalogRoot(),
    host: {
      secretStorage: app.secretStorage,
      openAuthorizationPage: async (url) => { openExternalPage(url); },
      request: async (request) => {
        const response = await requestUrl({
          method: request.method,
          url: request.url,
          throw: false,
        });
        return { status: response.status, text: response.text };
      },
      copyText: (value) => navigator.clipboard.writeText(value),
      openBaidu: async () => { openExternalPage("https://pan.baidu.com/disk/main"); },
    },
  }),
  createCatalogConfirmation: (app, getLocale) => {
    const ConcreteCatalogScanConfirmationModal = createCatalogScanConfirmationModalClass(
      Modal,
      getLocale,
    );
    return {
      request: (rootPath) => new ConcreteCatalogScanConfirmationModal(app).request(rootPath),
    };
  },
  createCatalogTxtImportConfirmation: (app, getLocale) => {
    const ConcreteCatalogTxtImportConfirmationModal = createCatalogTxtImportConfirmationModalClass(
      Modal,
      getLocale,
    );
    return {
      request: (summary) => new ConcreteCatalogTxtImportConfirmationModal(app).request(summary),
    };
  },
  createCatalogLargeScanConfirmation: (app, getLocale) => {
    const ConcreteCatalogLargeScanConfirmationModal = createCatalogLargeScanConfirmationModalClass(
      Modal,
      getLocale,
    );
    return {
      request: (input) => new ConcreteCatalogLargeScanConfirmationModal(app).request(input),
    };
  },
  createCatalogDirectoryPicker: (app, getLocale) => ({
    request: (input) => new ConcreteCloudDirectoryPickerModal(
      app,
      () => createWorkbenchI18n(getLocale()),
    ).request(input),
  }),
  createAi: (app, getLocale) => {
    const ConcreteAiPayloadPreviewModal = createAiPayloadPreviewModalClass(Modal, getLocale);
    return {
    preview: {
      request: (preview) => new ConcreteAiPayloadPreviewModal(app).request(preview),
    },
    getSecret: (id) => app.secretStorage.getSecret(id),
    createClient: (endpoint, model, secret) => new ObsidianAiClient(
      endpoint,
      model,
      secret,
      async (request) => {
        const response = await requestUrl(request);
        return { status: response.status, text: response.text };
      },
      {
        setTimeout: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
        clearTimeout: (handle) => window.clearTimeout(handle as number),
      },
    ),
    delay: (milliseconds) => new Promise<void>((resolve) => {
      window.setTimeout(resolve, milliseconds);
    }),
    };
  },
} satisfies RuntimeComposition);

export default createKnowledgeWorkbenchPluginClass(runtime);
