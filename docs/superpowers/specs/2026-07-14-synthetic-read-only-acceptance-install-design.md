# Synthetic Read-only Acceptance Installation and Host Rehearsal Design

Date: 2026-07-14
Status: approved; implementation plan linked
Implementation plan: [Synthetic read-only acceptance installation and host rehearsal](../plans/2026-07-14-synthetic-read-only-acceptance-install.md)

## 1. Problem

The repository now produces a hard `read-only-acceptance` artifact whose content-write and network prohibitions are compiled into a separate composition root. The generated artifact is an exact, bound four-file set, but the supported synthetic-vault workflow can install only the normal three-file artifact.

Manually copying the acceptance files would bypass the existing synthetic-vault path, marker, disabled-plugin, source-snapshot, and rollback protections. Extending the normal installer with a mode flag would also blur two deliberately disjoint build identities.

The next deliverable is therefore a separate, guarded path that:

1. creates and attests a fresh deterministic 5,000-note synthetic vault;
2. installs only the bound acceptance four-file artifact into that fixed vault;
3. leaves the plugin disabled and never starts Obsidian;
4. supports a human-controlled Obsidian host rehearsal; and
5. emits a separate, strictly aggregate read-only acceptance report.

This design does not install into, open, read, scan, or mutate a real vault. It does not use an endpoint, credential, model, or network request. Preparation and synthetic rehearsal do not authorize a real-vault acceptance pass.

## 2. Goals

1. Add a distinct acceptance installer with no normal/acceptance mode switch and no arbitrary artifact path.
2. Restrict installation to one fixed vault beneath the current canonical worktree: `.dev-vault/read-only-acceptance-vault`.
3. Prove that the vault content is the deterministic generated fixture rather than trusting a self-declared marker alone.
4. Publish the four acceptance files as one prepared directory, never as a transient cross-mixed file set.
5. Refuse an in-place normal-to-acceptance switch and never inherit a normal installation's `data.json`.
6. Keep Obsidian launch and plugin enablement outside the installer and under explicit human control.
7. Record only aggregate counts, timings, exact status values, and sanitized failure categories in a new ignored report.
8. Preserve the existing normal installer, normal acceptance evidence, and real-vault authorization stop gate.

## 3. Non-goals

- Do not install into, identify, or inspect any real vault.
- Do not accept `--mode`, `--artifact`, arbitrary destination arguments, relative vault paths, or an `OBSIDIAN_DEV_VAULT` override for the acceptance installer.
- Do not replace an existing plugin directory, migrate a normal installation, copy historical `data.json`, or automatically clean a retained stage, lock, backup, or quarantine object.
- Do not enable the plugin, edit `community-plugins.json`, launch Obsidian, select a vault, or restore a previous Obsidian window.
- Do not execute Quick Capture, an organization plan, Undo, History mutation/export, AI configuration, or an AI request.
- Do not overwrite `.dev-vault/acceptance.json`; that report already represents the earlier normal-mode acceptance run, including its separately authorized synthetic write/Undo pass.
- Do not publish, deploy, or install a community-plugin release.
- Do not promise zero filesystem writes. Obsidian and the acceptance plugin may write configuration, cache, and derived plugin-local `data.json`; the product promise remains zero Markdown/content writes and zero plugin-initiated network requests.

## 4. Approaches considered

### A. Separate installer plus fresh fixed synthetic vault — selected

Use a dedicated CLI whose source, target, file set, and build identity are constants. Generate a fresh deterministic vault and require the plugin target to be absent. Publish the complete staged directory in one same-filesystem rename.

This creates the narrowest authorization surface, avoids cross-mode residue, and makes the host rehearsal reproducible.

### B. Extend the normal installer with a mode flag

Share one public installer and choose three or four files at runtime. This reduces wrapper code but creates a mode-confusion boundary around source directories, manifest identity, metadata, destination residue, and success messages. It is rejected.

### C. Manually copy the four acceptance files

This is operationally simple but bypasses marker validation, deterministic fixture attestation, frozen source snapshots, disabled-state checks, rollback, and reproducible evidence. It is rejected.

## 5. Component boundary

### 5.1 Public entry points

Add explicit package scripts with no mode argument:

- `prepare:acceptance:synthetic` creates the fixed fresh synthetic vault and pre-run attestation state;
- `install:acceptance:dev` holds one artifact lease while it builds, freezes, installs the acceptance artifact, seeds fixed synthetic plugin-local host state while the plugin is disabled, and finally creates the matching receipt;
- `record:read-only-acceptance` accepts one bounded exact-schema observation object on stdin, recomputes local evidence, and creates the fixed report once; and
- `validate:read-only-acceptance` validates the independent aggregate report against the current fixed vault, installed artifact, Git state, and pre-run attestation.

The exact script names may be shortened during planning only if their distinct identities and fixed-target behavior remain unchanged. The existing `install:dev`, `build`, `build:acceptance`, and `validate:acceptance` commands retain their current meanings.

Every fresh preparation creates an opaque lowercase UUIDv4 `runId`. The preparation state, installation receipt, and final aggregate report must carry the same value. An existing state, receipt, report, target vault, preparation stage, or associated lock is a hard stop; a new run never reuses earlier evidence.

