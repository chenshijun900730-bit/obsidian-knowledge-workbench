import { CatalogError, type BaiduCredentialBundle } from "../catalog/catalog-types";
import type { CatalogCredentialPort } from "../catalog/catalog-ports";

const SECRET_ID = "knowledge-workbench-baidu-credentials";
const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const VISIBLE_ASCII = /^[\x21-\x7e]+$/u;
const MAX_SECRET_LENGTH = 8_192;
const EXACT_KEYS = new Set([
  "schemaVersion",
  "profileId",
  "appKey",
  "secretKey",
  "accessToken",
  "refreshToken",
  "accessTokenExpiresAt",
]);

export interface ObsidianSecretStoragePort {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

const unavailable = (): CatalogError => new CatalogError("credentials-unavailable");

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSecret = (value: unknown): value is string =>
  typeof value === "string"
  && value.length > 0
  && value.length <= MAX_SECRET_LENGTH
  && VISIBLE_ASCII.test(value);

const cloneBundle = (value: BaiduCredentialBundle): BaiduCredentialBundle => ({
  schemaVersion: 1,
  profileId: value.profileId,
  appKey: value.appKey,
  secretKey: value.secretKey,
  ...(value.accessToken === undefined ? {} : { accessToken: value.accessToken }),
  ...(value.refreshToken === undefined ? {} : { refreshToken: value.refreshToken }),
  ...(value.accessTokenExpiresAt === undefined
    ? {}
    : { accessTokenExpiresAt: value.accessTokenExpiresAt }),
});

const decodeBundle = (value: unknown): BaiduCredentialBundle => {
  if (!isRecord(value) || Object.keys(value).some((key) => !EXACT_KEYS.has(key))) {
    throw unavailable();
  }
  if (
    value.schemaVersion !== 1
    || typeof value.profileId !== "string"
    || !PROFILE_ID.test(value.profileId)
    || !isSecret(value.appKey)
    || !isSecret(value.secretKey)
    || (value.accessToken !== undefined && !isSecret(value.accessToken))
    || (value.refreshToken !== undefined && !isSecret(value.refreshToken))
    || (
      value.accessTokenExpiresAt !== undefined
      && (
        typeof value.accessTokenExpiresAt !== "number"
        || !Number.isSafeInteger(value.accessTokenExpiresAt)
        || value.accessTokenExpiresAt < 0
      )
    )
  ) {
    throw unavailable();
  }
  return cloneBundle(value as unknown as BaiduCredentialBundle);
};

const parseBundle = (serialized: string): BaiduCredentialBundle => {
  try {
    return decodeBundle(JSON.parse(serialized) as unknown);
  } catch {
    throw unavailable();
  }
};

export class ObsidianBaiduCredentialAdapter implements CatalogCredentialPort {
  readonly #storage: ObsidianSecretStoragePort;

  constructor(storage: ObsidianSecretStoragePort) {
    this.#storage = storage;
  }

  async read(): Promise<BaiduCredentialBundle | null> {
    let serialized: string | null;
    try {
      serialized = this.#storage.getSecret(SECRET_ID);
    } catch {
      throw unavailable();
    }
    if (serialized === null || serialized === "") return null;
    return parseBundle(serialized);
  }

  async replace(value: BaiduCredentialBundle): Promise<void> {
    const serialized = this.#serialize(value);
    this.#write(serialized);
  }

  async replaceIfCurrent(
    value: BaiduCredentialBundle,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    const serialized = this.#serialize(value);
    if (!isCurrent()) return false;
    this.#write(serialized);
    return true;
  }

  #serialize(value: BaiduCredentialBundle): string {
    let serialized: string;
    try {
      serialized = JSON.stringify(decodeBundle(value));
    } catch {
      throw unavailable();
    }
    return serialized;
  }

  #write(serialized: string): void {
    try {
      this.#storage.setSecret(SECRET_ID, serialized);
    } catch {
      throw unavailable();
    }
  }

  async revoke(): Promise<void> {
    try {
      this.#storage.setSecret(SECRET_ID, "");
    } catch {
      throw unavailable();
    }
  }
}
