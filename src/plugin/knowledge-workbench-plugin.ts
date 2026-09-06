import {
  getFrontMatterInfo,
  ItemView,
  normalizePath,
  Notice,
  parseLinktext,
  parseYaml,
  Plugin,
  TFile,
} from "obsidian";
import { ObsidianPluginDataAdapter } from "../adapters/obsidian-plugin-data-adapter";
import { ObsidianVaultAdapter } from "../adapters/obsidian-vault-adapter";
import {
  initializeIndexForLayout,
  initializeRecoveredLayout,
  LifecycleEpoch,
  ObsidianWorkspaceAdapter,
  closeObsidianSettingsIfSupported,
  requireActivatedWorkbench,
  RetryableAsyncGate,
  runVisibleHostAction,
  SurfacedHostError,
} from "../adapters/obsidian-workspace-adapter";
import {
  ClassificationService,
  createIndexPathPolicy,
} from "../classification/classification-service";
import { VIEW_TYPE } from "../constants";
import type { Clock } from "../core/ports";
import { IncrementalIndexQueue } from "../indexing/incremental-index-queue";
import { IndexService } from "../indexing/index-service";
import { MapService } from "../map/map-service";
import { ChangePlanService } from "../plans/change-plan-service";
import { verifyArtifactBinding } from "../runtime/artifact-binding";
import {
  assertRuntimeCompositionCoherence,
  type DisposableQuickCapturePort,
  type RuntimeComposition,
} from "../runtime/runtime-composition";
import {
  createCaseSensitiveArtifactPort,
  runStartupGate,
} from "../runtime/startup-gate";
import { PluginDataStore } from "../storage/plugin-data-store";
import { SuggestionService } from "../suggestions/suggestion-service";
import { TodayService } from "../today/today-service";
import { OperationJournal } from "../transactions/operation-journal";
import { RecoveryAuditService } from "../transactions/recovery-audit-service";
import { RecoveryReadinessGate } from "../transactions/recovery-readiness-gate";
import { TransactionService } from "../transactions/transaction-service";
import { UndoService } from "../transactions/undo-service";
import { WorkbenchController } from "../ui/workbench-controller";
import { createWorkbenchViewClass } from "../ui/workbench-view";
import { startCatalogInitialization } from "../runtime/catalog-runtime-lifecycle";
import {
  createWorkbenchI18n,
  type WorkbenchLocaleProvider,
  type WorkbenchMessageKey,
} from "../i18n/workbench-i18n";

const systemClock: Clock = { now: () => Date.now() };
type HostActionMessageKey = Extract<WorkbenchMessageKey, `host.action.${string}`>;

