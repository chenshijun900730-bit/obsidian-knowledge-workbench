import { decodeBaiduListResponse } from "../catalog/catalog-codec";
import { normalizeCloudAbsolutePath } from "../catalog/catalog-path";
import type {
  BaiduCatalogListRequest,
  BaiduCatalogListResponse,
  BaiduCatalogSourcePort,
  BaiduOAuthPort,
  CatalogListRequestPermit,
  CatalogCredentialPort,
} from "../catalog/catalog-ports";
import { CatalogError } from "../catalog/catalog-types";

const LIST_ENDPOINT = "https://pan.baidu.com/rest/2.0/xpan/file";
const ACCESS_TOKEN = /^[\x21-\x7e]{1,8192}$/u;

export interface BaiduCatalogSourceAdapterDependencies {
  readonly credentials: CatalogCredentialPort;
  readonly oauth: BaiduOAuthPort;
  readonly request: (
    request: BaiduCatalogListRequest,
  ) => Promise<BaiduCatalogListResponse>;
}

const catalogError = (
  code: "credentials-unavailable" | "invalid-scan-root" | "baidu-access-unavailable",
): CatalogError => new CatalogError(code);

const validateInput = (
  input: Readonly<{ path: string; start: number; limit: 1000 }>,
): Readonly<{ path: string; start: number }> => {
  if (
    typeof input.path !== "string"
    || !Number.isSafeInteger(input.start)
    || input.start < 0
    || input.limit !== 1000
  ) {
    throw catalogError("invalid-scan-root");
  }
  return {
    path: normalizeCloudAbsolutePath(input.path),
    start: input.start,
  };
};

export class BaiduCatalogSourceAdapter implements BaiduCatalogSourcePort {
  readonly #credentials: CatalogCredentialPort;
  readonly #oauth: BaiduOAuthPort;
  readonly #request: (
    request: BaiduCatalogListRequest,
  ) => Promise<BaiduCatalogListResponse>;

  constructor(dependencies: BaiduCatalogSourceAdapterDependencies) {
    this.#credentials = dependencies.credentials;
    this.#oauth = dependencies.oauth;
    this.#request = dependencies.request;
  }

  async listDirectory(input: Readonly<{
    path: string;
    start: number;
    limit: 1000;
    beforeRequest: CatalogListRequestPermit;
  }>): Promise<ReturnType<typeof decodeBaiduListResponse>> {
    const page = validateInput(input);
    const accessToken = await this.#accessToken();
    try {
      return await this.#list(page, accessToken, input.beforeRequest);
    } catch (error) {
      if (!(error instanceof CatalogError) || error.code !== "baidu-token-expired") {
        throw error;
      }
    }

    try {
      await this.#oauth.refresh();
    } catch {
      throw catalogError("baidu-access-unavailable");
    }
    const refreshedAccessToken = await this.#accessToken();
    return this.#list(page, refreshedAccessToken, input.beforeRequest);
  }

  async #accessToken(): Promise<string> {
    let accessToken: string | undefined;
    try {
      accessToken = (await this.#credentials.read())?.accessToken;
    } catch {
      throw catalogError("credentials-unavailable");
    }
    if (accessToken === undefined || !ACCESS_TOKEN.test(accessToken)) {
      throw catalogError("credentials-unavailable");
    }
    return accessToken;
  }

  async #list(
    page: Readonly<{ path: string; start: number }>,
    accessToken: string,
    beforeRequest: CatalogListRequestPermit,
  ): Promise<ReturnType<typeof decodeBaiduListResponse>> {
    await beforeRequest();
    return this.#sendList(page, accessToken);
  }

  async #sendList(
    page: Readonly<{ path: string; start: number }>,
    accessToken: string,
  ): Promise<ReturnType<typeof decodeBaiduListResponse>> {
    const url = new URL(LIST_ENDPOINT);
    url.searchParams.set("method", "list");
    url.searchParams.set("access_token", accessToken);
    url.searchParams.set("dir", page.path);
    url.searchParams.set("order", "name");
    url.searchParams.set("desc", "0");
    url.searchParams.set("start", String(page.start));
    url.searchParams.set("limit", "1000");
    url.searchParams.set("folder", "0");

    let response: BaiduCatalogListResponse;
    try {
      response = await this.#request({ method: "GET", url: url.toString() });
    } catch {
      throw catalogError("baidu-access-unavailable");
    }
    if (
      !Number.isSafeInteger(response.status)
      || response.status < 200
      || response.status >= 300
    ) {
      throw catalogError("baidu-access-unavailable");
    }
    return decodeBaiduListResponse(response.text);
  }
}
