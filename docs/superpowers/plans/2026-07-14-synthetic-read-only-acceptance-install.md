# Synthetic Read-only Acceptance Installation and Host Rehearsal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create, attest, and install the bound read-only acceptance artifact into one fresh fixed 5,000-note synthetic vault, then record a one-time aggregate host-rehearsal report without touching a real vault or using any network capability.

**Architecture:** Keep one run-bound evidence chain: clean Git commit → immutable preparation state and UUIDv4 run ID → continuously leased acceptance build → frozen four-file artifact → atomic target publication → fixed synthetic plugin-data seed → one-time receipt → human-controlled Obsidian rehearsal → one-time aggregate report. Share only mode-free filesystem and synthetic-vault guards with the normal installer; keep normal and acceptance entry points, artifact identities, targets, evidence, and reports disjoint.

**Tech Stack:** Node.js ESM, TypeScript 5.8.3, Obsidian API 1.13.1 targeting Obsidian Desktop 1.12.7, esbuild 0.25.5, Vitest 4.1.10, ESLint 9.39.4, Git CLI through `execFile`, SHA-256, Graphify.

---

## Global constraints

- Work only in the existing `feat/knowledge-workbench-mvp` worktree. Never inspect, install into, open, scan, or mutate a real vault.
- The only acceptance vault is `<canonical-worktree>/.dev-vault/read-only-acceptance-vault`; production APIs and CLIs accept no destination, mode, artifact path, fixture size, or environment override.
- Never launch Obsidian, edit `community-plugins.json`, enable the plugin, or select a vault from an implementation script.
- Never persist or use an endpoint, model, secret, credential, or request-capable client in the acceptance workflow. Acceptance-recorder AI boundary tests may use only in-memory `.invalid` values and must prove no client or request is constructed; ordinary pre-existing normal-mode regressions remain outside recorder evidence and still may not perform real network I/O.
- Existing `.dev-vault/acceptance.json`, the normal three-file installer, and the real-vault authorization stop gate keep their meanings.
- Every filesystem mutation uses exclusive/no-follow creation, identity plus byte evidence, fixed allowlists, same-filesystem rename, and exact-snapshot cleanup. No unguarded recursive delete is permitted in production code.
- Locks are cooperative, identity checked, never stolen by age, and acquired in the fixed order artifact → destination. Retained lock/stage/backup/quarantine objects are hard stops.
- A persisted report is terminal (`passed`, `failed`, or `inconclusive`). Report absence means pending; no early pending report is written.
- Both successful and failed human rehearsals end only after the plugin is disabled and Obsidian is fully quit. Uncertainty is `inconclusive`, never guessed as passed.
- Each task follows RED → focused GREEN → relevant regression suite → commit. Do not combine task commits.

## File map

New production-neutral safety and contract modules:

- `scripts/safe-fs-core.mjs` — frozen no-follow file reads, `nlink === 1`, directory/tree identity, exact snapshots, exclusive writes, and identity-safe cleanup.
- `scripts/synthetic-vault-install-core.mjs` — canonical worktree and fixed `.dev-vault` guards, marker constants, component-wise symlink rejection, and frozen disabled-community-plugin evidence.
- `scripts/git-worktree-state.mjs` — stable clean-HEAD capture and revalidation using shell-free Git calls.
- `scripts/acceptance-artifact-contract.mjs` — exact four-file acceptance schema, bundle denylist, binding validation, and artifact-set digest.
- `scripts/acceptance-run-contract.mjs` — fixed paths plus strict preparation-state and installation-receipt codecs and digests.
- `scripts/synthetic-note-fixture.mjs` and `scripts/synthetic-note-fixture.d.mts` — deterministic note generator shared by performance and on-disk acceptance fixtures.
- `scripts/synthetic-acceptance-data.mjs` and `scripts/synthetic-acceptance-data.d.mts` — exact plugin-local seed object, canonical bytes, and strict validator.
- `scripts/synthetic-acceptance-vault.mjs` — corpus attestation, allowed tree shape, and complete owned-tree manifest.
- `scripts/read-only-acceptance-report.mjs` and `scripts/read-only-acceptance-report.d.mts` — exact host input/report codecs, status composition, category derivation, and report encoding.
- `scripts/read-only-acceptance-local-evidence.mjs` — current state/receipt/artifact/fixture/settings evidence plus the fixed same-commit automated safety suite.

New orchestration and CLI files:

- `scripts/prepare-acceptance-synthetic.mjs` — preparation transaction with test-only hooks.
- `scripts/prepare-acceptance-synthetic-cli.mjs` — no-argument, fixed-target, sanitized preparation CLI.
- `scripts/install-acceptance-dev.mjs` — continuous-lease build/install/seed/receipt transaction with test-only hooks.
- `scripts/install-acceptance-dev-cli.mjs` — no-argument, sanitized acceptance installation CLI.
- `scripts/record-read-only-acceptance.mjs` — bounded-stdin, one-time terminal report recorder.
- `scripts/validate-read-only-acceptance.mjs` — independent current-evidence report validator.

New tests and documentation:

- `tests/packaging/helpers/acceptance-fs-fixture.ts`
- `tests/packaging/safe-fs-core.test.ts`
- `tests/packaging/synthetic-vault-install-core.test.ts`
- `tests/packaging/acceptance-artifact-lease.test.ts`
- `tests/packaging/synthetic-acceptance-fixture.test.ts`
- `tests/packaging/acceptance-run-contract.test.ts`
- `tests/packaging/synthetic-acceptance-data.test.ts`
- `tests/packaging/prepare-acceptance-synthetic.test.ts`
- `tests/packaging/install-acceptance-dev.test.ts`
- `tests/packaging/acceptance-workflow-cli.test.ts`
- `tests/packaging/read-only-acceptance-report.test.ts`
- `tests/packaging/read-only-acceptance-recorder.test.ts`
- `tests/packaging/synthetic-read-only-runbook.test.ts`
- `tests/integration/read-only-acceptance-automated-safety.test.ts`
- `tests/ui/read-only-acceptance-surfaces.test.ts`
- `docs/runbooks/synthetic-read-only-acceptance.md`

Existing files changed:

- `scripts/acceptance-build.mjs`, `scripts/install-dev.mjs`
- `tests/performance/generate-fixture.ts`, `tests/performance/index.bench.test.ts`
- `tests/packaging/read-only-acceptance-build.test.ts`, `tests/packaging/install-dev.test.ts`, `tests/packaging/build-acceptance-cli.test.ts`
- `package.json`, `eslint.config.mts`, `README.md`
- `docs/superpowers/specs/2026-07-14-synthetic-read-only-acceptance-install-design.md`

---

### Task 1: Share frozen filesystem evidence and owned cleanup

**Files:**

- Create: `scripts/safe-fs-core.mjs`
- Create: `tests/packaging/safe-fs-core.test.ts`
- Create: `tests/packaging/helpers/acceptance-fs-fixture.ts`
- Modify: `scripts/acceptance-build.mjs`
- Modify: `scripts/install-dev.mjs`
- Modify: `tests/packaging/read-only-acceptance-build.test.ts`
- Modify: `tests/packaging/install-dev.test.ts`

**Interfaces:**

```ts
export interface FileEvidence {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly sha256: string;
}

export interface FrozenFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly evidence: FileEvidence;
}

export interface DirectorySnapshot {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface ExactDirectorySnapshot extends DirectorySnapshot {
  readonly names: readonly string[];
  readonly files: ReadonlyMap<string, FrozenFile>;
}

export interface OwnedTreeSnapshot {
  readonly root: DirectorySnapshot;
  readonly entries: ReadonlyMap<string, Readonly<{
    type: "directory" | "file";
    dev: bigint;
    ino: bigint;
    nlink: bigint;
    size: bigint;
    sha256?: string;
  }>>;
}

export interface LockLease { readonly __opaque: unique symbol }

export async function readFrozenRegularFile(path: string, label: string): Promise<FrozenFile>;
export async function assertFrozenRegularFile(snapshot: FrozenFile, label: string): Promise<void>;
export async function snapshotExactDirectory(path: string, names: readonly string[], label: string): Promise<ExactDirectorySnapshot>;
export async function assertExactDirectory(snapshot: ExactDirectorySnapshot, label: string): Promise<void>;
export async function snapshotOwnedTree(
  root: string,
  completeAllowlist: readonly string[],
  label: string,
): Promise<OwnedTreeSnapshot>;
export async function assertOwnedTree(snapshot: OwnedTreeSnapshot, label: string): Promise<void>;
export async function writeExclusiveRegularFile(path: string, bytes: Uint8Array, label: string): Promise<FrozenFile>;
export async function withExclusiveIdentityLock<T>(input: Readonly<{
  parent: DirectorySnapshot;
  name: string;
  label: string;
}>, callback: (lease: LockLease) => Promise<T>): Promise<T>;
export async function removeOwnedTreeBottomUp(snapshot: OwnedTreeSnapshot, label: string): Promise<void>;
```

- [ ] **Step 1: Add RED tests for hard links, same-size mutation, and unknown cleanup entries**

Use real temporary directories and files. Include concurrent/stale/replaced lock cases in addition to these assertions:

```ts
it("rejects multiply linked regular files", async () => {
  const value = await regularFileFixture("SAFE-BYTES");
  await link(value.path, value.hardLink);
  await expect(core.readFrozenRegularFile(value.path, "fixture"))
    .rejects.toThrow(/single link|hard link|nlink/iu);
});

it("detects same-inode same-size byte changes", async () => {
  const value = await regularFileFixture("SAFE-BYTES");
  const frozen = await core.readFrozenRegularFile(value.path, "fixture");
  await writeFile(value.path, "EVIL-BYTES");
  await expect(core.assertFrozenRegularFile(frozen, "fixture"))
    .rejects.toThrow(/changed|snapshot/iu);
});

it("stops owned-tree cleanup when an unknown entry appears", async () => {
  const value = await ownedTreeFixture();
  const snapshot = await core.snapshotOwnedTree(value.root, value.allowlist, "owned tree");
  await writeFile(join(value.root, "unknown"), "KEEP");
  await expect(core.removeOwnedTreeBottomUp(snapshot, "owned tree"))
    .rejects.toThrow(/unknown|changed|cleanup/iu);
  await expect(readFile(join(value.root, "unknown"), "utf8")).resolves.toBe("KEEP");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npx vitest run tests/packaging/safe-fs-core.test.ts --no-file-parallelism --maxWorkers=1
```

Expected: FAIL because `safe-fs-core.mjs` does not exist.

- [ ] **Step 3: Implement the frozen regular-file primitive**

The read path must open once with `O_NOFOLLOW`, require `before.nlink === 1n`, hash the bytes, re-stat both the open handle and path, and require identity, size, link count, and digest coherence:

