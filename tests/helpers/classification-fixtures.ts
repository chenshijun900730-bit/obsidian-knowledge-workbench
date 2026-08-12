import type { VaultPath } from "../../src/core/types";
import { createIndexPathPolicy } from "../../src/classification/classification-service";
import { IndexService } from "../../src/indexing/index-service";
import { PluginDataStore } from "../../src/storage/plugin-data-store";
import type { PluginSettings } from "../../src/storage/plugin-data";
import { FakeVault } from "../fakes/fake-vault";
import { MemoryPluginDataPort } from "../fakes/memory-plugin-data-port";

export type ClassificationFixtureSettings = Partial<Pick<PluginSettings, "excludedPrefixes" | "folderRules">>;

export async function classificationIndexFixture(
  paths: readonly VaultPath[],
  settings: ClassificationFixtureSettings = {},
) {
  const vault = FakeVault.withNotes(paths);
  const port = new MemoryPluginDataPort();
  const store = new PluginDataStore(port);
  await store.load();
  await store.saveSettings({ ...store.settings(), ...settings });
  const pathPolicy = createIndexPathPolicy(() => store.settings());
  const index = new IndexService(vault, store, { now: () => 100 }, 2, pathPolicy);
  await index.buildInitial(new AbortController().signal, () => undefined);
  return { vault, port, store, pathPolicy, index };
}
