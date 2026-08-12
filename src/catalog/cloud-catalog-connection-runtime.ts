import type {
  BaiduOAuthPort,
  CatalogCredentialPort,
} from "./catalog-ports";
import { normalizeCatalogScanRoot } from "./catalog-path";
import {
  CatalogError,
  type CatalogErrorCode,
  type CatalogScanProgress,
  type CatalogScanResult,
} from "./catalog-types";
import type {
  CloudCatalogConnectionRuntime,
  CloudCatalogConnectionViewModel,
} from "./cloud-catalog-runtime";

export interface CatalogScannerPort {
  scan(input: Readonly<{
    scanId: string;
    rootPath: string;
    signal?: AbortSignal;
    onProgress?: (progress: CatalogScanProgress) => void;
  }>): Promise<CatalogScanResult>;
}

export interface CloudCatalogConnectionRuntimeDependencies {
  readonly credentials: CatalogCredentialPort;
  readonly oauth: BaiduOAuthPort;
  readonly scanner: CatalogScannerPort;
  readonly createScanId: () => string;
  readonly onSnapshotChanged: () => Promise<void>;
}

type RestingStatus = "configured" | "authorized";

const fixedError = (
  code: "credentials-unavailable" | "baidu-access-unavailable",
): CatalogError => new CatalogError(code);

const safeCatalogError = (error: unknown, fallback: CatalogErrorCode): CatalogError =>
  error instanceof CatalogError ? error : new CatalogError(fallback);

const cloneProgress = (progress: CatalogScanProgress): CatalogScanProgress => ({
  ...progress,
  budget: { ...progress.budget },
});

const cloneViewModel = (
  viewModel: CloudCatalogConnectionViewModel,
): CloudCatalogConnectionViewModel => ({
  ...viewModel,
  ...(viewModel.scanProgress === undefined
    ? {}
    : { scanProgress: cloneProgress(viewModel.scanProgress) }),
});

export class CloudCatalogConnectionRuntimeService implements CloudCatalogConnectionRuntime {
  readonly #credentials: CatalogCredentialPort;
  readonly #oauth: BaiduOAuthPort;
  readonly #scanner: CatalogScannerPort;
  readonly #createScanId: () => string;
  readonly #onSnapshotChanged: () => Promise<void>;
  #viewModel: CloudCatalogConnectionViewModel = { status: "unconfigured" };
  #authorizationFallback: RestingStatus = "configured";
  #scanAbort: AbortController | undefined;
  readonly #listeners = new Set<() => void>();
  #authorized = false;
  #disposed = false;
  #authorizationEpoch = 0;

  constructor(dependencies: CloudCatalogConnectionRuntimeDependencies) {
    this.#credentials = dependencies.credentials;
    this.#oauth = dependencies.oauth;
    this.#scanner = dependencies.scanner;
    this.#createScanId = dependencies.createScanId;
    this.#onSnapshotChanged = dependencies.onSnapshotChanged;
  }

