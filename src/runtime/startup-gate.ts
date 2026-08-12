import type { HostArtifactPort } from "./artifact-binding";

export interface StartupGateDependencies<T> {
  readonly verifyArtifact: () => Promise<void>;
  readonly loadStore: () => Promise<T>;
  readonly enforcePolicy: (store: T) => Promise<void>;
}

export async function runStartupGate<T>(
  dependencies: StartupGateDependencies<T>,
): Promise<T> {
  await dependencies.verifyArtifact();
  const store = await dependencies.loadStore();
  await dependencies.enforcePolicy(store);
  return store;
}

export interface CaseSensitiveArtifactAdapter {
  exists(path: string, sensitive?: boolean): Promise<boolean>;
  read(path: string): Promise<string>;
}

export function createCaseSensitiveArtifactPort(
  adapter: CaseSensitiveArtifactAdapter,
): HostArtifactPort {
  return {
    exists: (path) => adapter.exists(path, true),
    read: (path) => adapter.read(path),
  };
}
