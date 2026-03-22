import { readFile } from "node:fs/promises";

import {
  normalizeProxyConfig,
  decryptJsonWithKeyVersion,
  encryptJson,
  type FanslySessionBundle,
  type OnlyMonsterTokenBundle,
  type ProxyConfig,
  type StoredPlatformCredentialBundle,
} from "@agency_hub_core/shared";
import {
  deleteProxyConfig,
  findPageById,
  findPageByLabel,
  storePlatformCredentials,
  storeProxyConfig,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";

function decryptStoredJson<T>(
  app: Pick<AppContext, "config">,
  payload: string,
) {
  return decryptJsonWithKeyVersion<T>(payload, app.config.encryptionKeysByVersion);
}

function normalizeOptionalSessionValue(value: unknown, key: string) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`Session file field "${key}" must be a string when provided`);
  }

  return value;
}

function normalizeSessionBundle(input: Record<string, unknown>): FanslySessionBundle {
  const authorization = input.authorization ?? input.token;
  const fanslyClientId = input.fanslyClientId ?? input["fansly-client-id"];
  const fanslyClientCheck = input.fanslyClientCheck ?? input["fansly-client-check"];
  const fanslySessionId = input.fanslySessionId ?? input["fansly-session-id"];

  if (typeof authorization !== "string") {
    throw new Error("Session file must include authorization");
  }

  return {
    authorization,
    fanslyClientId: normalizeOptionalSessionValue(fanslyClientId, "fansly-client-id"),
    fanslyClientCheck: normalizeOptionalSessionValue(fanslyClientCheck, "fansly-client-check"),
    fanslySessionId: normalizeOptionalSessionValue(fanslySessionId, "fansly-session-id"),
  };
}

function normalizeOnlyMonsterTokenBundle(input: Record<string, unknown>): OnlyMonsterTokenBundle {
  const token = input.token ?? input.authToken ?? input["x-om-auth-token"];
  if (typeof token !== "string") {
    throw new Error("Token file must include token");
  }

  return { token };
}

function asRecord(value: unknown) {
  if (typeof value !== "object" || value === null) {
    throw new Error("Credentials payload must be an object");
  }

  return value as Record<string, unknown>;
}

function isStoredPlatformCredentialBundle(value: unknown): value is StoredPlatformCredentialBundle {
  if (typeof value !== "object" || value === null || !("platform" in value)) {
    return false;
  }

  return value.platform === "fansly" || value.platform === "onlyfans";
}

export async function loadFanslySessionBundleFromFile(filePath: string) {
  const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  return normalizeSessionBundle(raw);
}

export const loadSessionBundleFromFile = loadFanslySessionBundleFromFile;

export async function loadOnlyMonsterTokenBundleFromFile(filePath: string) {
  const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  return normalizeOnlyMonsterTokenBundle(raw);
}

export async function saveEncryptedCredentials(
  app: Pick<AppContext, "config" | "db">,
  platformAccountId: number,
  credentials: StoredPlatformCredentialBundle,
) {
  const encrypted = encryptJson(
    credentials,
    app.config.encryptionKey,
    app.config.encryptionKeyVersion,
  );
  await storePlatformCredentials(app.db, {
    platformAccountId,
    encryptedSession: JSON.stringify(encrypted),
    keyVersion: app.config.encryptionKeyVersion,
  });
}

export async function saveProxy(
  app: Pick<AppContext, "config" | "db">,
  platformAccountId: number,
  proxy: ProxyConfig,
) {
  const normalized = normalizeProxyConfig(proxy);
  const encryptedAuth = normalized.username || normalized.password
    ? JSON.stringify(
      encryptJson(
        {
          username: normalized.username ?? null,
          password: normalized.password ?? null,
        },
        app.config.encryptionKey,
        app.config.encryptionKeyVersion,
      ),
    )
    : null;

  await storeProxyConfig(app.db, platformAccountId, {
    url: normalized.url,
    encryptedAuth,
    keyVersion: encryptedAuth ? app.config.encryptionKeyVersion : null,
  });
}

export async function removeProxy(
  app: Pick<AppContext, "db">,
  platformAccountId: number,
) {
  await deleteProxyConfig(app.db, platformAccountId);
}

export function resolveStoredProxyConfig(
  app: AppContext,
  storedProxy: NonNullable<Awaited<ReturnType<typeof findPageByLabel>>>["proxy"],
) {
  if (!storedProxy) {
    return null;
  }

  const auth = storedProxy.encryptedAuth
    ? decryptStoredJson<{ username: string | null; password: string | null }>(
      app,
      storedProxy.encryptedAuth,
    )
    : null;

  return normalizeProxyConfig({
    url: storedProxy.url,
    username: auth?.username ?? null,
    password: auth?.password ?? null,
  });
}

export async function resolvePageContext(app: AppContext, label: string) {
  const stored = await findPageByLabel(app.db, label);
  return resolveStoredPageContext(app, stored, label);
}

export async function resolvePageContextById(app: AppContext, platformAccountId: number) {
  const stored = await findPageById(app.db, platformAccountId);
  return resolveStoredPageContext(app, stored, String(platformAccountId));
}

function resolveStoredPageContext(
  app: AppContext,
  stored: Awaited<ReturnType<typeof findPageByLabel>> | Awaited<ReturnType<typeof findPageById>>,
  label: string,
) {
  if (!stored) {
    throw new Error(`Page not found for label "${label}"`);
  }

  if (!stored.credentials) {
    throw new Error(`Page "${label}" has no stored platform credentials`);
  }

  const decrypted = decryptStoredJson<StoredPlatformCredentialBundle | Record<string, unknown>>(
    app,
    stored.credentials.encryptedSession,
  );

  const proxy = resolveStoredProxyConfig(app, stored.proxy);

  if (stored.page.platform === "fansly") {
    const session = isStoredPlatformCredentialBundle(decrypted)
      ? decrypted.platform === "fansly"
        ? decrypted.session
        : (() => {
          throw new Error(`Page "${label}" has OnlyFans credentials stored for a Fansly page`);
        })()
      : normalizeSessionBundle(asRecord(decrypted));

    return {
      page: stored.page,
      platform: "fansly" as const,
      session,
      proxy,
    };
  }

  const auth = isStoredPlatformCredentialBundle(decrypted)
    ? decrypted.platform === "onlyfans"
      ? decrypted.auth
      : (() => {
        throw new Error(`Page "${label}" has Fansly credentials stored for an OnlyFans page`);
      })()
    : normalizeOnlyMonsterTokenBundle(asRecord(decrypted));

  return {
    page: stored.page,
    platform: "onlyfans" as const,
    auth,
    proxy,
  };
}

export type ResolvedPageContext = Awaited<ReturnType<typeof resolvePageContext>>;
export type ResolvedFanslyPageContext = Extract<ResolvedPageContext, { platform: "fansly" }>;
export type ResolvedOnlyFansPageContext = Extract<ResolvedPageContext, { platform: "onlyfans" }>;
