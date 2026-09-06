import type { App, Plugin, PluginSettingTab } from "obsidian";
import type { RuntimeSafetyPolicy } from "../runtime/safety-policy";
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
          this.surface.dispose();
          if (this.openTaskOverview !== undefined) void this.openTaskOverview();
        },
      }, presentCatalogProgress);
    }

    get secretComponent(): SecretComponentLike | null {
      return (this.surface as SettingsSectionsSurface & {
        readonly secretComponent?: SecretComponentLike | null;
      }).secretComponent ?? null;
    }

    display(): void {
      this.surface.render(this.containerEl, this.controller.settings().locale);
    }

    hide(): void {
      this.surface.dispose();
    }
  };
}