```js
export async function readFrozenRegularFile(path, label) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) throw new Error(`${label} must be a singly linked regular file`);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (!after.isFile() || after.nlink !== 1n || current.isSymbolicLink() || !current.isFile()
      || current.nlink !== 1n || before.dev !== after.dev || before.ino !== after.ino
      || after.dev !== current.dev || after.ino !== current.ino
      || after.size !== BigInt(bytes.byteLength)) throw new Error(`${label} changed while it was read`);
    return Object.freeze({
      path,
      bytes: Buffer.from(bytes),
      evidence: Object.freeze({ dev: after.dev, ino: after.ino, nlink: after.nlink, size: after.size, sha256: digest }),
    });
  } finally {
    await handle?.close();
  }
}
```

- [ ] **Step 4: Implement exact directory and owned-tree snapshots**

Store the complete relative-path set, type, `dev`, `ino`, `nlink`, size, and hash for every owned regular file plus directory identities. `removeOwnedTreeBottomUp` receives only the captured snapshot, validates the complete tree first, and then re-runs `lstat` immediately before each `unlink` or `rmdir`. It stops on the first missing, linked, special, replaced, or unknown entry.

`withExclusiveIdentityLock` accepts a previously frozen parent identity plus a fixed basename, creates one exclusive no-follow lock file, passes an opaque active lease, revalidates parent/lock after the callback, and removes only the exact lock snapshot. Existing locks are never age-stolen; replaced locks are retained and reported as incomplete cleanup.

- [ ] **Step 5: Replace duplicated private readers without changing public behavior**

Import the shared primitives in both existing scripts. Keep `buildAcceptanceArtifact`, `installDevelopmentBuild`, exported installer marker constants, current result shapes, and current normal success text unchanged. Do not expose target selection or build mode through the shared module.

- [ ] **Step 6: Run focused builder and installer regressions**

```bash
npx vitest run tests/packaging/safe-fs-core.test.ts tests/packaging/read-only-acceptance-build.test.ts tests/packaging/install-dev.test.ts --no-file-parallelism --maxWorkers=1
```

Expected: PASS, including new hard-link cases for builder source files and normal installer source/destination files.

- [ ] **Step 7: Commit Task 1**

```bash
git add scripts/safe-fs-core.mjs scripts/acceptance-build.mjs scripts/install-dev.mjs tests/packaging/helpers/acceptance-fs-fixture.ts tests/packaging/safe-fs-core.test.ts tests/packaging/read-only-acceptance-build.test.ts tests/packaging/install-dev.test.ts
git commit -m "refactor: share frozen filesystem snapshots"
```

### Task 2: Share synthetic-vault guards and close normal cross-mode residue

**Files:**

- Create: `scripts/synthetic-vault-install-core.mjs`
- Create: `tests/packaging/synthetic-vault-install-core.test.ts`
- Modify: `scripts/install-dev.mjs`
- Modify: `tests/packaging/install-dev.test.ts`

**Interfaces:**

```ts
export const TEST_VAULT_MARKER_FILE: ".knowledge-workbench-test-vault.json";
export const OBSIDIAN_CONFIG_DIRECTORY: ".obsidian";
export const TEST_VAULT_MARKER: Readonly<{
  schemaVersion: 1;
  purpose: "knowledge-workbench-dedicated-test-vault";
  contentPolicy: "synthetic-notes-only";
}>;

export interface CanonicalWorktree {
  readonly repoRoot: string;
  readonly devRoot: string;
  readonly devRootSnapshot: DirectorySnapshot;
}

export async function resolveCanonicalWorktree(repoRoot: string): Promise<CanonicalWorktree>;
export async function validateSyntheticVaultMarker(vault: string): Promise<FrozenFile>;
export async function freezeDisabledCommunityPlugins(obsidian: string): Promise<FrozenFile>;
export async function assertDisabledCommunityPlugins(snapshot: FrozenFile): Promise<void>;
```

- [ ] **Step 1: Add RED guard tests**

Cover canonical roots, component symlinks, malformed/extra marker keys, enabled plugin IDs, non-array entries, hard links, and same-size manifest mutation. Require `freezeDisabledCommunityPlugins` to accept only an exact JSON string array that omits `knowledge-workbench`; the acceptance vault later requires the stricter empty array.

- [ ] **Step 2: Add the missing normal-target acceptance metadata regression**

Extend `tests/packaging/install-dev.test.ts` with file, directory, and symlink shapes inside the existing target:

```ts
it("rejects destination acceptance metadata of every filesystem shape before mutation", async () => {
  for (const shape of ["file", "directory", "symlink"] as const) {
    const value = await fixture();
    const target = join(value.vaultPath, ".obsidian", "plugins", "knowledge-workbench");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "main.js"), "NORMAL-SENTINEL");
    const metadata = join(target, "acceptance-build.json");
    if (shape === "file") await writeFile(metadata, "{}\n");
    if (shape === "directory") await mkdir(metadata);
    if (shape === "symlink") await symlink(join(value.repoRoot, "styles.css"), metadata);

    await expect(installDevelopmentBuild({ repoRoot: value.repoRoot, vaultPath: value.vaultPath }))
      .rejects.toThrow("acceptance-build.json");
    await expect(readFile(join(target, "main.js"), "utf8")).resolves.toBe("NORMAL-SENTINEL");
  }
});
```

Add FIFO and Unix-socket target-metadata cases on supported platforms and an injected device-stat branch for portable CI. Every filesystem shape must fail before `main.js`, `manifest.json`, `styles.css`, or existing `data.json` changes.

- [ ] **Step 3: Run the two focused suites and verify RED**

```bash
npx vitest run tests/packaging/synthetic-vault-install-core.test.ts tests/packaging/install-dev.test.ts --no-file-parallelism --maxWorkers=1
```

Expected: FAIL because the shared guard is absent and normal destination preflight ignores acceptance metadata.

- [ ] **Step 4: Extract mode-free guards and re-export compatibility constants**

Move marker/path/community validation without adding a mode argument. In `scripts/install-dev.mjs`, import and re-export the three existing constants so current consumers remain valid:

```js
export {
  OBSIDIAN_CONFIG_DIRECTORY,
  TEST_VAULT_MARKER,
  TEST_VAULT_MARKER_FILE,
} from "./synthetic-vault-install-core.mjs";
```

- [ ] **Step 5: Reject target acceptance metadata before any normal mutation**

During normal destination preflight, call `lstat` on `<target>/acceptance-build.json`; any existing filesystem object is a hard stop. Repeat the absence assertion in every mutation-safety revalidation so a concurrent metadata insertion also stops installation.

- [ ] **Step 6: Run regressions and commit Task 2**

```bash
npx vitest run tests/packaging/synthetic-vault-install-core.test.ts tests/packaging/install-dev.test.ts --no-file-parallelism --maxWorkers=1
git add scripts/synthetic-vault-install-core.mjs scripts/install-dev.mjs tests/packaging/synthetic-vault-install-core.test.ts tests/packaging/install-dev.test.ts
git commit -m "refactor: share synthetic vault guards"
```

### Task 3: Extract the acceptance artifact contract and expose a continuous lease

**Files:**

- Create: `scripts/acceptance-artifact-contract.mjs`
- Create: `tests/packaging/acceptance-artifact-lease.test.ts`
- Modify: `scripts/acceptance-build.mjs`
- Modify: `tests/packaging/read-only-acceptance-build.test.ts`
- Modify: `tests/packaging/build-acceptance-cli.test.ts`
- Modify: `tests/packaging/composition-roots.test.ts`

**Interfaces:**

```ts
export interface AcceptanceArtifactLease { readonly __opaque: unique symbol }

export const ACCEPTANCE_FILES: readonly [
  "acceptance-build.json",
  "main.js",
  "manifest.json",
  "styles.css",
];

export interface AcceptanceArtifactSnapshot {
  readonly directory: DirectorySnapshot;
  readonly names: typeof ACCEPTANCE_FILES;
  readonly files: ReadonlyMap<(typeof ACCEPTANCE_FILES)[number], FrozenFile>;
}

export function validateAcceptanceArtifactSnapshot(
  snapshot: AcceptanceArtifactSnapshot,
): Readonly<{ pluginVersion: string; artifactBinding: string }>;

export function computeAcceptanceArtifactSetDigest(
  snapshot: AcceptanceArtifactSnapshot,
): string;

export async function withAcceptanceArtifactLock<T>(
  repoRoot: string,
  callback: (lease: AcceptanceArtifactLease) => Promise<T>,
): Promise<T>;

export async function buildAcceptanceArtifactUnderLease(options: Readonly<{
  lease: AcceptanceArtifactLease;
  hooks?: AcceptanceBuildHooks;
}>): Promise<AcceptanceBuildResult>;

export async function loadAcceptanceArtifactSource(options: Readonly<{
  lease: AcceptanceArtifactLease;
}>): Promise<AcceptanceArtifactSnapshot>;

export async function buildAcceptanceArtifact(options: Readonly<{
  repoRoot: string;
  hooks?: AcceptanceBuildHooks;
}>): Promise<AcceptanceBuildResult>;
```

- [ ] **Step 1: Write RED lease lifecycle tests**

Test a forged object, an expired lease retained after callback return, a lease used with another repo, nested/double acquisition, a paused installer-equivalent lease blocking the standalone builder, and two concurrent standalone builders. Use a `WeakMap`-opaque lease contract; no token/path field may be user supplied.

- [ ] **Step 2: Flip the old-residue behavior to the approved hard stop**

Replace the current `never touches unrelated old stage...` success expectation in `read-only-acceptance-build.test.ts` with:

```ts
it("preserves retained stage, backup, and quarantine objects and refuses to build", async () => {
  for (const name of [
    ".read-only-acceptance.tmp-old",
    ".read-only-acceptance.backup-old",
    ".read-only-acceptance.quarantine-old",
  ]) {
    const repoRoot = await fixture();
    const dist = join(repoRoot, "dist");
    await mkdir(join(dist, name), { recursive: true });
    await writeFile(join(dist, name, "sentinel"), name);
    await expect(builder.buildAcceptanceArtifact({ repoRoot })).rejects.toThrow(/residue|retained|hard stop/iu);
    await expect(readFile(join(dist, name, "sentinel"), "utf8")).resolves.toBe(name);
  }
});
```

- [ ] **Step 3: Extend the shared bundle denylist**

Move the four-file contract, metadata validator, manifest coherence, compile binding, and bundle tripwire to `acceptance-artifact-contract.mjs`. The exact denylist is:

```js
export const FORBIDDEN_ACCEPTANCE_BUNDLE_TEXT = Object.freeze([
  "requestUrl",
  "WebSocket",
  "fetch(",
  "secretStorage",
  "SecretComponent",
  "ObsidianAiClient",
  "ObsidianQuickCaptureAdapter",
]);
```

Add one real-builder test per new token so WebSocket and direct `fetch(` cannot drift out of the scan.

Keep `ACCEPTANCE_FILES` available from `acceptance-build.mjs` by re-exporting the contract constant. Both the fixed source loader and the later installed-target validator must call `validateAcceptanceArtifactSnapshot`; neither may duplicate manifest/metadata/bundle rules. The artifact-set digest lives in this shared contract for the same reason.

- [ ] **Step 4: Run the lease and builder tests and verify RED**

```bash
npx vitest run tests/packaging/acceptance-artifact-lease.test.ts tests/packaging/read-only-acceptance-build.test.ts --no-file-parallelism --maxWorkers=1
```