### 5.2 Shared mode-free primitives

Extract only low-level, build-mode-neutral safety operations from `scripts/install-dev.mjs` into a shared module such as `scripts/synthetic-vault-install-core.mjs`:

- canonical worktree and `.dev-vault` resolution;
- component-by-component `lstat` and symlink rejection;
- exact marker decoding;
- disabled `community-plugins.json` validation;
- frozen regular-file reads using `O_NOFOLLOW` plus identity, size, link count, and SHA-256 evidence; the existing snapshot contract must be extended to collect and require `nlink === 1`;
- directory/file identity comparison; and
- deletion of an owned object only when its recorded identity still matches.

The shared module has no CLI, build-mode parameter, artifact profile, or arbitrary target API. It cannot select normal versus acceptance behavior.

`scripts/install-dev.mjs` may import and re-export the shared marker constants so its existing API and tests remain stable. Its normal three-file transaction remains normal-specific.

### 5.3 Acceptance source contract

Expose a narrow read-only source-set loader from `scripts/acceptance-build.mjs` rather than duplicating the acceptance contract. It always reads `<repo>/dist/read-only-acceptance`, returns frozen bytes/evidence for the exact `ACCEPTANCE_FILES`, and reuses the builder contract for:

- exact four-file directory contents;
- regular non-symlink files;
- acceptance manifest identity and strict semantic version;
- the exact six-key `acceptance-build.json` schema;
- manifest, metadata, bundle, and compiled binding coherence;
- blocked content-write/network declarations; and
- forbidden Quick Capture, AI, secret-storage, `requestUrl`, WebSocket, and `fetch(` composition tokens.

The current builder tripwire covers only the existing Quick Capture, AI client, secret-storage, and `requestUrl` tokens. This phase first extends one shared builder/loader denylist to cover WebSocket and `fetch(` as well; the design does not assume those checks already exist. The same shared snapshot extension introduces the `nlink === 1` hard-link rejection for builder and install source reads.

The loader does not build, publish, accept another directory, or trust metadata without re-running the bundle tripwire.

### 5.3.1 Artifact lock lease

Refactor the builder's current private lock into one lease-scoped API such as `withAcceptanceArtifactLock(repoRoot, callback)`. Both the standalone builder and combined acceptance-install wrapper use this API. Build/source-load operations invoked inside the callback receive an opaque active lease and do not acquire the lock again; calls without the required live lease fail closed. Lock acquisition also validates the exact dist directory shape and rejects unknown lock/stage/backup/quarantine residue according to the builder's ownership rules.

This prevents a double lock while ensuring the installer holds the same artifact lock continuously across build, source snapshot, destination stage, and final publication.

### 5.4 Acceptance installer

Add a separate module such as `scripts/install-acceptance-dev.mjs`. Its public function and CLI have these constants:

- source: `<repo>/dist/read-only-acceptance`;
- target vault: `<repo>/.dev-vault/read-only-acceptance-vault`;
- target plugin directory: `<vault>/.obsidian/plugins/knowledge-workbench`;
- managed files: `main.js`, `manifest.json`, `styles.css`, and `acceptance-build.json`;
- target requirement: absent before installation.

It accepts test-only fault-injection callbacks through the imported function API, but the executable CLI accepts no positional arguments or environment path overrides.

### 5.5 Report validator

Add a separate validator for `.dev-vault/read-only-acceptance-report.json`. It decodes an exact schema, recomputes overall status, and validates current local evidence. It never reads or modifies a real vault and never emits note-level data.

### 5.6 Synthetic plugin-local host state

The combined installer creates one fixed, separately attested `data.json` only after the exact four managed artifact files have been published and verified while the plugin remains disabled. This is not inherited normal data. A new production-neutral pure `.mjs` fixture module exports the exact object, canonical bytes, and strict validator used by the installer. A TypeScript compatibility test feeds those bytes through the real `PluginDataStore` decoder and then the real `OperationJournal.list()`/`get()` validation path, asserting exactly one usable `completed` entry and no recovery state. The design does not assume a currently exported encoder seam. The fixture contains:

- historical `writeEnabled: true` with `writePreviewAcknowledged: true`, so host startup must durably normalize an actually enabled write state;
- `aiEnabled: false` with empty endpoint, model, and secret ID, so the host seed contains no endpoint/model/secret data;
- one completed journal entry that refers only to fixed generated fixture paths, so History renders the controls that acceptance mode must disable;
- no recovery-required state;
- no endpoint, model, secret identifier/value, real path, real title/content, or free text from outside the fixed generator; and
- only schema-valid plugin-local fields needed to render the intended host checks.

The installer writes this file with exclusive no-follow semantics, verifies its exact schema and frozen digest, and includes that digest only in the ignored installation receipt. Failure to seed or validate it rolls back the just-published target only if the entire target still matches the installer-owned snapshot.

Historical valid `aiEnabled: true` normalization, recovery-detail direct-call blocking, AI-client/secret callback absence, and controller/port bypasses that cannot be safely represented through this endpoint-free, non-recovery host seed remain automated-only checks. Those AI tests may use an in-memory reserved `.invalid` synthetic endpoint and model but never persist them, construct a client, or make a request. The final recorder reruns the fixed same-commit automated safety suite before it can derive a passed report; the report does not pretend those sub-checks were exercised manually.

