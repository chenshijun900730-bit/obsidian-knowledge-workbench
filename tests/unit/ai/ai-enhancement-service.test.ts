import { describe, expect, it } from "vitest";
import {
  AiClientError,
  AiEnhancementService,
} from "../../../src/ai/ai-enhancement-service";
import { FakeAiClient } from "../../fakes/fake-ai-client";

const note = (path: string, content: string) => ({ path, content });

describe("AiEnhancementService", () => {
  it("allows exactly 20 notes and 100000 transmitted characters", async () => {
    const client = new FakeAiClient([{ text: "bounded" }]);
    const notes = Array.from({ length: 20 }, (_, index) => note(`${index}.md`, "x".repeat(5_000)));

    await expect(new AiEnhancementService(client, async () => undefined).summarize(notes))
      .resolves.toEqual({ kind: "ok", value: "bounded" });
    expect(client.calls).toHaveLength(1);
  });

  it.each([
    [Array.from({ length: 21 }, (_, index) => note(`${index}.md`, "x"))],
    [[note("a.md", "x".repeat(100_001))]],
  ])("rejects a selection over either hard limit before calling the client", async (notes) => {
    const client = new FakeAiClient();
    await expect(new AiEnhancementService(client, async () => undefined).summarize(notes))
      .resolves.toEqual({ kind: "local-fallback", reason: "selection-limit" });
    expect(client.calls).toHaveLength(0);
  });

  it.each(["network", "server"] as const)("retries %s once after 250 ms", async (category) => {
    const client = new FakeAiClient([new AiClientError(category, category === "server" ? 503 : 0), { text: "retry-ok" }]);
    const delays: number[] = [];
    const result = await new AiEnhancementService(client, async (milliseconds) => { delays.push(milliseconds); })
      .explainRelation([note("a.md", "a")]);
    expect(result).toEqual({ kind: "ok", value: "retry-ok" });
    expect(delays).toEqual([250]);
    expect(client.calls).toHaveLength(2);
  });

  it.each(["timeout", "auth", "rate-limit", "request", "malformed"] as const)("does not retry %s", async (category) => {
    const client = new FakeAiClient([new AiClientError(category, 400), { text: "must-not-run" }]);
    const result = await new AiEnhancementService(client, async () => undefined).nameCluster([note("a.md", "a")]);
    expect(result).toEqual({ kind: "local-fallback", reason: "service-unavailable" });
    expect(client.calls).toHaveLength(1);
  });

  it("rechecks action validity after retry delay", async () => {
    let valid = true;
    const client = new FakeAiClient([new AiClientError("network", 0), { text: "must-not-run" }]);
    const service = new AiEnhancementService(client, async () => { valid = false; }, () => valid);
    await expect(service.suggestLabels([note("a.md", "a")]))
      .resolves.toEqual({ kind: "local-fallback", reason: "action-invalidated" });
    expect(client.calls).toHaveLength(1);
  });

  it("rechecks validity immediately after the first network boundary before delaying", async () => {
    let valid = true;
    let delays = 0;
    const client = {
      calls: 0,
      async complete(): Promise<Readonly<{ text: string }>> {
        this.calls += 1;
        valid = false;
        throw new AiClientError("network", 0);
      },
    };
    const service = new AiEnhancementService(client, async () => { delays += 1; }, () => valid);
    await expect(service.summarize([note("a.md", "a")]))
      .resolves.toEqual({ kind: "local-fallback", reason: "action-invalidated" });
    expect(delays).toBe(0);
    expect(client.calls).toBe(1);
  });

  it("sanitizes the second failure", async () => {
    const secret = "sk-private-value";
    const client = new FakeAiClient([new AiClientError("server", 503), new Error(secret)]);
    const result = await new AiEnhancementService(client, async () => undefined).summarize([note("a.md", "a")]);
    expect(result).toEqual({ kind: "local-fallback", reason: "service-unavailable" });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("does not retry a huge 5xx response after the adapter classifies it as malformed", async () => {
    let calls = 0;
    let delays = 0;
    const client = {
      async complete(): Promise<Readonly<{ text: string }>> {
        calls += 1;
        throw new AiClientError("malformed", 503);
      },
    };
    await expect(new AiEnhancementService(client, async () => { delays += 1; }).summarize([note("A.md", "a")]))
      .resolves.toEqual({ kind: "local-fallback", reason: "service-unavailable" });
    expect({ calls, delays }).toEqual({ calls: 1, delays: 0 });
  });

  it.each([
    Object.assign([note("a.md", "a")], { extra: true }),
    [Object.assign(note("a.md", "a"), { extra: true })],
    (() => { const value: unknown[] = []; value.push(value); return value; })(),
    new Proxy([note("a.md", "a")], { ownKeys: () => { throw new Error("hostile"); } }),
  ])("rejects hostile or non-exact payloads before the client", async (input) => {
    const client = new FakeAiClient();
    await expect(new AiEnhancementService(client, async () => undefined).summarize(input as never))
      .resolves.toEqual({ kind: "local-fallback", reason: "invalid-selection" });
    expect(client.calls).toHaveLength(0);
  });

  it("rejects accessors even when they return valid-looking note data", async () => {
    const getterNote: Record<string, unknown> = { path: "a.md" };
    Object.defineProperty(getterNote, "content", { enumerable: true, get: () => "private body" });
    const client = new FakeAiClient();
    await expect(new AiEnhancementService(client, async () => undefined).summarize([getterNote] as never))
      .resolves.toEqual({ kind: "local-fallback", reason: "invalid-selection" });
    expect(client.calls).toHaveLength(0);
  });

  it.each([
    new Proxy([note("a.md", "a")], {}),
    (() => {
      const notes: unknown[] = [note("a.md", "a")];
      Object.defineProperty(notes, "0", { enumerable: true, get: () => note("a.md", "a") });
      return notes;
    })(),
  ])("rejects transparent proxies and array index accessors", async (input) => {
    const client = new FakeAiClient();
    await expect(new AiEnhancementService(client, async () => undefined).summarize(input as never))
      .resolves.toEqual({ kind: "local-fallback", reason: "invalid-selection" });
    expect(client.calls).toHaveLength(0);
  });

  it.each([
    { input: [note("../A.md", "a")] },
    { input: [note("Folder/../A.md", "a")] },
    { input: [note("Bad\u0000/A.md", "a")] },
    { input: [note("A.md", "a"), note("A.md", "b")] },
  ])("rejects unsafe or duplicate paths before calling the client", async ({ input }) => {
    const client = new FakeAiClient();
    await expect(new AiEnhancementService(client, async () => undefined).summarize(input))
      .resolves.toEqual({ kind: "local-fallback", reason: "invalid-selection" });
    expect(client.calls).toHaveLength(0);
  });

  it("rejects a transparent proxy response as malformed", async () => {
    const client = { complete: async () => new Proxy({ text: "looks valid" }, {}) };
    await expect(new AiEnhancementService(client, async () => undefined).summarize([note("A.md", "a")]))
      .resolves.toEqual({ kind: "local-fallback", reason: "service-unavailable" });
  });

  it("enforces action-specific text output schemas", async () => {
    const client = new FakeAiClient([{ text: "x".repeat(4_097) }]);
    await expect(new AiEnhancementService(client, async () => undefined).summarize([note("a.md", "a")]))
      .resolves.toEqual({ kind: "local-fallback", reason: "service-unavailable" });
    const carriageReturn = new FakeAiClient([{ text: "unsafe\routput" }]);
    await expect(new AiEnhancementService(carriageReturn, async () => undefined).summarize([note("a.md", "a")]))
      .resolves.toEqual({ kind: "local-fallback", reason: "service-unavailable" });
  });
});