Expected: FAIL on missing lease APIs, old residue behavior, and missing WebSocket/`fetch(` checks.

- [ ] **Step 5: Implement private lease validation**

Create the lease inside `withAcceptanceArtifactLock`, store `{ repoRoot, active: true, lockSnapshot }` in a module-private `WeakMap`, pass only the frozen opaque object, and set `active = false` before lock cleanup. `buildAcceptanceArtifactUnderLease` and `loadAcceptanceArtifactSource` must retrieve and validate that record on every entry and after every test hook.

- [ ] **Step 6: Keep the standalone builder API compatible**

Implement the existing function only as:

```js
export async function buildAcceptanceArtifact({ repoRoot, hooks } = {}) {
  return await withAcceptanceArtifactLock(repoRoot, async (lease) =>
    await buildAcceptanceArtifactUnderLease({ lease, hooks }));
}
```

The loader always reads `<repo>/dist/read-only-acceptance`, requires the exact four names, re-runs the shared contract, and returns immutable copy-out bytes plus frozen evidence. It accepts no directory argument.

- [ ] **Step 7: Run packaging regressions and commit Task 3**

```bash
npx vitest run tests/packaging/acceptance-artifact-lease.test.ts tests/packaging/read-only-acceptance-build.test.ts tests/packaging/build-acceptance-cli.test.ts tests/packaging/composition-roots.test.ts --no-file-parallelism --maxWorkers=1
git add scripts/acceptance-artifact-contract.mjs scripts/acceptance-build.mjs tests/packaging/acceptance-artifact-lease.test.ts tests/packaging/read-only-acceptance-build.test.ts tests/packaging/build-acceptance-cli.test.ts tests/packaging/composition-roots.test.ts
git commit -m "refactor: expose leased acceptance artifacts"
```

### Task 4: Share the deterministic 5,000-note fixture and corpus attestation

**Files:**

- Create: `scripts/synthetic-note-fixture.mjs`
- Create: `scripts/synthetic-note-fixture.d.mts`
- Create: `scripts/synthetic-acceptance-vault.mjs`
- Create: `tests/packaging/synthetic-acceptance-fixture.test.ts`
- Modify: `tests/performance/generate-fixture.ts`
- Modify: `tests/performance/index.bench.test.ts`

**Fixed contract:**

```ts
export const SYNTHETIC_ACCEPTANCE_NOTE_COUNT = 5_000;
export const SYNTHETIC_ACCEPTANCE_MINIMUM_BYTES = 75 * 1024 * 1024;
export const SYNTHETIC_ACCEPTANCE_SEED = 13;
export const SYNTHETIC_CONTENT_DIRECTORY = "Generated";

export interface SyntheticFixtureNote {
  readonly path: string;
  readonly basename: string;
  readonly mtime: number;
  readonly size: number;
  readonly content: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly headings: readonly string[];
  readonly outgoingLinks: readonly string[];
}

export interface CorpusAttestation {
  readonly syntheticNoteCount: 5000;
  readonly syntheticTotalBytes: 78643200;
  readonly corpusDigest: string;
  readonly tree: OwnedTreeSnapshot;
}

export interface AttestationInput {
  readonly vaultPath: string;
  readonly phase: "prepared" | "post-host";
  readonly expected?: Readonly<{
    syntheticNoteCount: 5000;
    syntheticTotalBytes: 78643200;
    corpusDigest: string;
  }>;
}

export function generateSyntheticFixture(input: Readonly<{
  notes: number;
  minimumBytes: number;
  seed?: number;
}>): Readonly<{
  notes: readonly SyntheticFixtureNote[];
  noteCount: number;
  totalBytes: number;
}>;

export function generateAcceptanceFixture(): ReturnType<typeof generateSyntheticFixture>;
export function computeSyntheticCorpusDigest(notes: readonly SyntheticFixtureNote[]): string;
export async function attestSyntheticAcceptanceVault(input: AttestationInput): Promise<CorpusAttestation>;
```

- [ ] **Step 1: Write RED generator parity and digest tests**

Assert byte-for-byte deterministic notes across calls, exact note count `5000`, exact total bytes `78_643_200`, fixed seed `13`, bilingual headings, every 100th malformed-frontmatter case, deterministic links, and the first two fixed paths:

```ts
expect(fixture.notes.slice(0, 2).map((note) => note.path)).toEqual([
  "Generated/00000/note-00000-3db92208.md",
  "Generated/00001/note-00001-752cddc7.md",
]);
expect(fixture.noteCount).toBe(5_000);
expect(fixture.totalBytes).toBe(75 * 1024 * 1024);
```

Also assert digest independence from array order and `mtime`, and sensitivity to a path-byte or content-byte change. Include an explicit framing test proving `a/b + c` does not collide with `a + b/c`.

- [ ] **Step 2: Write RED on-disk attestation tests**

Materialize one complete fixture once, then prove attestation rejects an added, missing, renamed, or one-byte-changed note; extra top-level content; a symlink; a hard link; FIFO/socket; a replaced directory component; a nonempty or enabled community-plugin list; and a changed marker. Cover device-node logic through injected stat evidence, not privileged `mknod`.

Declare a scoped `600_000` ms timeout constant in this test file and pass it explicitly to every test and setup/cleanup hook that materializes or attests the 5,000-note/75 MiB fixture. Do not widen Vitest's global timeout or unrelated lightweight tests; the on-disk cases must pass through plain `npm test`, not only the focused command below.

- [ ] **Step 3: Run the fixture suite and verify RED**

```bash
npx vitest run tests/packaging/synthetic-acceptance-fixture.test.ts --no-file-parallelism --maxWorkers=1 --testTimeout=180000 --hookTimeout=180000
```

Expected: FAIL because the pure fixture and attestation modules do not exist.

- [ ] **Step 4: Move the current generator without changing its algorithm**

Move the LCG, path construction, bilingual heading, frontmatter, link, padding, and byte-count logic from `tests/performance/generate-fixture.ts` into the pure `.mjs` module. `generateAcceptanceFixture()` must be exactly:

```js
export function generateAcceptanceFixture() {
  return generateSyntheticFixture({
    notes: SYNTHETIC_ACCEPTANCE_NOTE_COUNT,
    minimumBytes: SYNTHETIC_ACCEPTANCE_MINIMUM_BYTES,
    seed: SYNTHETIC_ACCEPTANCE_SEED,
  });
}
```

The TypeScript performance adapter becomes only:

```ts
import { generateSyntheticFixture } from "../../scripts/synthetic-note-fixture.mjs";
import { FakeVault } from "../fakes/fake-vault";

export function generateFixture(input: { notes: number; minimumBytes: number; seed?: number }): GeneratedFixture {
  const fixture = generateSyntheticFixture(input);
  return {
    vault: new FakeVault().withGeneratedNotes(fixture.notes),
    noteCount: fixture.noteCount,
    totalBytes: fixture.totalBytes,
  };
}
```

- [ ] **Step 5: Implement the canonical corpus digest**

Use ASCII prefix `knowledge-workbench-synthetic-corpus-v1\0`, unsigned UTF-8 path-byte ordering, and unsigned 64-bit big-endian path/content lengths. Only `Generated/**` Markdown entries participate. Return `sha256:<64 lowercase hex>`.

- [ ] **Step 6: Implement exact vault attestation**

Require only the marker, `Generated`, and `.obsidian` at the top level. Before host launch, `.obsidian` must contain the exact minimal configuration plus empty `plugins`; after host launch, use a separate post-host allowlist but continue to validate the marker, empty `community-plugins.json`, installed target, seed/runtime settings, and corpus. Return only aggregate count, total bytes, digest, and in-process tree snapshots—never note paths or contents in persisted evidence.

- [ ] **Step 7: Run generator, performance parity, and type checks**

```bash
npx vitest run tests/packaging/synthetic-acceptance-fixture.test.ts --no-file-parallelism --maxWorkers=1 --testTimeout=180000 --hookTimeout=180000
KNOWLEDGE_WORKBENCH_PERFORMANCE=1 npx vitest run tests/performance/index.bench.test.ts -t "generates identical rich note metadata" --no-file-parallelism --maxWorkers=1
npx tsc -noEmit -skipLibCheck
```

Expected: PASS with the performance adapter producing the same fixture semantics.

- [ ] **Step 8: Commit Task 4**

```bash
git add scripts/synthetic-note-fixture.mjs scripts/synthetic-note-fixture.d.mts scripts/synthetic-acceptance-vault.mjs tests/packaging/synthetic-acceptance-fixture.test.ts tests/performance/generate-fixture.ts tests/performance/index.bench.test.ts
git commit -m "refactor: share deterministic acceptance fixture"
```

### Task 5: Bind clean Git state, run ID, preparation state, and receipt

**Files:**

- Create: `scripts/git-worktree-state.mjs`
- Create: `scripts/acceptance-run-contract.mjs`
- Create: `tests/packaging/acceptance-run-contract.test.ts`

**Interfaces:**

```ts
export async function captureCleanGitState(repoRoot: string): Promise<Readonly<{ commit: string }>>;
export async function assertCleanGitState(repoRoot: string, expectedCommit: string): Promise<void>;

export interface PreparationState {
  readonly schemaVersion: 1;
  readonly scope: "dedicated-synthetic-vault";
  readonly contentPolicy: "deterministic-synthetic-notes-only";
  readonly runId: string;
  readonly commit: string;
  readonly syntheticNoteCount: 5000;
  readonly syntheticTotalBytes: 78643200;
  readonly corpusDigest: string;
}

export interface InstallationReceipt {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly commit: string;
  readonly pluginVersion: string;
  readonly artifactBinding: string;
  readonly artifactSetDigest: string;
  readonly fixtureStateDigest: string;
  readonly seedDataDigest: string;
}

export function createPreparationState(input: Readonly<{
  runId: string;
  commit: string;
  attestation: CorpusAttestation;
}>): PreparationState;
export function encodePreparationState(state: PreparationState): Buffer;
export function decodePreparationState(bytes: Uint8Array): PreparationState;

export function createInstallationReceipt(input: Readonly<{
  state: PreparationState;
  stateBytes: Buffer;
  pluginVersion: string;
  artifactBinding: string;
  artifactSetDigest: string;
  seedBytes: Buffer;
}>): InstallationReceipt;
export function encodeInstallationReceipt(receipt: InstallationReceipt): Buffer;
export function decodeInstallationReceipt(bytes: Uint8Array): InstallationReceipt;
```

- [ ] **Step 1: Write RED clean-Git tests with real temporary repositories**

Initialize and commit a tiny repo, then cover a staged change, tracked worktree change, non-ignored untracked file, ignored `.dev-vault` content, `HEAD` switching between checks, symlinked/noncanonical roots, and 40/64-hex commit validation. `captureCleanGitState` must tolerate only ignored `.dev-vault` changes.

- [ ] **Step 2: Write RED strict codec tests**

Test lowercase canonical UUIDv4 only—reject uppercase, nil, non-v4, and noncanonical forms. For state and receipt, reject missing/extra keys, wrong insertion order bytes, invalid prototype/type, unsafe integers, wrong constants, non-40/64 lowercase commit, malformed digest/SemVer/binding, and missing final newline. Re-encoding decoded bytes must be byte identical.

