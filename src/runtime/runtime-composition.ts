import type { App, Plugin, PluginSettingTab } from "obsidian";
import type { Clock, QuickCapturePort, VaultWritePort } from "../core/ports";
import type { ChangePlanService } from "../plans/change-plan-service";
import type { ChangePreviewPresenter } from "../ui/change-preview-modal";
import type { HistoryConfirmationPresenter } from "../ui/history-tab";
import type {
  CloudDirectorySelectionValidator,
  WorkbenchAiDependencies,
  WorkbenchController,
} from "../ui/workbench-controller";
import type { ArtifactExpectation } from "./artifact-binding";
import type { RuntimeSafetyPolicy } from "./safety-policy";
import type { CloudCatalogRuntime } from "../catalog/cloud-catalog-runtime";
import type { CatalogScanConfirmationPresenter } from "../ui/catalog-scan-confirmation-modal";
import type { CatalogTxtImportConfirmationPresenter } from "../ui/catalog-txt-import-confirmation-modal";
import type { CatalogLargeScanConfirmationPresenter } from "../ui/catalog-large-scan-confirmation-modal";
import type { SettingsSectionsSurface } from "../ui/settings-sections";
import type {
  WorkbenchLocaleProvider,
} from "../i18n/workbench-i18n";
import type { CloudDirectoryPickerPresenter } from "../ui/cloud-directory-picker";
import type { CloudVerificationRootHasher } from "../catalog/cloud-verification-scope";
import type { PluginDataStore } from "../storage/plugin-data-store";
import type {
  FolderSelectionHostCapability,
  FolderSelectionSessionFactoryPort,
} from "../ui/folder-selection-host";

export type { WorkbenchLocaleProvider } from "../i18n/workbench-i18n";

export interface DisposableQuickCapturePort extends QuickCapturePort {
  dispose(): void;
}

export interface FolderSelectionComposition {
  readonly sessionFactory: FolderSelectionSessionFactoryPort;
  readonly hostCapability: FolderSelectionHostCapability;
}

export interface RuntimeComposition {
  readonly policy: RuntimeSafetyPolicy;
  readonly artifact: ArtifactExpectation;
  readonly selectVaultWrites: (vault: VaultWritePort) => VaultWritePort;
  readonly createQuickCapture: (
    app: App,
    getLocale: WorkbenchLocaleProvider,
  ) => DisposableQuickCapturePort;
  readonly createChangePreview: (
    app: App,
    plans: ChangePlanService,
    getLocale: WorkbenchLocaleProvider,
  ) => ChangePreviewPresenter;
  readonly createHistoryConfirmation: (
    app: App,
    getLocale: WorkbenchLocaleProvider,
  ) => HistoryConfirmationPresenter;
  readonly createSettingsTab: (
    app: App,
    plugin: Plugin,
    controller: WorkbenchController,
    getLocale: WorkbenchLocaleProvider,
  ) => PluginSettingTab;
  readonly createWorkbenchSettingsSurface?: (
    app: App,
    controller: WorkbenchController,
    getLocale: WorkbenchLocaleProvider,
  ) => SettingsSectionsSurface;
  readonly createAi?: (
    app: App,
    getLocale: WorkbenchLocaleProvider,
  ) => WorkbenchAiDependencies;
  readonly createCatalog: (app: App) => CloudCatalogRuntime;
  readonly createFolderSelection: (input: Readonly<{
    store: PluginDataStore;
    catalog: CloudCatalogRuntime;
    clock: Clock;
  }>) => FolderSelectionComposition;
  readonly cloudVerificationRootHasher: CloudVerificationRootHasher;
  readonly createCatalogConfirmation: (
    app: App,
    getLocale: WorkbenchLocaleProvider,
  ) => CatalogScanConfirmationPresenter;
  readonly createCatalogTxtImportConfirmation?: (
    app: App,
    getLocale: WorkbenchLocaleProvider,
  ) => CatalogTxtImportConfirmationPresenter;
  readonly createCatalogLargeScanConfirmation?: (
    app: App,
    getLocale: WorkbenchLocaleProvider,
  ) => CatalogLargeScanConfirmationPresenter;
  readonly createCatalogDirectoryPicker?: (
    app: App,
    getLocale: WorkbenchLocaleProvider,
  ) => CloudDirectoryPickerPresenter;
  readonly catalogDirectorySelectionValidator?: CloudDirectorySelectionValidator;
}

export function assertRuntimeCompositionCoherence(
  policy: Pick<RuntimeSafetyPolicy, "mode">,
  artifact: Pick<ArtifactExpectation, "mode">,
): void {
  if (policy.mode !== artifact.mode) {
    throw new Error("Runtime policy and artifact mode do not match");
  }
}
