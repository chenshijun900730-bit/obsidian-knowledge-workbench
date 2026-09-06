import type { App, Plugin, PluginSettingTab } from "obsidian";
import type { RuntimeSafetyPolicy } from "../runtime/safety-policy";
import { createWorkbenchI18n } from "../i18n/workbench-i18n";
import {
  createSettingsSectionsSurface,
  type CatalogProgressPresenter,
  type SecretComponentConstructor,
  type SecretComponentLike,
  type SettingsController,
  type SettingsSectionsSurface,
} from "./settings-sections";

export type {
  CatalogProgressPresentation,
  CatalogProgressPresenter,
  SecretComponentConstructor,
  SecretComponentLike,
  SettingsController,
  SettingsSectionsDependencies,
  SettingsSectionsSurface,
} from "./settings-sections";

export type PluginSettingTabConstructor = abstract new (
  app: App,
  plugin: Plugin,
) => PluginSettingTab;

export type OpenTaskOverview = () => Promise<void>;

export function createSettingsTabClass(
  PluginSettingTabBase: PluginSettingTabConstructor,
  PrivateCredentialInputBase: SecretComponentConstructor | undefined,
  policy: RuntimeSafetyPolicy,
  presentCatalogProgress?: CatalogProgressPresenter,
) {
  return class KnowledgeWorkbenchSettingsTab extends PluginSettingTabBase {
    private readonly surface: SettingsSectionsSurface;
    private displayGeneration = 0;
    private renderedGeneration: number | null = null;

    constructor(
      app: App,
      plugin: Plugin,
      private readonly controller: SettingsController,
      private readonly openTaskOverview?: OpenTaskOverview,
    ) {
      super(app, plugin);
      this.surface = createSettingsSectionsSurface({
        app,
        controller,
        policy,
        createSecretComponent: PrivateCredentialInputBase === undefined
          ? undefined
          : (hostApp, root) => new PrivateCredentialInputBase(hostApp, root),
        onOpenTaskOverview: () => {
          const generation = this.displayGeneration;
          this.disposeSurfaceFor(generation);
          if (this.openTaskOverview !== undefined) {
            void this.openTaskOverview().catch(() => this.showHandoffFailure(generation));
          }
        },
      }, presentCatalogProgress);
    }

    get secretComponent(): SecretComponentLike | null {
      return (this.surface as SettingsSectionsSurface & {
        readonly secretComponent?: SecretComponentLike | null;
      }).secretComponent ?? null;
    }

    display(): void {
      this.disposeRenderedSurface();
      this.displayGeneration += 1;
      this.surface.render(this.containerEl, this.controller.settings().locale);
      this.renderedGeneration = this.displayGeneration;
    }

    hide(): void {
      this.displayGeneration += 1;
      this.disposeRenderedSurface();
    }

    private disposeRenderedSurface(): void {
      if (this.renderedGeneration === null) return;
      this.surface.dispose();
      this.renderedGeneration = null;
    }

    private disposeSurfaceFor(generation: number): void {
      if (this.renderedGeneration !== generation) return;
      this.surface.dispose();
      this.renderedGeneration = null;
    }

    private showHandoffFailure(generation: number): void {
      if (generation !== this.displayGeneration) return;
      this.disposeSurfaceFor(generation);
      const error = this.containerEl.ownerDocument.createElement("p");
      error.dataset.taskHandoffError = "true";
      error.setAttribute("role", "status");
      error.textContent = createWorkbenchI18n(this.controller.settings().locale)
        .t("host.settings.handoffFailed");
      this.containerEl.replaceChildren(error);
    }
  };
}
