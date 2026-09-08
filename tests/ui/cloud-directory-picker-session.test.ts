import { describe, expect, it, vi } from "vitest";
import type {
  CloudDirectoryCandidate,
  CloudDirectoryCandidateRuntime,
} from "../../src/catalog/cloud-directory-candidates";
import type {
  CloudDirectoryBrowserRuntime,
  CloudDirectoryBrowseRound,
  CloudDirectoryLayerSnapshot,
} from "../../src/catalog/cloud-directory-browser";
import type {
  CloudDirectoryLocatorRuntime,
  CloudDirectoryLocatorSummary,
} from "../../src/catalog/cloud-directory-locator";
import type {
  CloudDirectoryPickerPurpose,
} from "../../src/catalog/cloud-directory-selection";
import { createCloudDirectoryPickerSession } from "../../src/ui/cloud-directory-picker-session";

const GROUP_A = `group:${"a".repeat(64)}`;
const GROUP_B = `group:${"b".repeat(64)}`;

const exact = (
  path: string,
  source: "recent" | "session-cache" | "cloud-locator" = "recent",
): CloudDirectoryCandidate => ({
  kind: "exact",
  path,
  filename: path.split("/").at(-1)!,
  source,
  pathState: source === "recent" ? "previously-used" : "session-verified",
});

class FakeCandidates implements CloudDirectoryCandidateRuntime {
  readonly rememberCalls: string[] = [];
  clearCalls = 0;
  rememberFailure: Error | null = null;
  clearFailure: Error | null = null;
  beforeRemember: (() => Promise<void>) | null = null;

  constructor(private current: readonly CloudDirectoryCandidate[]) {}

  snapshot(): readonly CloudDirectoryCandidate[] {
    return structuredClone(this.current);
  }

  async remember(path: string): Promise<void> {
    this.rememberCalls.push(path);
    await this.beforeRemember?.();
    if (this.rememberFailure !== null) throw this.rememberFailure;
  }

  async clearRecent(): Promise<void> {
    this.clearCalls += 1;
    if (this.clearFailure !== null) throw this.clearFailure;
    this.current = this.current.filter((candidate) => candidate.source !== "recent");
  }
}

class FakeLocator implements CloudDirectoryLocatorRuntime {
  readonly calls: string[] = [];
  readonly signals: AbortSignal[] = [];
  cancelCalls = 0;
  disposeCalls = 0;

  constructor(
    private readonly locate: (
      query: string,
      signal: AbortSignal | undefined,
    ) => Promise<CloudDirectoryLocatorSummary>,
  ) {}

  async locateByName(
    query: string,
    signal?: AbortSignal,
  ): Promise<CloudDirectoryLocatorSummary> {
    this.calls.push(query);
    if (signal !== undefined) this.signals.push(signal);
    return this.locate(query, signal);
  }

  cancel(): void { this.cancelCalls += 1; }
  dispose(): void { this.disposeCalls += 1; }
}

class FakeBrowser implements CloudDirectoryBrowserRuntime {
  rootGranted = false;
  grantCalls = 0;
  readonly loads: Array<Readonly<{ path: string; start: number }>> = [];
  readonly signals: AbortSignal[] = [];
  readonly layers = new Map<string, CloudDirectoryLayerSnapshot>();
  readonly listeners = new Set<(path: string) => void>();
  readonly snapshotFailures = new Set<string>();
  clearCalls = 0;
  disposeCalls = 0;
  load: (
    input: Readonly<{ path: string; start: number }>,
    signal?: AbortSignal,
  ) => Promise<CloudDirectoryBrowseRound> = async (input) => {
    const value = layer(input.path, [], { complete: true, nextStart: null });
    this.layers.set(input.path, value);
    this.emit(input.path);
    return round(input.path, { status: "complete", stopReason: "complete" });
  };

