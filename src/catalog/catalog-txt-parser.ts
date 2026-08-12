import { createHash } from "node:crypto";
import { isbnCandidatesFromFilename } from "./catalog-codec";
import {
  CATALOG_TXT_IMPORT_BUDGET,
  HybridCatalogError,
  type CatalogTxtImportSummary,
  type TxtCandidateRecordV1,
} from "./hybrid-catalog-types";

export interface CatalogTxtByteSource {
  readonly byteSize: number;
  chunks(): AsyncIterable<Uint8Array>;
}

export interface CatalogTxtParseInput {
  readonly source: CatalogTxtByteSource;
  readonly onCandidate: (record: TxtCandidateRecordV1) => Promise<void>;
}

interface ParsedTreeEntry {
  readonly depth: number;
  readonly name: string;
  readonly isPdf: boolean;
}

const TREE_LINE_PATTERN = /^((?:│ {3})*)(?:├── |└── )(.*)$/u;
const CONTROL_PATTERN = /\p{Cc}/u;

const hashText = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const treeInvalid = (): never => {
  throw new HybridCatalogError("txt-tree-invalid");
};

const budgetExceeded = (): never => {
  throw new HybridCatalogError("txt-import-budget-exceeded");
};

const sourceInvalid = (): never => {
  throw new HybridCatalogError("txt-source-invalid");
};

const safeSourceSize = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) return sourceInvalid();
  if (value > CATALOG_TXT_IMPORT_BUDGET.maxBytes) return budgetExceeded();
  return value;
};

const parseTreeLine = (
  rawLine: string,
): Readonly<{ entry: ParsedTreeEntry; whitespaceNormalized: boolean }> => {
  if (new TextEncoder().encode(rawLine).byteLength > CATALOG_TXT_IMPORT_BUDGET.maxLineBytes) {
    return budgetExceeded();
  }
  const match = rawLine.match(TREE_LINE_PATTERN);
  if (match === null) return treeInvalid();
  const prefix = match[1] ?? "";
  const rawName = match[2] ?? "";
  const trimmed = rawName.trim();
  const name = trimmed.normalize("NFC");
  const depth = (prefix.match(/│ {3}/gu) ?? []).length + 1;
  if (depth > CATALOG_TXT_IMPORT_BUDGET.maxDepth) return budgetExceeded();
  if (
    name.length === 0
    || name === "."
    || name === ".."
    || name.includes("/")
    || name.includes("\\")
    || CONTROL_PATTERN.test(name)
  ) return treeInvalid();
  return {
    entry: { depth, name, isPdf: /\.pdf$/iu.test(name) },
    whitespaceNormalized: rawName !== trimmed,
  };
};

const parentNames = (stack: readonly string[], depth: number): readonly string[] => {
  const count = depth - 1;
  const parents = stack.slice(0, count);
  if (parents.length !== count || parents.some((value) => value.length === 0)) return treeInvalid();
  return parents;
};

const candidateFrom = (
  parents: readonly string[],
  name: string,
): TxtCandidateRecordV1 => {
  const relativePath = [...parents, name].join("/");
  const parentRelativePath = parents.join("/");
  const topLevel = parents[0];
  return {
    schemaVersion: 1,
    source: "txt-candidate",
    candidateId: `txt:${hashText(relativePath)}`,
    relativePath,
    parentRelativePath,
    filename: name,
    title: name.slice(0, -4),
    isbnCandidates: [...isbnCandidatesFromFilename(name)],
    topLevelGroupId: topLevel === undefined
      ? "txt-root-items"
      : `group:${hashText(topLevel)}`,
    hierarchyTags: parents.map((parent) => `folder/${parent}`),
  };
};

