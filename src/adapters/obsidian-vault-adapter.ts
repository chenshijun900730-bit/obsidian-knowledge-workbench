import type { App, CachedMetadata, EventRef, FrontMatterInfo, TAbstractFile, TFile } from "obsidian";
import { sha256 } from "../core/hash";
import { validateTargetPath } from "../core/path-policy";
import type { VaultEvent, VaultReadPort, VaultWritePort } from "../core/ports";
import {
  OWNED_FIELDS,
  isFieldStateSchema,
  isFilePreconditionSchema,
  sameFieldState,
  type FieldState,
  type FilePrecondition,
  type OwnedField,
  type OwnedFieldValue,
  type VaultNote,
} from "../core/types";

export type LinktextParser = (linktext: string) => Readonly<{ path: string; subpath: string }>;

export interface ObsidianVaultHostApi {
  readonly TFile: abstract new (...args: never[]) => object;
  readonly normalizePath: (path: string) => string;
  readonly getFrontMatterInfo: (content: string) => FrontMatterInfo;
  readonly parseYaml: (yaml: string) => unknown;
}

const normalizePath = (path: string): string => path.normalize("NFC")
  .replaceAll("\\", "/")
  .replace(/\/{2,}/gu, "/")
  .replace(/^\/+|\/+$/gu, "");

const isMarkdownFile = (file: TAbstractFile | null): file is TFile => file !== null
  && "extension" in file
  && typeof file.extension === "string"
  && file.extension.toLocaleLowerCase("en-US") === "md";

const uniqueSorted = (values: Iterable<string>): readonly string[] => [...new Set(values)].sort();
const hasReferences = (cache: CachedMetadata): boolean => (
  (cache.links?.length ?? 0) > 0 || (cache.frontmatterLinks?.length ?? 0) > 0
);

const clonedFrontmatter = (cache: CachedMetadata | null): Readonly<Record<string, unknown>> => {
  if (cache?.frontmatter === undefined) return {};
  const { position: _position, ...frontmatter } = cache.frontmatter;
  return structuredClone(frontmatter);
};

const ownedValue = (value: unknown): OwnedFieldValue | null => {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item): item is string => typeof item === "string")) return [...value];
  return null;
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object"
  && value !== null
  && !Array.isArray(value);

const isOwnedField = (value: string): value is OwnedField => (OWNED_FIELDS as readonly string[]).includes(value);

const samePrecondition = (left: FilePrecondition, right: FilePrecondition): boolean => {
  if (left.path !== right.path || left.exists !== right.exists) return false;
  if (!left.exists || !right.exists) return true;
  return left.mtime === right.mtime && left.contentHash === right.contentHash;
};

export class ObsidianVaultAdapter implements VaultReadPort, VaultWritePort {
  private readonly listeners = new Set<(event: VaultEvent) => void>();
  private readonly metadataRefs: EventRef[] = [];
  private readonly vaultRefs: EventRef[] = [];
  private readonly pendingMetadataPaths = new Set<string>();
  private metadataStarted = false;
  private vaultStarted = false;
  private disposed = false;

  constructor(
    private readonly app: App,
    queueListener: (event: VaultEvent) => void,
    private readonly parseLinktext: LinktextParser,
    private readonly host: ObsidianVaultHostApi,
  ) {
    // Queue subscription is installed before public metadata listeners can emit.
    this.listeners.add(queueListener);
  }

  startMetadataTracking(): void {
    if (this.disposed || this.metadataStarted) return;
    this.metadataStarted = true;
    this.bootstrapPending(false);
    this.metadataRefs.push(
      this.app.metadataCache.on("changed", (file) => {
        if (!isMarkdownFile(file) || this.disposed) return;
        this.pendingMetadataPaths.add(file.path);
        this.emit({ kind: "modify", path: file.path });
      }),
      this.app.metadataCache.on("resolve", (file) => {
        if (!isMarkdownFile(file) || this.disposed) return;
        this.pendingMetadataPaths.delete(file.path);
        this.emit({ kind: "modify", path: file.path });
      }),
      this.app.metadataCache.on("resolved", () => {
        if (this.disposed) return;
        this.bootstrapPending(true);
      }),
    );
  }