  rootAccessGranted(): boolean { return this.rootGranted; }
  grantRootAccess(): void { this.rootGranted = true; this.grantCalls += 1; }
  async loadLayer(
    input: Readonly<{ path: string; start: number }>,
    signal?: AbortSignal,
  ): Promise<CloudDirectoryBrowseRound> {
    this.loads.push({ ...input });
    if (signal !== undefined) this.signals.push(signal);
    return this.load(input, signal);
  }
  snapshot(path: string): CloudDirectoryLayerSnapshot | null {
    if (this.snapshotFailures.has(path)) throw new Error("private-browser-snapshot-detail");
    const value = this.layers.get(path);
    return value === undefined ? null : { ...value };
  }
  subscribe(listener: (path: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  clear(): void { this.clearCalls += 1; this.layers.clear(); this.rootGranted = false; }
  dispose(): void { this.disposeCalls += 1; this.clear(); this.listeners.clear(); }
  emit(path: string): void { for (const listener of this.listeners) listener(path); }
}

const directory = (path: string, index = 1) => ({
  fsId: String(index),
  path,
  filename: path.split("/").at(-1)!,
});

const layer = (
  path: string,
  directories: CloudDirectoryLayerSnapshot["directories"],
  input: Partial<CloudDirectoryLayerSnapshot> = {},
): CloudDirectoryLayerSnapshot => ({
  path,
  directories,
  nextStart: null,
  complete: true,
  cumulativeCheckedEntryCount: directories.length,
  cumulativeListRequestCount: 1,
  lastStopReason: "complete",
  ...input,
});

const round = (
  path: string,
  input: Partial<CloudDirectoryBrowseRound> = {},
): CloudDirectoryBrowseRound => ({
  path,
  status: "complete",
  stopReason: "complete",
  nextStart: null,
  checkedEntryCount: 0,
  cumulativeCheckedEntryCount: 0,
  directoryCount: 0,
  listRequestCount: 1,
  cumulativeListRequestCount: 1,
  elapsedMs: 1,
  ...input,
});

const summary = (
  query: string,
  candidates: readonly CloudDirectoryCandidate[],
  input: Partial<CloudDirectoryLocatorSummary> = {},
): CloudDirectoryLocatorSummary => ({
  status: "complete",
  stopReason: "complete",
  query,
  directoryCount: 4,
  matchCount: candidates.length,
  listRequestCount: 3,
  elapsedMs: 25,
  candidates,
  ...input,
});

const verificationPurpose = (
  groups: Extract<CloudDirectoryPickerPurpose, { kind: "verification" }>["groups"] = [{
    groupKey: GROUP_A,
    rootRelativePath: "9-文学253册",
    label: "文学",
  }],
): CloudDirectoryPickerPurpose => ({ kind: "verification", groups });

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("cloud directory picker session", () => {
  it("searches and filters all four local sources without a locator or browser request", () => {
    const locator = new FakeLocator(async () => { throw new Error("must-not-locate"); });
    const browser = new FakeBrowser();
    const session = createCloudDirectoryPickerSession({
      candidates: new FakeCandidates([
        exact("/库/Recent", "recent"),
        exact("/库/Cached", "session-cache"),
        { kind: "name-hint", filename: "Hint", source: "txt-group", catalogGroupKey: GROUP_A },
        exact("/库/Located", "cloud-locator"),
      ]),
      browser,
      locator,
      purpose: { kind: "scan" },
      initialPath: null,
    });

    expect(session.snapshot().enabledSources).toEqual([
      "recent",
      "session-cache",
      "txt-group",
      "cloud-locator",
    ]);
    expect(session.snapshot().rankedCandidates).toHaveLength(4);
    session.toggleSource("recent");
    expect(session.snapshot().rankedCandidates.some((item) => (
      item.candidate.kind === "exact" && item.candidate.path === "/库/Recent"
    ))).toBe(false);
    session.setQuery("Cached");
    expect(session.snapshot().rankedCandidates).toHaveLength(1);
    expect(locator.calls).toEqual([]);
    expect(browser.loads).toEqual([]);
  });

  it("infers one local verification category and commits only from useSelection", async () => {
    const candidates = new FakeCandidates([exact("/科学文库/9-文学253册")]);
    const session = createCloudDirectoryPickerSession({
      candidates,
      purpose: verificationPurpose(),
      initialPath: null,
    });

    session.selectCandidate("/科学文库/9-文学253册");
    expect(session.snapshot().draftSelection).toEqual({
      kind: "category",
      selectedPath: "/科学文库/9-文学253册",
      effectiveRoot: "/科学文库",
      groupKey: GROUP_A,
    });
    expect(candidates.rememberCalls).toEqual([]);

    await expect(session.useSelection()).resolves.toEqual({
      kind: "category",
      selectedPath: "/科学文库/9-文学253册",
      effectiveRoot: "/科学文库",
      groupKey: GROUP_A,
    });
    expect(candidates.rememberCalls).toEqual(["/科学文库/9-文学253册"]);
    expect(session.snapshot().phase).toBe("closed");
  });

  it.each([
    ["initial path", "initial" as const],
    ["recent candidate", "recent" as const],
    ["session-cache candidate", "session-cache" as const],
  ])("infers the category parent from a unique %s without network", async (_label, source) => {
    const path = "/科学文库/9-文学253册";
    const browser = new FakeBrowser();
    const locator = new FakeLocator(async () => { throw new Error("must-not-locate"); });
    const candidates = new FakeCandidates(source === "initial" ? [] : [
      exact(path, source),
    ]);
    const session = createCloudDirectoryPickerSession({
      candidates,
      browser,
      locator,
      purpose: verificationPurpose(),
      initialPath: source === "initial" ? path : null,
    });

    if (source !== "initial") session.selectCandidate(path);
    expect(session.snapshot().draftSelection).toEqual({
      kind: "category",
      selectedPath: path,
      effectiveRoot: "/科学文库",
      groupKey: GROUP_A,
    });
    expect(browser.loads).toEqual([]);
    expect(locator.calls).toEqual([]);
  });

  it("uses a directory draft for zero group matches and rejects ambiguous local categories", async () => {
    const candidates = new FakeCandidates([
      exact("/科学文库/普通目录"),
      exact("/科学文库/重复分类"),
    ]);
    const session = createCloudDirectoryPickerSession({
      candidates,
      purpose: verificationPurpose([
        { groupKey: GROUP_A, rootRelativePath: "重复分类", label: "重复一" },
        { groupKey: GROUP_B, rootRelativePath: "重复分类", label: "重复二" },
      ]),
      initialPath: null,
    });

    session.selectCandidate("/科学文库/普通目录");
    expect(session.snapshot().draftSelection).toEqual({
      kind: "directory",
      selectedPath: "/科学文库/普通目录",
      effectiveRoot: "/科学文库/普通目录",
    });
    session.selectCandidate("/科学文库/重复分类");
    expect(session.snapshot()).toMatchObject({
      selectedPath: null,
      draftSelection: null,
      statusCode: "conflict",
    });
    await expect(session.useSelection()).resolves.toBeNull();
    expect(candidates.rememberCalls).toEqual([]);
  });

  it("lets a same-path conflict mask and invalidate an earlier exact draft", async () => {
    const path = "/科学文库/9-文学253册";
    const candidates = new FakeCandidates([exact(path)]);
    const locator = new FakeLocator(async (query) => summary(query, [{
      kind: "conflict",
      filename: "9-文学253册",
      path,
      source: "cloud-locator",
      reason: "same-path-different-identity",
    }]));
    const session = createCloudDirectoryPickerSession({
      candidates,
      locator,
      purpose: verificationPurpose(),
      initialPath: null,
    });
    session.selectCandidate(path);
    expect(session.snapshot().draftSelection).not.toBeNull();
    session.setQuery("9-文学253册");
    session.requestLookupConsent();
    await session.confirmLookup();

    expect(session.snapshot()).toMatchObject({
      selectedPath: null,
      draftSelection: null,
      statusCode: "conflict",
    });
    await expect(session.useSelection()).resolves.toBeNull();
    expect(candidates.rememberCalls).toEqual([]);
  });

  it("requires lookup consent and exposes only detached raw lookup detail", async () => {
    const privateDetail = "private-response-body";
    const locator = new FakeLocator(async (query) => summary(query, [
      exact("/云端/Science", "cloud-locator"),
    ], {
      status: "paused",
      stopReason: "directory-limit",
      elapsedMs: 37,
    }));
    const session = createCloudDirectoryPickerSession({
      candidates: new FakeCandidates([]),
      locator,
      purpose: { kind: "scan" },
      initialPath: null,
    });

    session.setQuery("Science");
    session.requestLookupConsent();
    expect(session.snapshot()).toMatchObject({
      phase: "lookup-consent",
      statusCode: "lookup-consent-required",
    });
    expect(locator.calls).toEqual([]);
    await session.confirmLookup();
    expect(locator.calls).toEqual(["Science"]);
    expect(session.snapshot().lookupDetail).toEqual({
      status: "paused",
      stopReason: "directory-limit",
      query: "Science",
      directoryCount: 4,
      matchCount: 1,
      listRequestCount: 3,
      elapsedMs: 37,
    });
    expect(session.snapshot().statusCode).toBe("lookup-incomplete");
    expect(JSON.stringify(session.snapshot())).not.toContain(privateDetail);
  });

  it("cancels lookup consent or a running lookup back to local without stale updates", async () => {
    let resolveLookup!: (value: CloudDirectoryLocatorSummary) => void;
    const locator = new FakeLocator(async () => new Promise((resolve) => {
      resolveLookup = resolve;
    }));
    const session = createCloudDirectoryPickerSession({
      candidates: new FakeCandidates([]),
      locator,
      purpose: { kind: "scan" },
      initialPath: null,
    });

    session.setQuery("Science");
    session.requestLookupConsent();
    session.cancelLookup();
    expect(session.snapshot().phase).toBe("local");
    expect(locator.calls).toEqual([]);

    session.requestLookupConsent();
    const pending = session.confirmLookup();
    session.cancelLookup();
    expect(locator.signals[0]?.aborted).toBe(true);
    expect(session.snapshot().phase).toBe("local");
    resolveLookup(summary("Science", [exact("/Late/Science", "cloud-locator")]));
    await pending;
    expect(session.snapshot().rankedCandidates).toEqual([]);
  });

  it("restores the active browser status after lookup cancel and lookup completion", async () => {
    let resolveFirst!: (value: CloudDirectoryLocatorSummary) => void;
    let call = 0;
    const locator = new FakeLocator(async (query) => {
      call += 1;
      if (call === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return summary(query, [exact("/云端/Science", "cloud-locator")]);
    });
    const browser = new FakeBrowser();
    browser.layers.set("/库", layer("/库", [directory("/库/Science")]));
    const session = createCloudDirectoryPickerSession({
      candidates: new FakeCandidates([]),
      browser,
      locator,
      purpose: { kind: "scan" },
      initialPath: null,
    });

    session.enterBrowserPath("/库");
    session.setQuery("Science");
    session.requestLookupConsent();
    const pending = session.confirmLookup();
    expect(session.snapshot().statusCode).toBe("lookup-running");
    session.cancelLookup();
    expect(session.snapshot()).toMatchObject({
      phase: "browsing",
      browserActivity: "complete",
      statusCode: null,
    });
    resolveFirst(summary("Science", [exact("/迟到/Science", "cloud-locator")]));
    await pending;

    session.requestLookupConsent();
    await session.confirmLookup();
    expect(session.snapshot()).toMatchObject({
      phase: "browsing",
      browserActivity: "complete",
      statusCode: null,
      lookupDetail: { status: "complete", query: "Science" },
    });
  });

  it("maps a locator exception to a closed status without exposing its message", async () => {
    const locator = new FakeLocator(async () => {
      throw new Error("private-locator-response-and-token");
    });
    const session = createCloudDirectoryPickerSession({
      candidates: new FakeCandidates([]),
      locator,
      purpose: { kind: "scan" },
      initialPath: null,
    });
    session.setQuery("Science");
    session.requestLookupConsent();
    await session.confirmLookup();

    expect(session.snapshot()).toMatchObject({
      phase: "local",
      statusCode: "lookup-incomplete",
      lookupDetail: null,
    });
    expect(JSON.stringify(session.snapshot())).not.toContain("private-locator-response-and-token");
  });

  it("aborts stale lookup A so lookup B alone can update the session", async () => {
    const pending: Array<Readonly<{
      query: string;
      resolve: (value: CloudDirectoryLocatorSummary) => void;
    }>> = [];
    const locator = new FakeLocator(async (query) => new Promise((resolve) => {
      pending.push({ query, resolve });
    }));
    const session = createCloudDirectoryPickerSession({
      candidates: new FakeCandidates([]),
      locator,
      purpose: { kind: "scan" },
      initialPath: null,
    });

    session.setQuery("Alpha");
    session.requestLookupConsent();
    const alpha = session.confirmLookup();
    session.setQuery("Beta");
    expect(session.snapshot().phase).toBe("local");
    session.requestLookupConsent();
    const beta = session.confirmLookup();
    expect(locator.signals[0]?.aborted).toBe(true);
    pending[1]!.resolve(summary("Beta", [exact("/云端/Beta", "cloud-locator")]));
    await beta;
    pending[0]!.resolve(summary("Alpha", [exact("/云端/Alpha", "cloud-locator")]));
    await alpha;

    const paths = session.snapshot().rankedCandidates.flatMap((item) => (
      item.candidate.kind === "exact" ? [item.candidate.path] : []
    ));
    expect(paths).toContain("/云端/Beta");
    expect(paths).not.toContain("/云端/Alpha");
  });

  it("requires separate root consent and continues with the exact saved cursor", async () => {
    const browser = new FakeBrowser();
    browser.load = async (input) => {
      const nextStart = input.start === 0 ? 20_000 : null;
      const value = layer(input.path, [directory(`${input.path}/Child`.replace("//", "/"))], {
        complete: nextStart === null,
        nextStart,
        lastStopReason: nextStart === null ? "complete" : "entry-limit",
      });
      browser.layers.set(input.path, value);
      browser.emit(input.path);
      return round(input.path, {
        status: nextStart === null ? "complete" : "paused",
        stopReason: nextStart === null ? "complete" : "entry-limit",
        nextStart,
        checkedEntryCount: 20_000,
      });
    };
    const session = createCloudDirectoryPickerSession({
      candidates: new FakeCandidates([]),
      browser,
      purpose: { kind: "scan" },
      initialPath: null,
    });

    session.revealRootBrowser();
    expect(session.snapshot()).toMatchObject({
      phase: "root-consent",
      statusCode: "root-consent-required",
    });
    expect(browser.loads).toEqual([]);
    session.cancelRootBrowser();
    expect(session.snapshot().phase).toBe("local");
    expect(browser.loads).toEqual([]);
    session.revealRootBrowser();
    session.confirmRootBrowser();
    await vi.waitFor(() => expect(session.snapshot().browserActivity).toBe("incomplete"));
    expect(browser.loads).toEqual([{ path: "/", start: 0 }]);
    expect(session.snapshot().browserDetail).toEqual({
      round: {
        checkedEntryCount: 20_000,
        listRequestCount: 1,
        elapsedMs: 1,
        stopReason: "entry-limit",
      },
      fixedError: null,
    });
    await session.selectCurrentDirectory();
    expect(session.snapshot().draftSelection).toBeNull();
    expect(session.snapshot().statusCode).toBe("selection-invalid");
    await session.continueBrowser();
    expect(browser.loads).toEqual([
      { path: "/", start: 0 },
      { path: "/", start: 20_000 },
    ]);
  });

  it("keeps browser selection as a draft and commits a category parent only on use", async () => {
    const candidates = new FakeCandidates([]);
    const browser = new FakeBrowser();
    browser.layers.set("/科学文库", layer("/科学文库", [
      directory("/科学文库/9-文学253册"),
      directory("/科学文库/普通目录", 2),
    ]));
    const session = createCloudDirectoryPickerSession({
      candidates,
      browser,
      purpose: verificationPurpose(),
      initialPath: null,
    });

    session.enterBrowserPath("/科学文库");
    await session.selectCategory("/科学文库/9-文学253册");
    expect(candidates.rememberCalls).toEqual([]);
    expect(session.snapshot().draftSelection).toMatchObject({
      kind: "category",
      effectiveRoot: "/科学文库",
      groupKey: GROUP_A,
    });
    await expect(session.useSelection()).resolves.toMatchObject({
      kind: "category",
      effectiveRoot: "/科学文库",
      groupKey: GROUP_A,
    });
    expect(candidates.rememberCalls).toEqual(["/科学文库/9-文学253册"]);
  });

  it("navigates cached layers, highlights visible children, and selects only explicitly", async () => {
    const candidates = new FakeCandidates([]);
    const browser = new FakeBrowser();
    browser.layers.set("/库", layer("/库", [directory("/库/A"), directory("/库/B", 2)]));
    browser.layers.set("/库/B", layer("/库/B", [directory("/库/B/Leaf")]));
    const session = createCloudDirectoryPickerSession({
      candidates,
      browser,
      purpose: { kind: "scan" },
      initialPath: null,
    });

    session.enterBrowserPath("/库");
    session.highlightBrowserPath("/库/B");
    expect(session.snapshot().browserHighlightedPath).toBe("/库/B");
    session.enterBrowserPath("/库/B");
    session.navigateBreadcrumb("/库");
    expect(session.snapshot().browserPath).toBe("/库");
    expect(session.snapshot().browserHighlightedPath).toBe("/库/B");
    await session.selectHighlightedDirectory();
    expect(session.snapshot().draftSelection).toEqual({
      kind: "directory",
      selectedPath: "/库/B",
      effectiveRoot: "/库/B",
    });
    expect(candidates.rememberCalls).toEqual([]);
    expect(browser.loads).toEqual([]);
    await expect(session.useSelection()).resolves.toEqual({
      kind: "directory",
      selectedPath: "/库/B",
      effectiveRoot: "/库/B",
    });
    expect(candidates.rememberCalls).toEqual(["/库/B"]);
  });

  it("fails closed for invalid current, highlighted, and category selection actions", async () => {
    const browser = new FakeBrowser();
    browser.layers.set("/库", layer("/库", [directory("/库/普通目录")]));
    const session = createCloudDirectoryPickerSession({
      candidates: new FakeCandidates([]),
      browser,
      purpose: verificationPurpose(),
      initialPath: null,
    });
    session.enterBrowserPath("/库");

    await session.selectCurrentDirectory();
    expect(session.snapshot().draftSelection).toEqual({
      kind: "directory",
      selectedPath: "/库",
      effectiveRoot: "/库",
    });
    await session.selectCategory("/库/普通目录");
    expect(session.snapshot()).toMatchObject({
      draftSelection: null,
      statusCode: "conflict",
    });

    session.highlightBrowserPath(null);
    await session.selectHighlightedDirectory();
    expect(session.snapshot().draftSelection).toBeNull();
    session.highlightBrowserPath("/库/不在当前层");
    expect(session.snapshot().browserHighlightedPath).toBeNull();
    await session.selectCategory("/库/不在当前层");
    expect(session.snapshot().draftSelection).toBeNull();
  });

  it("aborts a stale browser layer and lets the newest path win without clearing shared cache", async () => {
    const pending: Array<Readonly<{
      path: string;
      resolve: (value: CloudDirectoryBrowseRound) => void;
    }>> = [];
    const browser = new FakeBrowser();
    browser.load = async (input) => new Promise((resolve) => {
      pending.push({ path: input.path, resolve });
    });
    const session = createCloudDirectoryPickerSession({
      candidates: new FakeCandidates([]),
      browser,
      purpose: { kind: "scan" },
      initialPath: null,
    });

    session.enterBrowserPath("/A");
    session.enterBrowserPath("/B");
    expect(browser.signals[0]?.aborted).toBe(true);
    browser.layers.set("/B", layer("/B", [directory("/B/Current")]));
    browser.emit("/B");
    pending[1]!.resolve(round("/B"));
    await vi.waitFor(() => expect(session.snapshot().browserActivity).toBe("complete"));
    browser.layers.set("/A", layer("/A", [directory("/A/Stale")]));
    pending[0]!.resolve(round("/A"));
    await flush();

    expect(session.snapshot().browserPath).toBe("/B");
    expect(session.snapshot().visibleBrowserDirectories.map((item) => item.path))
      .toEqual(["/B/Current"]);
    session.dispose();
    expect(browser.layers.has("/A")).toBe(true);
    expect(browser.layers.has("/B")).toBe(true);
    expect(browser.clearCalls).toBe(0);
    expect(browser.disposeCalls).toBe(0);
  });

  it("clears the previous layer when a new path snapshot throws", () => {
    const browser = new FakeBrowser();
    browser.layers.set("/A", layer("/A", [directory("/A/Old")]));
    const session = createCloudDirectoryPickerSession({
      candidates: new FakeCandidates([]),
      browser,
      purpose: { kind: "scan" },
      initialPath: null,
    });

    session.enterBrowserPath("/A");
    expect(session.snapshot().visibleBrowserDirectories.map((item) => item.path))
      .toEqual(["/A/Old"]);
    browser.snapshotFailures.add("/B");
    session.enterBrowserPath("/B");

    expect(session.snapshot()).toMatchObject({
      browserPath: "/B",
      browserLayer: null,
      browserHighlightedPath: null,
      visibleBrowserDirectories: [],
      browserActivity: "error",
      statusCode: "browser-error",
      browserDetail: { fixedError: "browser-unavailable" },
    });
    expect(JSON.stringify(session.snapshot())).not.toContain("/A/Old");
    expect(JSON.stringify(session.snapshot())).not.toContain("private-browser-snapshot-detail");
  });

  it("cancels one browser run without closing the session or accepting its late result", async () => {
    let resolveLoad!: (value: CloudDirectoryBrowseRound) => void;
    const browser = new FakeBrowser();
    browser.load = async () => new Promise((resolve) => { resolveLoad = resolve; });
    const session = createCloudDirectoryPickerSession({
      candidates: new FakeCandidates([]),
      browser,
      purpose: { kind: "scan" },
      initialPath: null,
    });

    session.enterBrowserPath("/Cancelable");
    expect(session.snapshot().browserActivity).toBe("running");
    session.cancelBrowser();
    expect(browser.signals[0]?.aborted).toBe(true);
    expect(session.snapshot()).toMatchObject({
      phase: "browsing",
      browserActivity: "canceled",
      statusCode: "browser-incomplete",
      browserDetail: { round: { stopReason: "user-canceled" } },
    });
    browser.layers.set("/Cancelable", layer("/Cancelable", [directory("/Cancelable/Late")]));
    browser.emit("/Cancelable");
    resolveLoad(round("/Cancelable"));
    await flush();
    expect(session.snapshot().browserActivity).toBe("canceled");
    expect(session.snapshot().visibleBrowserDirectories).toEqual([]);
  });

  it("retries a failed browser layer at its exact cursor without exposing the failure", async () => {
    const browser = new FakeBrowser();
    let attempt = 0;
    browser.load = async (input) => {
      attempt += 1;
      if (attempt === 1) throw new Error("private-browser-response-and-token");
      browser.layers.set(input.path, layer(input.path, [directory(`${input.path}/Recovered`)]));
      browser.emit(input.path);
      return round(input.path);
    };
    const session = createCloudDirectoryPickerSession({
      candidates: new FakeCandidates([]),
      browser,
      purpose: { kind: "scan" },
      initialPath: null,
    });

    session.enterBrowserPath("/Retry");
    await vi.waitFor(() => expect(session.snapshot().browserActivity).toBe("error"));
    expect(session.snapshot()).toMatchObject({
      statusCode: "browser-error",
      browserDetail: { round: null, fixedError: "load-failed" },
    });
    expect(JSON.stringify(session.snapshot())).not.toContain("private-browser-response-and-token");
    await session.retryBrowser();
    expect(browser.loads).toEqual([
      { path: "/Retry", start: 0 },
      { path: "/Retry", start: 0 },
    ]);
    expect(session.snapshot().browserActivity).toBe("complete");
    expect(session.snapshot().visibleBrowserDirectories.map((item) => item.path))
      .toEqual(["/Retry/Recovered"]);
  });

  it("keeps a 20,000-directory visible array stable across snapshots and highlight changes", () => {
    const browser = new FakeBrowser();
    const directories = Object.freeze(Array.from({ length: 20_000 }, (_, index) => Object.freeze(
      directory(`/压力/F${index}`, index + 1),
    )));
    browser.layers.set("/压力", layer("/压力", directories));
    const session = createCloudDirectoryPickerSession({
      candidates: new FakeCandidates([]),
      browser,
      purpose: { kind: "scan" },
      initialPath: null,
    });

    session.enterBrowserPath("/压力");
    const first = session.snapshot().visibleBrowserDirectories;
    expect(first).toHaveLength(20_000);
    session.highlightBrowserPath("/压力/F19999");
    expect(session.snapshot().visibleBrowserDirectories).toBe(first);
    expect(session.snapshot().browserLayer?.directories).toBe(first);
    session.setQuery("F19999");
    const filtered = session.snapshot().visibleBrowserDirectories;
    expect(filtered).toHaveLength(1);
    expect(session.snapshot().browserHighlightedPath).toBe("/压力/F19999");
    expect(session.snapshot().visibleBrowserDirectories).toBe(filtered);
    session.setQuery("没有匹配项");
    expect(session.snapshot().visibleBrowserDirectories).toEqual([]);
    expect(session.snapshot().browserHighlightedPath).toBeNull();
  });

  it("keeps a failed remember recoverable and never reports a successful selection", async () => {
    const candidates = new FakeCandidates([exact("/库/Chosen")]);
    candidates.rememberFailure = new Error("private-storage-detail");
    const session = createCloudDirectoryPickerSession({
      candidates,
      purpose: { kind: "scan" },
      initialPath: null,
    });
    session.selectCandidate("/库/Chosen");

    await expect(session.useSelection()).resolves.toBeNull();
    expect(session.snapshot()).toMatchObject({
      phase: "local",
      statusCode: "save-failed",
      draftSelection: {
        kind: "directory",
        selectedPath: "/库/Chosen",
        effectiveRoot: "/库/Chosen",
      },
    });
    expect(JSON.stringify(session.snapshot())).not.toContain("private-storage-detail");
    candidates.rememberFailure = null;
    await expect(session.useSelection()).resolves.toEqual({
      kind: "directory",
      selectedPath: "/库/Chosen",
      effectiveRoot: "/库/Chosen",
    });
    expect(candidates.rememberCalls).toEqual(["/库/Chosen", "/库/Chosen"]);
  });

  it("clears recent entries without lookup and maps failure to a closed status code", async () => {
    const candidates = new FakeCandidates([
      exact("/库/Recent"),
      exact("/库/Cached", "session-cache"),
    ]);
    const locator = new FakeLocator(async () => { throw new Error("must-not-locate"); });
    const session = createCloudDirectoryPickerSession({
      candidates,
      locator,
      purpose: { kind: "scan" },
      initialPath: null,
    });

    await session.clearRecent();
    expect(candidates.clearCalls).toBe(1);
    expect(locator.calls).toEqual([]);
    expect(session.snapshot().rankedCandidates.some((item) => (
      item.candidate.kind === "exact" && item.candidate.path === "/库/Recent"
    ))).toBe(false);
    candidates.clearFailure = new Error("private-clear-detail");
    await session.clearRecent();
    expect(session.snapshot().statusCode).toBe("save-failed");
    expect(JSON.stringify(session.snapshot())).not.toContain("private-clear-detail");
  });

  it("aborts async work, discards drafts, and notifies subscribers only while live", async () => {
    let resolveLookup!: (value: CloudDirectoryLocatorSummary) => void;
    const locator = new FakeLocator(async () => new Promise((resolve) => {
      resolveLookup = resolve;
    }));
    const session = createCloudDirectoryPickerSession({
      candidates: new FakeCandidates([exact("/库/Chosen")]),
      locator,
      purpose: { kind: "scan" },
      initialPath: null,
    });
    const listener = vi.fn();
    session.subscribe(listener);
    session.selectCandidate("/库/Chosen");
    session.setQuery("Science");
    session.requestLookupConsent();
    const pending = session.confirmLookup();
    session.cancel();
    session.dispose();
    expect(locator.signals[0]?.aborted).toBe(true);
    expect(session.snapshot()).toMatchObject({
      phase: "closed",
      draftSelection: null,
      selectedPath: null,
    });
    const beforeLate = listener.mock.calls.length;
    resolveLookup(summary("Science", [exact("/Late/Science", "cloud-locator")]));
    await pending;
    await flush();
    expect(listener).toHaveBeenCalledTimes(beforeLate);
    await expect(session.useSelection()).resolves.toBeNull();
    expect(locator.cancelCalls).toBe(0);
    expect(locator.disposeCalls).toBe(0);
  });

  it("drops an uncommitted draft when canceled", async () => {
    const candidates = new FakeCandidates([exact("/库/Chosen")]);
    const session = createCloudDirectoryPickerSession({
      candidates,
      purpose: { kind: "scan" },
      initialPath: null,
    });
    session.selectCandidate("/库/Chosen");
    expect(session.snapshot().draftSelection).not.toBeNull();
    session.cancel();
    expect(session.snapshot()).toMatchObject({
      phase: "closed",
      selectedPath: null,
      draftSelection: null,
    });
    expect(candidates.rememberCalls).toEqual([]);
    await expect(session.useSelection()).resolves.toBeNull();
  });

  it("settles one concurrent use and does not let cancel bind a stale result", async () => {
    let release!: () => void;
    const candidates = new FakeCandidates([exact("/库/Chosen")]);
    candidates.beforeRemember = () => new Promise<void>((resolve) => { release = resolve; });
    const session = createCloudDirectoryPickerSession({
      candidates,
      purpose: { kind: "scan" },
      initialPath: null,
    });
    session.selectCandidate("/库/Chosen");

    const first = session.useSelection();
    const second = session.useSelection();
    expect(candidates.rememberCalls).toEqual(["/库/Chosen"]);
    session.cancel();
    release();
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    expect(session.snapshot().phase).toBe("closed");
  });

  it("shares one successful remember operation across concurrent use calls", async () => {
    let release!: () => void;
    const candidates = new FakeCandidates([exact("/库/Chosen")]);
    candidates.beforeRemember = () => new Promise<void>((resolve) => { release = resolve; });
    const session = createCloudDirectoryPickerSession({
      candidates,
      purpose: { kind: "scan" },
      initialPath: null,
    });
    session.selectCandidate("/库/Chosen");

    const first = session.useSelection();
    const second = session.useSelection();
    expect(candidates.rememberCalls).toEqual(["/库/Chosen"]);
    release();
    await expect(first).resolves.toEqual({
      kind: "directory",
      selectedPath: "/库/Chosen",
      effectiveRoot: "/库/Chosen",
    });
    await expect(second).resolves.toEqual({
      kind: "directory",
      selectedPath: "/库/Chosen",
      effectiveRoot: "/库/Chosen",
    });
    expect(candidates.rememberCalls).toEqual(["/库/Chosen"]);
  });
});
