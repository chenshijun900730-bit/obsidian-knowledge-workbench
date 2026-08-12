import type { App } from "obsidian";
import { normalizeVaultPath, validateTargetPath } from "../core/path-policy";
import type { QuickCapturePort } from "../core/ports";
import type { QuickCaptureRequest } from "../ui/quick-capture-modal";

export type QuickCaptureModalFactory = () => QuickCaptureRequest;

const INVALID_FILENAME_CHARACTERS = /[/\\:*?"<>|]/gu;
const MARKDOWN_EXTENSION = /\.md$/iu;
const RESERVED_DEVICE_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

export const captureFilename = (title: string): string | null => {
  let stem = title.trim().replace(INVALID_FILENAME_CHARACTERS, "").replace(/[. ]+$/gu, "");
  stem = stem.replace(MARKDOWN_EXTENSION, "").replace(/[. ]+$/gu, "");
  if (stem.length === 0 || RESERVED_DEVICE_BASENAME.test(stem.split(".", 1)[0] ?? "")) return null;
  return `${stem}.md`;
};

const targetPath = (parentPath: string, filename: string): string => normalizeVaultPath(
  parentPath.length === 0 ? filename : `${parentPath}/${filename}`,
);

export class ObsidianQuickCaptureAdapter implements QuickCapturePort {
  private active: Readonly<{
    generation: number;
    modal: QuickCaptureRequest;
    promise: Promise<string | null>;
  }> | null = null;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly app: App,
    private readonly createModal: QuickCaptureModalFactory,
  ) {}

  capture(): Promise<string | null> {
    if (this.disposed) return Promise.resolve(null);
    if (this.active !== null) return this.active.promise;
    const modal = this.createModal();
    const generation = ++this.generation;
    const promise = this.runCapture(modal, generation).finally(() => {
      if (this.active?.generation === generation) this.active = null;
      modal.dispose();
    });
    this.active = { generation, modal, promise };
    return promise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    const active = this.active;
    this.active = null;
    active?.modal.dispose();
  }

  private async runCapture(modal: QuickCaptureRequest, generation: number): Promise<string | null> {
    const title = await modal.request();
    if (!this.owns(generation) || title === null) return null;
    const filename = captureFilename(title);
    if (filename === null) return null;
    const activePath = this.app.workspace.getActiveFile()?.path ?? "";
    const parent = this.app.fileManager.getNewFileParent(activePath, filename);
    const proposed = targetPath(parent.path, filename);
    if (!this.owns(generation) || !this.validAndAbsent(proposed)) return null;
    // Re-evaluate at the write boundary to close the preview/create race window.
    if (!this.owns(generation) || !this.validAndAbsent(proposed)) return null;
    const file = await this.app.vault.create(proposed, "");
    if (!this.owns(generation)) return null;
    await this.app.workspace.getLeaf(false).openFile(file);
    return proposed;
  }

  private owns(generation: number): boolean {
    return !this.disposed && this.active?.generation === generation;
  }

  private validAndAbsent(path: string): boolean {
    const currentPaths = new Set(this.app.vault.getMarkdownFiles().map((file) => file.path));
    return validateTargetPath("", path, currentPaths).ok
      && this.app.vault.getAbstractFileByPath(path) === null;
  }
}
