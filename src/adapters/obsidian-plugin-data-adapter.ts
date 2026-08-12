import type { Plugin } from "obsidian";
import type { PluginDataPort } from "../core/ports";

export class ObsidianPluginDataAdapter implements PluginDataPort {
  constructor(private readonly plugin: Plugin) {}
  load(): Promise<unknown> { return this.plugin.loadData(); }
  save(data: unknown): Promise<void> { return this.plugin.saveData(data); }
}