export class CatalogTxtParser {
  async parse(input: CatalogTxtParseInput): Promise<CatalogTxtImportSummary> {
    const declaredByteSize = safeSourceSize(input.source.byteSize);
    const sourceHasher = createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const candidatePaths = new Set<string>();
    const directoryStack: string[] = [];
    let decodedBuffer = "";
    let byteSize = 0;
    let nonEmptyLineCount = 0;
    let pdfCount = 0;
    let directoryCount = 0;
    let ignoredLeafCount = 0;
    let normalizedWhitespaceCount = 0;
    let maxDepth = 0;
    let pending: ParsedTreeEntry | undefined;

    const emitPending = async (nextDepth: number): Promise<void> => {
      if (pending === undefined) return;
      if (nextDepth > pending.depth + 1 || (pending.isPdf && nextDepth > pending.depth)) {
        return treeInvalid();
      }
      const parents = parentNames(directoryStack, pending.depth);
      if (!pending.isPdf && nextDepth > pending.depth) {
        directoryStack[pending.depth - 1] = pending.name;
        directoryStack.length = pending.depth;
        directoryCount += 1;
        return;
      }
      if (!pending.isPdf) {
        ignoredLeafCount += 1;
        return;
      }
      if (pdfCount >= CATALOG_TXT_IMPORT_BUDGET.maxPdfCount) return budgetExceeded();
      const candidate = candidateFrom(parents, pending.name);
      if (candidatePaths.has(candidate.relativePath)) {
        throw new HybridCatalogError("txt-duplicate-path");
      }
      candidatePaths.add(candidate.relativePath);
      pdfCount += 1;
      await input.onCandidate(candidate);
    };

    const consumeLine = async (lineWithOptionalCarriageReturn: string): Promise<void> => {
      const rawLine = lineWithOptionalCarriageReturn.endsWith("\r")
        ? lineWithOptionalCarriageReturn.slice(0, -1)
        : lineWithOptionalCarriageReturn;
      if (rawLine.trim().length === 0) return;
      if (nonEmptyLineCount >= CATALOG_TXT_IMPORT_BUDGET.maxNonEmptyLineCount) {
        return budgetExceeded();
      }
      const parsed = parseTreeLine(rawLine);
      nonEmptyLineCount += 1;
      maxDepth = Math.max(maxDepth, parsed.entry.depth);
      if (parsed.whitespaceNormalized) normalizedWhitespaceCount += 1;
      await emitPending(parsed.entry.depth);
      pending = parsed.entry;
    };

    const consumeDecoded = async (value: string): Promise<void> => {
      decodedBuffer += value;
      let newline = decodedBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = decodedBuffer.slice(0, newline);
        decodedBuffer = decodedBuffer.slice(newline + 1);
        await consumeLine(line);
        newline = decodedBuffer.indexOf("\n");
      }
      if (
        new TextEncoder().encode(decodedBuffer).byteLength
        > CATALOG_TXT_IMPORT_BUDGET.maxLineBytes
      ) budgetExceeded();
    };

    try {
      for await (const chunk of input.source.chunks()) {
        if (!(chunk instanceof Uint8Array)) return sourceInvalid();
        byteSize += chunk.byteLength;
        if (byteSize > CATALOG_TXT_IMPORT_BUDGET.maxBytes) return budgetExceeded();
        if (byteSize > declaredByteSize) return sourceInvalid();
        sourceHasher.update(chunk);
        let decoded: string;
        try {
          decoded = decoder.decode(chunk, { stream: true });
        } catch {
          return sourceInvalid();
        }
        await consumeDecoded(decoded);
      }
    } catch (error) {
      if (error instanceof HybridCatalogError) throw error;
      return sourceInvalid();
    }
    let finalDecoded: string;
    try {
      finalDecoded = decoder.decode();
    } catch {
      return sourceInvalid();
    }
    await consumeDecoded(finalDecoded);
    if (decodedBuffer.length > 0) await consumeLine(decodedBuffer);
    await emitPending(0);
    if (byteSize !== declaredByteSize) return sourceInvalid();
    if (pdfCount === 0) return treeInvalid();
    return {
      sourceSha256: sourceHasher.digest("hex"),
      byteSize,
      nonEmptyLineCount,
      pdfCount,
      directoryCount,
      ignoredLeafCount,
      normalizedWhitespaceCount,
      maxDepth,
    };
  }
}
