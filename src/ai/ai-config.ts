import { AiClientError } from "./ai-enhancement-service";

const hasAnyControlCharacter = (value: string): boolean => /\p{Cc}/u.test(value);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const requestError = (): AiClientError => new AiClientError("request", 0);

export const normalizeAiEndpoint = (raw: string): string => {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2_048) throw requestError();
  const schemeBoundary = raw.indexOf("://");
  const authorityAndPath = schemeBoundary < 0 ? "" : raw.slice(schemeBoundary + 3);
  const authorityEnd = authorityAndPath.search(/[/?#]/u);
  const authority = authorityAndPath.slice(0, authorityEnd < 0 ? authorityAndPath.length : authorityEnd);
  if (raw.includes("?") || raw.includes("#") || authority.includes("@")) throw requestError();
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw requestError(); }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:")
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || (parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(parsed.hostname))) throw requestError();
  let path = parsed.pathname.replace(/\/+$/u, "");
  while (path.toLocaleLowerCase("en-US").endsWith("/chat/completions")) {
    path = path.slice(0, -"/chat/completions".length).replace(/\/+$/u, "");
  }
  const normalized = `${parsed.origin}${path}`;
  if (normalized.length > 2_048) throw requestError();
  return normalized;
};

export const normalizeAiModel = (raw: string): string => {
  if (typeof raw !== "string") throw requestError();
  if (hasAnyControlCharacter(raw)) throw requestError();
  const model = raw.trim();
  if (model.length === 0 || model.length > 256) throw requestError();
  return model;
};

export const normalizeAiSecretId = (raw: string): string => {
  if (typeof raw !== "string") throw requestError();
  const secretId = raw.trim();
  if (secretId.length === 0) return "";
  if (secretId.length > 128 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(secretId)) throw requestError();
  return secretId;
};
