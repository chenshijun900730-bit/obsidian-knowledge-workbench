import { Modal, PluginSettingTab } from "obsidian";
import { createKnowledgeWorkbenchPluginClass } from "./plugin/knowledge-workbench-plugin";
import type { ArtifactExpectation } from "./runtime/artifact-binding";
import {
  READ_ONLY_QUICK_CAPTURE_PORT,
  READ_ONLY_VAULT_WRITE_PORT,
} from "./runtime/read-only-ports";
import type { RuntimeComposition } from "./runtime/runtime-composition";
import { policyFor } from "./runtime/safety-policy";
import { createChangePreviewModalClass } from "./ui/change-preview-modal";
import { createSettingsTabClass } from "./ui/settings-tab";

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
const ConcreteChangePreviewModal = createChangePreviewModalClass(Modal, policy);
const ConcreteSettingsTab = createSettingsTabClass(
  PluginSettingTab,
  undefined,
  policy,
);

const runtime = Object.freeze({
  policy,
  artifact,
  selectVaultWrites: () => READ_ONLY_VAULT_WRITE_PORT,
  createQuickCapture: () => ({
    capture: () => READ_ONLY_QUICK_CAPTURE_PORT.capture(),
    dispose: () => undefined,
  }),
  createChangePreview: (app, plans) => ({
    request: (preview) => new ConcreteChangePreviewModal(app, plans).request(preview),
    requestSample: () => new ConcreteChangePreviewModal(app, plans).requestSample(),
  }),
  createHistoryConfirmation: () => ({ request: async () => false }),
  createSettingsTab: (app, plugin, controller) => new ConcreteSettingsTab(
    app,
    plugin,
    controller,
  ),
} satisfies RuntimeComposition);

export default createKnowledgeWorkbenchPluginClass(runtime);
