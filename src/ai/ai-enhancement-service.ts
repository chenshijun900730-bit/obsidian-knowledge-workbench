import { normalizeVaultPath } from "../core/path-policy";
import type { AiAction, AiClientPort, AiCompletionInput, AiNotePayload } from "../core/ports";

export type AiClientErrorCategory = "auth" | "rate-limit" | "network" | "server" | "timeout" | "request" | "malformed";
export type AiFallbackReason =
  | "disabled"
  | "invalid-configuration"
  | "empty-selection"
  | "invalid-selection"
  | "selection-limit"
  | "cancelled"
  | "busy"
  | "note-unavailable"
  | "secret-unavailable"
  | "service-unavailable"
  | "action-invalidated";
export type AiResult<T> = Readonly<{ kind: "ok"; value: T }>
  | Readonly<{ kind: "local-fallback"; reason: AiFallbackReason }>;

export class AiClientError extends Error {
  constructor(readonly category: AiClientErrorCategory, readonly status: number) {
    super(`${category}:${Number.isFinite(status) ? status : 0}`);
    this.name = "AiClientError";
  }
}

const fallback = (reason: AiFallbackReason): AiResult<never> => ({ kind: "local-fallback", reason });
const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const hasExactOwnKeys = (value: object, keys: readonly string[]): boolean => {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) => typeof key === "string" && keys.includes(key));
};
const hasExactDataKeys = (value: object, keys: readonly string[]): boolean => hasExactOwnKeys(value, keys)
  && keys.every((key) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && Object.prototype.hasOwnProperty.call(descriptor, "value");
  });
const isExactArray = (value: unknown): value is readonly unknown[] => {
  if (!Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) return false;
  return keys.every((key) => key === "length" || (typeof key === "string" && /^(0|[1-9]\d*)$/u.test(key)));
};
const isExactDataArray = (value: unknown): value is readonly unknown[] => isExactArray(value)
  && Array.from({ length: value.length }, (_, index) => String(index)).every((key) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && Object.prototype.hasOwnProperty.call(descriptor, "value");
  });

const decodeNotes = (value: unknown): readonly AiNotePayload[] | null => {
  try {
    if (!isExactDataArray(value)) return null;
    const notes: AiNotePayload[] = [];
    const seenPaths = new Set<string>();
    for (const item of value) {
      if (!isPlainRecord(item) || !hasExactDataKeys(item, ["path", "content"])) return null;
      if (typeof item.path !== "string" || typeof item.content !== "string") return null;
      const path = normalizeVaultPath(item.path);
      const segments = path.split("/");
      if (path.length === 0
        || path !== item.path
        || path.startsWith("/")
        || !path.toLocaleLowerCase("en-US").endsWith(".md")
        || seenPaths.has(path)
        || segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || /\p{Cc}/u.test(segment))) return null;
      seenPaths.add(path);
      notes.push(Object.freeze({ path, content: item.content }));
    }
    return Object.freeze(notes);
  } catch {
    return null;
  }
};

const cloneNotes = (value: unknown): readonly AiNotePayload[] | null => {
  const decoded = decodeNotes(value);
  if (decoded === null) return null;
  try {
    return decodeNotes(structuredClone(value));
  } catch {
    return null;
  }
};

const hasUnsafeControlCharacter = (value: string): boolean => [...value].some((character) => {
  const code = character.codePointAt(0);
  return code !== undefined && ((code < 32 && code !== 9 && code !== 10) || code === 127);
});
const validText = (value: unknown): value is string => typeof value === "string"
  && value.trim().length > 0
  && value.trim().length <= 4_096
  && !hasUnsafeControlCharacter(value);
const decodeClientText = (value: unknown): string | null => {
  try {
    if (!isPlainRecord(value) || !hasExactDataKeys(value, ["text"])) return null;
    const detached: unknown = structuredClone(value);
    if (!isPlainRecord(detached) || !hasExactDataKeys(detached, ["text"]) || !validText(detached.text)) return null;
    return detached.text.trim();
  } catch {
    return null;
  }
};

export class AiEnhancementService {
  constructor(
    private readonly client: AiClientPort,
    private readonly delay: (milliseconds: number) => Promise<void>,
    private readonly isActionValid: () => boolean = () => true,
  ) {}

  summarize(notes: readonly AiNotePayload[]): Promise<AiResult<string>> { return this.run("summarize", notes); }
  nameCluster(notes: readonly AiNotePayload[]): Promise<AiResult<string>> { return this.run("name-cluster", notes); }
  explainRelation(notes: readonly AiNotePayload[]): Promise<AiResult<string>> { return this.run("explain-relation", notes); }
  suggestLabels(notes: readonly AiNotePayload[]): Promise<AiResult<string>> { return this.run("suggest-labels", notes); }

  private async run(action: AiAction, input: unknown): Promise<AiResult<string>> {
    const notes = cloneNotes(input);
    if (notes === null) return fallback("invalid-selection");
    if (notes.length === 0) return fallback("empty-selection");
    let characters = 0;
    for (const note of notes) {
      characters += note.content.length;
      if (characters > 100_000) return fallback("selection-limit");
    }
    if (notes.length > 20) return fallback("selection-limit");
    const request: AiCompletionInput = Object.freeze({ action, notes });
    const first = await this.attempt(request);
    if (first.kind === "ok") return first;
    if (first.error?.category !== "network" && first.error?.category !== "server") return fallback("service-unavailable");
    if (!this.safeActionValid()) return fallback("action-invalidated");
    try {
      await this.delay(250);
    } catch {
      return fallback("service-unavailable");
    }
    if (!this.safeActionValid()) return fallback("action-invalidated");
    const second = await this.attempt(request);
    return second.kind === "ok" ? second : fallback("service-unavailable");
  }

  private async attempt(request: AiCompletionInput): Promise<
    Readonly<{ kind: "ok"; value: string }> | Readonly<{ kind: "error"; error: AiClientError | null }>
  > {
    if (!this.safeActionValid()) return { kind: "error", error: null };
    try {
      const response = await this.client.complete(request);
      const text = decodeClientText(response);
      if (text === null) return { kind: "error", error: new AiClientError("malformed", 0) };
      return { kind: "ok", value: text };
    } catch (error) {
      return { kind: "error", error: error instanceof AiClientError ? error : null };
    }
  }

  private safeActionValid(): boolean {
    try { return this.isActionValid() === true; } catch { return false; }
  }
}