## 6. Deterministic synthetic vault

### 6.1 Fresh fixed destination

Preparation uses only:

`<canonical-worktree>/.dev-vault/read-only-acceptance-vault`

The vault path, plugin target, pre-run state, installation receipt, final report, or preparation stage already existing is a hard stop. Preparation never deletes or refreshes an existing directory. A retry after retained state requires a separate, deliberate diagnostic and cleanup step.

### 6.2 Fixture contract

Move or expose the existing seeded fixture generator through a production-neutral pure module so performance tests and the on-disk synthetic preparation use one algorithm. The acceptance fixture is fixed to:

- 5,000 Markdown notes;
- seed `13`;
- at least 75 MiB of deterministic Markdown;
- generated relative paths under one allowlisted content directory;
- the existing deterministic bilingual headings, synthetic tags, links, malformed-frontmatter cases, and padding rules; and
- no real-vault input, copied note, template, endpoint, secret, or environment-derived content.

Preparation writes only generated fixture files, the exact synthetic marker, and minimal `.obsidian` configuration with an empty `community-plugins.json` plus an empty, non-symlink `.obsidian/plugins/` directory. Preparation records and attests that plugins-parent identity so the installer never has to create an unowned destination parent. It does not copy the current `.dev-vault/acceptance-vault` because that vault contains historical host state and a normal installation.

### 6.3 Attestation

The marker remains necessary but is not sufficient. Before installation and before/after host rehearsal, attestation must verify:

- exactly 5,000 Markdown files;
- every relative path and byte sequence matches a fresh in-memory generation with the fixed contract;
- no additional user-content file exists outside the explicit configuration/state allowlist;
- no symlink, hard link, FIFO, socket, device, or other special file appears in user content;
- all traversed directories are regular non-symlink directories; and
- aggregate note count, total bytes, and one canonical corpus digest match the pre-run state.

The ignored pre-run state has the fixed location `.dev-vault/read-only-acceptance-state.json` and is created once through an exclusive same-directory stage plus atomic rename. It uses exactly these keys and no others:

```json
{
  "schemaVersion": 1,
  "scope": "dedicated-synthetic-vault",
  "contentPolicy": "deterministic-synthetic-notes-only",
  "runId": "00000000-0000-4000-8000-000000000000",
  "commit": "0000000000000000000000000000000000000000",
  "syntheticNoteCount": 5000,
  "syntheticTotalBytes": 78643200,
  "corpusDigest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
}
```

`runId` is a lowercase canonical UUIDv4 and `commit` is the exact 40- or 64-hex current Git object ID. Count and bytes are non-negative safe integers and must equal the fixed fixture contract. The digest uses SHA-256 over this unambiguous byte stream:

1. ASCII domain prefix `knowledge-workbench-synthetic-corpus-v1\0`;
2. every `Generated/**` Markdown entry ordered by unsigned lexicographic comparison of its UTF-8 path bytes;
3. for each entry, an unsigned 64-bit big-endian path-byte length, the UTF-8 path bytes, an unsigned 64-bit big-endian content-byte length, and the exact content bytes.

Only `Generated/**` participates in the corpus digest. The marker is validated separately, and `.obsidian/**` is configuration/plugin-local state rather than user content. At preparation time `.obsidian` must match the minimal prepared allowlist; after host launch its contents may evolve, but the marker, community-plugin isolation, installed artifact, and relevant plugin-local safety state remain separately validated. Any top-level entry other than `Generated`, `.obsidian`, and the exact marker is forbidden.

The state bytes are exactly `JSON.stringify(state, null, 2) + "\n"` with keys inserted in the displayed order. The receipt and final report use the same displayed-key-order, two-space, final-newline encoding before their own atomic publication.

The pre-run state must not store an artifact digest, note paths, titles, contents, frontmatter, or per-note hashes. The installed artifact is revalidated directly, while the public aggregate report stores only the resulting status and never the corpus digest.

### 6.4 Preparation transaction

Preparation requires a clean canonical Git worktree whose `HEAD` becomes the state commit. Its `.dev-vault` parent must already exist as a non-symlink directory and preparation snapshots that identity. It acquires an exclusive `.read-only-acceptance-prepare.lock` before checking for any prior run object. The lock is cooperative, identity-checked, never age-stolen, and held through final publication and cleanup.

The generator creates a random exclusive `0700` sibling stage beneath `.dev-vault`. Every directory and file is created without following links; every file uses exclusive creation. The stage contains the full generated corpus, exact marker, minimal `.obsidian` configuration, and empty `.obsidian/plugins/`. After every preparation hook and before each publication rename, preparation revalidates clean Git state, exact `HEAD === state.commit`, the `.dev-vault` parent identity, stage identity, generated bytes, exact allowlists, special-file absence, and full corpus attestation.

The pre-run state is encoded and staged separately beside its fixed destination. After both snapshots pass, preparation publishes the vault with one same-filesystem directory rename and then publishes the state with one file rename while still holding the lock. It records and revalidates the published state identity and exact bytes as well as the published vault tree.

