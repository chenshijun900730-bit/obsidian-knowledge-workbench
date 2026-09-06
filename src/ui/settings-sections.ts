import type { App } from "obsidian";
import type { FolderRule, FolderRuleProposal, PluginSettings } from "../storage/plugin-data";
import type { AiSettingsInput } from "./workbench-controller";
import type { RuntimeSafetyPolicy } from "../runtime/safety-policy";
import type { CloudCatalogConnectionViewModel } from "../catalog/cloud-catalog-runtime";
import type { HybridCatalogViewModel } from "../catalog/hybrid-catalog-runtime";
import {
  CATALOG_TXT_IMPORT_BUDGET,
  type CatalogVerificationStatus,
} from "../catalog/hybrid-catalog-types";
import {
  createWorkbenchI18n,
  type WorkbenchI18n,
  type WorkbenchLocale,
  type WorkbenchMessageKey,
} from "../i18n/workbench-i18n";
import { presentCatalogMessage } from "./catalog-message-presenter";
import {
  createCloudDirectoryField,
  type CloudDirectoryFieldSurface,
} from "./cloud-directory-field";
import { connectionCanVerify } from "./verification-connection-semantics";
import {
  type CloudDirectoryPickerPurpose,
  type CloudDirectorySelection,
} from "../catalog/cloud-directory-selection";

export interface SettingsController {
  settings(): PluginSettings;
  folderRuleProposals(): readonly FolderRuleProposal[];
  previewSampleChange(): void;
  setOpenAtStartup(value: boolean): Promise<void>;
  setLocale(locale: WorkbenchLocale): Promise<void>;
  setWriteEnabled(value: boolean): Promise<void>;
  applyFolderRules(rules: readonly FolderRule[]): Promise<void>;
  setExcludedPrefixes(prefixes: readonly string[]): Promise<void>;
  saveAiSettings?(settings: AiSettingsInput): Promise<void>;
  setSessionAiSecret?(secret: string): void;
  catalogConnection?(): CloudCatalogConnectionViewModel | undefined;
  subscribeCatalogConnection?(listener: () => void): () => void;
  connectCatalog?(
    credentials: Readonly<{ appKey: string; secretKey: string }>,
    intent?: CatalogAuthorizationIntent,
  ): Promise<void>;
  submitCatalogAuthorizationCode?(
    code: string,
    expectedIntent?: CatalogAuthorizationIntent,
  ): Promise<void>;
  cancelCatalogAuthorization?(): void;
  revokeCatalog?(): Promise<void>;
  validateCatalogScanRoot?(rootPath: string): string;
  chooseCatalogRoot?(input: Readonly<{
    initialRoot: string;
    purpose: CloudDirectoryPickerPurpose;
  }>): Promise<CloudDirectorySelection | null>;
  requestCatalogScan?(rootPath: string, onConfirmed?: () => void): Promise<void>;
  cancelCatalogScan?(): void;
  hybridCatalog?(): HybridCatalogViewModel | undefined;
  subscribeHybridCatalog?(listener: () => void): () => void;
  previewCatalogTxt?(path: string): Promise<void>;
  requestCatalogTxtImport?(path: string, onConfirmed?: () => void): Promise<void>;
}

export type CatalogAuthorizationIntent = "repair-same-account" | "replace-identity";

export interface SecretComponentLike {
  setValue(value: string): this;
  onChange(callback: (value: string) => void): this;
}
export type SecretComponentConstructor = new (app: App, containerEl: HTMLElement) => SecretComponentLike;
export type SettingsSectionId =
  | "language"
  | "baidu"
  | "catalog-data"
  | "cloud-scan-advanced"
  | "privacy-ai";

export interface SettingsSectionsRenderOptions {
  readonly section?: SettingsSectionId;
  readonly onBackToMore?: () => void;
  readonly onOpenTaskOverview?: () => void;
}

export interface SettingsSectionsSurface {
  render(
    root: HTMLElement,
    locale: WorkbenchLocale,
    options?: SettingsSectionsRenderOptions,
  ): void;
  dispose(): void;
}

export interface SettingsSectionsDependencies {
  readonly app: App;
  readonly controller: SettingsController;
  readonly policy: RuntimeSafetyPolicy;
  readonly createSecretComponent?: (app: App, root: HTMLElement) => SecretComponentLike;
  /** The host owns navigation so native Settings never changes an invisible route. */
  readonly onOpenTaskOverview?: () => void;
}

const SECRET_STORAGE_BRAND = "SecretStorage";

export interface CatalogProgressPresentation {
  readonly scanStatus: string;
  readonly pdfProgress: string;
  readonly directoryProgress: string;
  readonly requestProgress: string;
  readonly timeProgress: string;
  readonly stopReason: string;
}
export type CatalogProgressPresenter = (
  connection: CloudCatalogConnectionViewModel | undefined,
  i18n: WorkbenchI18n,
) => CatalogProgressPresentation;

const CATALOG_AUTHORIZATION_INPUT_LIFETIME_MS = 10 * 60 * 1_000;

type SettingsDisplayStatus =
  | CloudCatalogConnectionViewModel["status"]
  | HybridCatalogViewModel["status"]
  | NonNullable<HybridCatalogViewModel["batch"]>["status"]
  | CatalogVerificationStatus;

const SETTINGS_STATUS_MESSAGE = {
  unconfigured: "settings.status.unconfigured",
  configured: "settings.status.configured",
  authorizing: "settings.status.authorizing",
  authorized: "settings.status.authorized",
  scanning: "settings.status.scanning",
  paused: "settings.status.paused",
  partial: "settings.status.partial",
  complete: "settings.status.complete",
  empty: "settings.status.empty",
  previewed: "settings.status.previewed",
  importing: "settings.status.importing",
  ready: "settings.status.ready",
  error: "settings.status.error",
  unavailable: "settings.status.unavailable",
  unverified: "settings.status.unverified",
  verified: "settings.status.verified",
  difference: "settings.status.difference",
} as const satisfies Record<SettingsDisplayStatus, WorkbenchMessageKey>;

type SettingsSaveMessageKey = Extract<WorkbenchMessageKey, `settings.save.${string}`>;
type SettingsErrorMessageKey = Extract<WorkbenchMessageKey, `settings.error.${string}`>;
type SettingsUiEvent = "change" | "input" | "toggle";