- [ ] **Step 3: Write digest boundary and replay tests**

Assert the state digest includes the final newline; artifact-set digest is name/content framed in exact four-file unsigned UTF-8 order; another run ID, stale same-version artifact digest, altered seed, fifth artifact, or replayed receipt is rejected.

- [ ] **Step 4: Run the contract tests and verify RED**

```bash
npx vitest run tests/packaging/acceptance-run-contract.test.ts --no-file-parallelism --maxWorkers=1
```

Expected: FAIL because both contract modules are absent.

- [ ] **Step 5: Implement stable clean-HEAD capture without a shell**

Use `execFile` for this exact sequence: `git rev-parse --show-toplevel`, `git rev-parse HEAD`, `git status --porcelain=v1 -z --untracked-files=all`, then `git rev-parse HEAD` again. Canonical top level must equal `repoRoot`; both HEAD values must match; status output must be empty. `assertCleanGitState` repeats the sequence and requires the supplied commit.

- [ ] **Step 6: Implement exact state bytes**

Insert keys only in this order and encode with `JSON.stringify(value, null, 2) + "\n"`:

```js
return Object.freeze({
  schemaVersion: 1,
  scope: "dedicated-synthetic-vault",
  contentPolicy: "deterministic-synthetic-notes-only",
  runId,
  commit,
  syntheticNoteCount: 5000,
  syntheticTotalBytes: 75 * 1024 * 1024,
  corpusDigest: attestation.corpusDigest,
});
```

State/receipt decoders must parse bytes, validate exact own keys and plain prototype, rebuild the canonical object, and require exact byte equality. They never persist local paths, inode/device values, per-note hashes, or artifact paths.

- [ ] **Step 7: Implement exact receipt bytes and fixed paths**

Export constants for `.dev-vault/read-only-acceptance-state.json`, `.dev-vault/read-only-acceptance-receipt.json`, `.dev-vault/read-only-acceptance-report.json`, and the fixed vault. Receipt key order is `schemaVersion`, `runId`, `commit`, `pluginVersion`, `artifactBinding`, `artifactSetDigest`, `fixtureStateDigest`, `seedDataDigest`.

- [ ] **Step 8: Run focused tests and commit Task 5**

```bash
npx vitest run tests/packaging/acceptance-run-contract.test.ts --no-file-parallelism --maxWorkers=1
git add scripts/git-worktree-state.mjs scripts/acceptance-run-contract.mjs tests/packaging/acceptance-run-contract.test.ts
git commit -m "feat: bind acceptance run evidence"
```

### Task 6: Create one exact synthetic plugin-data seed and prove runtime compatibility

**Files:**

- Create: `scripts/synthetic-acceptance-data.mjs`
- Create: `scripts/synthetic-acceptance-data.d.mts`
- Create: `tests/packaging/synthetic-acceptance-data.test.ts`

**Interfaces:**

```ts
export function createSyntheticPluginDataSeed(): Readonly<Record<string, unknown>>;
export function encodeSyntheticPluginDataSeed(): Buffer;
export function decodeSyntheticPluginDataSeed(bytes: Uint8Array): Readonly<Record<string, unknown>>;
export function inspectPostHostPluginData(bytes: Uint8Array): Readonly<{
  startupNormalizationEvidence: "seed-unchanged" | "normalized-safe" | "unsafe";
  seededJournalPresent: boolean;
  recoveryAbsent: boolean;
}>;
```

- [ ] **Step 1: Write RED exact-seed tests**

Require exact top-level keys `schemaVersion`, `settings`, `activeIndex`, `staging`, and `operational`; canonical two-space JSON plus final newline; deterministic bytes; no unknown keys; and no endpoint, model, secret, URL, absolute path, arbitrary free text, or non-generated path. Settings must decode initially as:

```ts
expect(store.settings()).toEqual({
  writeEnabled: true,
  writePreviewAcknowledged: true,
  openAtStartup: false,
  folderRules: [],
  excludedPrefixes: [],
  aiEnabled: false,
  aiEndpoint: "",
  aiModel: "",
  secretId: "",
});
```

- [ ] **Step 2: Write the real decoder/journal compatibility test**

Parse the encoded bytes into `MemoryPluginDataPort`, call `PluginDataStore.load()`, then call both `OperationJournal.list()` and `get()`. Assert exactly one valid `completed` journal, no blocking/recovery state, and only the two fixed generator paths:

```ts
const paths = [
  "Generated/00000/note-00000-3db92208.md",
  "Generated/00001/note-00001-752cddc7.md",
];
expect(entries).toHaveLength(1);
expect(entries[0]?.status).toBe("completed");
expect(await journal.get(entries[0]!.id)).toEqual(entries[0]);
expect(journal.organizationWritesBlocked()).toBe(false);
expect(JSON.stringify(entries[0])).not.toMatch(/recovery|endpoint|model|secret|https?:/iu);
for (const path of paths) expect(JSON.stringify(entries[0])).toContain(path);
```

- [ ] **Step 3: Verify startup normalization against the real store**

Before host normalization, inspect the exact canonical seed bytes and require `startupNormalizationEvidence === "seed-unchanged"`; do not prematurely collapse this evidence to a terminal status because its meaning depends on the human host observation. Then call `store.enforceRuntimePolicy(READ_ONLY_ACCEPTANCE_POLICY)` and reload. Assert `writeEnabled === false`, `aiEnabled === false`, the completed journal remains usable, and the in-memory port never contains an endpoint/model/secret; encoding those post-policy bytes must inspect as `startupNormalizationEvidence === "normalized-safe"`. Historical valid `aiEnabled: true` remains covered by the dedicated acceptance automated-safety test, not this persisted seed.

- [ ] **Step 4: Run the seed suite and verify RED**

```bash
npx vitest run tests/packaging/synthetic-acceptance-data.test.ts --no-file-parallelism --maxWorkers=1
```

Expected: FAIL because the seed module does not exist.

- [ ] **Step 5: Build the valid completed journal deterministically**

Use one fixed `rename` operation between the two generated paths, two fixed preconditions, identical local/display rationales, and Node `createHash("sha256")` over the same recursively key-sorted fingerprint payload used by `ChangePlanService`. Set `plan.id = fingerprint.slice(0, 16)`. The completed step must use the exact inverse operation, identical preconditions, source-absent plus target-present postconditions, `prepared: null`, and no rolled-back IDs.

- [ ] **Step 6: Implement strict seed encode/decode and post-host inspection**

The seed decoder validates every allowed nested key and requires re-encoding to equal the input bytes. The post-host inspector keeps three independent concerns. Normalization evidence looks only at settings: exact canonical original seed → `seed-unchanged`; `writeEnabled === false`, `aiEnabled === false`, and empty endpoint/model/secret with no unknown sensitive field → `normalized-safe`; retained write capability or nonempty/unknown AI/secret field → `unsafe`. `seededJournalPresent` separately reports whether the one expected completed journal remains valid, and `recoveryAbsent` separately reports whether recovery state is absent. Normalized settings plus recovery must remain normalization-safe while `recoveryAbsent` is false. Add RED cases for every normalization branch, each nonempty AI field, missing/malformed journal, and recovery. The inspector returns only the three aggregate fields shown above and never returns the raw object; read/decode uncertainty is represented by the evidence gatherer as `indeterminate`.

- [ ] **Step 7: Run seed and existing storage/history regressions**

```bash
npx vitest run tests/packaging/synthetic-acceptance-data.test.ts tests/unit/storage/plugin-data-store.test.ts tests/ui/history-tab.test.ts --no-file-parallelism --maxWorkers=1
npx tsc -noEmit -skipLibCheck
```

Expected: PASS without changing `PluginDataStore` or `OperationJournal` production code.

- [ ] **Step 8: Commit Task 6**

```bash
git add scripts/synthetic-acceptance-data.mjs scripts/synthetic-acceptance-data.d.mts tests/packaging/synthetic-acceptance-data.test.ts
git commit -m "feat: add synthetic acceptance host data"
```

### Task 7: Prepare the fixed synthetic vault transactionally

**Files:**

- Create: `scripts/prepare-acceptance-synthetic.mjs`
- Create: `scripts/prepare-acceptance-synthetic-cli.mjs`
- Create: `tests/packaging/prepare-acceptance-synthetic.test.ts`

**Interfaces:**

```ts
export type PreparationHook =
  | "afterLockAcquired"
  | "afterStageCreated"
  | "afterStagePopulated"
  | "afterStateStaged"
  | "beforeVaultPublish"
  | "afterVaultPublish"
  | "beforeStatePublish"
  | "afterStatePublish";

export interface PreparationHookContext {
  readonly repoRoot: string;
  readonly devRoot: string;
  readonly lockPath: string;
  readonly vaultStagePath: string | null;
  readonly stateStagePath: string | null;
  readonly vaultPath: string;
  readonly statePath: string;
  readonly runId: string | null;
  readonly commit: string | null;
}

export async function prepareSyntheticAcceptance(options: Readonly<{
  repoRoot: string;
  hooks?: Partial<Record<PreparationHook, (
    context: Readonly<PreparationHookContext>,
  ) => void | Promise<void>>>;
}>): Promise<Readonly<{
  runId: string;
  commit: string;
  syntheticNoteCount: 5000;
  syntheticTotalBytes: 78643200;
}>>;
```

- [ ] **Step 1: Write the full successful preparation test**

Create a real temporary Git repository with a committed copy of the required project files and an existing non-symlink `.dev-vault`. Call the public function with no fixture override. Assert exact fixed paths, one state, 5,000 notes, 75 MiB, exact marker, minimal `.obsidian`, empty plugins directory, empty `community-plugins.json`, matching corpus digest/run ID/commit, and no lock/stage residue.

Declare `600_000` ms per-test and hook timeouts inside this test file so the same full-fixture cases also pass under plain `npm test`, not only the focused CLI command.

- [ ] **Step 2: Write prior-run and concurrency RED tests**

For each fixed vault/state/receipt/report and every run-scoped residue—preparation lock/stage, destination installer lock/stage/backup/quarantine, artifact lock/stage/backup/quarantine residue (not the valid exact artifact target), fixed report lock, and retained report stage—prove preparation refuses and preserves the sentinel. Start two preparers simultaneously and require exactly one lock winner. A stale lock is never stolen. Replacing `.dev-vault` or the lock identity during a hook must stop and retain the replacement.

- [ ] **Step 3: Write clean-Git and stage tamper RED tests**

At each applicable hook, inject a HEAD switch, staged change, tracked worktree change, or non-ignored untracked file; ignored `.dev-vault` changes alone must not fail Git cleanliness. Add/rename/remove/change a generated note, replace the stage, or insert a symlink/hard link/FIFO/socket/unknown top-level entry and require safe failure.

- [ ] **Step 4: Write every publication fault and cleanup assertion**

