import type { AiClientPort, AiCompletionInput } from "../../src/core/ports";

export class FakeAiClient implements AiClientPort {
  readonly calls: AiCompletionInput[] = [];

  constructor(private readonly outcomes: readonly (Readonly<{ text: string }> | Error)[] = [{ text: "AI text" }]) {}

  async complete(input: AiCompletionInput): Promise<Readonly<{ text: string }>> {
    this.calls.push(structuredClone(input));
    const outcome = this.outcomes[this.calls.length - 1] ?? this.outcomes.at(-1) ?? { text: "AI text" };
    if (outcome instanceof Error) throw outcome;
    return structuredClone(outcome);
  }
}
