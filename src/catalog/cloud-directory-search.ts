export interface CloudDirectorySearchCandidate {
  readonly filename: string;
  readonly path?: string;
}

export interface CloudDirectoryCandidate extends CloudDirectorySearchCandidate {
  readonly path: string;
}

export interface RankedCloudDirectory extends CloudDirectoryCandidate {
  readonly score: number;
}

const normalize = (value: string): string => value
  .normalize("NFC")
  .toLocaleLowerCase("en-US")
  .replace(/[\s._—\-/]+/gu, " ")
  .trim();

export const scoreCloudDirectoryCandidate = (
  candidate: CloudDirectorySearchCandidate,
  query: string,
): number | null => {
  const name = normalize(candidate.filename);
  const path = normalize(candidate.path ?? "");
  const tokens = normalize(query).split(" ").filter((value) => value.length > 0);
  if (tokens.length === 0) return 0;
  if (!tokens.every((token) => name.includes(token) || path.includes(token))) return null;
  const joined = tokens.join(" ");
  if (name === joined) return 0;
  if (name.startsWith(joined)) return 10 + name.length;
  const nameIndex = name.indexOf(joined);
  if (nameIndex >= 0) return 100 + nameIndex;
  return 1_000 + path.indexOf(joined);
};

export const rankCloudDirectories = (
  candidates: readonly CloudDirectoryCandidate[],
  query: string,
): readonly RankedCloudDirectory[] => candidates
  .map((candidate) => ({
    ...candidate,
    score: scoreCloudDirectoryCandidate(candidate, query),
  }))
  .filter((candidate): candidate is RankedCloudDirectory => candidate.score !== null)
  .sort((left, right) => left.score - right.score || left.path.localeCompare(right.path));
