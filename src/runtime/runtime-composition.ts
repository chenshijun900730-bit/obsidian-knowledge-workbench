import type { App, Plugin, PluginSettingTab } from "obsidian";
import type { QuickCapturePort, VaultWritePort } from "../core/ports";
import type { ChangePlanService } from "../plans/change-plan-service";
import type { ChangePreviewPresenter } from "../ui/change-preview-modal";
import type { HistoryConfirmationPresenter } from "../ui/history-tab";
import type {
  WorkbenchAiDependencies,
  WorkbenchController,
} from "../ui/workbench-controller";
import type { ArtifactExpectation } from "./artifact-binding";
import type { RuntimeSafetyPolicy } from "./safety-policy";

export interface DisposableQuickCapturePort extends QuickCapturePort {
  dispose(): void;
}

export interface RuntimeComposition {
  readonly policy: RuntimeSafetyPolicy;
  readonly artifact: ArtifactExpectation;
  readonly selectVaultWrites: (vault: VaultWritePort) => VaultWritePort;
  readonly createQuickCapture: (app: App) => DisposableQuickCapturePort;
  readonly createChangePreview: (
    app: App,
    plans: ChangePlanService,
  ) => ChangePreviewPresenter;
  readonly createHistoryConfirmation: (app: App) => HistoryConfirmationPresenter;
  readonly createSettingsTab: (
    app: App,
    plugin: Plugin,
    controller: WorkbenchController,
  ) => PluginSettingTab;
  readonly createAi?: (app: App) => WorkbenchAiDependencies;
}

export function assertRuntimeCompositionCoherence(
  policy: Pick<RuntimeSafetyPolicy, "mode">,
  artifact: Pick<ArtifactExpectation, "mode">,
): void {
  if (policy.mode !== artifact.mode) {
    throw new Error("Runtime policy and artifact mode do not match");
  }
}