const heading = (doc: Document, level: 2 | 3, text: string): HTMLHeadingElement => {
  const value = doc.createElement(`h${level}`);
  value.textContent = text;
  return value;
};

const actionButton = (
  doc: Document,
  label: string,
  action: () => void,
  signal: AbortSignal,
): HTMLButtonElement => {
  const button = doc.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", action, { signal });
  return button;
};

type CollapsibleSettingsSection = Exclude<SettingsSectionId, "language">;

export function createSettingsSectionsSurface(
  dependencies: SettingsSectionsDependencies,
  presentCatalogProgress?: CatalogProgressPresenter,
): SettingsSectionsSurface {
  const { app, controller, policy, createSecretComponent, onOpenTaskOverview } = dependencies;
  return new (class StatefulSettingsSectionsSurface implements SettingsSectionsSurface {
    secretComponent: SecretComponentLike | null = null;
    private catalogAuthorizationExpiryTimer: number | null = null;
    private unsubscribeCatalogConnection: (() => void) | null = null;
    private unsubscribeHybridCatalog: (() => void) | null = null;
    private readonly expandedSections = new Set<CollapsibleSettingsSection>();
    private catalogAppKeyDraft = "";
    private catalogSecretKeyDraft = "";
    private catalogAuthorizationCodeDraft = "";
    private catalogAuthorizationIntent: CatalogAuthorizationIntent | null = null;
    private catalogScanRootDraft = "";
    private catalogScanDirectorySelection: CloudDirectorySelection | undefined;
    private catalogTxtPathDraft = "";
    private sessionAiSecretDraft = "";
    private liveStatus: HTMLElement | null = null;
    private renderGeneration = 0;
    private disposed = true;
    private renderAbortController: AbortController | null = null;
    private readonly sessionInputs = new Set<HTMLInputElement>();
    private readonly cloudDirectoryFields = new Set<CloudDirectoryFieldSurface>();
    render(
      root: HTMLElement,
      locale: WorkbenchLocale,
      options: SettingsSectionsRenderOptions = {},
    ): void {
      this.renderGeneration += 1;
      const generation = this.renderGeneration;
      this.disposed = false;
      this.renderAbortController?.abort();
      this.renderAbortController = new AbortController();
      const renderSignal = this.renderAbortController.signal;
      this.disposeCloudDirectoryFields();
      this.clearSessionInputValues();
      this.clearCatalogAuthorizationExpiryTimer();
      this.unsubscribeCatalogConnection?.();
      this.unsubscribeCatalogConnection = null;
      this.unsubscribeHybridCatalog?.();
      this.unsubscribeHybridCatalog = null;
      const doc = root.ownerDocument;
      const settings = controller.settings();
      const i18n = createWorkbenchI18n(locale);
      const localizedStatus = (value: SettingsDisplayStatus | undefined): string => value === undefined
        ? "—"
        : i18n.t(SETTINGS_STATUS_MESSAGE[value]);
      const localizedOr = (key: string, fallback: string): string => {
        try {
          return i18n.t(key as WorkbenchMessageKey);
        } catch {
          return fallback;
        }
      };
      const isCurrent = (): boolean => !this.disposed && this.renderGeneration === generation;
      const includesSection = (section: SettingsSectionId): boolean => (
        options.section === undefined || options.section === section
      );
      const listen = (
        target: EventTarget,
        type: SettingsUiEvent,
        listener: EventListenerOrEventListenerObject,
      ): void => { target.addEventListener(type, listener, { signal: renderSignal }); };
      const button = (label: string, action: () => void): HTMLButtonElement => actionButton(
        doc,
        label,
        () => { if (isCurrent()) action(); },
        renderSignal,
      );
      const trackSessionInput = (input: HTMLInputElement): void => {
        this.sessionInputs.add(input);
      };
      this.secretComponent = null;
      root.replaceChildren();
      root.classList.add("knowledge-workbench", "knowledge-workbench__settings");
      root.classList.toggle(
        "knowledge-workbench__settings--read-only",
        policy.configuration === "read-only",
      );
      root.append(heading(doc, 2, i18n.t("settings.title")));
      const status = doc.createElement("div");
      status.className = "knowledge-workbench__settings-status";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      status.textContent = i18n.t("settings.surface.ready");
      root.append(status);
      this.liveStatus = status;

      const languageSection = doc.createElement("section");
      languageSection.dataset.settingsSection = "language";
      languageSection.className = "knowledge-workbench__settings-card";
      languageSection.append(heading(doc, 3, i18n.t("settings.section.language")));
      const createCollapsibleSection = (
        id: CollapsibleSettingsSection,
        title: string,
        summary: string,
      ): Readonly<{ card: HTMLDetailsElement; content: HTMLElement }> => {
        const card = doc.createElement("details");
        card.dataset.settingsSection = id;
        card.className = "knowledge-workbench__settings-card";
        card.open = this.expandedSections.has(id);
        listen(card, "toggle", () => {
          if (card.open) this.expandedSections.add(id);
          else this.expandedSections.delete(id);
        });
        const cardSummary = doc.createElement("summary");
        const cardTitle = doc.createElement("strong");
        cardTitle.textContent = title;
        const cardDescription = doc.createElement("span");
        cardDescription.textContent = summary;
        cardSummary.append(cardTitle, cardDescription);
        const content = doc.createElement("div");
        content.className = "knowledge-workbench__settings-card-content";
        card.append(cardSummary, content);
        return { card, content };
      };
      const baiduSection = createCollapsibleSection(
        "baidu",
        i18n.t("settings.section.baidu"),
        i18n.t("settings.section.baidu.summary"),
      );
      const largeCatalogSection = createCollapsibleSection(
        "catalog-data",
        i18n.t("settings.section.largeCatalog"),
        i18n.t("settings.section.largeCatalog.summary"),
      );
      const verificationSection = createCollapsibleSection(
        "cloud-scan-advanced",
        i18n.t("settings.section.verification"),
        i18n.t("settings.section.verification.summary"),
      );
      const privacyAiSection = createCollapsibleSection(
        "privacy-ai",
        i18n.t("settings.section.privacyAi"),
        i18n.t("settings.section.privacyAi.summary"),
      );
      const renderLanguageSection = (): HTMLElement => languageSection;
      const renderBaiduConnectionSection = (): HTMLDetailsElement => baiduSection.card;
      const renderLargeCatalogSection = (): HTMLDetailsElement => largeCatalogSection.card;
      const renderVerificationSection = (): HTMLDetailsElement => verificationSection.card;
      const renderPrivacyAiSection = (): HTMLDetailsElement => privacyAiSection.card;
      const renderAdvancedOrganizationSection = (): HTMLElement => privacyAiSection.content;
      const sections: readonly [SettingsSectionId, HTMLElement][] = [
        ["language", renderLanguageSection()],
        ["baidu", renderBaiduConnectionSection()],
        ["catalog-data", renderLargeCatalogSection()],
        ["cloud-scan-advanced", renderVerificationSection()],
        ["privacy-ai", renderPrivacyAiSection()],
      ];
      if (options.section !== undefined) {
        const back = button(i18n.t("more.back"), () => options.onBackToMore?.());
        back.dataset.action = "more-back";
        root.append(back);
      }
      root.append(...sections
        .filter(([id]) => options.section === undefined || options.section === id)
        .map(([, section]) => section));
      const openTask = button(i18n.t("settings.surface.openTaskOverview"), () => {
        (options.onOpenTaskOverview ?? onOpenTaskOverview)?.();
      });
      openTask.dataset.action = "open-task-overview";
      verificationSection.content.append(openTask);
      const run = async (
        labelKey: SettingsSaveMessageKey,
        operation: () => Promise<void>,
        near: HTMLElement,
        onError?: () => void,
        safeErrorKey?: SettingsErrorMessageKey,
      ): Promise<void> => {
        if (!isCurrent()) return;
        const label = i18n.t(labelKey);
        near.insertAdjacentElement("afterend", status);
        status.textContent = i18n.t("settings.save.progress", { label });
        try {
          await operation();
          if (!isCurrent()) return;
          status.textContent = i18n.t("settings.save.success", { label });
        } catch (error) {
          if (!isCurrent()) return;
          onError?.();
          const authorityGuidance = error instanceof Error
            ? ({
                "verification-must-pause": localizedOr(
                  "settings.error.verificationMustPause",
                  locale === "zh-CN"
                    ? "请先暂停当前核验，再修改百度网盘授权。"
                    : "Pause the current verification before changing Baidu authorization.",
                ),
                "scan-must-cancel": localizedOr(
                  "settings.error.scanMustCancel",
                  locale === "zh-CN"
                    ? "请先取消当前云端扫描，再修改百度网盘授权。"
                    : "Cancel the current cloud scan before changing Baidu authorization.",
                ),
                "cloud-authority-operation-busy": localizedOr(
                  "settings.error.cloudAuthorityBusy",
                  locale === "zh-CN"
                    ? "另一项百度网盘权限操作正在进行，请稍后再试。"
                    : "Another Baidu authority operation is in progress. Try again later.",
                ),
              } as Readonly<Record<string, string>>)[error.message]
            : undefined;
          status.textContent = authorityGuidance ?? (safeErrorKey === undefined
            ? i18n.t("settings.save.failure")
            : i18n.t(safeErrorKey));
        }
      };

      const startup = doc.createElement("label");
      startup.className = "knowledge-workbench__settings-row";
      const startupInput = doc.createElement("input");
      startupInput.type = "checkbox";
      startupInput.checked = settings.openAtStartup;
      listen(startupInput, "change", () => {
        void run(
          "settings.save.startup",
          () => controller.setOpenAtStartup(startupInput.checked),
          startup,
          () => { startupInput.checked = controller.settings().openAtStartup; },
        );
      });
      const startupText = doc.createElement("span");
      startupText.textContent = i18n.t("settings.surface.startup");
      startup.append(startupInput, startupText);
      const localeLabel = doc.createElement("label");
      localeLabel.className = "knowledge-workbench__settings-row";
      const localeText = doc.createElement("span");
      localeText.textContent = i18n.t("settings.save.language");
      const localeSelect = doc.createElement("select");
      localeSelect.dataset.locale = "true";
      localeSelect.dataset.focusKey = "settings-locale";
      for (const value of ["zh-CN", "en"] as const) {
        const option = doc.createElement("option");
        option.value = value;
        option.textContent = i18n.t(value === "zh-CN" ? "language.chinese" : "language.english");
        localeSelect.append(option);
      }
      localeSelect.value = settings.locale;
      listen(localeSelect, "change", () => {
        const previous = controller.settings().locale;
        const next = localeSelect.value as WorkbenchLocale;
        const restoreFocus = doc.activeElement === localeSelect;
        localeLabel.insertAdjacentElement("afterend", status);
        status.textContent = i18n.t("settings.save.progress", {
          label: i18n.t("settings.save.language"),
        });
        void controller.setLocale(next).then(() => {
          if (!isCurrent()) return;
          this.render(root, next, options);
          if (restoreFocus) {
            root.querySelector<HTMLSelectElement>('select[data-focus-key="settings-locale"]')
              ?.focus({ preventScroll: true });
          }
        }).catch(() => {
          if (!isCurrent()) return;
          localeSelect.value = previous;
          status.textContent = i18n.t("settings.save.failure");
        });
      });
      localeLabel.append(localeText, localeSelect);
      languageSection.append(localeLabel, startup);

      if (includesSection("privacy-ai")) {
      const safety = doc.createElement("section");
      safety.append(heading(doc, 3, i18n.t("settings.surface.writeSafety")));
      if (policy.configuration === "read-only") {
        const locked = doc.createElement("p");
        locked.className = "knowledge-workbench__locked";
        locked.textContent = i18n.t("settings.surface.writeUnavailable");
        safety.append(locked);
      } else if (!settings.writePreviewAcknowledged) {
        const locked = doc.createElement("p");
        locked.className = "knowledge-workbench__locked";
        locked.textContent = i18n.t("settings.surface.writeLocked");
        const review = button(i18n.t("settings.surface.reviewSample"), () => controller.previewSampleChange());
        safety.append(locked, review);
      } else {
        const writeLabel = doc.createElement("label");
        writeLabel.className = "knowledge-workbench__settings-row";
        const writeEnabled = doc.createElement("input");
        writeEnabled.type = "checkbox";
        writeEnabled.checked = settings.writeEnabled;
        writeEnabled.dataset.writeEnabled = "true";
        listen(writeEnabled, "change", () => {
          void run(
            "settings.save.write",
            () => controller.setWriteEnabled(writeEnabled.checked),
            safety,
            () => { writeEnabled.checked = controller.settings().writeEnabled; },
          );
        });
        const writeText = doc.createElement("span");
        writeText.textContent = i18n.t("settings.surface.enableWrite");
        writeLabel.append(writeEnabled, writeText);
        safety.append(writeLabel);
      }
      renderAdvancedOrganizationSection().append(safety);

      const organization = doc.createElement("section");
      organization.append(heading(doc, 3, i18n.t("settings.surface.folderRules")));
      const selected = new Map<string, FolderRule>();
      const folderRuleChoices: HTMLInputElement[] = [];
      const proposals = controller.folderRuleProposals();
      if (proposals.length === 0) {
        const empty = doc.createElement("p");
        empty.textContent = i18n.t("settings.surface.noFolderRules");
        organization.append(empty);
      }
      for (const proposal of proposals) {
        const row = doc.createElement("label");
        row.className = "knowledge-workbench__settings-row";
        const checkbox = doc.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = false;
        checkbox.dataset.folderRule = proposal.prefix;
        folderRuleChoices.push(checkbox);
        listen(checkbox, "change", () => {
          if (checkbox.checked) selected.set(proposal.prefix, { prefix: proposal.prefix, kind: proposal.kind });
          else selected.delete(proposal.prefix);
        });
        const description = doc.createElement("span");
        description.textContent = i18n.t("settings.surface.ruleDescription", {
          prefix: proposal.prefix,
          count: i18n.number(proposal.noteCount),
          samples: proposal.samplePaths.join(", "),
        });
        row.append(checkbox, description);
        organization.append(row);
      }
      organization.append(button(i18n.t("settings.surface.confirmRules"), () => {
        if (selected.size === 0) return;
        void run("settings.save.folderRules", async () => {
          const merged = new Map(controller.settings().folderRules.map((rule) => [rule.prefix, rule]));
          for (const [prefix, rule] of selected) merged.set(prefix, rule);
          await controller.applyFolderRules([...merged.values()]);
          if (!isCurrent()) return;
          selected.clear();
          for (const choice of folderRuleChoices) choice.checked = false;
        }, organization);
      }));
      privacyAiSection.content.append(organization);

      const exclusions = doc.createElement("section");
      exclusions.append(heading(doc, 3, i18n.t("settings.surface.excludedFolders")));
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
          i18n.t("settings.surface.ruleDescription", {
            prefix: proposal.prefix,
            count: i18n.number(proposal.noteCount),
            samples: proposal.samplePaths.join(", "),
          }),
        );
      }
      for (const prefix of settings.excludedPrefixes.filter((value) => !proposalPrefixes.has(value)).sort()) {
        appendExclusion(prefix, i18n.t("settings.surface.existingExclusion", { prefix }));
      }
      if (exclusionRows.length === 0) {
        const empty = doc.createElement("p");
        empty.textContent = i18n.t("settings.surface.noExclusions");
        exclusions.append(empty);
      }
      exclusions.append(button(i18n.t("settings.surface.applyExclusions"), () => {
        const prefixes = exclusionRows.filter((checkbox) => checkbox.checked)
          .map((checkbox) => checkbox.dataset.excludedPrefix!);
        void run("settings.save.exclusions", () => controller.setExcludedPrefixes(prefixes), exclusions, () => {
          const persisted = new Set(controller.settings().excludedPrefixes);
          for (const checkbox of exclusionRows) {
            checkbox.checked = persisted.has(checkbox.dataset.excludedPrefix!);
          }
        });
      }));
      privacyAiSection.content.append(exclusions);
      }

      const renderSharedScanControls = (
        target: HTMLElement,
        onConnectionRender?: (connection: CloudCatalogConnectionViewModel | undefined) => void,
      ): void => {
        if (
          controller.validateCatalogScanRoot === undefined
          || controller.requestCatalogScan === undefined
        ) return;
        const validateCatalogScanRoot = controller.validateCatalogScanRoot.bind(controller);
        const requestCatalogScan = controller.requestCatalogScan.bind(controller);
        const catalogProgress = doc.createElement("div");
        catalogProgress.className = "knowledge-workbench__catalog-progress";
        const scanStatus = doc.createElement("p");
        scanStatus.dataset.catalogScanStatus = "true";
        const pdfProgress = doc.createElement("p");
        pdfProgress.dataset.catalogPdfProgress = "true";
        const directoryProgress = doc.createElement("p");
        directoryProgress.dataset.catalogDirectoryProgress = "true";
        const requestProgress = doc.createElement("p");
        requestProgress.dataset.catalogRequestProgress = "true";
        const timeProgress = doc.createElement("p");
        timeProgress.dataset.catalogTimeProgress = "true";
        const stopReason = doc.createElement("p");
        stopReason.dataset.catalogStopReason = "true";
        catalogProgress.append(
          scanStatus,
          pdfProgress,
          directoryProgress,
          requestProgress,
          timeProgress,
          stopReason,
        );
        const interactionLocked = policy.configuration === "read-only";
        const initialConnection = controller.catalogConnection?.();
        let scanBusy = initialConnection?.status === "scanning";
        let scanActionPending = false;
        let recomputeScanActions = (): void => undefined;
        const field = createCloudDirectoryField(doc, i18n, {
          path: this.catalogScanRootDraft,
          selection: this.catalogScanDirectorySelection,
          disabled: interactionLocked || scanBusy,
          locked: false,
        }, {
          onChoose: async () => {
            const selection = await (controller.chooseCatalogRoot?.({
              initialRoot: this.catalogScanRootDraft,
              purpose: { kind: "scan" },
            }) ?? Promise.resolve(null));
            return selection?.kind === "directory" ? selection : null;
          },
          onSelection: (selection) => {
            if (selection.kind !== "directory") return;
            this.catalogScanDirectorySelection = structuredClone(selection);
            this.catalogScanRootDraft = selection.effectiveRoot;
            queueMicrotask(() => {
              if (isCurrent()) recomputeScanActions();
            });
          },
          onManualChange: (value) => {
            this.catalogScanDirectorySelection = undefined;
            this.catalogScanRootDraft = value;
            recomputeScanActions();
          },
          onValidate: validateCatalogScanRoot,
        });
        this.cloudDirectoryFields.add(field);
        field.manualInput.dataset.catalogScanRoot = "true";
        field.manualInput.dataset.focusKey = "settings-catalog-scan-root";
        trackSessionInput(field.manualInput);
        field.chooseButton.dataset.action = "browse-catalog-scan-root";
        field.chooseButton.dataset.focusKey = "settings-catalog-scan-root-choose";
        field.root.querySelector<HTMLButtonElement>(
          '[data-action="validate-cloud-directory"]',
        )?.setAttribute("data-action", "catalog-validate-root");
        if (controller.chooseCatalogRoot === undefined) {
          field.chooseButton.hidden = true;
          field.chooseButton.disabled = true;
        }
        const actions = doc.createElement("div");
        actions.className = "knowledge-workbench__settings-row";
        const start = button(i18n.t("settings.surface.startScan"), () => {
          if (start.disabled || scanActionPending) return;
          scanActionPending = true;
          recomputeScanActions();
          void run("settings.save.cloudScan", () => requestCatalogScan(
            this.catalogScanRootDraft,
            () => {
              this.catalogScanRootDraft = "";
              this.catalogScanDirectorySelection = undefined;
              field.setPath("");
              recomputeScanActions();
            },
          ), actions, undefined, "settings.error.cloudUnavailable").finally(() => {
            if (!isCurrent()) return;
            scanActionPending = false;
            recomputeScanActions();
          });
        });
        start.dataset.action = "catalog-start-scan";
        actions.append(start);
        let cancel: HTMLButtonElement | undefined;
        if (controller.cancelCatalogScan !== undefined) {
          cancel = button(i18n.t("settings.surface.cancelScan"), () => controller.cancelCatalogScan?.());
          cancel.dataset.action = "catalog-cancel-scan";
          actions.append(cancel);
        }
        const renderScanConnection = (): void => {
          if (!isCurrent()) return;
          const current = controller.catalogConnection?.();
          const empty = i18n.t("progress.empty");
          const progress = presentCatalogProgress?.(current, i18n) ?? {
            scanStatus: i18n.t("progress.scan.status", { status: empty }),
            pdfProgress: i18n.t("progress.scan.pdf", { current: empty, maximum: empty }),
            directoryProgress: i18n.t("progress.scan.directory", { current: empty, maximum: empty }),
            requestProgress: i18n.t("progress.scan.request", { current: empty, maximum: empty }),
            timeProgress: i18n.t("progress.scan.elapsed", { current: empty, maximum: empty }),
            stopReason: i18n.t("progress.scan.stopReason", { reason: empty }),
          };
          scanStatus.textContent = progress.scanStatus;
          pdfProgress.textContent = progress.pdfProgress;
          directoryProgress.textContent = progress.directoryProgress;
          requestProgress.textContent = progress.requestProgress;
          timeProgress.textContent = progress.timeProgress;
          stopReason.textContent = progress.stopReason;
          scanBusy = current?.status === "scanning";
          field.updateState({ disabled: interactionLocked || scanBusy, locked: false });
          if (controller.chooseCatalogRoot === undefined) {
            field.chooseButton.hidden = true;
            field.chooseButton.disabled = true;
          }
          recomputeScanActions = () => {
            const latest = controller.catalogConnection?.();
            start.disabled = interactionLocked
              || scanActionPending
              || scanBusy
              || !connectionCanVerify(latest)
              || latest?.messageCode !== undefined
              || !field.valid();
          };
          recomputeScanActions();
          if (cancel !== undefined) {
            cancel.hidden = !scanBusy;
            cancel.disabled = !scanBusy;
          }
          onConnectionRender?.(current);
        };
        renderScanConnection();
        this.unsubscribeCatalogConnection = controller.subscribeCatalogConnection?.(
          renderScanConnection,
        ) ?? null;
        target.append(catalogProgress, field.root, actions);
      };

      const renderScanOnlySection = (): void => {
        renderSharedScanControls(verificationSection.content);
      };

      const catalog = doc.createElement("section");
      catalog.className = "knowledge-workbench__catalog-settings";
      catalog.append(heading(doc, 3, i18n.t("settings.surface.cloudCatalog")));
      const connection = controller.catalogConnection?.();
      if (!includesSection("baidu")) {
        if (includesSection("cloud-scan-advanced")) renderScanOnlySection();
      } else if (policy.configuration === "read-only") {
        const locked = doc.createElement("p");
        locked.className = "knowledge-workbench__locked";
        locked.textContent = i18n.t("settings.surface.readOnlyCatalogUnavailable");
        catalog.append(locked);
        const verificationLocked = locked.cloneNode(true) as HTMLParagraphElement;
        verificationSection.content.append(verificationLocked);
        const largeCatalogLocked = locked.cloneNode(true) as HTMLParagraphElement;
        largeCatalogSection.content.append(largeCatalogLocked);
      } else if (
        connection === undefined
        || controller.connectCatalog === undefined
        || controller.submitCatalogAuthorizationCode === undefined
        || controller.cancelCatalogAuthorization === undefined
        || controller.revokeCatalog === undefined
        || controller.validateCatalogScanRoot === undefined
        || controller.requestCatalogScan === undefined
      ) {
        const locked = doc.createElement("p");
        locked.className = "knowledge-workbench__locked";
        locked.textContent = i18n.t("settings.surface.cloudUnavailable");
        catalog.append(locked);
      } else {
        const connectCatalog = controller.connectCatalog.bind(controller);
        const submitCatalogAuthorizationCode = controller.submitCatalogAuthorizationCode
          .bind(controller);
        const cancelCatalogAuthorization = controller.cancelCatalogAuthorization
          .bind(controller);
        const revokeCatalog = controller.revokeCatalog.bind(controller);
        const connectionStatus = doc.createElement("p");
        connectionStatus.dataset.catalogConnectionStatus = "true";
        const connectionMessage = doc.createElement("p");
        connectionMessage.dataset.catalogConnectionMessage = "true";
        connectionMessage.setAttribute("aria-live", "polite");
        const credentialStorageNotice = doc.createElement("p");
        credentialStorageNotice.textContent = i18n.t("settings.surface.credentialStorage", {
          credentialStoreName: SECRET_STORAGE_BRAND,
        });

        const appKeyLabel = doc.createElement("label");
        appKeyLabel.className = "knowledge-workbench__settings-row";
        const appKeyText = doc.createElement("span");
        appKeyText.textContent = i18n.t("settings.surface.applicationKey");
        const appKey = doc.createElement("input");
        appKey.type = "password";
        appKey.autocomplete = "off";
        appKey.dataset.catalogAppKey = "true";
        trackSessionInput(appKey);
        appKey.value = this.catalogAppKeyDraft;
        listen(appKey, "input", () => { this.catalogAppKeyDraft = appKey.value; });
        appKeyLabel.append(appKeyText, appKey);

        const secretKeyLabel = doc.createElement("label");
        secretKeyLabel.className = "knowledge-workbench__settings-row";
        const secretKeyText = doc.createElement("span");
        secretKeyText.textContent = i18n.t("settings.surface.secretKey");
        const secretKey = doc.createElement("input");
        secretKey.type = "password";
        secretKey.autocomplete = "off";
        secretKey.dataset.catalogSecretKey = "true";
        trackSessionInput(secretKey);
        secretKey.value = this.catalogSecretKeyDraft;
        listen(secretKey, "input", () => { this.catalogSecretKeyDraft = secretKey.value; });
        secretKeyLabel.append(secretKeyText, secretKey);

        const connectionActions = doc.createElement("div");
        connectionActions.className = "knowledge-workbench__settings-row";
        const beginAuthorization = (intent: CatalogAuthorizationIntent): void => {
          this.catalogAuthorizationIntent = null;
          const credentials = { appKey: appKey.value, secretKey: secretKey.value };
          appKey.value = "";
          secretKey.value = "";
          this.catalogAppKeyDraft = "";
          this.catalogSecretKeyDraft = "";
          authorizationCode.value = "";
          this.catalogAuthorizationCodeDraft = "";
          this.clearCatalogAuthorizationExpiryTimer();
          void run(
            "settings.save.cloudConnection",
            async () => {
              await connectCatalog(credentials, intent);
              if (!isCurrent()) return;
              this.catalogAuthorizationIntent = intent;
              scheduleAuthorizationExpiry(
                controller.catalogConnection?.()?.authorizationExpiresAt,
              );
            },
            connectionActions,
            () => {
              if (this.catalogAuthorizationIntent === intent) {
                this.catalogAuthorizationIntent = null;
              }
            },
            "settings.error.cloudUnavailable",
          );
        };
        const connect = button(
          localizedOr(
            "settings.surface.repairSameAccount",
            locale === "zh-CN" ? "使用原账号重新连接" : "Reconnect original account",
          ),
          () => beginAuthorization("repair-same-account"),
        );
        connect.dataset.action = "catalog-connect";
        const replaceIdentity = button(
          localizedOr(
            "settings.surface.replaceIdentity",
            locale === "zh-CN" ? "更换账号或凭据" : "Change account or credentials",
          ),
          () => beginAuthorization("replace-identity"),
        );
        replaceIdentity.dataset.action = "catalog-replace-identity";
        const replaceIdentitySection = doc.createElement("details");
        replaceIdentitySection.dataset.settingsReplaceIdentity = "true";
        const replaceIdentitySummary = doc.createElement("summary");
        replaceIdentitySummary.textContent = i18n.t("settings.surface.replaceIdentity");
        const replaceIdentityConsequence = doc.createElement("p");
        replaceIdentityConsequence.textContent = i18n.t("cloudAuthority.replaceIdentity");
        replaceIdentitySection.append(replaceIdentitySummary, replaceIdentityConsequence, replaceIdentity);
        const revoke = button(i18n.t("settings.surface.removeCredentials"), () => {
          authorizationCode.value = "";
          this.catalogAuthorizationCodeDraft = "";
          this.catalogAuthorizationIntent = null;
          this.clearCatalogAuthorizationExpiryTimer();
          void run(
            "settings.save.cloudAuthorization",
            revokeCatalog,
            connectionActions,
            undefined,
            "settings.error.cloudUnavailable",
          );
        });
        revoke.dataset.action = "catalog-revoke";
        connectionActions.append(connect, revoke);

        const authorizationCodeLabel = doc.createElement("label");
        authorizationCodeLabel.className = "knowledge-workbench__settings-row";
        const authorizationCodeText = doc.createElement("span");
        authorizationCodeText.textContent = i18n.t("settings.surface.authorizationCode");
        const authorizationCode = doc.createElement("input");
        authorizationCode.type = "password";
        authorizationCode.autocomplete = "off";
        authorizationCode.dataset.catalogAuthorizationCode = "true";
        trackSessionInput(authorizationCode);
        authorizationCode.value = this.catalogAuthorizationCodeDraft;
        listen(authorizationCode, "input", () => {
          this.catalogAuthorizationCodeDraft = authorizationCode.value;
        });
        authorizationCodeLabel.append(authorizationCodeText, authorizationCode);

        const authorizationActions = doc.createElement("div");
        authorizationActions.className = "knowledge-workbench__settings-row";
        const scheduleAuthorizationExpiry = (expiresAt: number | undefined): void => {
          if (!isCurrent()) return;
          this.clearCatalogAuthorizationExpiryTimer();
          const remaining = expiresAt === undefined
            ? CATALOG_AUTHORIZATION_INPUT_LIFETIME_MS
            : Math.max(0, expiresAt - Date.now());
          this.catalogAuthorizationExpiryTimer = window.setTimeout(() => {
            if (!isCurrent()) return;
            this.catalogAuthorizationExpiryTimer = null;
            authorizationCode.value = "";
            this.catalogAuthorizationCodeDraft = "";
            this.catalogAuthorizationIntent = null;
            cancelCatalogAuthorization();
            status.textContent = i18n.t("settings.surface.authorizationExpired");
            authorizationActions.insertAdjacentElement("afterend", status);
          }, remaining);
        };
        const submitAuthorization = button(i18n.t("settings.surface.submitAuthorization"), () => {
          const code = authorizationCode.value;
          const expectedIntent = this.catalogAuthorizationIntent ?? undefined;
          authorizationCode.value = "";
          this.catalogAuthorizationCodeDraft = "";
          this.clearCatalogAuthorizationExpiryTimer();
          void run(
            "settings.save.cloudAuthorization",
            async () => {
              await submitCatalogAuthorizationCode(code, expectedIntent);
              if (this.catalogAuthorizationIntent === expectedIntent) {
                this.catalogAuthorizationIntent = null;
              }
            },
            authorizationActions,
            undefined,
            "settings.error.cloudUnavailable",
          );
        });
        submitAuthorization.dataset.action = "catalog-submit-authorization-code";
        const cancelAuthorization = button(i18n.t("settings.surface.cancelAuthorization"), () => {
          authorizationCode.value = "";
          this.catalogAuthorizationCodeDraft = "";
          this.catalogAuthorizationIntent = null;
          this.clearCatalogAuthorizationExpiryTimer();
          cancelCatalogAuthorization();
          status.textContent = i18n.t("settings.surface.authorizationCanceled");
          authorizationActions.insertAdjacentElement("afterend", status);
        });
        cancelAuthorization.dataset.action = "catalog-cancel-authorization";
        authorizationActions.append(submitAuthorization, cancelAuthorization);

        renderSharedScanControls(verificationSection.content, (current) => {
          connectionStatus.textContent = i18n.t("settings.connection.status", {
            status: localizedStatus(current?.status),
          });
          connectionMessage.hidden = current?.messageCode === undefined;
          connectionMessage.textContent = current?.messageCode === undefined
            ? ""
            : presentCatalogMessage(current.messageCode, i18n).title;
        });
        if (connection.status === "authorizing") {
          scheduleAuthorizationExpiry(connection.authorizationExpiresAt);
        }
        catalog.append(
          connectionStatus,
          connectionMessage,
          credentialStorageNotice,
          appKeyLabel,
          secretKeyLabel,
          connectionActions,
          replaceIdentitySection,
          authorizationCodeLabel,
          authorizationActions,
        );
      }

      const hybrid = controller.hybridCatalog?.();
      if (
        includesSection("catalog-data")
        && policy.configuration !== "read-only"
        && hybrid !== undefined
        && controller.subscribeHybridCatalog !== undefined
        && controller.previewCatalogTxt !== undefined
        && controller.requestCatalogTxtImport !== undefined
      ) {
        const previewCatalogTxt = controller.previewCatalogTxt.bind(controller);
        const requestCatalogTxtImport = controller.requestCatalogTxtImport.bind(controller);
        const hybridSection = doc.createElement("section");
        hybridSection.className = "knowledge-workbench__hybrid-catalog-settings";
        hybridSection.append(heading(doc, 3, i18n.t("settings.surface.largeCatalog")));
        const explanation = doc.createElement("p");
        explanation.textContent = i18n.t("settings.surface.largeCatalogExplanation");

        const activeSummary = doc.createElement("p");
        activeSummary.dataset.catalogHybridActiveSummary = "true";
        const previewSummary = doc.createElement("p");
        previewSummary.dataset.catalogHybridPreviewSummary = "true";
        const txtLabel = doc.createElement("label");
        txtLabel.className = "knowledge-workbench__settings-row";
        const txtText = doc.createElement("span");
        txtText.textContent = i18n.t("settings.surface.localTxtSession");
        const txtPath = doc.createElement("input");
        txtPath.type = "text";
        txtPath.autocomplete = "off";
        txtPath.dataset.catalogTxtPath = "true";
        trackSessionInput(txtPath);
        txtPath.value = this.catalogTxtPathDraft;
        listen(txtPath, "input", () => { this.catalogTxtPathDraft = txtPath.value; });
        txtLabel.append(txtText, txtPath);
        const txtActions = doc.createElement("div");
        txtActions.className = "knowledge-workbench__settings-row";
        const previewTxt = button(i18n.t("settings.surface.previewLocalCatalog"), () => {
          const path = txtPath.value;
          void run(
            "settings.save.localPreview",
            () => previewCatalogTxt(path),
            txtActions,
            undefined,
            "settings.error.localCatalogUnavailable",
          );
        });
        previewTxt.dataset.action = "catalog-preview-txt";
        const importTxt = button(i18n.t("settings.surface.importPreviewedCatalog"), () => {
          const path = txtPath.value;
          void run(
            "settings.save.localImport",
            () => requestCatalogTxtImport(path, () => {
              if (!isCurrent()) return;
              txtPath.value = "";
              this.catalogTxtPathDraft = "";
            }),
            txtActions,
            undefined,
            "settings.error.localCatalogUnavailable",
          );
        });
        importTxt.dataset.action = "catalog-import-txt";
        txtActions.append(previewTxt, importTxt);

        const renderCatalogData = (): void => {
          if (!isCurrent()) return;
          const current = controller.hybridCatalog?.();
          activeSummary.textContent = current?.active === undefined
            ? i18n.t("settings.surface.activeCatalogEmpty")
            : i18n.t("settings.surface.activeCatalogSummary", {
              pdf: i18n.number(current.active.pdfCount),
              unverified: i18n.number(current.active.unverifiedCount),
              verified: i18n.number(current.active.verifiedCount),
              differences: i18n.number(current.active.differenceCount),
              verifiedGroups: i18n.number(current.active.verifiedGroupCount),
              groups: i18n.number(current.active.groupCount),
            });
          previewSummary.textContent = current?.candidate === undefined
            ? i18n.t("settings.surface.previewEmpty")
            : i18n.t("settings.surface.previewSummary", {
              pdf: i18n.number(current.candidate.pdfCount),
              maximum: i18n.number(CATALOG_TXT_IMPORT_BUDGET.maxPdfCount),
              directories: i18n.number(current.candidate.directoryCount),
              ignored: i18n.number(current.candidate.ignoredLeafCount),
            });
          const busy = current?.status === "importing" || current?.status === "scanning";
          previewTxt.disabled = busy;
          importTxt.disabled = busy || current?.candidate === undefined;
        };
        hybridSection.append(explanation, activeSummary, previewSummary, txtLabel, txtActions);
        largeCatalogSection.content.append(hybridSection);
        renderCatalogData();
        this.unsubscribeHybridCatalog = controller.subscribeHybridCatalog(renderCatalogData);
      }
      baiduSection.content.append(catalog);

      if (includesSection("privacy-ai") && policy.ai === "blocked") {
        const ai = doc.createElement("section");
        ai.className = "knowledge-workbench__ai-settings";
        ai.append(heading(doc, 3, i18n.t("settings.surface.privateAi")));
        const locked = doc.createElement("p");
        locked.className = "knowledge-workbench__locked";
        locked.textContent = i18n.t("settings.surface.aiUnavailable");
        ai.append(locked);
        privacyAiSection.content.append(ai);
      } else if (
        includesSection("privacy-ai")
        && controller.saveAiSettings !== undefined
        && controller.setSessionAiSecret !== undefined
      ) {
        const ai = doc.createElement("section");
        ai.className = "knowledge-workbench__ai-settings";
        ai.append(heading(doc, 3, i18n.t("settings.surface.privateAi")));
        const description = doc.createElement("p");
        description.textContent = i18n.t("settings.surface.aiDescription");
        ai.append(description);

        let secretId = settings.secretId;
        const enabledLabel = doc.createElement("label");
        enabledLabel.className = "knowledge-workbench__settings-row";
        const enabled = doc.createElement("input");
        enabled.type = "checkbox";
        enabled.checked = settings.aiEnabled;
        enabled.dataset.aiEnabled = "true";
        const enabledText = doc.createElement("span");
        enabledText.textContent = i18n.t("settings.surface.enableAi");
        enabledLabel.append(enabled, enabledText);

        const endpointLabel = doc.createElement("label");
        endpointLabel.textContent = i18n.t("settings.surface.aiEndpoint");
        const endpoint = doc.createElement("input");
        endpoint.type = "url";
        endpoint.value = settings.aiEndpoint;
        endpoint.dataset.aiEndpoint = "true";
        endpointLabel.append(endpoint);

        const modelLabel = doc.createElement("label");
        modelLabel.textContent = i18n.t("settings.surface.aiModel");
        const model = doc.createElement("input");
        model.type = "text";
        model.value = settings.aiModel;
        model.dataset.aiModel = "true";
        modelLabel.append(model);

        const save = (): Promise<void> => controller.saveAiSettings!({
          enabled: enabled.checked,
          endpoint: endpoint.value,
          model: model.value,
          secretId,
        });
        const rollbackAiControls = (): void => {
          const current = controller.settings();
          enabled.checked = current.aiEnabled;
          endpoint.value = current.aiEndpoint;
          model.value = current.aiModel;
          secretId = current.secretId;
          this.secretComponent?.setValue(current.secretId);
        };
        const saveAi = (near: HTMLElement, onError?: () => void): void => {
          void run("settings.save.ai", save, near, () => {
            rollbackAiControls();
            onError?.();
          }, "settings.error.aiUnavailable");
        };
        listen(enabled, "change", () => saveAi(enabledLabel));
        listen(endpoint, "change", () => saveAi(endpointLabel));
        listen(model, "change", () => saveAi(modelLabel));
        ai.append(enabledLabel, endpointLabel, modelLabel);

        if (createSecretComponent !== undefined) {
          const persistent = doc.createElement("label");
          persistent.className = "knowledge-workbench__settings-row";
          const persistentLabel = doc.createElement("span");
          persistentLabel.textContent = i18n.t("settings.surface.persistentCredentialId", {
            credentialStoreName: SECRET_STORAGE_BRAND,
          });
          const host = doc.createElement("div");
          persistent.append(persistentLabel, host);
          this.secretComponent = createSecretComponent(app, host)
            .setValue(secretId)
            .onChange((value) => {
              if (!isCurrent()) return;
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
        sessionLabel.textContent = i18n.t("settings.surface.sessionSecret");
        const session = doc.createElement("input");
        session.type = "password";
        session.autocomplete = "off";
        session.dataset.sessionAiSecret = "true";
        trackSessionInput(session);
        session.value = this.sessionAiSecretDraft;
        listen(session, "input", () => { this.sessionAiSecretDraft = session.value; });
        sessionLabel.append(session);
        const useSession = button(i18n.t("settings.surface.useSessionSecret"), () => {
          const value = session.value;
          session.value = "";
          this.sessionAiSecretDraft = "";
          if (value.length === 0 || secretId.length > 0) return;
          controller.setSessionAiSecret!(value);
          status.textContent = i18n.t("settings.surface.sessionSecretAccepted");
        });
        useSession.dataset.action = "use-session-secret";
        ai.append(sessionLabel, useSession);
        privacyAiSection.content.append(ai);
      }
    }

    dispose(): void {
      this.disposed = true;
      this.renderGeneration += 1;
      this.renderAbortController?.abort();
      this.renderAbortController = null;
      this.disposeCloudDirectoryFields();
      this.clearSessionInputValues();
      this.clearCatalogAuthorizationExpiryTimer();
      this.unsubscribeCatalogConnection?.();
      this.unsubscribeCatalogConnection = null;
      this.unsubscribeHybridCatalog?.();
      this.unsubscribeHybridCatalog = null;
      this.catalogAppKeyDraft = "";
      this.catalogSecretKeyDraft = "";
      this.catalogAuthorizationCodeDraft = "";
      this.catalogAuthorizationIntent = null;
      this.catalogScanRootDraft = "";
      this.catalogScanDirectorySelection = undefined;
      this.catalogTxtPathDraft = "";
      this.sessionAiSecretDraft = "";
      this.secretComponent = null;
      this.liveStatus = null;
    }

    private clearCatalogAuthorizationExpiryTimer(): void {
      if (this.catalogAuthorizationExpiryTimer === null) return;
      window.clearTimeout(this.catalogAuthorizationExpiryTimer);
      this.catalogAuthorizationExpiryTimer = null;
    }

    private disposeCloudDirectoryFields(): void {
      for (const field of this.cloudDirectoryFields) field.dispose();
      this.cloudDirectoryFields.clear();
    }

    private clearSessionInputValues(): void {
      for (const input of this.sessionInputs) input.value = "";
      this.sessionInputs.clear();
    }
  })();
}