  async initialize(): Promise<void> {
    this.#assertAvailable();
    try {
      const credentials = await this.#credentials.read();
      if (credentials === null) {
        this.#authorized = false;
        this.#setViewModel({ status: "unconfigured" });
      } else if (credentials.accessToken === undefined || credentials.refreshToken === undefined) {
        this.#authorized = false;
        this.#setViewModel({ status: "configured" });
      } else {
        this.#authorized = true;
        this.#setViewModel({ status: "authorized" });
      }
    } catch {
      this.#authorized = false;
      this.#setViewModel({
        status: "unconfigured",
        messageCode: "credentials-unavailable",
      });
    }
  }

  snapshot(): CloudCatalogConnectionViewModel {
    return cloneViewModel(this.#viewModel);
  }

  subscribe(listener: () => void): () => void {
    if (this.#disposed) return () => undefined;
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  async saveApplicationCredentials(input: Readonly<{
    appKey: string;
    secretKey: string;
  }>): Promise<void> {
    this.#assertAvailable();
    this.#invalidateAuthorization();
    this.cancelScan();
    this.#authorized = false;
    try {
      await this.#credentials.replace({
        schemaVersion: 1,
        profileId: "primary",
        appKey: input.appKey,
        secretKey: input.secretKey,
      });
    } catch (error) {
      const safe = safeCatalogError(error, "credentials-unavailable");
      this.#setViewModel({ status: "unconfigured", messageCode: safe.code });
      throw safe;
    }
    this.#setViewModel({ status: "configured" });
  }

  async beginAuthorization(): Promise<Readonly<{ expiresAt: number }>> {
    this.#assertAvailable();
    if (this.#viewModel.status === "unconfigured") {
      throw fixedError("credentials-unavailable");
    }
    if (this.#scanAbort !== undefined) {
      throw fixedError("baidu-access-unavailable");
    }
    this.#authorizationFallback = this.#authorized ? "authorized" : "configured";
    const epoch = this.#authorizationEpoch;
    try {
      const attempt = await this.#oauth.beginAuthorization();
      this.#assertAuthorizationCurrent(epoch);
      this.#setViewModel({
        status: "authorizing",
        authorizationExpiresAt: attempt.expiresAt,
      });
      return attempt;
    } catch (error) {
      if (!this.#authorizationCurrent(epoch)) throw new CatalogError("authorization-canceled");
      const safe = safeCatalogError(error, "baidu-access-unavailable");
      this.#setViewModel({ status: this.#authorizationFallback, messageCode: safe.code });
      throw safe;
    }
  }

  async submitAuthorizationCode(code: string): Promise<void> {
    this.#assertAvailable();
    if (this.#viewModel.status !== "authorizing") {
      throw new CatalogError("authorization-attempt-unavailable");
    }
    const epoch = this.#authorizationEpoch;
    try {
      await this.#oauth.submitAuthorizationCode(code);
      this.#assertAuthorizationCurrent(epoch);
      this.#authorized = true;
      this.#setViewModel({ status: "authorized" });
    } catch (error) {
      if (!this.#authorizationCurrent(epoch)) throw new CatalogError("authorization-canceled");
      const safe = safeCatalogError(error, "authorization-exchange-failed");
      this.#setViewModel({ status: this.#authorizationFallback, messageCode: safe.code });
      throw safe;
    }
  }

  cancelAuthorization(): void {
    if (this.#disposed) return;
    this.#invalidateAuthorization();
    if (this.#viewModel.status === "authorizing") {
      this.#setViewModel({ status: this.#authorizationFallback });
    }
  }

  async revoke(): Promise<void> {
    this.#assertAvailable();
    this.#invalidateAuthorization();
    this.cancelScan();
    this.#authorized = false;
    try {
      await this.#credentials.revoke();
    } catch (error) {
      const safe = safeCatalogError(error, "credentials-unavailable");
      this.#setViewModel({ status: "unconfigured", messageCode: safe.code });
      throw safe;
    }
    this.#setViewModel({ status: "unconfigured" });
  }

  async startScan(rootPath: string): Promise<void> {
    this.#assertAvailable();
    if (!this.#authorized || this.#viewModel.status === "authorizing") {
      throw fixedError("credentials-unavailable");
    }
    if (this.#scanAbort !== undefined) throw fixedError("baidu-access-unavailable");
    const normalized = normalizeCatalogScanRoot(rootPath);
    const abort = new AbortController();
    this.#scanAbort = abort;
    this.#setViewModel({ status: "scanning" });
    try {
      const result = await this.#scanner.scan({
        scanId: this.#createScanId(),
        rootPath: normalized,
        signal: abort.signal,
        onProgress: (progress) => {
          if (!this.#scanCurrent(abort) || abort.signal.aborted) return;
          this.#setViewModel({
            status: progress.status === "complete" ? "authorized" : progress.status,
            scanProgress: progress,
          });
        },
      });
      if (!this.#scanCurrent(abort)) return;
      if (
        abort.signal.aborted
        && !(result.status === "paused" && result.stopReason === "user-canceled")
      ) return;
      if (result.status === "complete") {
        await this.#onSnapshotChanged();
        if (!this.#scanCurrent(abort)) return;
        this.#setViewModel({ status: "authorized", scanProgress: result.progress });
      } else {
        this.#setViewModel({
          status: result.status,
          scanProgress: result.progress,
          ...(result.errorCode === undefined ? {} : { messageCode: result.errorCode }),
        });
      }
    } catch (error) {
      if (!this.#scanCurrent(abort)) return;
      const safe = safeCatalogError(error, "baidu-access-unavailable");
      this.#setViewModel({
        status: "partial",
        messageCode: safe.code,
        ...(this.#viewModel.scanProgress === undefined
          ? {}
          : { scanProgress: this.#viewModel.scanProgress }),
      });
      throw safe;
    } finally {
      if (this.#scanAbort === abort) this.#scanAbort = undefined;
    }
  }

  cancelScan(): void {
    this.#scanAbort?.abort();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.cancelScan();
    this.#authorizationEpoch += 1;
    this.#oauth.dispose();
    this.#disposed = true;
    this.#listeners.clear();
  }

  #setViewModel(viewModel: CloudCatalogConnectionViewModel): void {
    this.#viewModel = cloneViewModel(viewModel);
    if (this.#disposed) return;
    for (const listener of this.#listeners) listener();
  }

  #assertAvailable(): void {
    if (this.#disposed) throw fixedError("baidu-access-unavailable");
  }

  #invalidateAuthorization(): void {
    this.#authorizationEpoch += 1;
    this.#oauth.cancelAuthorization();
  }

  #authorizationCurrent(epoch: number): boolean {
    return !this.#disposed && epoch === this.#authorizationEpoch;
  }

  #scanCurrent(abort: AbortController): boolean {
    return !this.#disposed && this.#authorized && this.#scanAbort === abort;
  }

  #assertAuthorizationCurrent(epoch: number): void {
    if (!this.#authorizationCurrent(epoch)) throw new CatalogError("authorization-canceled");
  }
}