If state publication or final verification fails, no rollback begins unless both published objects still match the owned snapshots. It first removes the exact state file by recorded identity, then removes the vault only through the captured complete tree manifest: bottom-up `lstat` must match every recorded file/directory identity and type before the implementation unlinks each regular file and removes each now-empty directory. The first missing, replaced, linked, special, or unknown state/tree entry stops cleanup, retains every object not already safely removed, and returns `cleanup-incomplete`. It never leaves a known owned state file behind while claiming rollback succeeded, calls an unguarded recursive delete, or writes outside the canonical parent.

The hostile same-UID final-check/rename limitation applies to preparation as well as installation and is disclosed in section 14.

## 7. Build and installation data flow

### 7.1 Preconditions and lock ordering

Formal installation requires a canonical Git worktree with no tracked, staged, or non-ignored untracked changes. The current `HEAD` must equal the commit in the immutable pre-run state, and the pre-run `runId` must not already have an installation receipt or report.

`install:acceptance:dev` is one Node orchestration wrapper, not a shell chain of the existing build CLI and installer CLI. It acquires the shared artifact lease before the clean-HEAD/state check, then holds that same lease continuously while it invokes the acceptance builder, freezes the four files, performs the destination transaction, seeds synthetic plugin-local state, and creates the installation receipt. No build-to-install handoff occurs outside the lease. The only executable boundary maps every escaping error to one sanitized category and never prints a nested builder error or absolute source path.

The lower-level install function requires both the live opaque lease and the exact run context derived from the pre-run state. It cannot install a previously built same-version artifact without the combined wrapper rebuilding and freezing it under the current lease.

The installer acquires locks in one fixed order:

1. the acceptance artifact/build lock shared with the builder; then
2. a destination installer lock beneath the fixed synthetic vault's plugins parent.

Locks are exclusive, cooperative, identity-checked objects. They are never auto-stolen based on age. Builder stage/backup/quarantine residue or installer stage/backup/quarantine residue causes an immediate stop rather than cleanup.

### 7.2 Source preflight

While holding the artifact lock, the installer:

1. resolves the worktree and fixed source directory canonically;
2. rejects symlinks and special files in every source component;
3. requires the exact four names and no fifth entry;
4. opens each source with `O_NOFOLLOW` and records `dev`, `ino`, `nlink`, size, and SHA-256 over frozen bytes;
5. validates manifest/metadata/bundle identity using the acceptance builder contract; and
6. retains the frozen bytes for staging instead of reopening or copying by source path.

### 7.3 Destination preflight

While holding the destination lock, the installer:

1. re-runs deterministic fixture attestation;
2. validates the exact marker;
3. validates `.obsidian` and `plugins` directory identities component by component;
4. requires `community-plugins.json` to be a regular non-symlink JSON string array that does not contain `knowledge-workbench` and records its identity/hash;
5. requires the target plugin directory to be absent; and
6. rejects any active/retained preparation lock or stage and all unknown installer residue.

The installer never creates, repairs, appends to, or rewrites `community-plugins.json`.

### 7.4 Stage and publication

The installer creates a random exclusive stage beside the target on the same filesystem, with directory mode `0700`. It writes the exact four frozen source byte arrays into exclusive regular files, then verifies:

- exact names and no extra entry;
- file identities, bytes, and hashes;
- manifest/metadata/bundle binding; and
- stage directory identity.

After every test hook, after build inputs/source bytes are frozen, immediately before target publication, before synthetic `data.json` creation, and immediately before receipt publication, it revalidates the clean Git index/worktree and exact `HEAD === state.commit` in addition to both locks, source snapshots, fixture attestation, vault/config/plugins identities, the unchanged disabled community manifest, target/receipt expectations, and the complete owned snapshots.

Publication is one same-filesystem directory `rename(stage, target)`. The installer never replaces the four files individually and never copies a prior `data.json`.

After publication it verifies the target directory identity, exact four managed artifact files, source-byte equality, binding, and unchanged `community-plugins.json`. While the plugin is still disabled and under the same locks, it then exclusively creates and validates the fixed synthetic `data.json` from section 5.6. The final target allowlist is the exact four managed artifacts plus this one attested synthetic plugin-local state file.

Success is not reported until the installation receipt below is published and all owned residue is absent. Output is a fixed sanitized sentence; it contains no absolute path and does not claim that Obsidian will remain disabled forever.

### 7.5 Installation receipt and artifact-set digest

After target and seed verification, the installer atomically creates the ignored fixed file `.dev-vault/read-only-acceptance-receipt.json` with exactly these keys:

```json
{
  "schemaVersion": 1,
  "runId": "00000000-0000-4000-8000-000000000000",
  "commit": "0000000000000000000000000000000000000000",
  "pluginVersion": "0.1.0",
  "artifactBinding": "knowledge-workbench@0.1.0:read-only-acceptance",
  "artifactSetDigest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "fixtureStateDigest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "seedDataDigest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
}
```

`runId` and commit must match the pre-run state. `fixtureStateDigest` is SHA-256 over the exact canonical state-file bytes, including its final newline. `seedDataDigest` is SHA-256 over the exact seeded `data.json` bytes before host startup.

