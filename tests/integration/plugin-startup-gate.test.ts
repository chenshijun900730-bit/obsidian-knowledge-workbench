import { describe, expect, it, vi } from "vitest";
import {
  createCaseSensitiveArtifactPort,
  runStartupGate,
} from "../../src/runtime/startup-gate";
import { closeObsidianSettingsIfSupported } from "../../src/adapters/obsidian-workspace-adapter";

describe("plugin startup gate", () => {
  it("finishes binding and durable normalization before composition", async () => {
    const order: string[] = [];
    const store = { id: "store" };

    const result = await runStartupGate({
      verifyArtifact: async () => { order.push("verify"); },
      loadStore: async () => { order.push("load"); return store; },
      enforcePolicy: async (value) => {
        expect(value).toBe(store);
        order.push("normalize");
      },
    });
    order.push("compose");

    expect(result).toBe(store);
    expect(order).toEqual(["verify", "load", "normalize", "compose"]);
  });

  it.each(["verify", "load", "normalize"] as const)(
    "does not reach composition after %s failure",
    async (failure) => {
      const compose = vi.fn();

      await expect(runStartupGate({
        verifyArtifact: async () => {
          if (failure === "verify") throw new Error("blocked");
        },
        loadStore: async () => {
          if (failure === "load") throw new Error("blocked");
          return {};
        },
        enforcePolicy: async () => {
          if (failure === "normalize") throw new Error("blocked");
        },
      }).then(compose)).rejects.toThrow("blocked");

      expect(compose).not.toHaveBeenCalled();
    },
  );

  it("checks installed artifact paths case-sensitively", async () => {
    const exists = vi.fn(async () => true);
    const read = vi.fn(async () => "metadata");
    const port = createCaseSensitiveArtifactPort({ exists, read });

    await expect(port.exists("Config/plugins/knowledge-workbench/main.js"))
      .resolves.toBe(true);
    await expect(port.read("Config/plugins/knowledge-workbench/acceptance-build.json"))
      .resolves.toBe("metadata");

    expect(exists).toHaveBeenCalledWith(
      "Config/plugins/knowledge-workbench/main.js",
      true,
    );
    expect(read).toHaveBeenCalledWith(
      "Config/plugins/knowledge-workbench/acceptance-build.json",
    );
  });

  it("feature-checks the host Settings close capability without DOM guessing", () => {
    const close = vi.fn();
    expect(closeObsidianSettingsIfSupported({ setting: { close } } as never)).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(closeObsidianSettingsIfSupported({} as never)).toBe(false);
  });
});