export function createKnowledgeWorkbenchPluginClass(runtime: RuntimeComposition) {
  assertRuntimeCompositionCoherence(runtime.policy, runtime.artifact);
  const ConcreteWorkbenchView = createWorkbenchViewClass(ItemView, runtime.policy);

  return class KnowledgeWorkbenchPlugin extends Plugin {
    private controller: WorkbenchController | null = null;
    private vaultAdapter: ObsidianVaultAdapter | null = null;
    private index: IndexService | null = null;
    private indexQueue: IncrementalIndexQueue | null = null;
    private store: PluginDataStore | null = null;
    private quickCapture: DisposableQuickCapturePort | null = null;
    private recoveryAudit: RecoveryAuditService | null = null;
    private recoveryReadiness: RecoveryReadinessGate | null = null;
    private readonly lifecycle = new LifecycleEpoch();
    private readonly layoutGate = new RetryableAsyncGate();
    private activeEpoch = 0;
    private unloaded = false;
    private layoutReady = false;
    private layoutTrackingStarted = false;

    async onload(): Promise<void> {
      const epoch = this.lifecycle.begin();
      this.activeEpoch = epoch;
      this.unloaded = false;
      this.layoutReady = false;
      this.layoutTrackingStarted = false;
      this.layoutGate.reset();

      const store = await runStartupGate({
        verifyArtifact: () => verifyArtifactBinding(
          this.manifest,
          createCaseSensitiveArtifactPort(this.app.vault.adapter),
          runtime.artifact,
        ),
        loadStore: async () => {
          const value = new PluginDataStore(new ObsidianPluginDataAdapter(this));
          await value.load();
          return value;
        },
        enforcePolicy: (value) => value.enforceRuntimePolicy(runtime.policy),
      });
      if (!this.lifecycle.owns(epoch)) return;
      const getLocale: WorkbenchLocaleProvider = () => store.settings().locale;

      let queueListener: IncrementalIndexQueue | null = null;
      const vaultAdapter = new ObsidianVaultAdapter(
        this.app,
        (event) => queueListener?.enqueue(event),
        parseLinktext,
        { TFile, normalizePath, getFrontMatterInfo, parseYaml },
      );
      const index = new IndexService(
        vaultAdapter,
        store,
        systemClock,
        8,
        createIndexPathPolicy(() => store.settings()),
      );
      const queue = new IncrementalIndexQueue(index);
      queueListener = queue;
      await queue.pauseAutoFlush();
      if (!this.lifecycle.owns(epoch)) {
        vaultAdapter.dispose();
        return;
      }
      const workspace = new ObsidianWorkspaceAdapter(this.app);
      const quickCapture = runtime.createQuickCapture(this.app, getLocale);
      const catalog = runtime.createCatalog(this.app);
      const folderSelection = runtime.createFolderSelection({
        store,
        catalog,
        clock: systemClock,
      });
      const catalogConfirmation = runtime.createCatalogConfirmation(this.app, getLocale);
      const catalogTxtImportConfirmation = runtime.createCatalogTxtImportConfirmation?.(
        this.app,
        getLocale,
      );
      const catalogLargeScanConfirmation = runtime.createCatalogLargeScanConfirmation?.(
        this.app,
        getLocale,
      );
      const catalogDirectoryPicker = runtime.createCatalogDirectoryPicker !== undefined
        ? runtime.createCatalogDirectoryPicker(this.app, getLocale)
        : undefined;
      const changePlans = new ChangePlanService(vaultAdapter, () => {
        const settings = store.settings();
        return runtime.policy.contentWrites === "allowed"
          && settings.writePreviewAcknowledged
          && settings.writeEnabled;
      });
      const journal = new OperationJournal(store);
      const recoveryReadiness = new RecoveryReadinessGate();
      const recoveryAudit = new RecoveryAuditService(
        journal,
        vaultAdapter,
        recoveryReadiness,
        store,
      );
      const undo = new UndoService(journal, vaultAdapter, changePlans);
      const transactions = new TransactionService(
        changePlans,
        vaultAdapter,
        runtime.selectVaultWrites(vaultAdapter),
        journal,
        systemClock,
        recoveryReadiness,
      );
      const controller = new WorkbenchController({
        policy: runtime.policy,
        reads: vaultAdapter,
        index,
        indexQueue: queue,
        classification: new ClassificationService(),
        today: new TodayService(systemClock),
        map: new MapService(),
        suggestions: new SuggestionService(),
        changePlans,
        changePreview: runtime.createChangePreview(this.app, changePlans, getLocale),
        store,
        workspace,
        quickCapture,
        transactions,
        journal,
        undo,
        historyConfirmation: runtime.createHistoryConfirmation(this.app, getLocale),
        clock: systemClock,
        ai: runtime.createAi?.(this.app, getLocale),
        catalog,
        folderSelectionSessionFactory: folderSelection.sessionFactory,
        cloudVerificationRootHasher: runtime.cloudVerificationRootHasher,
        catalogConfirmation,
        ...(catalogTxtImportConfirmation === undefined
          ? {}
          : { catalogTxtImportConfirmation }),
        ...(catalogLargeScanConfirmation === undefined
          ? {}
          : { catalogLargeScanConfirmation }),
        ...(catalogDirectoryPicker === undefined ? {} : { catalogDirectoryPicker }),
        ...(runtime.catalogDirectorySelectionValidator === undefined
          ? {}
          : {
              catalogDirectorySelectionValidator:
                runtime.catalogDirectorySelectionValidator,
            }),
      });
      this.controller = controller;
      this.vaultAdapter = vaultAdapter;
      this.index = index;
      this.indexQueue = queue;
      this.quickCapture = quickCapture;
      this.store = store;
      this.recoveryAudit = recoveryAudit;
      this.recoveryReadiness = recoveryReadiness;

      startCatalogInitialization(controller, (code) => {
        if (this.lifecycle.owns(epoch)) controller.reportCatalogError(code);
      });

      // Metadata events begin during onload; vault events wait until layout readiness.
      vaultAdapter.startMetadataTracking();
      this.registerView(VIEW_TYPE, (leaf) => new ConcreteWorkbenchView(
        leaf,
        controller,
        runtime.createWorkbenchSettingsSurface?.(this.app, controller, getLocale),
        folderSelection.hostCapability,
      ));
      const loadI18n = createWorkbenchI18n(getLocale());
      this.addRibbonIcon(
        "network",
        loadI18n.t("host.ribbon.open"),
        () => this.requestOpenWorkbench(),
      );
      this.addCommand({
        id: "open-workbench",
        name: loadI18n.t("host.command.open"),
        callback: () => this.requestOpenWorkbench(),
      });
      this.addSettingTab(runtime.createSettingsTab(
        this.app,
        this,
        controller,
        getLocale,
        async () => {
          controller.selectRoute({ tab: "task", page: "overview" });
          const settingsClosed = closeObsidianSettingsIfSupported(this.app);
          if (!settingsClosed) {
            new Notice(createWorkbenchI18n(getLocale()).t("host.settings.closeGuidance"));
          }
          await requireActivatedWorkbench(
            this.app,
            (view) => view instanceof ConcreteWorkbenchView,
            () => controller.reportError("host.action.openWorkbenchFailed" satisfies HostActionMessageKey),
          );
        },
      ));
      this.app.workspace.onLayoutReady(() => {
        if (!this.lifecycle.owns(epoch)) return;
        this.layoutReady = true;
        void this.initializeLayout().catch(() => undefined);
      });
    }

    onunload(): void {
      this.unloaded = true;
      this.lifecycle.invalidate();
      this.layoutGate.reset();
      this.recoveryReadiness?.reset();
      this.layoutReady = false;
      this.layoutTrackingStarted = false;
      this.controller?.dispose();
      this.quickCapture?.dispose();
      this.vaultAdapter?.dispose();
      this.controller = null;
      this.vaultAdapter = null;
      this.index = null;
      this.indexQueue = null;
      this.store = null;
      this.quickCapture = null;
      this.recoveryAudit = null;
      this.recoveryReadiness = null;
    }

    private initializeLayout(): Promise<void> {
      if (!this.layoutReady || this.unloaded) return Promise.resolve();
      const epoch = this.activeEpoch;
      return this.layoutGate.run(async () => {
        try {
          await this.initializeLayoutAttempt(epoch);
        } catch (error) {
          this.showLayoutError(error, epoch);
          throw new SurfacedHostError(error);
        }
      });
    }

    private async initializeLayoutAttempt(epoch: number): Promise<void> {
      const controller = this.controller;
      const vaultAdapter = this.vaultAdapter;
      const index = this.index;
      const queue = this.indexQueue;
      const store = this.store;
      const recoveryAudit = this.recoveryAudit;
      if (
        !this.lifecycle.owns(epoch)
        || controller === null
        || vaultAdapter === null
        || index === null
        || queue === null
        || store === null
        || recoveryAudit === null
      ) return;
      if (!this.layoutTrackingStarted) {
        vaultAdapter.startVaultTracking();
        this.registerEvent(this.app.workspace.on("file-open", (file) => {
          if (
            !this.lifecycle.owns(epoch)
            || file === null
            || file.extension.toLocaleLowerCase("en-US") !== "md"
          ) return;
          void controller.recordFileOpen(file.path).catch((error: unknown) => {
            void error;
            controller.reportError("host.action.openNoteFailed" satisfies HostActionMessageKey);
          });
        }));
        this.layoutTrackingStarted = true;
      }
      await initializeRecoveredLayout({
        auditRecovery: () => recoveryAudit.auditInFlight(),
        refreshHistory: () => controller.refreshHistory(),
        initializeIndex: () => initializeIndexForLayout({
          hasActiveIndex: () => store.hasActiveIndex(),
          startInitialScan: () => controller.startInitialScan(),
          reconcileInventory: () => index.reconcileInventory(),
          resumeAndFlush: () => queue.resumeAndFlush(),
        }, () => this.lifecycle.owns(epoch)),
        reportReady: () => controller.reportReady(),
      }, () => this.lifecycle.owns(epoch));
      if (!this.lifecycle.owns(epoch)) return;
      if (store.settings().openAtStartup) await this.revealWorkbench(epoch);
    }

    private async openWorkbench(): Promise<void> {
      if (this.unloaded) return;
      if (this.layoutReady && !this.layoutGate.isComplete()) {
        await this.initializeLayout();
      }
      if (this.unloaded) return;
      await this.revealWorkbench();
    }

    private requestOpenWorkbench(): void {
      const epoch = this.activeEpoch;
      runVisibleHostAction(() => this.openWorkbench(), (error: unknown) => {
        if (error instanceof SurfacedHostError) return;
        void error;
        this.showSafeHostError("host.action.openWorkbenchFailed", epoch);
      });
    }

    private revealWorkbench(epoch = this.activeEpoch): Promise<void> {
      return requireActivatedWorkbench(
        this.app,
        (view) => view instanceof ConcreteWorkbenchView,
        () => {
          if (this.lifecycle.owns(epoch)) {
            this.controller?.reportError("host.action.openWorkbenchFailed" satisfies HostActionMessageKey);
          }
        },
      );
    }

    private showLayoutError(error: unknown, epoch: number): void {
      void error;
      this.showSafeHostError("host.action.layoutFailed", epoch);
    }

    private showSafeHostError(key: HostActionMessageKey, epoch: number): void {
      if (!this.lifecycle.owns(epoch)) return;
      const locale = this.store?.settings().locale ?? "zh-CN";
      const message = createWorkbenchI18n(locale).t(key);
      this.controller?.reportError(key);
      new Notice(message);
    }
  };
}
