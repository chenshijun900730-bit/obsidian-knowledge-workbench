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
const ConcreteQuickCaptureModal = createQuickCaptureModalClass(Modal);
const ConcreteChangePreviewModal = createChangePreviewModalClass(Modal, policy);
const ConcreteSettingsTab = createSettingsTabClass(
  PluginSettingTab,
  SecretComponent,
  policy,
);
const ConcreteHistoryConfirmationModal = createHistoryConfirmationModalClass(Modal);
const ConcreteAiPayloadPreviewModal = createAiPayloadPreviewModalClass(Modal);

const runtime = Object.freeze({
  policy,
  artifact,
  selectVaultWrites: (vault) => vault,
  createQuickCapture: (app) => new ObsidianQuickCaptureAdapter(
    app,
    () => new ConcreteQuickCaptureModal(app),
  ),
  createChangePreview: (app, plans) => ({
    request: (preview) => new ConcreteChangePreviewModal(app, plans).request(preview),
    requestSample: () => new ConcreteChangePreviewModal(app, plans).requestSample(),
  }),
  createHistoryConfirmation: (app) => ({
    request: () => new ConcreteHistoryConfirmationModal(app).request(),
  }),
  createSettingsTab: (app, plugin, controller) => new ConcreteSettingsTab(
    app,
    plugin,
    controller,
  ),
  createAi: (app) => ({
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
  }),
} satisfies RuntimeComposition);

export default createKnowledgeWorkbenchPluginClass(runtime);
