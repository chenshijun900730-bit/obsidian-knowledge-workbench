import { createHash } from "node:crypto";

export const SYNTHETIC_ACCEPTANCE_NOTE_COUNT = 5_000;
export const SYNTHETIC_ACCEPTANCE_MINIMUM_BYTES = 75 * 1024 * 1024;
export const SYNTHETIC_ACCEPTANCE_SEED = 13;
export const SYNTHETIC_CONTENT_DIRECTORY = "Generated";

const CORPUS_DOMAIN = Buffer.from("knowledge-workbench-synthetic-corpus-v1\0", "ascii");
const encoder = new TextEncoder();
const byteLength = (value) => encoder.encode(value).byteLength;

const lcg = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
};

const assertInput = (input) => {
  if (!Number.isInteger(input.notes) || input.notes <= 0) {
    throw new RangeError("notes must be a positive integer");
  }
  if (!Number.isSafeInteger(input.minimumBytes) || input.minimumBytes < 0) {
    throw new RangeError("minimumBytes must be a non-negative safe integer");
  }
  if (input.seed !== undefined && !Number.isInteger(input.seed)) {
    throw new RangeError("seed must be an integer");
  }
};

export function generateSyntheticFixture(input) {
  assertInput(input);
  const random = lcg(input.seed ?? 0x4b_57_42_31);
  const firstBasenames = new Map();
  const paths = Array.from({ length: input.notes }, (_, index) => {
    const group = Math.floor(index / 20);
    const generated = `note-${String(index).padStart(5, "0")}-${random().toString(16).padStart(8, "0")}`;
    if (index % 20 === 0) firstBasenames.set(group, generated);
    const basename = index % 20 === 19 ? firstBasenames.get(group) : generated;
    return `${SYNTHETIC_CONTENT_DIRECTORY}/${String(index).padStart(5, "0")}/${basename}.md`;
  });
  const drafts = paths.map((path, index) => {
    const basename = path.split("/").at(-1).slice(0, -3);
    const heading = index % 2 === 0 ? `知识条目 ${index}` : `Knowledge Note ${index}`;
    const outgoingLinks = (index + 1) % 25 === 0 ? [paths[(index + 1) % paths.length]] : [];
    const linkText = outgoingLinks[0] === undefined ? "" : `\n[[${outgoingLinks[0].slice(0, -3)}]]`;
    const malformed = (index + 1) % 100 === 0;
    const frontmatterText = malformed
      ? `---\ntitle: [unterminated\nseed: ${random()}\n`
      : `---\ntitle: ${JSON.stringify(heading)}\ntags: [synthetic, benchmark]\nseed: ${random()}\n---\n`;
    const content = `${frontmatterText}# ${heading}${linkText}\n\nDeterministic synthetic body ${index}.\n`;
    return {
      path,
      basename,
      heading,
      outgoingLinks,
      malformed,
      content,
    };
  });
  const baseBytes = drafts.reduce((sum, draft) => sum + byteLength(draft.content), 0);
  const missing = Math.max(0, input.minimumBytes - baseBytes);
  const perNote = Math.floor(missing / input.notes);
  const remainder = missing % input.notes;
  const notes = drafts.map((draft, index) => {
    const paddingBytes = perNote + (index < remainder ? 1 : 0);
    const content = `${draft.content}${"x".repeat(paddingBytes)}`;
    return {
      path: draft.path,
      basename: draft.basename,
      mtime: index + 1,
      size: byteLength(content),
      content,
      frontmatter: draft.malformed ? {} : { title: draft.heading, tags: ["synthetic", "benchmark"] },
      headings: [draft.heading],
      outgoingLinks: draft.outgoingLinks,
    };
  });
  const totalBytes = notes.reduce((sum, note) => sum + note.size, 0);
  return {
    notes,
    noteCount: notes.length,
    totalBytes,
  };
}

export function generateAcceptanceFixture() {
  return generateSyntheticFixture({
    notes: SYNTHETIC_ACCEPTANCE_NOTE_COUNT,
    minimumBytes: SYNTHETIC_ACCEPTANCE_MINIMUM_BYTES,
    seed: SYNTHETIC_ACCEPTANCE_SEED,
  });
}

function isCorpusPath(path) {
  if (typeof path !== "string" || !path.endsWith(".md")) return false;
  const components = path.split("/");
  return components.length >= 2
    && components[0] === SYNTHETIC_CONTENT_DIRECTORY
    && components.every((component) => component.length > 0 && component !== "." && component !== "..");
}

function uint64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

export function computeSyntheticCorpusDigest(notes) {
  if (!Array.isArray(notes)) throw new TypeError("notes must be an array");
  const entries = notes
    .filter((note) => isCorpusPath(note?.path))
    .map((note) => {
      if (typeof note.content !== "string") throw new TypeError("synthetic note content must be a string");
      return {
        pathBytes: Buffer.from(note.path, "utf8"),
        contentBytes: Buffer.from(note.content, "utf8"),
      };
    })
    .sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));
  const hash = createHash("sha256");
  hash.update(CORPUS_DOMAIN);
  for (const entry of entries) {
    hash.update(uint64(entry.pathBytes.byteLength));
    hash.update(entry.pathBytes);
    hash.update(uint64(entry.contentBytes.byteLength));
    hash.update(entry.contentBytes);
  }
  return `sha256:${hash.digest("hex")}`;
}