Inject an exception at all eight hooks. Before vault publication, target and state remain absent. After vault publication but before state publication, rollback may delete only the exact owned vault. After state publication, rollback must first validate the state snapshot and the complete published vault snapshot together before deleting either object; if the vault was tampered, the state must remain. Only after both prevalidations pass may it remove the exact state first and then the exact vault. If state, vault, stage, lock, or any owned entry is missing/replaced/linked/special/unknown, stop at the first mismatch, preserve all not-yet-removed evidence, and surface `cleanup-incomplete`. The tests use the full fixed fixture and never add a production fixture-size option.

- [ ] **Step 5: Run preparation tests and verify RED**

```bash
npx vitest run tests/packaging/prepare-acceptance-synthetic.test.ts --no-file-parallelism --maxWorkers=1 --testTimeout=600000 --hookTimeout=600000
```

Expected: FAIL because preparation does not exist.

- [ ] **Step 6: Implement lock-first preflight and stage population**

Resolve the canonical worktree, require the existing `.dev-vault` on the same device, create `.read-only-acceptance-prepare.lock` exclusively, then reject every prior-run object and all known run-scoped lock/stage/backup/quarantine prefixes, including recorder residue. Capture clean Git state only after lock acquisition. Generate a lowercase UUIDv4 and exact fixture. Create a random sibling stage at mode `0700`; write every directory/file without following links and every file with exclusive creation.

- [ ] **Step 7: Stage and publish the exact state**

After full stage attestation, encode the fixed state to an exclusive sibling state stage. Before each rename and after every hook, revalidate Git/HEAD, parent, lock, stage tree, marker/config, corpus, destination absence, and state bytes. Publish with exactly:

```js
await rename(vaultStagePath, fixedVaultPath);
await rename(stateStagePath, fixedStatePath);
```

Both renames must be same-device and no target may preexist. Re-attest the published vault and re-read exact state bytes before success.

- [ ] **Step 8: Implement identity-safe rollback and sanitized CLI**

Before the first rollback deletion, prevalidate every published object that would be removed: the exact state and complete vault tree when both exist, otherwise the exact single published object. Only then remove state first and vault second from captured snapshots. Map internal failures to fixed categories such as `fixture-invalid`, `fixture-changed`, `concurrent-operation`, and `cleanup-incomplete`. The CLI derives `repoRoot` from `import.meta.url`, accepts no args, rejects path-related environment overrides, and never emits a path, raw JSON, note name, nested error, or digest.

- [ ] **Step 9: Run preparation, fixture, and CLI tests**

```bash
npx vitest run tests/packaging/prepare-acceptance-synthetic.test.ts tests/packaging/synthetic-acceptance-fixture.test.ts --no-file-parallelism --maxWorkers=1 --testTimeout=600000 --hookTimeout=600000
npm run lint
```

Expected: PASS; no real vault or Obsidian process is involved.

- [ ] **Step 10: Commit Task 7**

```bash
git add scripts/prepare-acceptance-synthetic.mjs scripts/prepare-acceptance-synthetic-cli.mjs tests/packaging/prepare-acceptance-synthetic.test.ts
git commit -m "feat: prepare attested acceptance vault"
```

### Task 8: Install, seed, and receipt the acceptance artifact under one lease

**Files:**

- Create: `scripts/install-acceptance-dev.mjs`
- Create: `scripts/install-acceptance-dev-cli.mjs`
- Create: `tests/packaging/install-acceptance-dev.test.ts`
- Create: `tests/packaging/acceptance-workflow-cli.test.ts`
- Modify: `package.json`
- Modify: `tests/packaging/build-acceptance-cli.test.ts`

**Interfaces:**

```ts
export type AcceptanceInstallHook =
  | "afterArtifactLock"
  | "afterBuild"
  | "afterSourceFreeze"
  | "afterDestinationLock"
  | "afterStageCreated"
  | "afterStageValidated"
  | "afterTargetPublished"
  | "beforeSeed"
  | "afterSeed"
  | "beforeReceiptPublish"
  | "afterReceiptPublish";

export interface AcceptanceInstallHookContext {
  readonly repoRoot: string;
  readonly artifactLockPath: string;
  readonly sourcePath: string;
  readonly destinationLockPath: string | null;
  readonly pluginsParentPath: string;
  readonly stagePath: string | null;
  readonly targetPath: string;
  readonly seedPath: string;
  readonly statePath: string;
  readonly receiptStagePath: string | null;
  readonly receiptPath: string;
  readonly reportPath: string;
  readonly runId: string | null;
  readonly commit: string | null;
}

export async function installAcceptanceDevelopment(options: Readonly<{
  repoRoot: string;
  hooks?: Partial<Record<AcceptanceInstallHook, (
    context: Readonly<AcceptanceInstallHookContext>,
  ) => void | Promise<void>>>;
}>): Promise<Readonly<{
  runId: string;
  pluginVersion: string;
  artifactBinding: string;
}>>;
```

Hook contexts are frozen, test-only observations from the imported function APIs. CLIs cannot accept hooks or emit any context field; null denotes that the relevant object has not yet been created at that hook.

- [ ] **Step 1: Write the RED happy-path transaction test**

Prepare a committed temporary repo through Task 7, call the public installer, and assert the fixed target contains exactly `main.js`, `manifest.json`, `styles.css`, `acceptance-build.json`, and the attested `data.json`; the four managed bytes equal the frozen builder output; the plugin ID is absent from the unchanged empty community manifest; one receipt matches state/run/commit/binding and all three digests; target/receipt/stages/locks revalidate; and `.dev-vault/acceptance.json` sentinel is unchanged.

Declare `600_000` ms per-test and hook timeouts inside the installer/CLI test files so full builds remain valid under plain `npm test`.

- [ ] **Step 2: Write lock ordering and continuous-lease tests**

Pause at `afterSourceFreeze`. While paused, prove a standalone builder and second installer cannot acquire the artifact lock. After the destination lock is held, prove a second installer cannot enter. Record hook order and require artifact lock before clean state, build, source freeze, and destination lock; destination lock must be released before artifact lock.

- [ ] **Step 3: Write source, Git, state, and destination TOCTOU tests**

After every hook, independently mutate HEAD/index/tracked/non-ignored-untracked state, state bytes with same inode/size, fixture bytes, source bytes with same inode/size, source directory identity, community manifest identity/bytes, plugins parent, target expectation, receipt expectation, either lock, stage, or target. Each case must stop before a successful receipt. Ignored `.dev-vault` changes outside the owned/fixed allowlist still fail the relevant exact-tree check.

- [ ] **Step 4: Write artifact and cross-run rejection tests**

Reject a missing/fifth artifact, symlink/hard link/special file, normal manifest, bad metadata key/value/binding, forbidden bundle token, stale same-version output, another run's state/receipt, replayed receipt, old final report, altered seed, existing normal target, partial acceptance target, retained builder/installer stage/backup/quarantine, and forged/expired/cross-repo lease. Also precreate the destination installer lock as a file, directory, symlink, and unknown sentinel shape; every form is preserved, never age-stolen or cleaned, and stops before mutation. Distinguish known-prefix owned residue from unknown residue and preserve both.

- [ ] **Step 5: Write rollback and publication-failure tests**

Every pre-target fault leaves target/receipt absent. Post-target or seed failure removes only an unchanged exact target. When receipt and target both exist, rollback first validates the exact receipt and complete five-entry target snapshots together before deleting either; a tampered target must leave the receipt intact. Only after both prevalidations pass may receipt publication/final verification failure remove the exact receipt first and then the exact target. If receipt/target/stage is replaced, linked, special, missing, or gains an unknown entry, retain evidence and return `rollback-incomplete` or `cleanup-incomplete`; never recursively delete or claim readiness.

- [ ] **Step 6: Run installer tests and verify RED**

```bash
npx vitest run tests/packaging/install-acceptance-dev.test.ts tests/packaging/acceptance-artifact-lease.test.ts --no-file-parallelism --maxWorkers=1 --testTimeout=600000 --hookTimeout=600000
```

Expected: FAIL because the acceptance installer does not exist.

- [ ] **Step 7: Implement the continuous orchestration wrapper**

The public function must perform one unbroken callback:

```js
return await withAcceptanceArtifactLock(repoRoot, async (lease) => {
  const git = await captureCleanGitState(repoRoot);
  const run = await loadAndValidatePreparationRun({ repoRoot, git });
  await buildAcceptanceArtifactUnderLease({ lease });
  const source = await loadAcceptanceArtifactSource({ lease });
  return await publishSeedAndReceipt({ lease, run, source, hooks });
});
```

`loadAndValidatePreparationRun` requires matching immutable state/current HEAD, exact fresh fixture, absent target/receipt/report, no preparation residue, and empty disabled community manifest. No build-to-install handoff occurs outside the lease.

- [ ] **Step 8: Publish the four managed files as one directory**

Acquire the destination lock under the already attested plugins parent. Freeze parent/community/state/source evidence. Create a random `0700` sibling stage, write only the four frozen byte arrays exclusively, validate their exact contract, and publish with one same-filesystem `rename(stage, target)`. Never reopen a source path while staging.

- [ ] **Step 9: Seed and create the one-time receipt**

After target verification and while the plugin is still disabled, exclusively create canonical seed `data.json`, validate its bytes, and extend the owned target snapshot to the exact five-entry allowlist. Derive receipt digests from the frozen four artifacts, exact state bytes including newline, and original seed bytes. Publish the receipt through an exclusive sibling stage and atomic rename; never overwrite an existing receipt.

- [ ] **Step 10: Add no-argument package scripts and sanitized CLI behavior**

Add exactly:

```json
{
  "prepare:acceptance:synthetic": "node scripts/prepare-acceptance-synthetic-cli.mjs",
  "install:acceptance:dev": "node scripts/install-acceptance-dev-cli.mjs"
}
```

The install CLI rejects all args and path/mode/artifact overrides. Its only success text is `Installed the bound read-only acceptance build into the fixed synthetic vault; Obsidian was not started.\n`. Internal errors containing an absolute path, raw JSON, note name, or nested error must map to one fixed category/message.

- [ ] **Step 11: Run focused and normal-installer regressions**

```bash
npx vitest run tests/packaging/install-acceptance-dev.test.ts tests/packaging/acceptance-workflow-cli.test.ts tests/packaging/acceptance-artifact-lease.test.ts tests/packaging/install-dev.test.ts tests/packaging/build-acceptance-cli.test.ts --no-file-parallelism --maxWorkers=1 --testTimeout=600000 --hookTimeout=600000
npm run lint
npx tsc -noEmit -skipLibCheck
```

Expected: PASS; normal and acceptance public commands remain disjoint and neither accepts a mode switch.

- [ ] **Step 12: Commit Task 8**

```bash
git add scripts/install-acceptance-dev.mjs scripts/install-acceptance-dev-cli.mjs tests/packaging/install-acceptance-dev.test.ts tests/packaging/acceptance-workflow-cli.test.ts package.json tests/packaging/build-acceptance-cli.test.ts
git commit -m "feat: install bound acceptance run transactionally"
```

### Task 9: Define terminal report composition and current local evidence

**Files:**

