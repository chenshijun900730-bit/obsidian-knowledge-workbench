import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, normalize, resolve } from "node:path";

const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const GIT_EXECUTABLE = "/usr/bin/git";
const GIT_ENVIRONMENT = Object.freeze({
  GIT_ATTR_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin",
});
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function requireCommit(value, label) {
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase 40- or 64-hex Git object ID`);
  }
  return value;
}

async function requireCanonicalRepositoryRoot(repoRoot) {
  if (
    typeof repoRoot !== "string"
    || !isAbsolute(repoRoot)
    || normalize(repoRoot) !== repoRoot
    || resolve(repoRoot) !== repoRoot
  ) {
    throw new Error("Repository root must be an absolute canonical path");
  }
  let canonical;
  try {
    canonical = await realpath(repoRoot);
  } catch (error) {
    throw new Error("Repository root must be an existing canonical directory", { cause: error });
  }
  if (canonical !== repoRoot) {
    throw new Error("Repository root must not use a symbolic link or noncanonical component");
  }
}

function runGit(repoRoot, args, label) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      GIT_EXECUTABLE,
      args,
      {
        cwd: repoRoot,
        encoding: "buffer",
        env: GIT_ENVIRONMENT,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        shell: false,
      },
      (error, stdout) => {
        if (error !== null) {
          rejectPromise(new Error(`${label} failed`, { cause: error }));
          return;
        }
        resolvePromise(Buffer.isBuffer(stdout) ? Buffer.from(stdout) : Buffer.from(stdout));
      },
    );
  });
}

function decodeExactLine(bytes, label) {
  if (
    bytes.byteLength < 2
    || bytes.at(-1) !== 0x0a
    || bytes.subarray(0, -1).includes(0x0a)
    || bytes.subarray(0, -1).includes(0x0d)
    || bytes.subarray(0, -1).includes(0x00)
  ) {
    throw new Error(`${label} must be one exact newline-terminated line`);
  }
  try {
    return UTF8.decode(bytes.subarray(0, -1));
  } catch (error) {
    throw new Error(`${label} must be valid UTF-8`, { cause: error });
  }
}

export async function captureCleanGitState(repoRoot) {
  await requireCanonicalRepositoryRoot(repoRoot);

  const topLevelBytes = await runGit(
    repoRoot,
    ["rev-parse", "--show-toplevel"],
    "Git top-level resolution",
  );
  const topLevel = decodeExactLine(topLevelBytes, "Git top-level output");
  if (topLevel !== repoRoot) {
    throw new Error("Git top level must equal the canonical repository root");
  }

  const firstHeadBytes = await runGit(
    repoRoot,
    ["rev-parse", "HEAD"],
    "First Git HEAD read",
  );
  const firstHead = requireCommit(decodeExactLine(firstHeadBytes, "First Git HEAD output"), "Git HEAD");

  const status = await runGit(
    repoRoot,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    "Git worktree status",
  );

  const secondHeadBytes = await runGit(
    repoRoot,
    ["rev-parse", "HEAD"],
    "Second Git HEAD read",
  );
  const secondHead = requireCommit(decodeExactLine(secondHeadBytes, "Second Git HEAD output"), "Git HEAD");

  if (status.byteLength !== 0) {
    throw new Error("Git index and worktree must be clean, including non-ignored untracked files");
  }
  if (firstHead !== secondHead) {
    throw new Error("Git HEAD changed while clean state was captured");
  }
  return Object.freeze({ commit: firstHead });
}

export async function captureTrackedGitState(repoRoot) {
  await requireCanonicalRepositoryRoot(repoRoot);

  const topLevelBytes = await runGit(
    repoRoot,
    ["rev-parse", "--show-toplevel"],
    "Git top-level resolution",
  );
  const topLevel = decodeExactLine(topLevelBytes, "Git top-level output");
  if (topLevel !== repoRoot) {
    throw new Error("Git top level must equal the canonical repository root");
  }

  const firstHeadBytes = await runGit(
    repoRoot,
    ["rev-parse", "HEAD"],
    "First Git HEAD read",
  );
  const firstHead = requireCommit(decodeExactLine(firstHeadBytes, "First Git HEAD output"), "Git HEAD");

  const status = await runGit(
    repoRoot,
    ["status", "--porcelain=v1", "-z", "--untracked-files=no"],
    "Tracked Git worktree status",
  );

  const secondHeadBytes = await runGit(
    repoRoot,
    ["rev-parse", "HEAD"],
    "Second Git HEAD read",
  );
  const secondHead = requireCommit(decodeExactLine(secondHeadBytes, "Second Git HEAD output"), "Git HEAD");

  if (status.byteLength !== 0) {
    throw new Error("Git index and tracked worktree must be clean");
  }
  if (firstHead !== secondHead) {
    throw new Error("Git HEAD changed while tracked state was captured");
  }
  return Object.freeze({ commit: firstHead });
}

function requireRelativeTrackedPath(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\0")
    || value.startsWith("/")
    || value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) throw new Error("Tracked build input must be one normalized repository-relative path");
  return value;
}

export async function assertTrackedBuildInputs(repoRoot, paths) {
  await requireCanonicalRepositoryRoot(repoRoot);
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("Tracked build inputs must be one nonempty array");
  }
  const checked = [...new Set(paths.map(requireRelativeTrackedPath))].sort();
  if (checked.length !== paths.length) {
    throw new Error("Tracked build inputs must not contain duplicates");
  }
  const output = await runGit(
    repoRoot,
    ["ls-files", "--error-unmatch", "-z", "--", ...checked],
    "Tracked build input resolution",
  );
  const decoded = [];
  let start = 0;
  for (let index = 0; index < output.byteLength; index += 1) {
    if (output[index] !== 0) continue;
    const bytes = output.subarray(start, index);
    if (bytes.byteLength === 0) throw new Error("Tracked build input output contains an empty path");
    decoded.push(UTF8.decode(bytes));
    start = index + 1;
  }
  if (start !== output.byteLength) {
    throw new Error("Tracked build input output must be NUL terminated");
  }
  decoded.sort();
  if (decoded.length !== checked.length || decoded.some((path, index) => path !== checked[index])) {
    throw new Error("Every non-dependency build input must be tracked exactly once");
  }
}

export async function assertCleanGitState(repoRoot, expectedCommit) {
  const checkedCommit = requireCommit(expectedCommit, "Expected commit");
  const current = await captureCleanGitState(repoRoot);
  if (current.commit !== checkedCommit) {
    throw new Error("Current Git HEAD does not match the expected commit");
  }
}

export async function assertTrackedGitState(repoRoot, expectedCommit) {
  const checkedCommit = requireCommit(expectedCommit, "Expected commit");
  const current = await captureTrackedGitState(repoRoot);
  if (current.commit !== checkedCommit) {
    throw new Error("Current Git HEAD does not match the expected commit");
  }
}
