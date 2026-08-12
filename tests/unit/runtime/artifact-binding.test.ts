import { describe, expect, it, vi } from "vitest";
import {
  decodeAcceptanceBuildMetadata,
  verifyArtifactBinding,
  type ArtifactExpectation,
  type HostArtifactPort,
  type HostPluginManifest,
} from "../../../src/runtime/artifact-binding";

const FAILURE_PREFIX = "Knowledge Workbench artifact binding failed:";
const PLUGIN_DIR = "config/plugins/knowledge-workbench";

const normalExpectation: ArtifactExpectation = Object.freeze({
  mode: "normal",
  pluginVersion: "0.1.0",
  manifestName: "Knowledge Workbench",
  artifactBinding: "knowledge-workbench@0.1.0:normal",
});

const acceptanceExpectation: ArtifactExpectation = Object.freeze({
  mode: "read-only-acceptance",
  pluginVersion: "0.1.0",
  manifestName: "Knowledge Workbench (Read-only acceptance)",
  artifactBinding: "knowledge-workbench@0.1.0:read-only-acceptance",
});

const normalManifest: HostPluginManifest = Object.freeze({
  id: "knowledge-workbench",
  name: "Knowledge Workbench",
  version: "0.1.0",
  dir: PLUGIN_DIR,
});

const acceptanceManifest: HostPluginManifest = Object.freeze({
  id: "knowledge-workbench",
  name: "Knowledge Workbench (Read-only acceptance)",
  version: "0.1.0",
  dir: PLUGIN_DIR,
});

const acceptanceMetadata = Object.freeze({
  schemaVersion: 1,
  pluginVersion: "0.1.0",
  buildMode: "read-only-acceptance",
  artifactBinding: "knowledge-workbench@0.1.0:read-only-acceptance",
  contentWrites: "blocked",
  network: "blocked",
});

const installedPath = (file: string): string => `${PLUGIN_DIR}/${file}`;

const normalFiles = (): Record<string, string> => ({
  [installedPath("main.js")]: "normal bundle",
  [installedPath("manifest.json")]: "{}",
  [installedPath("styles.css")]: "styles",
});

const acceptanceFiles = (metadata: unknown = acceptanceMetadata): Record<string, string> => ({
  [installedPath("main.js")]: "acceptance bundle",
  [installedPath("manifest.json")]: "{}",
  [installedPath("styles.css")]: "styles",
  [installedPath("acceptance-build.json")]: typeof metadata === "string" ? metadata : JSON.stringify(metadata),
});

class FakeHostArtifactPort implements HostArtifactPort {
  readonly existsCalls: string[] = [];
  readonly readCalls: string[] = [];

  constructor(
    private readonly files: Readonly<Record<string, string>>,
    private readonly failures: Readonly<{
      existsAt?: string;
      existsFailure?: unknown;
      readAt?: string;
      readFailure?: unknown;
    }> = {},
  ) {}

  async exists(path: string): Promise<boolean> {
    this.existsCalls.push(path);
    if (path === this.failures.existsAt) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- hostile rejection values are the behavior under test
      return Promise.reject(this.failures.existsFailure ?? new Error("Injected artifact exists failure"));
    }
    return Object.prototype.hasOwnProperty.call(this.files, path);
  }

  async read(path: string): Promise<string> {
    this.readCalls.push(path);
    if (path === this.failures.readAt) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- hostile rejection values are the behavior under test
      return Promise.reject(this.failures.readFailure ?? new Error("Injected artifact read failure"));
    }
    const value = this.files[path];
    if (value === undefined) throw new Error(`Missing fake artifact: ${path}`);
    return value;
  }
}

const errorWithThrowingMessage = (): Error => {
  const error = new Error("unreachable message");
  Object.defineProperty(error, "message", {
    configurable: true,
    get: () => { throw new Error("hostile message getter"); },
  });
  return error;
};