- Create: `scripts/read-only-acceptance-report.mjs`
- Create: `scripts/read-only-acceptance-report.d.mts`
- Create: `scripts/read-only-acceptance-local-evidence.mjs`
- Create: `tests/packaging/read-only-acceptance-report.test.ts`
- Create: `tests/integration/read-only-acceptance-automated-safety.test.ts`
- Create: `tests/ui/read-only-acceptance-surfaces.test.ts`

**Interfaces:**

```ts
export type TerminalStatus = "passed" | "failed" | "inconclusive";
export type StartupNormalizationEvidence =
  | "seed-unchanged"
  | "normalized-safe"
  | "unsafe"
  | "indeterminate";
export type FailureCategory =
  | "artifact"
  | "fixture"
  | "startup"
  | "host-isolation"
  | "ui-capability"
  | "content-drift"
  | "network"
  | "recovery"
  | "timing";

export interface ReadOnlyAcceptanceReport {
  readonly schemaVersion: 1;
  readonly scope: "dedicated-synthetic-vault";
  readonly contentPolicy: "deterministic-synthetic-notes-only";
  readonly buildMode: "read-only-acceptance";
  readonly status: TerminalStatus;
  readonly recordedAt: string;
  readonly runId: string;
  readonly commit: string;
  readonly pluginVersion: string;
  readonly obsidianVersion: string;
  readonly artifactBinding: string;
  readonly syntheticNoteCount: 5000;
  readonly scanElapsedMs: number;
  readonly restartRestoreElapsedMs: number;
  readonly artifactIdentity: TerminalStatus;
  readonly fixtureIdentity: TerminalStatus;
  readonly automatedSafety: TerminalStatus;
  readonly hostIsolation: TerminalStatus;
  readonly banner: TerminalStatus;
  readonly startupNormalization: TerminalStatus;
  readonly quickCaptureBlocked: TerminalStatus;
  readonly organizationWritesBlocked: TerminalStatus;
  readonly undoBlocked: TerminalStatus;
  readonly historySensitiveActionsBlocked: TerminalStatus;
  readonly aiBlocked: TerminalStatus;
  readonly readSurfaces: TerminalStatus;
  readonly restartRestore: TerminalStatus;
  readonly contentUnchanged: TerminalStatus;
  readonly networkBoundary: TerminalStatus;
  readonly recoveryAbsent: TerminalStatus;
  readonly finalHostStopped: TerminalStatus;
  readonly failureCategories: readonly FailureCategory[];
}

export interface HostObservation {
  readonly recordedAt: string;
  readonly obsidianVersion: string;
  readonly scanElapsedMs: number;
  readonly restartRestoreElapsedMs: number;
  readonly hostIsolation: TerminalStatus;
  readonly banner: TerminalStatus;
  readonly startupNormalization: TerminalStatus;
  readonly quickCaptureBlocked: TerminalStatus;
  readonly organizationWritesBlocked: TerminalStatus;
  readonly undoBlocked: TerminalStatus;
  readonly historySensitiveActionsBlocked: TerminalStatus;
  readonly aiBlocked: TerminalStatus;
  readonly readSurfaces: TerminalStatus;
  readonly restartRestore: TerminalStatus;
  readonly networkBoundary: TerminalStatus;
  readonly recoveryAbsent: TerminalStatus;
  readonly finalHostStopped: TerminalStatus;
}

export interface LocalAcceptanceEvidence {
  readonly runId: string;
  readonly commit: string;
  readonly pluginVersion: string;
  readonly artifactBinding: string;
  readonly syntheticNoteCount: 5000;
  readonly artifactIdentity: TerminalStatus;
  readonly fixtureIdentity: TerminalStatus;
  readonly automatedSafety: TerminalStatus;
  readonly contentUnchanged: TerminalStatus;
  readonly startupNormalizationEvidence: StartupNormalizationEvidence;
  readonly hostIsolation: TerminalStatus;
  readonly historySensitiveActionsBlocked: TerminalStatus;
  readonly networkBoundary: TerminalStatus;
  readonly recoveryAbsent: TerminalStatus;
  readonly finalHostStopped: TerminalStatus;
}

export function decodeHostObservation(value: unknown): HostObservation;
export function decodeReadOnlyAcceptanceReport(bytes: Uint8Array): ReadOnlyAcceptanceReport;
export function composeReadOnlyAcceptanceReport(
  local: LocalAcceptanceEvidence,
  host: HostObservation,
): ReadOnlyAcceptanceReport;
export function computeReportStatus(report: ReadOnlyAcceptanceReport): TerminalStatus;
export function deriveFailureCategories(report: ReadOnlyAcceptanceReport): readonly FailureCategory[];
export function encodeReadOnlyAcceptanceReport(report: ReadOnlyAcceptanceReport): Buffer;
export async function gatherLocalAcceptanceEvidence(repoRoot: string): Promise<LocalAcceptanceEvidence>;
export async function validateReportAgainstCurrentEvidence(
  repoRoot: string,
  report: ReadOnlyAcceptanceReport,
): Promise<void>;
```

- [ ] **Step 1: Write exact host-input and report-schema RED tests**

Require the exact keys from design section 10. Reject every missing/extra key, accessor/non-plain prototype, invalid status, duplicate/unallowed category, a noncanonical or longer-than-32-character `recordedAt`, an `obsidianVersion` longer than 40 characters or outside `^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9A-Za-z.-]{1,16})?$`, wrong run/commit/SemVer/binding/constants, `NaN`/infinity/negative timing, timing above `3_600_000`, unbounded strings, path/title/content/endpoint/secret/journal/digest/raw-error injection, and noncanonical JSON bytes. Report encoding uses displayed key order, two spaces, and final newline.

Declare scoped `600_000` ms per-test and setup/cleanup-hook timeouts in `read-only-acceptance-report.test.ts` for cases that materialize the full fixture, install current evidence, or execute the fixed automated safety suite. Apply the same scoped rule to any heavy case in the two dedicated safety-surface files. Never raise the global Vitest timeout; all of these cases must pass through plain `npm test`.

- [ ] **Step 2: Write deterministic severity and timing tests**

Use exact precedence `failed > inconclusive > passed`. Fold timing into only its related gate:

```ts
expect(timingFloor(0)).toBe("inconclusive");
expect(timingFloor(1)).toBe("passed");
expect(timingFloor(30_000)).toBe("passed");
expect(timingFloor(30_001)).toBe("failed");
expect(() => timingFloor(3_600_001)).toThrow(/timing|bound/iu);
```

`scanElapsedMs` composes with `readSurfaces`; `restartRestoreElapsedMs` composes with `restartRestore`. A failed final gate makes overall failed; otherwise any inconclusive gate makes overall inconclusive; otherwise passed.

- [ ] **Step 3: Write exact category-order tests**

Derive unique categories only in this fixed allowlist order:

```ts
const FAILURE_CATEGORY_ORDER = [
  "artifact",
  "fixture",
  "startup",
  "host-isolation",
  "ui-capability",
  "content-drift",
  "network",
  "recovery",
  "timing",
] as const;
```

Map gates exactly as the design specifies. A passed report has `[]`; human input never supplies categories. Timing downgrade adds `timing` in addition to the category implied by the final gate.

- [ ] **Step 4: Write local/composite/host-only validation tests**

The saved report contains final gates, not raw host observations. Therefore validator behavior is:

```ts
const LOCAL_ONLY = ["artifactIdentity", "fixtureIdentity", "automatedSafety", "contentUnchanged"] as const;
const LOCAL_COMPOSITE = [
  "hostIsolation",
  "historySensitiveActionsBlocked",
  "networkBoundary",
  "recoveryAbsent",
  "finalHostStopped",
] as const;
const TIMING_COMPOSITE = ["readSurfaces", "restartRestore"] as const;
```

Require local-only gates to equal freshly derived values. Require each saved composite gate to be no better than the current local floor. Missing/malformed seeded History sets only the local `historySensitiveActionsBlocked` floor; recovery sets only the local `recoveryAbsent` floor. Validate startup normalization separately: `normalized-safe` has passed local floor even when recovery is present, `unsafe` has failed floor, and `seed-unchanged`/`indeterminate` have inconclusive floor; a saved report may be worse but never better. Require timing composites to be no better than their current timing floor. Preserve host-only final gates because original human input is intentionally not persisted. Recompute overall status and categories from saved final gates and require exact equality.

- [ ] **Step 5: Write current-evidence RED tests**

First establish a run anchor: canonical state plus canonical receipt must decode, share run ID/commit, and bind the state digest. Without that anchor, the recorder cannot safely attribute a terminal report and must create no report. Once anchored, definite artifact/binding/settings/recovery/marker/config/corpus mismatches become derived `failed` gates; a check that cannot complete or be attributed becomes `inconclusive` rather than an exception.

Keep pre-host and post-host corpus evidence separate. `fixtureIdentity` comes from the valid preparation state plus matching install receipt and the continuing fixed marker/top-level/config boundary. `contentUnchanged` comes from a fresh post-host comparison of `Generated/**` against the state corpus digest. Add a RED case that changes one generated note after a valid install: `fixtureIdentity` remains passed and only `contentUnchanged` becomes failed. A changed marker or forbidden top-level/config object downgrades `fixtureIdentity` and, where it breaks host isolation, the local `hostIsolation` floor.

Also cover clean current HEAD; current exact four-file artifact digest and contract through the shared `validateAcceptanceArtifactSnapshot`; empty community-plugin list/fixed target; post-host plugin data with writes/AI false, empty endpoint/model/secret, and no recovery; old `.dev-vault/acceptance.json` untouched; and report absence. Prove the current `data.json` may contain legal derived index changes and need not equal `seedDataDigest`; the receipt digest proves original canonical seed bytes, while `inspectPostHostPluginData()` proves current safety state. Add the explicit stopped-before-enable case: ambiguous vault path, exact unchanged seed bytes, and no host run compose to terminal `hostIsolation: inconclusive` plus `startupNormalization: inconclusive`, not failed and not no-report.

- [ ] **Step 6: Fix the automated safety suite as data and test its exact invocation**

Create two dedicated acceptance-only suites. `read-only-acceptance-automated-safety.test.ts` covers frozen policy/composition, historical valid write/AI normalization using only in-memory `https://acceptance.invalid/v1`, zero secret ID, direct controller/service/port/recovery-detail bypasses, and zero client/secret/request callbacks. `read-only-acceptance-surfaces.test.ts` covers the persistent non-color-only banner and all acceptance-only Change Preview, History, Settings, and Workbench controls without constructing normal-mode settings or clients.

The recorder runs this exact same-commit list, with no user-supplied test names and no broad normal-mode test file:

```js
export const AUTOMATED_SAFETY_TESTS = Object.freeze([
  "tests/unit/runtime/artifact-binding.test.ts",
  "tests/integration/plugin-startup-gate.test.ts",
  "tests/integration/read-only-acceptance.test.ts",
  "tests/integration/read-only-acceptance-automated-safety.test.ts",
  "tests/packaging/composition-roots.test.ts",
  "tests/packaging/read-only-acceptance-build.test.ts",
  "tests/ui/read-only-acceptance-surfaces.test.ts",
]);
```

