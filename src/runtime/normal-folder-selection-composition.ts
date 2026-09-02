import type { Clock } from "../core/ports";
import type { CloudCatalogRuntime } from "../catalog/cloud-catalog-runtime";
import {
  buildLocalCloudDirectoryCandidates,
  type CloudDirectoryCandidateRuntime,
} from "../catalog/cloud-directory-candidates";
import type { PluginDataStore } from "../storage/plugin-data-store";
import {
  EMPTY_RECENT_CLOUD_DIRECTORIES,
  rememberRecentCloudDirectory,
} from "../storage/recent-cloud-directories";
import { createCloudDirectoryPickerSession } from "../ui/cloud-directory-picker-session";
import { createFolderSelectionHostCapability } from "../ui/folder-selection-page";
import type {
  FolderSelectionHostCapability,
  FolderSelectionSessionFactoryPort,
} from "../ui/folder-selection-host";

export interface NormalFolderSelectionComposition {
  readonly sessionFactory: FolderSelectionSessionFactoryPort;
  readonly hostCapability: FolderSelectionHostCapability;
}

export function createNormalFolderSelectionComposition(input: Readonly<{
  store: PluginDataStore;
  catalog: CloudCatalogRuntime;
  clock: Clock;
}>): NormalFolderSelectionComposition {
  const candidates: CloudDirectoryCandidateRuntime = Object.freeze({
    snapshot: () => buildLocalCloudDirectoryCandidates({
      recent: input.store.settings().recentCloudDirectories,
      cached: input.catalog.directoryDiscovery?.snapshotCached() ?? [],
      groups: input.catalog.hybrid?.snapshot().active?.groups ?? [],
    }),
    remember: async (path: string) => {
      const usedAt = input.clock.now();
      await input.store.updateSettings((settings) => ({
        ...settings,
        recentCloudDirectories: rememberRecentCloudDirectory(
          settings.recentCloudDirectories,
          path,
          usedAt,
        ),
      }));
    },
    clearRecent: async () => {
      await input.store.updateSettings((settings) => ({
        ...settings,
        recentCloudDirectories: EMPTY_RECENT_CLOUD_DIRECTORIES,
      }));
    },
  });

  const sessionFactory: FolderSelectionSessionFactoryPort = Object.freeze({
    available: true,
    create: (sessionInput: Parameters<FolderSelectionSessionFactoryPort["create"]>[0]) =>
      createCloudDirectoryPickerSession({
      candidates,
      purpose: sessionInput.purpose,
      initialPath: sessionInput.initialPath,
      ...(input.catalog.directoryBrowser === undefined
        ? {}
        : { browser: input.catalog.directoryBrowser }),
      ...(input.catalog.directoryLocator === undefined
        ? {}
        : { locator: input.catalog.directoryLocator }),
      }),
  });

  return Object.freeze({
    sessionFactory,
    hostCapability: createFolderSelectionHostCapability(),
  });
}