  startVaultTracking(): void {
    if (this.disposed || this.vaultStarted) return;
    this.vaultStarted = true;
    this.bootstrapPending(false, true);
    this.vaultRefs.push(
      this.app.vault.on("create", (file) => {
        if (!isMarkdownFile(file) || this.disposed) return;
        this.pendingMetadataPaths.add(file.path);
        this.emit({ kind: "create", path: file.path });
      }),
      this.app.vault.on("modify", (file) => {
        if (!isMarkdownFile(file) || this.disposed) return;
        this.pendingMetadataPaths.add(file.path);
        this.emit({ kind: "modify", path: file.path });
      }),
      this.app.vault.on("rename", (file, oldPath) => {
        if (this.disposed) return;
        const oldWasMarkdown = oldPath.toLocaleLowerCase("en-US").endsWith(".md");
        const newIsMarkdown = isMarkdownFile(file);
        this.pendingMetadataPaths.delete(oldPath);
        if (newIsMarkdown) this.pendingMetadataPaths.add(file.path);
        if (oldWasMarkdown && newIsMarkdown) this.emit({ kind: "rename", path: file.path, oldPath });
        else if (oldWasMarkdown) this.emit({ kind: "delete", path: oldPath });
        else if (newIsMarkdown) this.emit({ kind: "create", path: file.path });
      }),
      this.app.vault.on("delete", (file) => {
        const path = file.path;
        if (!path.toLocaleLowerCase("en-US").endsWith(".md") || this.disposed) return;
        this.pendingMetadataPaths.delete(path);
        this.emit({ kind: "delete", path });
      }),
    );
  }

