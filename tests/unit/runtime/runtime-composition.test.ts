import { describe, expect, it } from "vitest";
import {
  CloudCatalogRuntimeService,
  type CloudCatalogConnectionRuntime,
} from "../../../src/catalog/cloud-catalog-runtime";
import type { CloudDirectoryDiscoveryRuntime } from "../../../src/catalog/cloud-directory-discovery-service";
import type { CloudDirectoryBrowserRuntime } from "../../../src/catalog/cloud-directory-browser";
import type { CloudDirectoryLocatorRuntime } from "../../../src/catalog/cloud-directory-locator";
import type { HybridCatalogRuntime } from "../../../src/catalog/hybrid-catalog-runtime";
import type { CatalogSnapshotPort } from "../../../src/catalog/catalog-ports";
import { assertRuntimeCompositionCoherence } from "../../../src/runtime/runtime-composition";
import { createOfflineCloudCatalogRuntime } from "../../../src/catalog/offline-cloud-catalog-runtime";
import { DISABLED_CLOUD_CATALOG_RUNTIME } from "../../../src/catalog/disabled-cloud-catalog-runtime";
import {
  NORMAL_RUNTIME_POLICY,
  READ_ONLY_ACCEPTANCE_POLICY,
} from "../../../src/runtime/safety-policy";

describe("runtime composition", () => {
  it("accepts matching policy and artifact modes", () => {
    expect(() => assertRuntimeCompositionCoherence(
      NORMAL_RUNTIME_POLICY,
      { mode: "normal" },
    )).not.toThrow();
    expect(() => assertRuntimeCompositionCoherence(
      READ_ONLY_ACCEPTANCE_POLICY,
      { mode: "read-only-acceptance" },
    )).not.toThrow();
  });

  it("rejects a policy and artifact mode mismatch immediately", () => {
    expect(() => assertRuntimeCompositionCoherence(
      READ_ONLY_ACCEPTANCE_POLICY,
      { mode: "normal" },
    )).toThrow("Runtime policy and artifact mode do not match");
  });

  it("keeps the browser absent from offline, disabled, and acceptance-safe runtimes", () => {
    const offline = createOfflineCloudCatalogRuntime();

    expect(offline.directoryBrowser).toBeUndefined();
    expect(DISABLED_CLOUD_CATALOG_RUNTIME.directoryBrowser).toBeUndefined();

    offline.dispose();
  });

  it("exposes and disposes directory consumers before their shared providers exactly once", () => {
    const order: string[] = [];
    const connection = {
      subscribe: () => () => undefined,
      dispose: () => { order.push("connection"); },
    } as unknown as CloudCatalogConnectionRuntime;
    const hybrid = {
      dispose: () => { order.push("hybrid"); },
    } as unknown as HybridCatalogRuntime;
    const discovery = {
      dispose: () => { order.push("discovery"); },
    } as unknown as CloudDirectoryDiscoveryRuntime;
    const browser = {
      rootAccessGranted: () => false,
      snapshot: () => null,
      dispose: () => { order.push("browser"); },
    } as unknown as CloudDirectoryBrowserRuntime;
    const locator = {
      dispose: () => { order.push("locator"); },
    } as unknown as CloudDirectoryLocatorRuntime;
    const runtime = new CloudCatalogRuntimeService(
      {} as CatalogSnapshotPort,
      { copyText: async () => undefined, openBaidu: async () => undefined },
      connection,
      hybrid,
      undefined,
      discovery,
      browser,
      locator,
    );

    expect(runtime.directoryBrowser).toBe(browser);
    expect(runtime.directoryBrowser?.rootAccessGranted()).toBe(false);
    expect(runtime.directoryBrowser?.snapshot("/")).toBeNull();
    expect(runtime.directoryLocator).toBe(locator);
    runtime.dispose();
    runtime.dispose();

    expect(order).toEqual(["locator", "browser", "discovery", "hybrid", "connection"]);
  });
});