const errorWithNonStringMessage = (): Error => {
  const error = new Error("unreachable message");
  Object.defineProperty(error, "message", {
    configurable: true,
    value: 42,
  });
  return error;
};

const revokedProxy = (): object => {
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  return revocable.proxy;
};

async function expectRejectedBeforeRegistration(
  manifest: HostPluginManifest,
  port: HostArtifactPort,
  expectation: ArtifactExpectation,
): Promise<void> {
  const registerHostSurface = vi.fn();
  await expect((async () => {
    await verifyArtifactBinding(manifest, port, expectation);
    registerHostSurface();
  })()).rejects.toThrow(new RegExp(`^${FAILURE_PREFIX}`));
  expect(registerHostSurface).not.toHaveBeenCalled();
}

describe("artifact binding", () => {
  it("accepts the complete bound acceptance set using full installed paths", async () => {
    const port = new FakeHostArtifactPort({
      ...acceptanceFiles(),
      [installedPath("data.json")]: "ordinary plugin-local data is allowed",
    });

    await expect(verifyArtifactBinding(
      acceptanceManifest,
      port,
      acceptanceExpectation,
    )).resolves.toBeUndefined();

    expect(port.existsCalls).toEqual([
      installedPath("main.js"),
      installedPath("manifest.json"),
      installedPath("styles.css"),
      installedPath("acceptance-build.json"),
    ]);
    expect(port.readCalls).toEqual([installedPath("acceptance-build.json")]);
    expect(port.existsCalls).not.toContain("main.js");
  });

  it("accepts a coherent normal set and does not read acceptance metadata", async () => {
    const port = new FakeHostArtifactPort(normalFiles());

    await expect(verifyArtifactBinding(normalManifest, port, normalExpectation))
      .resolves.toBeUndefined();

    expect(port.readCalls).toEqual([]);
  });

  it.each([
    {
      name: "normal runtime with stale acceptance metadata",
      manifest: normalManifest,
      files: { ...normalFiles(), [installedPath("acceptance-build.json")]: JSON.stringify(acceptanceMetadata) },
      expectation: normalExpectation,
    },
    {
      name: "acceptance runtime without acceptance metadata",
      manifest: acceptanceManifest,
      files: normalFiles(),
      expectation: acceptanceExpectation,
    },
  ])("rejects the cross-mix: $name", async ({ manifest, files, expectation }) => {
    await expectRejectedBeforeRegistration(
      manifest,
      new FakeHostArtifactPort(files),
      expectation,
    );
  });

  it.each([
    { name: "missing directory", dir: undefined },
    { name: "absolute directory", dir: "/config/plugins/knowledge-workbench" },
    { name: "Windows separators", dir: "config\\plugins\\knowledge-workbench" },
    { name: "trailing slash", dir: "config/plugins/knowledge-workbench/" },
    { name: "empty segment", dir: "config//plugins/knowledge-workbench" },
    { name: "current-directory segment", dir: "config/./plugins/knowledge-workbench" },
    { name: "parent-directory segment", dir: "config/plugins/../knowledge-workbench" },
    { name: "drive-relative prefix", dir: "C:config/plugins/knowledge-workbench" },
    { name: "colon in a segment", dir: "config/plugins:preview/knowledge-workbench" },
    { name: "C0 control character", dir: `config/${String.fromCharCode(1)}plugins/knowledge-workbench` },
    { name: "C1 control character", dir: `config/${String.fromCharCode(0x85)}plugins/knowledge-workbench` },
    { name: "segment ending in a dot", dir: "config./plugins/knowledge-workbench" },
    { name: "segment ending in a space", dir: "config /plugins/knowledge-workbench" },
    { name: "wrong final segment", dir: "config/plugins/other-plugin" },
  ])("rejects a non-normalized manifest directory: $name", async ({ dir }) => {
    const port = new FakeHostArtifactPort(normalFiles());
    await expectRejectedBeforeRegistration(
      { ...normalManifest, dir },
      port,
      normalExpectation,
    );
    expect(port.existsCalls).toEqual([]);
  });

  it.each([
    { name: "plugin ID", manifest: { ...acceptanceManifest, id: "other-plugin" } },
    { name: "display name", manifest: { ...acceptanceManifest, name: "Knowledge Workbench" } },
    { name: "version", manifest: { ...acceptanceManifest, version: "0.1.1" } },
  ])("rejects the wrong manifest $name", async ({ manifest }) => {
    await expectRejectedBeforeRegistration(
      manifest,
      new FakeHostArtifactPort(acceptanceFiles()),
      acceptanceExpectation,
    );
  });

  it.each([
    "main.js",
    "manifest.json",
    "styles.css",
    "acceptance-build.json",
  ])("rejects an acceptance set missing %s", async (missing) => {
    const files = acceptanceFiles();
    delete files[installedPath(missing)];
    await expectRejectedBeforeRegistration(
      acceptanceManifest,
      new FakeHostArtifactPort(files),
      acceptanceExpectation,
    );
  });

  it.each(Object.keys(acceptanceMetadata))(
    "rejects acceptance metadata missing %s",
    async (missing) => {
      const metadata = { ...acceptanceMetadata } as Record<string, unknown>;
      delete metadata[missing];
      await expectRejectedBeforeRegistration(
        acceptanceManifest,
        new FakeHostArtifactPort(acceptanceFiles(metadata)),
        acceptanceExpectation,
      );
    },
  );

  it("rejects an extra acceptance metadata key", async () => {
    await expectRejectedBeforeRegistration(
      acceptanceManifest,
      new FakeHostArtifactPort(acceptanceFiles({ ...acceptanceMetadata, unexpected: true })),
      acceptanceExpectation,
    );
  });

  it.each([
    { key: "schemaVersion", value: "1" },
    { key: "pluginVersion", value: 1 },
    { key: "buildMode", value: null },
    { key: "artifactBinding", value: [] },
    { key: "contentWrites", value: 0 },
    { key: "network", value: {} },
  ])("rejects the wrong metadata type for $key", async ({ key, value }) => {
    await expectRejectedBeforeRegistration(
      acceptanceManifest,
      new FakeHostArtifactPort(acceptanceFiles({ ...acceptanceMetadata, [key]: value })),
      acceptanceExpectation,
    );
  });

  it.each([
    { key: "schemaVersion", value: 2 },
    { key: "buildMode", value: "normal" },
    { key: "contentWrites", value: "allowed" },
    { key: "network", value: "allowed" },
    { key: "artifactBinding", value: "knowledge-workbench@0.1.0:normal" },
  ])("rejects the wrong metadata value for $key", async ({ key, value }) => {
    await expectRejectedBeforeRegistration(
      acceptanceManifest,
      new FakeHostArtifactPort(acceptanceFiles({ ...acceptanceMetadata, [key]: value })),
      acceptanceExpectation,
    );
  });

  it("rejects self-consistent metadata for a different plugin version", async () => {
    await expectRejectedBeforeRegistration(
      acceptanceManifest,
      new FakeHostArtifactPort(acceptanceFiles({
        ...acceptanceMetadata,
        pluginVersion: "0.1.1",
        artifactBinding: "knowledge-workbench@0.1.1:read-only-acceptance",
      })),
      acceptanceExpectation,
    );
  });

  it.each([
    {
      name: "normal display name in acceptance mode",
      expectation: { ...acceptanceExpectation, manifestName: "Knowledge Workbench" },
    },
    {
      name: "acceptance display name in normal mode",
      expectation: { ...normalExpectation, manifestName: "Knowledge Workbench (Read-only acceptance)" },
    },
    {
      name: "wrong normal binding",
      expectation: { ...normalExpectation, artifactBinding: "knowledge-workbench@0.1.0:read-only-acceptance" },
    },
    {
      name: "wrong acceptance binding",
      expectation: { ...acceptanceExpectation, artifactBinding: "knowledge-workbench@0.1.0:normal" },
    },
    {
      name: "empty version",
      expectation: { ...acceptanceExpectation, pluginVersion: "", artifactBinding: "knowledge-workbench@:read-only-acceptance" },
    },
    {
      name: "invalid prerelease version",
      expectation: {
        ...acceptanceExpectation,
        pluginVersion: "0.1.0-alpha..1",
        artifactBinding: "knowledge-workbench@0.1.0-alpha..1:read-only-acceptance",
      },
    },
    {
      name: "unsupported mode",
      expectation: { ...acceptanceExpectation, mode: "unexpected" },
    },
  ])("rejects an incoherent compiled expectation: $name", async ({ expectation }) => {
    const port = new FakeHostArtifactPort(acceptanceFiles());
    await expectRejectedBeforeRegistration(
      acceptanceManifest,
      port,
      expectation as ArtifactExpectation,
    );
    expect(port.existsCalls).toEqual([]);
  });

  it("prefixes an artifact existence port error", async () => {
    const path = installedPath("main.js");
    await expectRejectedBeforeRegistration(
      acceptanceManifest,
      new FakeHostArtifactPort(acceptanceFiles(), { existsAt: path }),
      acceptanceExpectation,
    );
  });

  it("prefixes an artifact read port error", async () => {
    const path = installedPath("acceptance-build.json");
    await expectRejectedBeforeRegistration(
      acceptanceManifest,
      new FakeHostArtifactPort(acceptanceFiles(), { readAt: path }),
      acceptanceExpectation,
    );
  });

  it("prefixes a revoked Proxy rejected by the artifact existence port", async () => {
    const path = installedPath("main.js");
    await expectRejectedBeforeRegistration(
      acceptanceManifest,
      new FakeHostArtifactPort(acceptanceFiles(), {
        existsAt: path,
        existsFailure: revokedProxy(),
      }),
      acceptanceExpectation,
    );
  });

  it("prefixes an artifact existence error whose message getter throws", async () => {
    const path = installedPath("main.js");
    await expectRejectedBeforeRegistration(
      acceptanceManifest,
      new FakeHostArtifactPort(acceptanceFiles(), {
        existsAt: path,
        existsFailure: errorWithThrowingMessage(),
      }),
      acceptanceExpectation,
    );
  });

  it("prefixes an artifact read error with a non-string message", async () => {
    const path = installedPath("acceptance-build.json");
    await expectRejectedBeforeRegistration(
      acceptanceManifest,
      new FakeHostArtifactPort(acceptanceFiles(), {
        readAt: path,
        readFailure: errorWithNonStringMessage(),
      }),
      acceptanceExpectation,
    );
  });

  it("prefixes hostile acceptance metadata JSON", async () => {
    await expectRejectedBeforeRegistration(
      acceptanceManifest,
      new FakeHostArtifactPort(acceptanceFiles("{not-json")),
      acceptanceExpectation,
    );
  });

  it("decodes only the exact six-key acceptance metadata object", () => {
    expect(decodeAcceptanceBuildMetadata(acceptanceMetadata)).toEqual(acceptanceMetadata);
    expect(() => decodeAcceptanceBuildMetadata({ ...acceptanceMetadata, extra: "no" }))
      .toThrow(new RegExp(`^${FAILURE_PREFIX}`));
  });

  it("prefixes a hostile decoder key-enumeration failure", () => {
    const hostile = new Proxy({}, {
      ownKeys: () => { throw errorWithThrowingMessage(); },
    });
    expect(() => decodeAcceptanceBuildMetadata(hostile))
      .toThrow(new RegExp(`^${FAILURE_PREFIX}`));
  });

  it("prefixes a revoked Proxy passed directly to the decoder", () => {
    expect(() => decodeAcceptanceBuildMetadata(revokedProxy()))
      .toThrow(new RegExp(`^${FAILURE_PREFIX}`));
  });
});
