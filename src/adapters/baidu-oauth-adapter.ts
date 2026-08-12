import type {
  BaiduOAuthPort,
  BaiduOAuthRequest,
  BaiduOAuthResponse,
  CatalogAuthorizationBrowserPort,
  CatalogCredentialPort,
} from "../catalog/catalog-ports";
import { CatalogError, type BaiduCredentialBundle } from "../catalog/catalog-types";

const AUTHORIZE_ENDPOINT = "https://openapi.baidu.com/oauth/2.0/authorize";
const TOKEN_ENDPOINT = "https://openapi.baidu.com/oauth/2.0/token";
const ATTEMPT_LIFETIME_MS = 10 * 60 * 1_000;
const AUTHORIZATION_CODE = /^[\x21-\x7e]{1,512}$/u;
const TOKEN = /^[\x21-\x7e]{1,8192}$/u;

type TokenPair = Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}>;

export interface BaiduOAuthAdapterDependencies {
  readonly credentials: CatalogCredentialPort;
  readonly browser: CatalogAuthorizationBrowserPort;
  readonly request: (request: BaiduOAuthRequest) => Promise<BaiduOAuthResponse>;
  readonly now?: () => number;
}

const catalogError = (
  code:
    | "authorization-canceled"
    | "authorization-attempt-unavailable"
    | "authorization-attempt-expired"
    | "authorization-code-invalid"
    | "authorization-exchange-failed"
    | "credentials-unavailable",
): CatalogError => new CatalogError(code);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseTokenResponse = (response: BaiduOAuthResponse): TokenPair => {
  if (!Number.isSafeInteger(response.status) || response.status < 200 || response.status >= 300) {
    throw catalogError("authorization-exchange-failed");
  }
  let value: unknown;
  try {
    value = JSON.parse(response.text) as unknown;
  } catch {
    throw catalogError("authorization-exchange-failed");
  }
  if (!isRecord(value)) throw catalogError("authorization-exchange-failed");
  const accessToken = value.access_token;
  const refreshToken = value.refresh_token;
  const expiresInSeconds = value.expires_in;
  if (
    typeof accessToken !== "string"
    || !TOKEN.test(accessToken)
    || typeof refreshToken !== "string"
    || !TOKEN.test(refreshToken)
    || typeof expiresInSeconds !== "number"
    || !Number.isSafeInteger(expiresInSeconds)
    || expiresInSeconds <= 0
  ) {
    throw catalogError("authorization-exchange-failed");
  }
  return { accessToken, refreshToken, expiresInSeconds };
};

const tokenExpiry = (now: number, expiresInSeconds: number): number => {
  const expiresAt = now + expiresInSeconds * 1_000;
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) {
    throw catalogError("authorization-exchange-failed");
  }
  return expiresAt;
};

const withTokens = (
  credentials: BaiduCredentialBundle,
  tokens: TokenPair,
  now: number,
): BaiduCredentialBundle => ({
  schemaVersion: 1,
  profileId: credentials.profileId,
  appKey: credentials.appKey,
  secretKey: credentials.secretKey,
  accessToken: tokens.accessToken,
  refreshToken: tokens.refreshToken,
  accessTokenExpiresAt: tokenExpiry(now, tokens.expiresInSeconds),
});

export class BaiduOAuthAdapter implements BaiduOAuthPort {
  readonly #credentials: CatalogCredentialPort;
  readonly #browser: CatalogAuthorizationBrowserPort;
  readonly #request: (request: BaiduOAuthRequest) => Promise<BaiduOAuthResponse>;
  readonly #now: () => number;
  #attemptExpiresAt: number | null = null;
  #lifecycleEpoch = 0;
  #disposed = false;

  constructor(dependencies: BaiduOAuthAdapterDependencies) {
    this.#credentials = dependencies.credentials;
    this.#browser = dependencies.browser;
    this.#request = dependencies.request;
    this.#now = dependencies.now ?? Date.now;
  }

  async beginAuthorization(): Promise<Readonly<{ expiresAt: number }>> {
    const epoch = this.#currentEpoch();
    const credentials = await this.#requiredCredentials();
    this.#assertCurrent(epoch);
    const now = this.#now();
    const expiresAt = now + ATTEMPT_LIFETIME_MS;
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(expiresAt)) {
      throw catalogError("authorization-canceled");
    }

