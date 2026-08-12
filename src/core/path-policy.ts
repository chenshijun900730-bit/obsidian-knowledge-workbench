export type PathValidation = Readonly<{ ok: true; normalized: string }> | Readonly<{ ok: false; code: "invalid-path" | "target-exists" | "case-collision" }>;

export function normalizeVaultPath(path: string): string {
  return path.normalize("NFC").replaceAll("\\", "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "");
}

const hasControlCharacter = (value: string): boolean => [...value].some((character) => {
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined && codePoint >= 0 && codePoint <= 0x1f;
});
const RESERVED_DEVICE_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
const hasReservedDeviceBasename = (segment: string): boolean => RESERVED_DEVICE_BASENAME.test(segment.split(".", 1)[0] ?? "");

export function validateTargetPath(_source: string, target: string, existing: ReadonlySet<string>): PathValidation {
  const normalized = normalizeVaultPath(target);
  const segments = normalized.split("/");
  const leaf = segments[segments.length - 1] ?? "";
  const stem = leaf.toLocaleLowerCase("en-US").endsWith(".md") ? leaf.slice(0, -3) : leaf;
  const invalidSegment = (part: string): boolean => part === "" || part === "." || part === ".." || hasControlCharacter(part) || hasReservedDeviceBasename(part) || /[<>:"|?*]/u.test(part) || /[. ]$/u.test(part);
  if (normalized.startsWith("/") || !normalized.toLocaleLowerCase("en-US").endsWith(".md") || !stem || invalidSegment(stem) || segments.slice(0, -1).some(invalidSegment)) {
    return { ok: false, code: "invalid-path" };
  }
  const normalizedExisting = [...existing].map(normalizeVaultPath);
  if (normalizedExisting.includes(normalized)) return { ok: false, code: "target-exists" };
  if (normalizedExisting.some((path) => path.toLocaleLowerCase("en-US") === normalized.toLocaleLowerCase("en-US"))) return { ok: false, code: "case-collision" };
  return { ok: true, normalized };
}