`artifactSetDigest` uses SHA-256 with ASCII domain prefix `knowledge-workbench-acceptance-artifact-set-v1\0`, followed by the four managed files ordered by unsigned UTF-8 filename bytes. Each file contributes unsigned 64-bit big-endian filename length, filename bytes, unsigned 64-bit big-endian content length, and exact content bytes.

The report exposes only the opaque `runId`; all digests remain in this ignored local receipt. The recorder and validator recompute the current managed artifact-set digest and state digest, require the same run, and reject stale same-version artifacts or evidence from another preparation.

### 7.6 Failure and rollback

- Before publication, failure leaves the target absent and removes only the stage/lock objects whose identities still match the installer records.
- If post-publication verification, synthetic seeding, or receipt publication fails, the installer may remove the target only when the directory and complete four-file-plus-seed snapshot still exactly match what it owns.
- If any owned object has been replaced, becomes a symlink/special file, or contains an unknown entry, cleanup stops and returns `rollback-incomplete` or `cleanup-incomplete`.
- The installer never recursively deletes an unknown object, follows a replaced directory, retries automatically, starts Obsidian, or claims the vault is ready after incomplete cleanup.
- Retained state requires a separate diagnostic/cleanup decision.

The artifact identity remains exactly four managed files. The installed target presented to the host contains those four files plus the one disclosed synthetic `data.json`; later host changes to `data.json` are plugin-local derived state and never alter the four-file artifact identity.

## 8. Cross-mode protections

The normal and acceptance public entry points remain disjoint.

- `install:dev` continues to source only the normal root `main.js`, `manifest.json`, and `styles.css`.
- The normal installer must reject a destination containing `acceptance-build.json` before any mutation. It must not silently overwrite three files and leave stale acceptance metadata.
- The acceptance installer requires an absent target and therefore cannot overwrite a normal installation.
- Neither installer exposes a mode flag, arbitrary artifact directory, or repair-one-file path.
- Returning to normal mode uses another fresh dedicated synthetic vault or a separately designed/authorized switch workflow; it is not part of this task.

## 9. Human-controlled Obsidian host rehearsal

Installation completion is not host-rehearsal completion. Before launch, a human must:

1. fully quit Obsidian and confirm no real-vault window remains open;
2. re-run fixture, artifact, target, and disabled-state preflight;
3. ensure no other community plugin is enabled and Obsidian Sync or another external mutator is not active for the fixed synthetic vault; and
4. validate the existing, preparation-created pre-run aggregate corpus attestation state without overwriting or refreshing it.

The vault is opened only through Obsidian's vault switcher by selecting the entry whose locally displayed canonical path is exactly `<canonical-worktree>/.dev-vault/read-only-acceptance-vault`; matching the vault name alone is insufficient. A duplicate name, hidden/ambiguous path, or inability to confirm the exact canonical path prevents plugin enablement and makes `hostIsolation` inconclusive. A bare application launch that may restore another vault is forbidden. The plugin is enabled manually only after the fixed canonical vault is visibly active. The exact path is checked again after restart but is never copied into the aggregate report.

The rehearsal then verifies, in order:

1. the manifest name and persistent read-only banner;
2. successful startup normalization before host surfaces become available;
3. disabled/unavailable Quick Capture, plan confirmation, Undo, History clear/export, write settings, AI settings, secret input, and AI actions against the seeded visible History state; automated same-commit checks cover recovery-detail and direct-call paths that the safe host seed intentionally does not create;
4. usable read-only scan, Today, search, map, folder-rule review, and non-confirming suggestion preview;
5. restart and restoration of the derived local index;
6. absence of `Recovery required`;
7. unchanged pre/post Markdown paths, counts, and bytes through aggregate corpus comparison; and
8. no unexpected plugin-initiated network activity.

The static acceptance-bundle dependency/tripwire scan is the primary network-boundary evidence. Host network observation is supplementary. If an observed request cannot be confidently attributed or excluded, the result is `inconclusive`, never guessed as passed.

On both success and failure, the evidence window ends only after the plugin is manually disabled and Obsidian is fully quit. The fixed vault path, final empty community-plugin list, managed artifact digest, installation receipt, normalized plugin-local safety settings, and post-run corpus attestation are then revalidated before the reporter may run. If full host stop cannot be confirmed, the result is `inconclusive`.

Any content drift, exposed blocked action, artifact/binding/normalization failure, unexplained network activity, or recovery state triggers the pre-agreed emergency action: disable the plugin, fully quit Obsidian, and stop. The rehearsal does not auto-repair, switch builds, inspect private content, or clean retained state.

## 10. Aggregate report

### 10.1 Separate file and exact schema

Write only to the ignored file:

`.dev-vault/read-only-acceptance-report.json`

It does not replace or reinterpret `.dev-vault/acceptance.json`.

The report uses an exact-key object equivalent to:

