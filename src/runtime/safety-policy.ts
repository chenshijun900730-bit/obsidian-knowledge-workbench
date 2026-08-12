import type { PluginSettings } from "../storage/plugin-data";

export type BuildMode = "normal" | "read-only-acceptance";

export interface RuntimeSafetyPolicy {
  readonly mode: BuildMode;
  readonly contentWrites: "allowed" | "blocked";
  readonly quickCapture: "allowed" | "blocked";
  readonly planConfirmation: "allowed" | "blocked";
  readonly history: "full" | "aggregate-only";
  readonly configuration: "mutable" | "read-only";
  readonly ai: "available" | "blocked";
  readonly network: "allowed" | "blocked";
}

export const NORMAL_RUNTIME_POLICY: RuntimeSafetyPolicy = Object.freeze({
  mode: "normal",
  contentWrites: "allowed",
  quickCapture: "allowed",
  planConfirmation: "allowed",
  history: "full",
  configuration: "mutable",
  ai: "available",
  network: "allowed",
});

export const READ_ONLY_ACCEPTANCE_POLICY: RuntimeSafetyPolicy = Object.freeze({
  mode: "read-only-acceptance",
  contentWrites: "blocked",
  quickCapture: "blocked",
  planConfirmation: "blocked",
  history: "aggregate-only",
  configuration: "read-only",
  ai: "blocked",
  network: "blocked",
});

export function policyFor(mode: BuildMode): RuntimeSafetyPolicy {
  if (mode === "normal") return NORMAL_RUNTIME_POLICY;
  if (mode === "read-only-acceptance") return READ_ONLY_ACCEPTANCE_POLICY;
  throw new Error("Unsupported runtime mode");
}

export function effectiveSettings(
  policy: RuntimeSafetyPolicy,
  settings: PluginSettings,
): PluginSettings {
  return policy.mode === "normal"
    ? structuredClone(settings)
    : { ...structuredClone(settings), writeEnabled: false, aiEnabled: false };
}

export function normalOnly<T>(
  policy: RuntimeSafetyPolicy,
  factory: () => T,
): T | undefined {
  return policy.mode === "normal" ? factory() : undefined;
}
