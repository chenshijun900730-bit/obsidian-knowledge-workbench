import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import type { CatalogTxtByteSource } from "../catalog/catalog-txt-parser";
import { HybridCatalogError } from "../catalog/hybrid-catalog-types";

const READ_CHUNK_BYTES = 64 * 1024;

const unavailable = (): HybridCatalogError => new HybridCatalogError("txt-source-unavailable");

const sameFile = (left: Stats, right: Stats): boolean => (
  left.dev === right.dev
  && left.ino === right.ino
  && left.size === right.size
  && left.mtimeMs === right.mtimeMs
  && right.isFile()
  && !right.isSymbolicLink()
);

const safePath = (value: string): string => {
  if (value.length === 0 || value.includes("\u0000")) throw unavailable();
  return value;
};

const closeQuietly = async (handle: FileHandle | undefined): Promise<void> => {
  if (handle === undefined) return;
  try {
    await handle.close();
  } catch {
    // A read-only close failure must not expose a native path or error.
  }
};

export class LocalCatalogTxtSourceAdapter {
  async open(pathInput: string): Promise<CatalogTxtByteSource> {
    const path = safePath(pathInput);
    let initial: Stats;
    try {
      initial = await lstat(path);
    } catch {
      throw unavailable();
    }
    if (
      !initial.isFile()
      || initial.isSymbolicLink()
      || !Number.isSafeInteger(initial.size)
      || initial.size < 1
    ) throw unavailable();
    let consumed = false;
    return {
      byteSize: initial.size,
      chunks: async function* () {
        if (consumed) throw unavailable();
        consumed = true;
        let handle: FileHandle | undefined;
        try {
          handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          const opened = await handle.stat();
          if (!sameFile(initial, opened)) throw unavailable();
          const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
          let position = 0;
          while (true) {
            const currentHandle = await handle.stat();
            const currentPath = await lstat(path);
            if (!sameFile(initial, currentHandle) || !sameFile(initial, currentPath)) {
              throw unavailable();
            }
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
            if (bytesRead === 0) break;
            position += bytesRead;
            yield Uint8Array.from(buffer.subarray(0, bytesRead));
          }
          const completedHandle = await handle.stat();
          const completedPath = await lstat(path);
          if (!sameFile(initial, completedHandle) || !sameFile(initial, completedPath)) {
            throw unavailable();
          }
        } catch (error) {
          if (error instanceof HybridCatalogError) throw error;
          throw unavailable();
        } finally {
          await closeQuietly(handle);
        }
      },
    };
  }
}