```json
{
  "schemaVersion": 1,
  "scope": "dedicated-synthetic-vault",
  "contentPolicy": "deterministic-synthetic-notes-only",
  "buildMode": "read-only-acceptance",
  "status": "passed",
  "recordedAt": "2026-07-14T00:00:00.000Z",
  "runId": "00000000-0000-4000-8000-000000000000",
  "commit": "0000000000000000000000000000000000000000",
  "pluginVersion": "0.1.0",
  "obsidianVersion": "1.12.7",
  "artifactBinding": "knowledge-workbench@0.1.0:read-only-acceptance",
  "syntheticNoteCount": 5000,
  "scanElapsedMs": 1,
  "restartRestoreElapsedMs": 1,
  "artifactIdentity": "passed",
  "fixtureIdentity": "passed",
  "automatedSafety": "passed",
  "hostIsolation": "passed",
  "banner": "passed",
  "startupNormalization": "passed",
  "quickCaptureBlocked": "passed",
  "organizationWritesBlocked": "passed",
  "undoBlocked": "passed",
  "historySensitiveActionsBlocked": "passed",
  "aiBlocked": "passed",
  "readSurfaces": "passed",
  "restartRestore": "passed",
  "contentUnchanged": "passed",
  "networkBoundary": "passed",
  "recoveryAbsent": "passed",
  "finalHostStopped": "passed",
  "failureCategories": []
}
```

Absence of the report represents the pending phase. A persisted report is terminal: its overall and gate status fields accept only `passed`, `failed`, or `inconclusive`. `failureCategories` is an array of at most nine unique strings using exactly this allowlist: `artifact`, `fixture`, `startup`, `host-isolation`, `ui-capability`, `content-drift`, `network`, `recovery`, and `timing`.

All constants must match exactly. `recordedAt` is at most 32 characters and must equal `new Date(value).toISOString()`. `runId` is the lowercase canonical UUIDv4 from both pre-run state and receipt. `commit` is lowercase 40- or 64-hex and must equal current `HEAD`, the state, and the receipt. `pluginVersion` uses the shared strict bounded SemVer decoder; `obsidianVersion` is at most 40 characters and matches `^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9A-Za-z.-]{1,16})?$`. `artifactBinding` is derived exactly from the validated manifest version and receipt. Counts are non-negative safe integers. Timings are finite numbers from `0` through the safety input bound `3_600_000`; the acceptance threshold for each timing remains `30_000`.

The aggregate gate names have exact sub-checks:

- `artifactIdentity`: installed manifest, metadata, four-file set, bundle tripwire, and compiled binding all match.
- `fixtureIdentity`: marker, fixed generator contract, count, total bytes, allowed top-level entries, and pre-run corpus digest all match before host launch.
- `automatedSafety`: the fixed same-commit acceptance controller/composition/artifact safety suite rerun by the recorder passes, including direct controller/service/port bypass, recovery-detail, secret retention, client construction, and network-capable callback paths.
- `hostIsolation`: the canonical fixed synthetic vault path is the selected host vault, no real-vault window is active, no other community plugin is enabled, and Sync/external mutators are inactive.
- `banner`: the acceptance display name and persistent non-color-only read-only banner are visible.
- `startupNormalization`: the human-observed startup completes before surfaces appear and the recorder independently confirms the seeded enabled write state became false while endpoint-free AI state remains false; the worse result wins. Historical enabled-AI normalization is covered by `automatedSafety` only.
- `quickCaptureBlocked`: the host UI action is disabled/unavailable; direct bypass belongs to `automatedSafety`.
- `organizationWritesBlocked`: host plan confirmation/execution, sample unlock, and write toggle are unavailable while non-confirming preview remains usable; direct bypass belongs to `automatedSafety`.
- `undoBlocked`: the seeded-history host Undo action is disabled/unavailable; direct execution belongs to `automatedSafety`.
- `historySensitiveActionsBlocked`: seeded History is aggregate-only and its host clear/export/path-bearing controls are disabled/unavailable; recovery-detail and direct-call paths belong to `automatedSafety`.
- `aiBlocked`: host endpoint/model/secret inputs and AI actions are absent/unavailable; secret retention, client construction, and callback paths belong to `automatedSafety`.
- `readSurfaces`: scan, Today, search, map, folder-rule review, and non-confirming suggestion preview all work.
- `restartRestore`: restart completes and the derived index restores.
- `contentUnchanged`: post-run `Generated/**` count, bytes, paths, and canonical corpus digest equal pre-run state.
- `networkBoundary`: the shared static bundle scan passes and host observation has no unexplained plugin-initiated traffic.
- `recoveryAbsent`: `Recovery required` never appears.
- `finalHostStopped`: the plugin is disabled, Obsidian is fully quit, the final community-plugin list is empty, and only then are receipt/artifact/settings/corpus checks performed.

Every aggregate gate is `passed` only when all of its sub-checks pass. A definite failed sub-check makes the gate `failed`; inability to complete or attribute any sub-check makes it `inconclusive`.

Recorder composition is deterministic. Human input supplies only host-observation statuses. The recorder derives `artifactIdentity`, `fixtureIdentity`, `automatedSafety`, and `contentUnchanged`; it also performs local checks for `startupNormalization`, `hostIsolation`, and `finalHostStopped`. When a final gate combines host and derived evidence, status precedence within that gate is `failed`, then `inconclusive`, then `passed`.