    const url = new URL(AUTHORIZE_ENDPOINT);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", credentials.appKey);
    url.searchParams.set("redirect_uri", "oob");
    url.searchParams.set("scope", "basic,netdisk");
    this.#attemptExpiresAt = expiresAt;
    try {
      await this.#browser.openAuthorizationPage(url.toString());
      this.#assertCurrent(epoch);
    } catch {
      this.#attemptExpiresAt = null;
      throw catalogError("authorization-canceled");
    }
    return { expiresAt };
  }

  async submitAuthorizationCode(code: string): Promise<void> {
    const expiresAt = this.#attemptExpiresAt;
    if (expiresAt === null) {
      throw catalogError("authorization-attempt-unavailable");
    }
    if (this.#now() > expiresAt) {
      this.#attemptExpiresAt = null;
      throw catalogError("authorization-attempt-expired");
    }
    this.#attemptExpiresAt = null;
    if (!AUTHORIZATION_CODE.test(code)) {
      throw catalogError("authorization-code-invalid");
    }
    const epoch = this.#currentEpoch();

    const credentials = await this.#requiredCredentials();
    this.#assertCurrent(epoch);
    const url = new URL(TOKEN_ENDPOINT);
    url.searchParams.set("grant_type", "authorization_code");
    url.searchParams.set("code", code);
    url.searchParams.set("client_id", credentials.appKey);
    url.searchParams.set("client_secret", credentials.secretKey);
    url.searchParams.set("redirect_uri", "oob");
    const tokens = await this.#exchange(url);
    this.#assertCurrent(epoch);
    await this.#replaceCredentials(withTokens(credentials, tokens, this.#now()), epoch);
  }

  cancelAuthorization(): void {
    this.#lifecycleEpoch += 1;
    this.#attemptExpiresAt = null;
  }

  async refresh(): Promise<void> {
    const epoch = this.#currentEpoch();
    const credentials = await this.#requiredCredentials();
    this.#assertCurrent(epoch);
    if (credentials.refreshToken === undefined) {
      throw catalogError("authorization-exchange-failed");
    }
    const url = new URL(TOKEN_ENDPOINT);
    url.searchParams.set("grant_type", "refresh_token");
    url.searchParams.set("refresh_token", credentials.refreshToken);
    url.searchParams.set("client_id", credentials.appKey);
    url.searchParams.set("client_secret", credentials.secretKey);
    const tokens = await this.#exchange(url);
    this.#assertCurrent(epoch);
    await this.#replaceCredentials(withTokens(credentials, tokens, this.#now()), epoch);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lifecycleEpoch += 1;
    this.#attemptExpiresAt = null;
  }

  #currentEpoch(): number {
    if (this.#disposed) throw catalogError("authorization-canceled");
    return this.#lifecycleEpoch;
  }

  #assertCurrent(epoch: number): void {
    if (!this.#isCurrent(epoch)) {
      throw catalogError("authorization-canceled");
    }
  }

  #isCurrent(epoch: number): boolean {
    return !this.#disposed && epoch === this.#lifecycleEpoch;
  }

  async #requiredCredentials(): Promise<BaiduCredentialBundle> {
    let credentials: BaiduCredentialBundle | null;
    try {
      credentials = await this.#credentials.read();
    } catch {
      throw catalogError("credentials-unavailable");
    }
    if (credentials === null) throw catalogError("credentials-unavailable");
    return credentials;
  }

  async #replaceCredentials(credentials: BaiduCredentialBundle, epoch: number): Promise<void> {
    this.#assertCurrent(epoch);
    let committed: boolean;
    try {
      committed = await this.#credentials.replaceIfCurrent(
        credentials,
        () => this.#isCurrent(epoch),
      );
    } catch {
      throw catalogError("credentials-unavailable");
    }
    if (!committed) throw catalogError("authorization-canceled");
  }

  async #exchange(url: URL): Promise<TokenPair> {
    let response: BaiduOAuthResponse;
    try {
      response = await this.#request({ method: "GET", url: url.toString() });
    } catch {
      throw catalogError("authorization-exchange-failed");
    }
    return parseTokenResponse(response);
  }
}
