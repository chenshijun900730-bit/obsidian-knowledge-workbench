import { describe, expect, it } from "vitest";
import { AiClientError } from "../../src/ai/ai-enhancement-service";
import { FakeAiClient } from "../fakes/fake-ai-client";
import { aiControllerFixture, aiRecord, DeferredAiClient, mismatchReadPort } from "../helpers/ai-fixtures";
import { manualProjectionScheduler } from "../helpers/ui-fixtures";

const paths = (...values: string[]) => values;

describe("optional AI stays downstream and offline by default", () => {
  it("does nothing at every sensitive boundary while disabled", async () => {
    const fixture = aiControllerFixture({ aiEnabled: false });
    const result = await fixture.controller.summarize(paths("Notes/Alpha.md"));
    expect(result).toEqual({ kind: "local-fallback", reason: "disabled" });
    expect(fixture.aiPreview.calls).toHaveLength(0);
    expect(fixture.vault.readCounts.size).toBe(0);
    expect(fixture.ai.secretCalls).toHaveLength(0);
    expect(fixture.ai.clientCalls).toHaveLength(0);
  });

  it.each([
    { name: "empty", selection: [] },
    { name: "duplicate", selection: ["Notes/Alpha.md", "Notes/Alpha.md"] },
    { name: "not indexed", selection: ["Missing.md"] },
    { name: "not Markdown", selection: ["Notes/Alpha.txt"] },
  ])("rejects $name selection before preview, read, secret, or client", async ({ selection }) => {
    const fixture = aiControllerFixture();
    await expect(fixture.controller.summarize(selection)).resolves.toMatchObject({ kind: "local-fallback" });
    expect(fixture.aiPreview.calls).toHaveLength(0);
    expect(fixture.vault.readCounts.size).toBe(0);
    expect(fixture.ai.secretCalls).toHaveLength(0);
    expect(fixture.ai.clientCalls).toHaveLength(0);
  });

  it("rejects invalid configuration and disposed state before every sensitive boundary", async () => {
    const invalid = aiControllerFixture({ aiEndpoint: "http://example.test/v1" });
    await expect(invalid.controller.summarize(paths("Notes/Alpha.md")))
      .resolves.toEqual({ kind: "local-fallback", reason: "invalid-configuration" });
    expect(invalid.aiPreview.calls).toHaveLength(0);
    expect(invalid.vault.readCounts.size).toBe(0);
    expect(invalid.ai.secretCalls).toHaveLength(0);
    expect(invalid.ai.clientCalls).toHaveLength(0);

    const disposed = aiControllerFixture();
    disposed.controller.dispose();
    await expect(disposed.controller.summarize(paths("Notes/Alpha.md")))
      .resolves.toEqual({ kind: "local-fallback", reason: "action-invalidated" });
    expect(disposed.aiPreview.calls).toHaveLength(0);
    expect(disposed.vault.readCounts.size).toBe(0);
    expect(disposed.ai.secretCalls).toHaveLength(0);
    expect(disposed.ai.clientCalls).toHaveLength(0);
  });

  it("allows exactly 20 indexed notes", async () => {
    const client = new FakeAiClient([{ text: "twenty accepted" }]);
    const fixture = aiControllerFixture({ recordCount: 20, aiClient: client });
    const selection = Array.from({ length: 20 }, (_, index) => `AI/Note-${index}.md`);
    await expect(fixture.controller.summarize(selection)).resolves.toEqual({ kind: "ok", value: "twenty accepted" });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.notes).toHaveLength(20);
  });

  it("allows exactly 100000 frontmatter-free characters and transmits no frontmatter", async () => {
    const client = new FakeAiClient([{ text: "limit accepted" }]);
    const fixture = aiControllerFixture({ recordCount: 1, recordSize: 100_000, aiClient: client });
    fixture.vault.modifyExternally("AI/Note-0.md", `---\nprivate: must-not-send\n---\n${"x".repeat(100_000)}`);
    await expect(fixture.controller.summarize(paths("AI/Note-0.md")))
      .resolves.toEqual({ kind: "ok", value: "limit accepted" });
    expect(client.calls[0]?.notes[0]?.content).toHaveLength(100_000);
    expect(JSON.stringify(client.calls)).not.toContain("must-not-send");
  });

  it("strips BOM-prefixed YAML frontmatter before constructing the request", async () => {
    const client = new FakeAiClient([{ text: "BOM accepted" }]);
    const fixture = aiControllerFixture({ recordCount: 1, aiClient: client });
    fixture.vault.modifyExternally("AI/Note-0.md", "\uFEFF---\nprivate: bom-secret-value\n---\nVisible body");
    await expect(fixture.controller.summarize(paths("AI/Note-0.md")))
      .resolves.toEqual({ kind: "ok", value: "BOM accepted" });
    expect(client.calls[0]?.notes[0]?.content).toBe("Visible body");
    expect(JSON.stringify(client.calls)).not.toContain("bom-secret-value");
  });

  it.each(["---\n---\nVisible", "\uFEFF---\n---\nVisible"])(
    "strips an empty initial frontmatter block from %j",
    async (content) => {
      const client = new FakeAiClient([{ text: "empty frontmatter accepted" }]);
      const fixture = aiControllerFixture({ recordCount: 1, aiClient: client });
      fixture.vault.modifyExternally("AI/Note-0.md", content);
      await expect(fixture.controller.summarize(paths("AI/Note-0.md")))
        .resolves.toEqual({ kind: "ok", value: "empty frontmatter accepted" });
      expect(client.calls[0]?.notes[0]?.content).toBe("Visible");
    },
  );

  it("resolves an exact current document ID to its canonical path", async () => {
    const fixture = aiControllerFixture({ aiPreviewResult: false });
    await expect(fixture.controller.summarize(["a"]))
      .resolves.toEqual({ kind: "local-fallback", reason: "cancelled" });
    expect(fixture.aiPreview.calls[0]?.paths).toEqual(["Notes/Alpha.md"]);
    expect(fixture.vault.readCounts.size).toBe(0);
  });

  it.each([
    {
      name: "path and ID ambiguity",
      records: [
        aiRecord(0, 10, { id: "Collision.md", path: "Other.md" }),
        aiRecord(1, 10, { id: "second", path: "Collision.md" }),
      ],
      selection: ["Collision.md"],
    },
    {
      name: "ID and path duplicate",
      records: undefined,
      selection: ["a", "Notes/Alpha.md"],
    },
  ])("fails closed for $name before preview", async ({ records, selection }) => {
    const fixture = aiControllerFixture(records === undefined ? {} : { records });
    await expect(fixture.controller.summarize(selection))
      .resolves.toEqual({ kind: "local-fallback", reason: "invalid-selection" });
    expect(fixture.aiPreview.calls).toHaveLength(0);
    expect(fixture.vault.readCounts.size).toBe(0);
    expect(fixture.ai.secretCalls).toHaveLength(0);
    expect(fixture.ai.clientCalls).toHaveLength(0);
  });

  it.each([
    {
      name: "duplicate record path selected through a unique ID",
      records: [
        aiRecord(0, 10, { id: "unique-a", path: "Duplicate.md" }),
        aiRecord(1, 10, { id: "unique-b", path: "Duplicate.md" }),
      ],
      selection: ["unique-a"],
    },
    {
      name: "duplicate record ID selected through a unique path",
      records: [
        aiRecord(0, 10, { id: "duplicate-id", path: "First.md" }),
        aiRecord(1, 10, { id: "duplicate-id", path: "Second.md" }),
      ],
      selection: ["First.md"],
    },
  ])("rejects $name before preview", async ({ records, selection }) => {
    const fixture = aiControllerFixture({ records });
    await expect(fixture.controller.summarize(selection))
      .resolves.toEqual({ kind: "local-fallback", reason: "invalid-selection" });
    expect(fixture.aiPreview.calls).toHaveLength(0);
    expect(fixture.vault.readCounts.size).toBe(0);
    expect(fixture.ai.secretCalls).toHaveLength(0);
    expect(fixture.ai.clientCalls).toHaveLength(0);
  });

  it.each([
    { name: "transparent Proxy", make: () => new Proxy(["Notes/Alpha.md"], {}) },
    { name: "array accessor", make: () => {
      const value: unknown[] = ["Notes/Alpha.md"];
      Object.defineProperty(value, "0", { enumerable: true, get: () => "Notes/Alpha.md" });
      return value;
    } },
    { name: "Array subclass", make: () => new (class extends Array<string> {})("Notes/Alpha.md") },
    { name: "cycle", make: () => { const value: unknown[] = []; value.push(value); return value; } },
  ])("rejects hostile controller selection $name before preview", async ({ make }) => {
    const fixture = aiControllerFixture();
    await expect(fixture.controller.summarize(make() as never))
      .resolves.toEqual({ kind: "local-fallback", reason: "invalid-selection" });
    expect(fixture.aiPreview.calls).toHaveLength(0);
    expect(fixture.vault.readCounts.size).toBe(0);
    expect(fixture.ai.secretCalls).toHaveLength(0);
    expect(fixture.ai.clientCalls).toHaveLength(0);
  });

  it.each(["../A.md", "/A.md", "Folder/../A.md", "Bad\u0000/A.md"])(
    "rejects indexed unsafe path %j before preview",
    async (unsafePath) => {
      const fixture = aiControllerFixture({ records: [aiRecord(0, 10, { id: "unsafe-id", path: unsafePath })] });
      await expect(fixture.controller.summarize([unsafePath]))
        .resolves.toEqual({ kind: "local-fallback", reason: "invalid-selection" });
      expect(fixture.aiPreview.calls).toHaveLength(0);
      expect(fixture.vault.readCounts.size).toBe(0);
      expect(fixture.ai.secretCalls).toHaveLength(0);
      expect(fixture.ai.clientCalls).toHaveLength(0);
    },
  );

  it("rejects 21 indexed notes before preview, reads, secret, or client construction", async () => {
    const fixture = aiControllerFixture({ recordCount: 21 });
    const selection = Array.from({ length: 21 }, (_, index) => `AI/Note-${index}.md`);
    await expect(fixture.controller.summarize(selection)).resolves.toEqual({ kind: "local-fallback", reason: "selection-limit" });
    expect(fixture.aiPreview.calls).toHaveLength(0);
    expect(fixture.vault.readCounts.size).toBe(0);
    expect(fixture.ai.secretCalls).toHaveLength(0);
    expect(fixture.ai.clientCalls).toHaveLength(0);
  });

  it("uses indexed size to reject an obvious over-limit selection before preview or reads", async () => {
    const fixture = aiControllerFixture({ recordCount: 1, recordSize: 100_001 });
    await expect(fixture.controller.summarize(paths("AI/Note-0.md"))).resolves.toEqual({ kind: "local-fallback", reason: "selection-limit" });
    expect(fixture.aiPreview.calls).toHaveLength(0);
    expect(fixture.vault.readCounts.size).toBe(0);
    expect(fixture.ai.secretCalls).toHaveLength(0);
    expect(fixture.ai.clientCalls).toHaveLength(0);
  });

  it("rejects a stale indexed record that current settings exclude before every sensitive boundary", async () => {
    const fixture = aiControllerFixture({ recordCount: 1 });
    fixture.store.setSettingsForTest({ ...fixture.store.settings(), excludedPrefixes: ["AI"] });
    await expect(fixture.controller.summarize(paths("AI/Note-0.md")))
      .resolves.toEqual({ kind: "local-fallback", reason: "invalid-selection" });
    expect(fixture.aiPreview.calls).toHaveLength(0);
    expect(fixture.vault.readCounts.size).toBe(0);
    expect(fixture.ai.secretCalls).toHaveLength(0);
    expect(fixture.ai.clientCalls).toHaveLength(0);
  });

  it("cancellation previews metadata but reads and sends nothing", async () => {
    const fixture = aiControllerFixture({ aiPreviewResult: false });
    await expect(fixture.controller.nameCluster(paths("Notes/Alpha.md"))).resolves.toEqual({ kind: "local-fallback", reason: "cancelled" });
    expect(fixture.aiPreview.calls[0]).toEqual({
      action: "name-cluster",
      endpointOrigin: "https://example.test",
      paths: ["Notes/Alpha.md"],
      noteCount: 1,
      approximateCharacters: 10,
    });
    expect(fixture.vault.readCounts.size).toBe(0);
    expect(fixture.ai.secretCalls).toHaveLength(0);
    expect(fixture.ai.clientCalls).toHaveLength(0);
  });

  it("invalidates a confirmation when settings change before body reads", async () => {
    const fixture = aiControllerFixture({ pauseAiPreview: true });
    const pending = fixture.controller.summarize(paths("Notes/Alpha.md"));
    await Promise.resolve();
    await fixture.controller.saveAiSettings({ enabled: false, endpoint: "https://example.test/v1", model: "fixture-model", secretId: "fixture-secret" });
    fixture.aiPreview.resume(true);
    await expect(pending).resolves.toEqual({ kind: "local-fallback", reason: "action-invalidated" });
    expect(fixture.vault.readCounts.size).toBe(0);
    expect(fixture.ai.clientCalls).toHaveLength(0);
  });

  it("invalidates confirmation on selection change or disposal before body reads", async () => {
    const changed = aiControllerFixture({ pauseAiPreview: true });
    const changedPending = changed.controller.summarize(paths("Notes/Alpha.md"));
    while (changed.aiPreview.calls.length === 0) await Promise.resolve();
    await changed.controller.selectCenter({ kind: "document", id: "a" });
    changed.aiPreview.resume(true);
    await expect(changedPending).resolves.toEqual({ kind: "local-fallback", reason: "action-invalidated" });
    expect(changed.vault.readCounts.size).toBe(0);
    expect(changed.ai.clientCalls).toHaveLength(0);

    const disposed = aiControllerFixture({ pauseAiPreview: true });
    const disposedPending = disposed.controller.summarize(paths("Notes/Alpha.md"));
    while (disposed.aiPreview.calls.length === 0) await Promise.resolve();
    disposed.controller.dispose();
    disposed.aiPreview.resume(true);
    await expect(disposedPending).resolves.toEqual({ kind: "local-fallback", reason: "action-invalidated" });
    expect(disposed.vault.readCounts.size).toBe(0);
    expect(disposed.ai.clientCalls).toHaveLength(0);
  });

  it("invalidates a payload-confirmation AI action immediately when the index changes", async () => {
    const scheduler = manualProjectionScheduler();
    const fixture = aiControllerFixture({
      pauseAiPreview: true,
      projectionScheduler: scheduler.dependency,
    });
    const before = fixture.controller.snapshot();
    const pending = fixture.controller.summarize(paths("Notes/Alpha.md"));
    expect(fixture.aiPreview.calls).toHaveLength(1);
    const updated = fixture.index.activeRecords().map((record) => record.id === "a"
      ? { ...record, mtime: record.mtime + 1, contentHash: "index-changed" }
      : record);

    fixture.index.publishRecords(updated);

    expect(scheduler.pendingCount).toBe(0);
    expect(fixture.controller.snapshot()).toEqual(before);
    fixture.aiPreview.resume(true);
    await expect(pending).resolves.toEqual({ kind: "local-fallback", reason: "action-invalidated" });
    expect(fixture.vault.readCounts.size).toBe(0);
    expect(fixture.ai.secretCalls).toHaveLength(0);
    expect(fixture.ai.clientCalls).toHaveLength(0);
  });

  it("invalidates at a body-read boundary before secret resolution", async () => {
    const fixture = aiControllerFixture();
    fixture.vault.pauseReadAt("Notes/Alpha.md");
    const pending = fixture.controller.summarize(paths("Notes/Alpha.md"));
    await fixture.vault.waitUntilReadPaused();
    fixture.controller.refreshSuggestions();
    fixture.vault.resumeReads();
    await expect(pending).resolves.toEqual({ kind: "local-fallback", reason: "action-invalidated" });
    expect(fixture.ai.secretCalls).toHaveLength(0);
    expect(fixture.ai.clientCalls).toHaveLength(0);
  });

  it("rejects missing and mismatched note reads before secret or client construction", async () => {
    const missing = aiControllerFixture();
    missing.vault.applyEvent("delete", "Notes/Alpha.md");
    await expect(missing.controller.summarize(paths("Notes/Alpha.md"))).resolves.toEqual({ kind: "local-fallback", reason: "note-unavailable" });
    expect(missing.ai.secretCalls).toHaveLength(0);
    expect(missing.ai.clientCalls).toHaveLength(0);

    const base = aiControllerFixture();
    const mismatch = aiControllerFixture({ aiReads: mismatchReadPort(base.vault) });
    await expect(mismatch.controller.summarize(paths("Notes/Alpha.md"))).resolves.toEqual({ kind: "local-fallback", reason: "note-unavailable" });
    expect(mismatch.ai.secretCalls).toHaveLength(0);
    expect(mismatch.ai.clientCalls).toHaveLength(0);
  });

  it("rejects exact transmitted text over 100000 after frontmatter stripping and before secret resolution", async () => {
    const fixture = aiControllerFixture({ recordCount: 1, recordSize: 10 });
    fixture.vault.modifyExternally("AI/Note-0.md", `---\nprivate: metadata\n---\n${"x".repeat(100_001)}`);
    await expect(fixture.controller.summarize(paths("AI/Note-0.md"))).resolves.toEqual({ kind: "local-fallback", reason: "selection-limit" });
    expect(fixture.ai.secretCalls).toHaveLength(0);
    expect(fixture.ai.clientCalls).toHaveLength(0);
  });

  it("sanitizes missing and throwing SecretStorage without constructing a client", async () => {
    const missing = aiControllerFixture({ aiSecret: null });
    await expect(missing.controller.summarize(paths("Notes/Alpha.md"))).resolves.toEqual({ kind: "local-fallback", reason: "secret-unavailable" });
    expect(missing.ai.clientCalls).toHaveLength(0);
    const throwing = aiControllerFixture({ aiSecretError: new Error("sk-private") });
    const result = await throwing.controller.summarize(paths("Notes/Alpha.md"));
    expect(result).toEqual({ kind: "local-fallback", reason: "secret-unavailable" });
    expect(JSON.stringify(result)).not.toContain("sk-private");
    expect(throwing.ai.clientCalls).toHaveLength(0);
  });

  it("keeps a session-only secret out of settings, snapshots, and fixture serialization", async () => {
    const fixture = aiControllerFixture({ aiSecretId: "", aiSecret: null });
    fixture.controller.setSessionAiSecret("sk-session-private");
    expect(JSON.stringify(fixture.controller.snapshot())).not.toContain("sk-session-private");
    expect(JSON.stringify(fixture.controller.settings())).not.toContain("sk-session-private");
    expect(JSON.stringify(fixture.ai)).not.toContain("sk-session-private");
    expect(JSON.stringify(fixture.controller)).not.toContain("sk-session-private");
    await expect(fixture.controller.summarize(paths("Notes/Alpha.md")))
      .resolves.toEqual({ kind: "ok", value: "AI fixture text" });
    expect(fixture.ai.secretCalls).toHaveLength(0);
    expect(JSON.stringify(fixture.ai)).not.toContain("sk-session-private");
  });

  it("clears a session secret when persisted secretId changes from non-empty to empty", async () => {
    const fixture = aiControllerFixture({ aiSecretId: "", aiSecret: null });
    fixture.controller.setSessionAiSecret("stale-session-secret");
    fixture.store.setSettingsForTest({ ...fixture.store.settings(), secretId: "persistent-id" });
    await fixture.controller.saveAiSettings({
      enabled: true,
      endpoint: "https://example.test/v1",
      model: "fixture-model",
      secretId: "",
    });
    await expect(fixture.controller.summarize(paths("Notes/Alpha.md")))
      .resolves.toEqual({ kind: "local-fallback", reason: "secret-unavailable" });
    expect(JSON.stringify(fixture.controller)).not.toContain("stale-session-secret");
  });

  it("coalesces the same action and returns busy for a different action", async () => {
    const client = new DeferredAiClient();
    const fixture = aiControllerFixture({ aiClient: client });
    const first = fixture.controller.summarize(paths("Notes/Alpha.md"));
    const same = fixture.controller.summarize(paths("Notes/Alpha.md"));
    const different = fixture.controller.suggestLabels(paths("Notes/Alpha.md"));
    expect(same).toBe(first);
    await expect(different).resolves.toEqual({ kind: "local-fallback", reason: "busy" });
    while (client.calls.length === 0) await Promise.resolve();
    client.resolve("late result");
    await expect(first).resolves.toEqual({ kind: "ok", value: "late result" });
    expect(client.calls).toHaveLength(1);
  });

  it("gives an active flight priority over changed configuration, over-limit, and hostile inputs", async () => {
    const client = new DeferredAiClient();
    const fixture = aiControllerFixture({ aiClient: client });
    const first = fixture.controller.summarize(paths("Notes/Alpha.md"));
    while (client.calls.length === 0) await Promise.resolve();
    const counts = {
      previews: fixture.aiPreview.calls.length,
      reads: [...fixture.vault.readCounts.values()].reduce((sum, count) => sum + count, 0),
      secrets: fixture.ai.secretCalls.length,
      clients: fixture.ai.clientCalls.length,
    };
    fixture.store.setSettingsForTest({ ...fixture.store.settings(), aiEndpoint: "http://unsafe.example/v1" });

    expect(fixture.controller.summarize(paths("Notes/Alpha.md"))).toBe(first);
    await expect(fixture.controller.summarize(Array.from({ length: 21 }, (_, index) => `${index}.md`)))
      .resolves.toEqual({ kind: "local-fallback", reason: "busy" });
    const hostile = new Proxy(["Notes/Alpha.md"], { ownKeys: () => { throw new Error("must stay busy"); } });
    await expect(fixture.controller.nameCluster(hostile as never))
      .resolves.toEqual({ kind: "local-fallback", reason: "busy" });
    expect({
      previews: fixture.aiPreview.calls.length,
      reads: [...fixture.vault.readCounts.values()].reduce((sum, count) => sum + count, 0),
      secrets: fixture.ai.secretCalls.length,
      clients: fixture.ai.clientCalls.length,
    }).toEqual(counts);
    client.resolve("done");
    await first;
  });

  it("invalidates a pending AI action when suggestion checkbox selection changes", async () => {
    const fixture = aiControllerFixture({ pauseAiPreview: true });
    let emissions = 0;
    fixture.controller.subscribe(() => { emissions += 1; });
    const pending = fixture.controller.summarize(paths("Notes/Alpha.md"));
    while (fixture.aiPreview.calls.length === 0) await Promise.resolve();
    const beforeSelectionChange = emissions;
    fixture.controller.notifySuggestionSelectionChanged();
    expect(emissions).toBe(beforeSelectionChange);
    fixture.aiPreview.resume(true);
    await expect(pending).resolves.toEqual({ kind: "local-fallback", reason: "action-invalidated" });
    expect(fixture.vault.readCounts.size).toBe(0);
    expect(fixture.ai.clientCalls).toHaveLength(0);
  });

  it("invalidates suggestion selection changes during body read and network boundaries", async () => {
    const reading = aiControllerFixture();
    reading.vault.pauseReadAt("Notes/Alpha.md");
    const readPending = reading.controller.summarize(paths("Notes/Alpha.md"));
    await reading.vault.waitUntilReadPaused();
    reading.controller.notifySuggestionSelectionChanged();
    reading.vault.resumeReads();
    await expect(readPending).resolves.toEqual({ kind: "local-fallback", reason: "action-invalidated" });
    expect(reading.ai.secretCalls).toHaveLength(0);
    expect(reading.ai.clientCalls).toHaveLength(0);

    const client = new DeferredAiClient();
    const networking = aiControllerFixture({ aiClient: client });
    const networkPending = networking.controller.summarize(paths("Notes/Alpha.md"));
    while (client.calls.length === 0) await Promise.resolve();
    networking.controller.notifySuggestionSelectionChanged();
    client.resolve("late result");
    await expect(networkPending).resolves.toEqual({ kind: "local-fallback", reason: "action-invalidated" });
    expect(networking.controller.snapshot()).not.toHaveProperty("aiSuggestion");
  });

  it("emits once when a suggestion selection change clears an existing AI display", async () => {
    const fixture = aiControllerFixture();
    await fixture.controller.summarize(paths("Notes/Alpha.md"));
    let emissions = 0;
    fixture.controller.subscribe(() => { emissions += 1; });
    fixture.controller.notifySuggestionSelectionChanged();
    expect(emissions).toBe(1);
    expect(fixture.controller.snapshot()).not.toHaveProperty("aiSuggestion");
  });

  it("discards a late network result after disable and never mutates local outputs", async () => {
    const client = new DeferredAiClient();
    const fixture = aiControllerFixture({ aiClient: client });
    const before = fixture.controller.snapshot();
    const pending = fixture.controller.summarize(paths("Notes/Alpha.md"));
    while (client.calls.length === 0) await Promise.resolve();
    await fixture.controller.saveAiSettings({ enabled: false, endpoint: "https://example.test/v1", model: "fixture-model", secretId: "fixture-secret" });
    client.resolve("late explanation");
    await expect(pending).resolves.toEqual({ kind: "local-fallback", reason: "action-invalidated" });
    const after = fixture.controller.snapshot();
    expect(after.today).toEqual(before.today);
    expect(after.map).toEqual(before.map);
    expect(after).not.toHaveProperty("aiSuggestion");
    expect(fixture.transactions.calls).toHaveLength(0);
    expect(fixture.vault.writeCalls).toHaveLength(0);
  });

  it("prevents retry after dispose during delay", async () => {
    let release: (() => void) | null = null;
    const client = new FakeAiClient([new AiClientError("network", 0), { text: "must-not-send" }]);
    const fixture = aiControllerFixture({
      aiClient: client,
      aiDelay: () => new Promise<void>((resolve) => { release = resolve; }),
    });
    const pending = fixture.controller.summarize(paths("Notes/Alpha.md"));
    while (release === null) await Promise.resolve();
    fixture.controller.dispose();
    const releaseDelay = release as (() => void) | null;
    releaseDelay?.();
    await expect(pending).resolves.toEqual({ kind: "local-fallback", reason: "action-invalidated" });
    expect(client.calls).toHaveLength(1);
  });

  it("does not touch AI boundaries during scan, map focus, suggestion refresh, quick capture, or history", async () => {
    const fixture = aiControllerFixture();
    fixture.controller.refreshSuggestions();
    await fixture.controller.selectCenter({ kind: "document", id: "a" });
    await fixture.controller.startInitialScan();
    await fixture.controller.startQuickCapture();
    await fixture.controller.refreshHistory();
    expect(fixture.vault.readCounts.size).toBe(0);
    expect(fixture.ai.secretCalls).toHaveLength(0);
    expect(fixture.ai.clientCalls).toHaveLength(0);
  });

  it("overrides only the explicitly targeted suggestion display and preserves its local safety baseline", async () => {
    const fixture = aiControllerFixture({ aiClient: new FakeAiClient([{ text: "Bounded AI explanation" }]) });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      folderRules: [
        { prefix: "Notes", kind: "note" },
        { prefix: "References", kind: "reference" },
      ],
    });
    const local = fixture.controller.refreshSuggestions();
    expect(local.length).toBeGreaterThanOrEqual(2);
    const target = local[0]!;
    const untouched = local[1]!;
    const beforeToday = fixture.controller.snapshot().today;
    const beforeMap = fixture.controller.snapshot().map;

    await expect(fixture.controller.explainRelation(
      ["Notes/Alpha.md", "References/Beta.md"],
      target.operation.id,
    )).resolves.toEqual({ kind: "ok", value: "Bounded AI explanation" });

    const after = fixture.controller.snapshot();
    const enhanced = (after.suggestions ?? []).find((value) => value.operation.id === target.operation.id);
    const stillLocal = (after.suggestions ?? []).find((value) => value.operation.id === untouched.operation.id);
    expect(enhanced).toBeDefined();
    expect(stillLocal).toBeDefined();
    if (enhanced === undefined || stillLocal === undefined) throw new Error("Expected both suggestion snapshots");
    expect(enhanced.operation).toEqual(target.operation);
    expect(enhanced.localRationale).toEqual(target.localRationale);
    expect(enhanced.rationale).toEqual({
      ...target.localRationale,
      source: "ai-assisted",
      summary: "Bounded AI explanation",
    });
    expect(stillLocal).toEqual(untouched);
    expect(after.today).toEqual(beforeToday);
    expect(after.map).toEqual(beforeMap);
    expect(fixture.transactions.calls).toHaveLength(0);
    expect(fixture.vault.writeCalls).toHaveLength(0);

    fixture.controller.setSessionAiSecret("replacement-session-secret");
    expect(fixture.controller.snapshot().suggestions?.every((value) => value.rationale.source === "local")).toBe(true);
    expect(fixture.controller.snapshot()).not.toHaveProperty("aiSuggestion");

    fixture.controller.refreshSuggestions();
    expect(fixture.controller.snapshot().suggestions?.every((value) => value.rationale.source === "local")).toBe(true);
    expect(fixture.controller.snapshot()).not.toHaveProperty("aiSuggestion");
  });

  it("allows a generic relation explanation with no suggestion target and changes no rationale", async () => {
    const fixture = aiControllerFixture({ aiClient: new FakeAiClient([{ text: "Generic explanation" }]) });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      folderRules: [{ prefix: "Notes", kind: "note" }],
    });
    const before = fixture.controller.refreshSuggestions();
    await expect(fixture.controller.explainRelation(["Notes/Alpha.md"]))
      .resolves.toEqual({ kind: "ok", value: "Generic explanation" });
    expect(fixture.controller.snapshot().suggestions).toEqual(before);
    expect(fixture.controller.snapshot().aiSuggestion).toEqual({ action: "explain-relation", text: "Generic explanation" });
  });

  it("keeps AI display text out of change previews and executed plans", async () => {
    const aiText = "AI text must never enter a plan or journal";
    const fixture = aiControllerFixture({ aiClient: new FakeAiClient([{ text: aiText }]) });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      folderRules: [{ prefix: "Notes", kind: "note" }],
      writePreviewAcknowledged: true,
      writeEnabled: true,
    });
    const target = fixture.controller.refreshSuggestions()[0]!;
    const sourcePath = "sourcePath" in target.operation ? target.operation.sourcePath : target.operation.path;
    await fixture.controller.explainRelation([sourcePath], target.operation.id);
    expect(fixture.controller.snapshot().suggestions?.[0]?.rationale.summary).toBe(aiText);

    await fixture.controller.previewSuggestion(target.operation.id);

    expect(fixture.changePreview.lastPreview?.plan.rationales[target.operation.id]).toEqual(target.localRationale);
    expect(JSON.stringify(fixture.changePreview.lastPreview)).not.toContain(aiText);
    expect(JSON.stringify(fixture.transactions.calls)).not.toContain(aiText);
    expect(fixture.transactions.calls[0]?.operations).toEqual([target.operation]);
  });

  it("restores an earlier display override before applying a second and never persists either", async () => {
    const fixture = aiControllerFixture({
      aiClient: new FakeAiClient([{ text: "AI first" }, { text: "AI second" }]),
      previewResult: "cancel",
    });
    fixture.store.setSettingsForTest({
      ...fixture.store.settings(),
      folderRules: [
        { prefix: "Notes", kind: "note" },
        { prefix: "References", kind: "reference" },
      ],
      writePreviewAcknowledged: true,
      writeEnabled: true,
    });
    const [first, second] = fixture.controller.refreshSuggestions();
    if (first === undefined || second === undefined) throw new Error("Expected two local suggestions");
    const pathOf = (value: typeof first): string => "sourcePath" in value.operation ? value.operation.sourcePath : value.operation.path;
    await fixture.controller.explainRelation([pathOf(first)], first.operation.id);
    await fixture.controller.explainRelation([pathOf(second)], second.operation.id);

    const projected = fixture.controller.snapshot().suggestions ?? [];
    expect(projected.find((value) => value.operation.id === first.operation.id)?.rationale).toEqual(first.localRationale);
    expect(projected.find((value) => value.operation.id === second.operation.id)?.rationale.summary).toBe("AI second");

    await fixture.controller.previewSuggestion(first.operation.id);
    const firstPreview = JSON.stringify(fixture.changePreview.lastPreview);
    await fixture.controller.previewSuggestion(second.operation.id);
    const secondPreview = JSON.stringify(fixture.changePreview.lastPreview);
    expect(firstPreview + secondPreview).not.toMatch(/AI first|AI second/u);

    fixture.controller.setSessionAiSecret("replacement");
    expect(fixture.controller.snapshot().suggestions?.every((value) => value.rationale.source === "local")).toBe(true);
  });
});