Timing is folded into the related final gate before overall status is computed. `scanElapsedMs === 0` makes `readSurfaces` inconclusive; `scanElapsedMs > 30_000` makes it failed; otherwise it does not downgrade the host result. `restartRestoreElapsedMs` applies identically to `restartRestore`. Values above the safety input bound are rejected as malformed rather than reported. Thus every accepted terminal report has one unambiguous final gate status for timing as well as behavior.

### 10.2 Computed status and privacy

The validator does not trust the supplied overall `status`. It recomputes the expected value and rejects a mismatch. `passed` requires:

- the exact current clean commit and bound installed artifact;
- exact deterministic fixture identity and count `5000`;
- `scanElapsedMs` and `restartRestoreElapsedMs` that are greater than `0` but no greater than the `30_000` acceptance threshold;
- every required status field equal to `passed`;
- an empty failure-category array; and
- matching pre/post aggregate corpus attestation.

Computed status uses fixed precedence: any failed final gate produces `failed`; otherwise any inconclusive final gate produces `inconclusive`; otherwise every final gate is passed and the status is `passed`. `failureCategories` is derived by the recorder from the completed final gates and timing outcomes; human input cannot supply or override it. A passed report has an empty array. A failed or inconclusive report contains the unique mapped categories: `artifactIdentity` → `artifact`; `fixtureIdentity` → `fixture`; `automatedSafety` or any blocked-capability/read-surface gate → `ui-capability`; `hostIsolation` or `finalHostStopped` → `host-isolation`; `banner`, `startupNormalization`, or `restartRestore` → `startup`; `contentUnchanged` → `content-drift`; `networkBoundary` → `network`; `recoveryAbsent` → `recovery`; and a zero or over-threshold timing → `timing`.

The report forbids vault paths, relative note paths, file names, titles, bodies, frontmatter, search terms, screenshots, DOM dumps, raw console/network logs, endpoint/model/secret identifiers or values, plugin data, journal payloads, hashes, raw errors, and arbitrary free text. Unknown keys, invalid prototypes/types, non-finite numbers, unbounded strings, duplicate categories, or path-like/category-like injection are rejected.

Report publication uses an exclusive same-directory stage, exact schema revalidation, identity/hash checks, and an atomic rename. The reporter assembles the final result in memory and creates the report once after the rehearsal or stop condition; an existing report is a hard stop and is not overwritten automatically.

### 10.3 Recorder input

`record:read-only-acceptance` reads exactly one bounded JSON object from stdin with these human observations and no other keys:

- canonical `recordedAt` and bounded `obsidianVersion`;
- `scanElapsedMs` and `restartRestoreElapsedMs`;
- terminal `passed`, `failed`, or `inconclusive` host observations for `hostIsolation`, `banner`, `startupNormalization`, `quickCaptureBlocked`, `organizationWritesBlocked`, `undoBlocked`, `historySensitiveActionsBlocked`, `aiBlocked`, `readSurfaces`, `restartRestore`, `networkBoundary`, `recoveryAbsent`, and `finalHostStopped`.

It does not accept `status`, run ID, commit, plugin version, binding, note count, artifact identity, fixture identity, automated-safety status, content-unchanged claims, or failure categories from stdin. Those fields are derived from the current clean Git state, matching state/receipt, installed four-file set, fixed automated safety rerun, normalized synthetic plugin data, fresh post-run corpus attestation, and the final composed gate statuses. It reads at most 8 KiB from stdin, never accepts a file path or free-text field, never echoes the submitted JSON, computes the complete report, validates it, and creates the fixed report once. The separate validator later re-runs the same derivations against the saved report.

## 11. Error handling and user-visible output

Errors are fail-closed and use bounded category plus fixed explanation. CLI stdout/stderr must not include the absolute repository/vault path, note identifiers, source excerpts, raw JSON, secrets, or raw nested error messages.

Important categories include:

- `artifact-invalid` or `artifact-changed`;
- `fixture-invalid` or `fixture-changed`;
- `plugin-enabled`;
- `target-exists`;
- `concurrent-operation`;
- `rollback-incomplete`;
- `cleanup-incomplete`; and
- `report-invalid`.

Tests may inspect full internal causes, but the executable CLI surfaces only sanitized messages. A failure never grants permission to broaden the path, bypass a check, clean an unknown object, or use a real vault.

## 12. Testing strategy

Implementation follows RED/GREEN TDD with focused commits.

### 12.1 Fixture and path tests

- Reject arguments, environment path overrides, relative/external destinations, `.dev-vault` itself, a different child vault, and case/symlink path escapes.
- Reject an existing fixed vault instead of deleting it during preparation.
- Serialize preparation with its dedicated lock; reject old state/receipt/report/target/residue and prove a replaced `.dev-vault` parent or stage produces safe failure.
- Inject faults before and after each of the vault/state publication renames; prove only exact owned objects are removed and unknown replacements produce `cleanup-incomplete`.
- Reject a correct marker with one added, missing, renamed, or byte-changed generated note.
- Reject additional Markdown or other user-content files.
- Reject symlinks, multiply linked files, FIFO/socket objects, and replaced directory components; cover device-node branches through injected stat/fake evidence rather than requiring privileged `mknod` in portable CI.
- Prove fixed-seed generation is byte-for-byte deterministic and matches the performance fixture contract.