Resolve `node_modules/vitest/vitest.mjs` beneath the canonical worktree and invoke it with `execFile(process.execPath, [vitestPath, "run", ...AUTOMATED_SAFETY_TESTS, "--no-file-parallelism", "--maxWorkers=1"], { cwd: repoRoot, timeout: 600_000, maxBuffer: 1_048_576, env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", CI: "1", NO_COLOR: "1" } })`. Capture output internally; a completed assertion failure is `failed`, while spawn failure, timeout, output overflow, or indeterminate termination is `inconclusive`; never expose raw output or inherit proxy/credential variables.

- [ ] **Step 7: Run report tests and verify RED**

```bash
npx vitest run tests/packaging/read-only-acceptance-report.test.ts --no-file-parallelism --maxWorkers=1
```

Expected: FAIL because report and local-evidence modules do not exist.

- [ ] **Step 8: Implement strict composition and canonical encoding**

Use a status-rank helper where `passed = 0`, `inconclusive = 1`, and `failed = 2`; `worstStatus` returns the greatest rank. Build the report only from decoded local evidence plus decoded host observation. Insert the exact schema keys in design order; never spread arbitrary input objects.

Startup normalization uses evidence-aware composition rather than ordinary `worstStatus`: `unsafe` always fails; `indeterminate` is at least inconclusive; `normalized-safe` composes with the host status normally; `seed-unchanged` plus host inconclusive remains inconclusive (safe never-enabled stop), `seed-unchanged` plus host failed remains failed, and `seed-unchanged` plus host passed is failed because the host claimed surfaces appeared without durable normalization. Add the contrasting RED cases.

- [ ] **Step 9: Implement local evidence without overclaiming host state**

Local checks may downgrade `hostIsolation`, `startupNormalization`, `historySensitiveActionsBlocked`, `networkBoundary`, `recoveryAbsent`, and `finalHostStopped`, but never upgrade a human observation. In particular, filesystem/process checks cannot independently prove Obsidian fully stopped, and the static bundle scan cannot attribute every host request. `finalHostStopped: passed` requires both human passed and local receipt/artifact/settings/corpus/community-plugin checks passed.

- [ ] **Step 10: Run report and existing safety suites**

```bash
npx vitest run tests/packaging/read-only-acceptance-report.test.ts tests/integration/read-only-acceptance-automated-safety.test.ts tests/ui/read-only-acceptance-surfaces.test.ts tests/unit/runtime/safety-policy.test.ts tests/unit/runtime/runtime-composition.test.ts tests/unit/runtime/artifact-binding.test.ts tests/unit/storage/plugin-data-store.test.ts tests/integration/plugin-startup-gate.test.ts tests/integration/read-only-acceptance.test.ts tests/integration/offline.test.ts tests/packaging/composition-roots.test.ts tests/packaging/read-only-acceptance-build.test.ts tests/ui/accessibility.test.ts tests/ui/change-preview-modal.test.ts tests/ui/history-tab.test.ts tests/ui/settings-tab.test.ts tests/ui/workbench-view.test.ts --no-file-parallelism --maxWorkers=1
npx tsc -noEmit -skipLibCheck
```

Expected: PASS with no network request and no real vault access.

- [ ] **Step 11: Commit Task 9**

```bash
git add scripts/read-only-acceptance-report.mjs scripts/read-only-acceptance-report.d.mts scripts/read-only-acceptance-local-evidence.mjs tests/packaging/read-only-acceptance-report.test.ts tests/integration/read-only-acceptance-automated-safety.test.ts tests/ui/read-only-acceptance-surfaces.test.ts
git commit -m "feat: validate terminal acceptance reports"
```

### Task 10: Record and independently validate one terminal report

**Files:**

- Create: `scripts/record-read-only-acceptance.mjs`
- Create: `scripts/validate-read-only-acceptance.mjs`
- Create: `tests/packaging/read-only-acceptance-recorder.test.ts`
- Modify: `package.json`
- Modify: `eslint.config.mts`

**Interfaces:**

```ts
export type RecorderHook =
  | "afterRunAnchor"
  | "afterAutomatedSafety"
  | "afterFinalEvidence"
  | "afterReportStaged"
  | "beforeReportPublish";

export interface RecorderHookContext {
  readonly repoRoot: string;
  readonly lockPath: string;
  readonly reportStagePath: string | null;
  readonly reportPath: string;
  readonly statePath: string;
  readonly receiptPath: string;
  readonly targetPath: string;
  readonly runId: string | null;
  readonly commit: string | null;
}

export async function recordReadOnlyAcceptance(options: Readonly<{
  repoRoot: string;
  observation: HostObservation;
  hooks?: Partial<Record<RecorderHook, (
    context: Readonly<RecorderHookContext>,
  ) => void | Promise<void>>>;
}>): Promise<ReadOnlyAcceptanceReport>;
```

The recorder context is frozen and available only to imported test hooks. The CLI cannot accept hooks or emit any context field; null means the run anchor or stage is not yet available.

- [ ] **Step 1: Write bounded-stdin RED tests**

Spawn the recorder with exact observation JSON. Accept at most 8 KiB and exactly one JSON object. Reject empty/multiple JSON, extra/missing/derived fields, a supplied `status`, run ID, commit, version, binding, note count, artifact/fixture/safety/content claims, category, file path, or free-text field. Assert stdin is never echoed.

Declare `600_000` ms per-test and hook timeouts inside recorder tests because the fixed nested safety suite must also pass under plain `npm test`.

- [ ] **Step 2: Write one-time and concurrency RED tests**

With valid current local evidence, start two recorders simultaneously; exactly one may publish. Use the fixed `.read-only-acceptance-report.lock`, acquired before checking report/stage absence and held through final verification and cleanup. Existing lock, report, or retained report-stage objects of file/directory/symlink/special shape are hard stops, are never age-stolen, and remain unchanged. A random same-directory stage is allowed only while the fixed lock is held. Fault before/after stage creation and publication; cleanup removes only exact owned stage/lock/report snapshots and retains replacements with `cleanup-incomplete`.

- [ ] **Step 3: Write terminal-result tests**

Record one passed, one failed, and one inconclusive form in separate fixtures. Require local-only fields derived rather than trusted, composite worst-status behavior, timing folds, exact category order, public `runId` but no receipt digests, and canonical report bytes. A completed failing automated safety suite creates a failed terminal report; a runner that cannot start or times out creates an inconclusive terminal report. Invalid/missing/mismatched state or receipt means no safe run anchor and creates no report. After a valid anchor exists, definite artifact, corpus, settings, endpoint/model/secret, recovery, or isolation mismatch is a terminal failed gate; indeterminate inspection is terminal inconclusive.

Include a valid anchored run where path selection is ambiguous, the plugin is never enabled, and `data.json` remains byte-identical to the original receipt-bound seed. The recorder must persist terminal `hostIsolation: inconclusive` and `startupNormalization: inconclusive`; it must not reject the seed as malformed or misclassify it as a failed normalization.

Use recorder hooks to change HEAD/index/artifact/corpus/data/community manifest/receipt during the long safety run, after final evidence, after report staging, and immediately before publication. Changes visible before the final gather must affect the terminal gates; anchor loss or any post-stage snapshot change must leave the report absent. No injected race may publish a stale passed report.

- [ ] **Step 4: Write independent validator tests**

Report absence returns pending and never creates a file. A valid saved report is accepted only when the fixed report lock and every report-stage prefix are absent and current clean commit/state/receipt/artifact/fixture/settings plus validator floor rules still hold. Add report-present cases with lock/stage file, directory, symlink, and special evidence: validator must refuse, preserve residue, and never announce passed until recorder cleanup finishes. Reject status/category mismatch, improved composite gate, changed state/receipt/artifact/corpus/current safety data, nonclean Git, another run ID, and report overwrite. Validator re-runs current evidence but never claims to reconstruct raw host observations.

- [ ] **Step 5: Write CLI privacy and fixed-message tests**

Inject internal errors containing an absolute path, raw JSON, generated note name, digest, endpoint-like text, and nested exception. External stdout/stderr must contain only fixed messages/categories, including `artifact-invalid`, `artifact-changed`, `fixture-invalid`, `fixture-changed`, `plugin-enabled`, `target-exists`, `concurrent-operation`, `rollback-incomplete`, `cleanup-incomplete`, or `report-invalid`.

- [ ] **Step 6: Run recorder tests and verify RED**

```bash
npx vitest run tests/packaging/read-only-acceptance-recorder.test.ts --no-file-parallelism --maxWorkers=1 --testTimeout=600000 --hookTimeout=600000
```

Expected: FAIL because recorder and validator CLIs do not exist.

- [ ] **Step 7: Implement the recorder boundary**

Read stdin incrementally and abort once accumulated UTF-8 bytes exceed 8192. Decode exact host observation, acquire the fixed report lock, establish the immutable run anchor, run the fixed automated suite, then freshly gather all local evidence and compose the report. Create one exclusive same-directory stage while the lock is held. After `afterReportStaged` and immediately before rename, revalidate clean HEAD/index/worktree, state, receipt, installed artifact, fixture/content, current plugin data, community manifest, lock/stage identities, and report absence against the final evidence snapshots. If a hook changes anchored artifact/corpus/data before the final gather, record the resulting failed/inconclusive gate; if it changes the run anchor, create no report. Any change after staging causes exact stage cleanup and `concurrent-operation`, never stale publication. Never accept a path or expose internal evidence.

- [ ] **Step 8: Implement the independent validator boundary**

Derive the canonical repo root from `import.meta.url`, accept no args/env override, require the fixed report lock and every report-stage prefix absent, read the fixed report with no-follow evidence, decode exact canonical bytes, gather current local evidence, apply the local-only/composite/timing-floor rules, and recompute status/categories. Missing report prints `Read-only acceptance report is pending.\n` and exits nonzero without mutation. Existing lock/stage residue returns a fixed concurrent/incomplete category and is never removed by validation.

- [ ] **Step 9: Add explicit package scripts**

Add exactly:

```json
{
  "record:read-only-acceptance": "node scripts/record-read-only-acceptance.mjs",
  "validate:read-only-acceptance": "node scripts/validate-read-only-acceptance.mjs"
}
```

Keep existing `validate:acceptance` unchanged. Ensure `scripts/*.mjs` remains covered by the ESLint default-project configuration and add only a narrow rule override if a specific standalone filesystem pattern requires it.

- [ ] **Step 10: Run recorder/report/CLI regressions**

```bash
npx vitest run tests/packaging/read-only-acceptance-recorder.test.ts tests/packaging/read-only-acceptance-report.test.ts tests/packaging/acceptance-workflow-cli.test.ts tests/packaging/build-acceptance-cli.test.ts --no-file-parallelism --maxWorkers=1 --testTimeout=600000 --hookTimeout=600000
npm run lint
npx tsc -noEmit -skipLibCheck
```

Expected: PASS; no report exists unless the recorder received valid bounded host observations.

- [ ] **Step 11: Commit Task 10**

```bash
git add scripts/record-read-only-acceptance.mjs scripts/validate-read-only-acceptance.mjs tests/packaging/read-only-acceptance-recorder.test.ts package.json eslint.config.mts
git commit -m "feat: record acceptance host rehearsal"
```

