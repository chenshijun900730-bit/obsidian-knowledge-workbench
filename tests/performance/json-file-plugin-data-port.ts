import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import type { PluginDataPort } from "../../src/core/ports";

const isNotFound = (error: unknown): boolean => typeof error === "object"
  && error !== null
  && "code" in error
  && error.code === "ENOENT";

export class JsonFilePluginDataPort implements PluginDataPort {
  static async create(): Promise<JsonFilePluginDataPort> {
    const directory = await mkdtemp(join(tmpdir(), "knowledge-workbench-data-"));
    return new JsonFilePluginDataPort(directory, join(directory, "data.json"));
  }

  saveCount = 0;
  serializedPluginDataBytes = 0;
  readonly persistenceTimesMs: number[] = [];
  private temporarySequence = 0;
  private beforeRenameFailure: Error | null = null;

  private constructor(
    private readonly directory: string,
    private readonly file: string,
  ) {}

  async load(): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as unknown;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async save(data: unknown): Promise<void> {
    const startedAt = performance.now();
    const snapshot = structuredClone(data);
    const serialized = JSON.stringify(snapshot);
    if (serialized === undefined) throw new Error("Plugin data must be JSON serializable");
    const temp = join(this.directory, `${basename(this.file)}.tmp-${process.pid}-${this.temporarySequence++}`);
    try {
      await writeFile(temp, serialized, { encoding: "utf8", flag: "wx" });
      const injected = this.beforeRenameFailure;
      this.beforeRenameFailure = null;
      if (injected !== null) throw injected;
      await rename(temp, this.file);
      this.saveCount += 1;
      this.serializedPluginDataBytes = Buffer.byteLength(serialized);
      this.persistenceTimesMs.push(performance.now() - startedAt);
    } finally {
      await rm(temp, { force: true });
    }
  }

  failBeforeRenameOnce(error: Error): void {
    this.beforeRenameFailure = error;
  }

  async temporaryArtifactCount(): Promise<number> {
    return (await readdir(this.directory)).filter((name) => name.includes(".tmp-")).length;
  }

  async dispose(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
  }
}