### 12.2 Artifact tests

- Install the exact four bound acceptance files from the fixed source.
- Reject a missing/fifth file, symlink/hard link/special file, normal manifest, bad name/version/binding, malformed or extra metadata key, and blocked-capability token in the bundle.
- Prove the source loader revalidates after same-inode/same-size content changes and directory swaps.
- Prove the normal root artifacts remain untouched.

### 12.3 Destination, concurrency, and rollback tests

- Reject malformed, enabled, symlinked, or concurrently replaced `community-plugins.json` without modifying it.
- Reject an existing target, including a normal installation or partial acceptance set.
- Reject builder locks and every owned/unknown stage, backup, quarantine, or installer-lock residue.
- Serialize a cooperative builder and installer by the shared artifact lock.
- Allow only one of two concurrent acceptance installers to acquire the destination lock.
- Revalidate after each injected hook and immediately before publication.
- Inject concurrent `HEAD`, index, tracked-worktree, and non-ignored-untracked changes after build freeze and before target/receipt publication; every case must stop without a successful receipt.
- Prove every pre-publication fault leaves the target absent.
- Prove post-publication validation failure removes only an exact owned target.
- Prove target/stage replacement or added unknown entries cause retained-state plus incomplete rollback/cleanup rather than recursive deletion.
- Prove the continuous artifact lease binds clean `HEAD`, pre-run `runId`, build, frozen source, installed four-file digest, synthetic `data.json`, and one-time receipt with no unprotected handoff.
- Prove stale same-version output, mismatched state/receipt run IDs, replayed receipt, altered seed data, receipt-publication failure, and old final report all fail closed.
- Prove success leaves the exact four managed files plus the one attested synthetic `data.json`, one matching ignored receipt, no owned residue, and unchanged `community-plugins.json`.

### 12.4 Cross-mode regression tests

- Keep all existing normal installer tests passing.
- Prove `install:dev` still sources only the normal three root files.
- Prove normal installation refuses any destination `acceptance-build.json` before mutation.
- Prove neither executable accepts a mode switch or custom artifact directory.

### 12.5 Report tests

- Treat report absence as pending; accept exact failed, inconclusive, and passed terminal forms only when computed status and required category mappings agree.
- Reject `passed` for any failed or inconclusive gate, non-positive/bad timing, wrong run ID/commit, tracked/staged/non-ignored-untracked changes, wrong binding, changed state/receipt/artifact/seed/fixture, failed automated safety rerun, missing final host stop, or non-empty failure categories.
- Reject every extra/missing key, unbounded value, `NaN`/infinity, duplicate category, path/title/content/endpoint/secret/journal/raw-error injection, and report overwrite.
- Prove a bounded stdin observation is the only human input, derived fields cannot be supplied, and report output exposes the run ID but none of the local digests.
- Prove output contains no absolute path or note-level data.

### 12.6 Verification order

Run focused fixture, installer, builder, normal-installer regression, report, safety-policy, composition, UI, and offline tests. Then run:

- ESLint;
- TypeScript;
- the full Vitest suite;
- the normal production build;
- the acceptance build and bundle denylist scan;
- the fixed-vault preparation/attestation;
- the acceptance installation into that fresh fixed vault; and
- Graphify refresh after documentation changes.

The formal host-rehearsal report is created only after the human-controlled Obsidian steps or a stop condition. Automated implementation can be complete while the report does not yet exist and the phase remains pending; no pending report is written early. This phase's product acceptance is not complete until the independent report exists and validates as `passed`.

## 13. Acceptance criteria

This phase is complete when:

1. the normal and acceptance installers remain distinct public entry points with no mode flag;
2. the fresh fixed vault and pre-run state are transactionally published and contain exactly one run ID plus the attested 5,000-note deterministic fixture;
3. under one continuous artifact lease, the acceptance installer publishes the exact bound four managed files, seeds one attested synthetic `data.json`, and creates the matching one-time receipt while the plugin remains disabled;
4. all automated safety, rollback, privacy, regression, and full verification gates pass;
5. the human-controlled host rehearsal confirms the acceptance UI/read paths and blocked capabilities, then disables the plugin and fully quits Obsidian on both success and failure;
6. final artifact/settings/host-isolation checks pass and pre/post Markdown corpus attestation is identical;
7. the one-time `.dev-vault/read-only-acceptance-report.json` carries the matching run ID and validates as `passed` without local digests, note-level data, or private data;
8. `.dev-vault/acceptance.json` remains unchanged;
9. the Git worktree and Graphify graph are current; and
10. no real vault, endpoint, credential, publication, or deployment has been used.

## 14. Explicit limitations

The preparation, artifact, and destination locks serialize cooperating generators/builders/installers. Portable Node.js directory `rename` does not provide a strong hostile same-UID no-clobber guarantee between the final validation and publication. Post-publication identity checks, run-bound receipts, exact-snapshot rollback, and refusal to delete unknown objects limit the damage and expose interference, but the implementation and report must not claim a stronger guarantee.

The installer also cannot reliably prove that every Obsidian process/window is fully closed or that no unrelated host-level network process exists. Those remain explicit human preflight and observation gates; uncertainty produces `inconclusive`, not `passed`.