### Task 11: Lock the human runbook, close all automated gates, and stop before host control

**Files:**

- Create: `docs/runbooks/synthetic-read-only-acceptance.md`
- Create: `tests/packaging/synthetic-read-only-runbook.test.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-14-synthetic-read-only-acceptance-install-design.md`

- [ ] **Step 1: Write the runbook contract test first**

Require the new runbook to contain only these executable package commands, split at the automation/host stop gate:

```text
npm run prepare:acceptance:synthetic
npm run install:acceptance:dev
npm run record:read-only-acceptance
npm run validate:read-only-acceptance
```

Reject `cp`, `rsync`, `open -a`, Finder launch instructions, URLs, absolute paths, file URLs, path/mode/artifact environment overrides, auto-enable steps, and any command that changes `community-plugins.json`. Endpoint/model/secret safety-control names are required in the checklist, but reject every endpoint, model, or secret value; every configuration or input instruction for one; and every example credential. Require fixed warnings that no real vault may be selected/opened and no real-vault window may be active; reject only instructions that authorize, identify, navigate to, or operate on a real vault.

The test also locks the ordered host checklist phrases: exact acceptance display name; persistent non-color-only banner; normalization before surfaces; each blocked Quick Capture/plan execution/sample unlock/write toggle/Undo/History clear-export-path/AI endpoint-model-secret-action control; usable non-confirming preview and read surfaces; restart restore; no recovery; unchanged corpus; static bundle scan as primary network evidence; host observation as supplementary; and unattributable traffic as inconclusive.

Require a fenced `json` example with exactly the 17 `HostObservation` keys in interface order and no derived field, path, free text, run ID, commit, digest, binding, category, or local-evidence claim. The safe all-unperformed form must use `0` for both timings and `"inconclusive"` for every status:

```json
{
  "recordedAt": "2026-07-14T12:00:00.000Z",
  "obsidianVersion": "1.12.7",
  "scanElapsedMs": 0,
  "restartRestoreElapsedMs": 0,
  "hostIsolation": "inconclusive",
  "banner": "inconclusive",
  "startupNormalization": "inconclusive",
  "quickCaptureBlocked": "inconclusive",
  "organizationWritesBlocked": "inconclusive",
  "undoBlocked": "inconclusive",
  "historySensitiveActionsBlocked": "inconclusive",
  "aiBlocked": "inconclusive",
  "readSurfaces": "inconclusive",
  "restartRestore": "inconclusive",
  "networkBoundary": "inconclusive",
  "recoveryAbsent": "inconclusive",
  "finalHostStopped": "inconclusive"
}
```

The contract test also reads `package.json` and the heavy acceptance test sources. It must prove that plain `npm test` still invokes the complete Vitest run and that `synthetic-acceptance-fixture.test.ts`, `prepare-acceptance-synthetic.test.ts`, `install-acceptance-dev.test.ts`, `acceptance-artifact-lease.test.ts`, `acceptance-workflow-cli.test.ts`, `read-only-acceptance-report.test.ts`, and `read-only-acceptance-recorder.test.ts` each declare and apply scoped per-test/setup/cleanup timeouts to their heavy cases. It must reject a global timeout increase used to hide a missing local declaration.

- [ ] **Step 2: Run the documentation test and verify RED**

```bash
npx vitest run tests/packaging/synthetic-read-only-runbook.test.ts tests/packaging/read-only-runbook.test.ts --no-file-parallelism --maxWorkers=1
```

Expected: FAIL because the synthetic runbook is absent; the existing real-vault runbook test remains GREEN.

- [ ] **Step 3: Write the automation boundary and fixed-vault preflight**

Document that prepare/install operate only in the fixed ignored synthetic vault, leave the plugin disabled, never launch Obsidian, never use network/credentials, and leave report absent/pending. Require clean committed HEAD, exact state/receipt/run, empty community-plugin list, no Sync/external mutator, and `.dev-vault/acceptance.json` unchanged.

- [ ] **Step 4: Write the exact human host rehearsal**

Require the human to fully quit Obsidian first. Proceed only through a vault-switcher-only human entry supplied by the installed Obsidian UI that does not restore or open a vault first; a bare application launch is forbidden. If that chooser-only state cannot be reached without risking restoration of another vault, do not launch or enable anything and record `hostIsolation: inconclusive` with all unperformed host gates inconclusive. If any non-target vault appears unexpectedly, do not enable the plugin: fully quit immediately and record the stop condition.

Inside the switcher, visibly confirm the exact locally displayed canonical fixed path before enablement and again after restart; reject name-only, duplicate, hidden, or ambiguous selections as `hostIsolation: inconclusive`. Manually enable only in that confirmed vault. The ordered checklist must require the exact acceptance manifest display name; a persistent non-color-only read-only banner; startup normalization completed before host surfaces appear; Quick Capture blocked; plan confirmation/execution, sample unlock, and write toggle blocked while non-confirming preview remains usable; Undo blocked; seeded History aggregate-only with clear/export/path-bearing controls blocked; endpoint/model/secret inputs and AI actions absent; scan, Today, search, map, folder-rule review, and suggestion preview usable; derived index restored after restart; no `Recovery required`; and unchanged aggregate corpus.

- [ ] **Step 5: Write the mandatory stop and terminal evidence rules**

On both success and failure: manually disable the plugin, fully quit Obsidian, then record observations. If full stop cannot be confirmed after the stop attempt, use `finalHostStopped: inconclusive`. The static acceptance-bundle tripwire is primary network evidence; host observation is supplementary, and unattributable traffic is `networkBoundary: inconclusive`. On content drift, exposed capability, binding/normalization failure, unexplained traffic, or recovery: disable, quit, stop—do not repair, switch builds, inspect private data, retry, or clean retained objects. State the cooperative-lock and host-process/network-attribution limitations explicitly.

- [ ] **Step 6: Link the runbook without changing existing executable README blocks**

Add a prose link to the synthetic runbook. Do not add another fenced command block to README and do not weaken the real-vault fresh-authorization stop gate. Update the design status to `approved; implementation plan linked` and add a relative link to this plan.

- [ ] **Step 7: Run the focused acceptance matrix**

```bash
npx vitest run tests/packaging/safe-fs-core.test.ts tests/packaging/synthetic-vault-install-core.test.ts tests/packaging/acceptance-artifact-lease.test.ts tests/packaging/synthetic-acceptance-fixture.test.ts tests/packaging/acceptance-run-contract.test.ts tests/packaging/synthetic-acceptance-data.test.ts tests/packaging/prepare-acceptance-synthetic.test.ts tests/packaging/install-acceptance-dev.test.ts tests/packaging/acceptance-workflow-cli.test.ts tests/packaging/read-only-acceptance-report.test.ts tests/packaging/read-only-acceptance-recorder.test.ts tests/integration/read-only-acceptance-automated-safety.test.ts tests/ui/read-only-acceptance-surfaces.test.ts tests/packaging/read-only-acceptance-build.test.ts tests/packaging/install-dev.test.ts tests/packaging/synthetic-read-only-runbook.test.ts tests/packaging/read-only-runbook.test.ts --no-file-parallelism --maxWorkers=1 --testTimeout=600000 --hookTimeout=600000
```

Expected: PASS.

- [ ] **Step 8: Run the complete release gate**

```bash
npm run lint
npx tsc -noEmit -skipLibCheck
npm test
npm run build
npm run build:acceptance
npm run verify
```

Expected: every command exits 0; normal root build stays normal and `dist/read-only-acceptance` is the exact bound four-file set.

- [ ] **Step 9: Audit unfinished markers and forbidden capability drift**

```bash
rg -n "TODO|FIXME|TBD|implement later|placeholder|skip\(|only\(" scripts tests docs/runbooks package.json README.md
rg -n "requestUrl|WebSocket|fetch\(|secretStorage|SecretComponent|ObsidianAiClient|ObsidianQuickCaptureAdapter" dist/read-only-acceptance/main.js
git diff --check
```

Expected: no unfinished marker in changed scope, no forbidden token in the acceptance bundle, and no whitespace error.

- [ ] **Step 10: Refresh Graphify, verify the hook, and commit documentation**

```bash
graphify update .
graphify hook status
git add docs/runbooks/synthetic-read-only-acceptance.md tests/packaging/synthetic-read-only-runbook.test.ts README.md docs/superpowers/specs/2026-07-14-synthetic-read-only-acceptance-install-design.md
git commit -m "docs: add synthetic acceptance rehearsal runbook"
git status --short --branch
```

Expected: Graphify reports an updated graph, the post-commit hook is installed, and the worktree is clean after the documentation commit. If review or verification required code changes, commit those fixes separately before this step and rerun the affected gates.

- [ ] **Step 11: Prepare and install only after the final clean commit**

```bash
npm run prepare:acceptance:synthetic
npm run install:acceptance:dev
git status --short --branch
```

Expected: fixed ignored vault/state/receipt exist, report does not exist, Git remains clean, Obsidian was not launched, and the phase is pending.

- [ ] **Step 12: STOP and hand control to the human host rehearsal**

Do not open Obsidian, enable the plugin, invoke the recorder, fabricate host observations, or create a pending report. Report the exact manual runbook link and wait for the user to complete or explicitly stop the human rehearsal.

- [ ] **Step 13: After the human rehearsal, record the terminal observation once**

After the human finishes the rehearsal or stop attempt and submits truthful terminal observations, copy the runbook's exact 17-key JSON template, replace only the timestamp, Obsidian version, two measured timings, and observed statuses, then run the interactive recorder and paste that bounded JSON followed by EOF. For every unperformed check, retain timing `0` where applicable and status `inconclusive`; never add a note, path, derived field, or explanation to stdin. A confirmed fixed path plus confirmed disable/quit can be represented by their statuses; an unconfirmable path must remain `hostIsolation: inconclusive`, and an unconfirmable full stop must remain `finalHostStopped: inconclusive`. These inconclusive outcomes still require terminal evidence. Run the recorder only when the canonical state/receipt run anchor remains valid; do not fabricate confirmation to satisfy a gate.

```bash
npm run record:read-only-acceptance
npm run validate:read-only-acceptance
```

Expected: a single terminal report is created. Product acceptance is complete only when validation returns `passed`; `failed` or `inconclusive` remains terminal evidence and triggers no automatic retry or cleanup.

## Completion definitions

**Automated implementation complete:** Tasks 1–11 code/docs/tests/builds/Graphify are committed; the final clean commit is bound into one fixed prepared and installed synthetic run; the report is absent/pending; Obsidian has not been opened or enabled by automation.

**Product acceptance complete:** The human-controlled rehearsal used the visibly confirmed fixed canonical synthetic vault, ended with the plugin disabled and Obsidian fully quit on success or failure, created one terminal aggregate report, and `npm run validate:read-only-acceptance` returns `passed`.

In both definitions, `.dev-vault/acceptance.json` remains unchanged and no real vault, endpoint, credential, network request, publication, or deployment is used. Cooperative locks do not claim hostile same-UID strong no-clobber, and local checks do not claim they can prove every Obsidian process/window or attribute all host network traffic; uncertainty is always `inconclusive`.