  async listMarkdownFiles(): Promise<readonly { path: string; mtime: number; size: number }[]> {
    return this.app.vault.getMarkdownFiles()
      .map((file) => ({ path: file.path, mtime: file.stat.mtime, size: file.stat.size }))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  async listMarkdownPaths(): Promise<readonly string[]> {
    return this.app.vault.getMarkdownFiles().map((file) => file.path).sort();
  }

  async readNote(path: string): Promise<VaultNote | null> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!isMarkdownFile(file)) return null;
    const cache = this.app.metadataCache.getFileCache(file);
    const references = [...(cache?.links ?? []), ...(cache?.frontmatterLinks ?? [])];
    const outgoing = new Set<string>();
    for (const reference of references) {
      const parsed = this.parseLinktext(reference.link).path;
      const destination = this.app.metadataCache.getFirstLinkpathDest(parsed, file.path);
      if (destination !== null && destination.extension.toLocaleLowerCase("en-US") === "md") {
        outgoing.add(normalizePath(destination.path));
      }
    }
    return {
      path: file.path,
      basename: file.basename,
      mtime: file.stat.mtime,
      size: file.stat.size,
      content: await this.app.vault.cachedRead(file),
      frontmatter: clonedFrontmatter(cache),
      headings: (cache?.headings ?? []).map((heading) => heading.heading),
      outgoingLinks: uniqueSorted(outgoing),
    };
  }

  async readOwnedField(path: string, field: OwnedField): Promise<FieldState | null> {
    const file = this.resolveHostFile(path);
    if (file === null) return null;
    try {
      const content = await this.app.vault.read(file);
      const info = this.host.getFrontMatterInfo(content);
      if (!info.exists) return { present: false };
      const parsed = this.host.parseYaml(info.frontmatter);
      if (!isObject(parsed)) return null;
      if (!Object.prototype.hasOwnProperty.call(parsed, field)) return { present: false };
      const value = ownedValue(parsed[field]);
      return value === null ? null : { present: true, value };
    } catch {
      return null;
    }
  }

  async setOwnedField(path: string, field: OwnedField, expected: FieldState, next: FieldState): Promise<void> {
    if (!isOwnedField(field)) throw new Error("Owned field is not allowlisted");
    if (!isFieldStateSchema(expected) || !isFieldStateSchema(next)) throw new Error("Owned field value schema is invalid");
    const expectedPath = this.host.normalizePath(path);
    if (expectedPath !== path || !validateTargetPath("", expectedPath, new Set()).ok) {
      throw new Error("Owned field source path is invalid");
    }
    const file = this.resolveHostFile(path);
    if (file === null) throw new Error("Owned field file changed or is unavailable");
    await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      if (file.path !== expectedPath || this.app.vault.getAbstractFileByPath(expectedPath) !== file) {
        throw new Error("Owned field file identity changed before write");
      }
      let current: FieldState;
      if (!Object.prototype.hasOwnProperty.call(frontmatter, field)) current = { present: false };
      else {
        const value = ownedValue(frontmatter[field]);
        if (value === null) throw new Error("Owned field value schema changed");
        current = { present: true, value };
      }
      if (!sameFieldState(current, expected)) throw new Error("Owned field changed before write");
      if (next.present) frontmatter[field] = structuredClone(next.value);
      else delete frontmatter[field];
    });
  }

  async renameFile(
    sourcePath: string,
    targetPath: string,
    expectedSource: FilePrecondition,
    expectedTarget: FilePrecondition,
  ): Promise<void> {
    const source = this.host.normalizePath(sourcePath);
    const target = this.host.normalizePath(targetPath);
    if (!isFilePreconditionSchema(expectedSource) || !isFilePreconditionSchema(expectedTarget)) {
      throw new Error("Rename precondition schema is invalid");
    }
    if (source.length === 0 || target.length === 0 || source === target
      || source !== sourcePath || target !== targetPath) throw new Error("Rename paths are invalid or not normalized");
    if (expectedSource.path !== source || expectedTarget.path !== target) throw new Error("Rename precondition paths changed");
    if (!validateTargetPath("", source, new Set()).ok) throw new Error("Rename source path is invalid");
    const existingPaths = new Set(this.app.vault.getMarkdownFiles().map((candidate) => candidate.path));
    if (!validateTargetPath(source, target, existingPaths).ok) throw new Error("Rename target path is invalid or unavailable");
    const file = this.resolveHostFile(source);
    if (file === null) throw new Error("Rename source changed or is unavailable");
    const currentSource = await this.snapshotHostFile(file);
    const currentTarget: FilePrecondition = this.app.vault.getAbstractFileByPath(target) === null
      ? { path: target, exists: false }
      : await this.snapshot(target);
    if (!samePrecondition(currentSource, expectedSource) || !samePrecondition(currentTarget, expectedTarget)) {
      throw new Error("Rename source or target changed before write");
    }
    this.assertRenameBoundary(file, source, target);
    await this.app.fileManager.renameFile(file, target);
  }

  async snapshot(path: string) {
    const note = await this.readNote(path);
    if (note === null) return { path: normalizePath(path), exists: false } as const;
    return { path: note.path, exists: true, mtime: note.mtime, contentHash: await sha256(note.content) } as const;
  }

  async inboundLinks(path: string): Promise<readonly string[] | null> {
    if (this.pendingMetadataPaths.size > 0) return null;
    const target = normalizePath(path);
    const sources: string[] = [];
    for (const [source, destinations] of Object.entries(this.app.metadataCache.resolvedLinks)) {
      if ((destinations[target] ?? 0) > 0) sources.push(source);
    }
    return uniqueSorted(sources);
  }

  async pathExists(path: string): Promise<boolean> {
    return this.app.vault.getAbstractFileByPath(normalizePath(path)) !== null;
  }

  subscribe(listener: (event: VaultEvent) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const ref of this.metadataRefs) this.app.metadataCache.offref(ref);
    for (const ref of this.vaultRefs) this.app.vault.offref(ref);
    this.metadataRefs.length = 0;
    this.vaultRefs.length = 0;
    this.listeners.clear();
    this.pendingMetadataPaths.clear();
  }

  private bootstrapPending(emitReadyTransitions: boolean, preserveExisting = false): void {
    const previous = new Set(this.pendingMetadataPaths);
    const next = new Set<string>();
    const files = this.app.vault.getMarkdownFiles();
    const filePaths = new Set(files.map((file) => file.path));
    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const representedInPublicLinks = Object.prototype.hasOwnProperty.call(this.app.metadataCache.resolvedLinks, file.path)
        || Object.prototype.hasOwnProperty.call(this.app.metadataCache.unresolvedLinks, file.path);
      if (cache === null || (hasReferences(cache) && !representedInPublicLinks)) next.add(file.path);
    }
    if (preserveExisting) {
      for (const path of previous) if (filePaths.has(path)) next.add(path);
    }
    this.pendingMetadataPaths.clear();
    for (const path of next) this.pendingMetadataPaths.add(path);
    if (!emitReadyTransitions) return;
    for (const path of previous) {
      if (!next.has(path) && filePaths.has(path)) this.emit({ kind: "modify", path });
    }
  }

  private emit(event: VaultEvent): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener(event);
  }

  private resolveHostFile(path: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(this.host.normalizePath(path));
    return file !== null && file instanceof this.host.TFile && isMarkdownFile(file) ? file : null;
  }

  private async snapshotHostFile(file: TFile): Promise<FilePrecondition> {
    const content = await this.app.vault.read(file);
    return { path: file.path, exists: true, mtime: file.stat.mtime, contentHash: await sha256(content) };
  }

  private assertRenameBoundary(file: TFile, source: string, target: string): void {
    if (this.app.vault.getAbstractFileByPath(source) !== file) throw new Error("Rename source changed at write boundary");
    if (this.app.vault.getAbstractFileByPath(target) !== null) throw new Error("Rename target appeared at write boundary");
    const targetKey = target.toLocaleLowerCase("en-US");
    const hasCaseCollision = this.app.vault.getMarkdownFiles()
      .some((candidate) => candidate !== file && this.host.normalizePath(candidate.path).toLocaleLowerCase("en-US") === targetKey);
    if (hasCaseCollision) throw new Error("Rename target has a case-insensitive collision");
    if (this.pendingMetadataPaths.size > 0) throw new Error("Metadata is not ready for rename");
    for (const destinations of Object.values(this.app.metadataCache.resolvedLinks)) {
      if ((destinations[source] ?? 0) > 0) throw new Error("Rename source has inbound links");
    }
  }

}
