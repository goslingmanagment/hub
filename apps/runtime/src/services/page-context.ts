import { readFile } from "node:fs/promises";

import { decryptJson, encryptJson, type FanslySessionBundle, type ProxyConfig } from "@fansly-connect/shared";
import {
  findPageByLabel,
  storeFanslySession,
  storeProxyConfig,
} from "@fansly-connect/db";

import type { AppContext } from "../bootstrap.ts";

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

export async function loadSessionBundleFromFile(filePath: string) {
  const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  return normalizeSessionBundle(raw);
}

export async function saveEncryptedSession(
  app: AppContext,
  platformAccountId: number,
  session: FanslySessionBundle,
) {
  const encrypted = encryptJson(
    session,
    app.config.encryptionKey,
    app.config.encryptionKeyVersion,
  );
  await storeFanslySession(
    app.db,
    platformAccountId,
    JSON.stringify(encrypted),
    app.config.encryptionKeyVersion,
  );
}

export async function saveProxy(
  app: AppContext,
  platformAccountId: number,
  proxy: ProxyConfig,
) {
  const encryptedAuth = proxy.username || proxy.password
    ? JSON.stringify(
      encryptJson(
        {
          username: proxy.username ?? null,
          password: proxy.password ?? null,
        },
        app.config.encryptionKey,
        app.config.encryptionKeyVersion,
      ),
    )
    : null;

  await storeProxyConfig(app.db, platformAccountId, {
    url: proxy.url,
    encryptedAuth,
    keyVersion: encryptedAuth ? app.config.encryptionKeyVersion : null,
  });
}

export async function resolvePageContext(app: AppContext, label: string) {
  const stored = await findPageByLabel(app.db, label);

  if (!stored) {
    throw new Error(`Page not found for label "${label}"`);
  }

  if (!stored.credentials) {
    throw new Error(`Page "${label}" has no stored Fansly session bundle`);
  }

  const session = decryptJson<FanslySessionBundle>(
    stored.credentials.encryptedSession,
    app.config.encryptionKey,
  );

  let proxy: ProxyConfig | null = null;
  if (stored.proxy) {
    const auth = stored.proxy.encryptedAuth
      ? decryptJson<{ username: string | null; password: string | null }>(
        stored.proxy.encryptedAuth,
        app.config.encryptionKey,
      )
      : null;

    proxy = {
      url: stored.proxy.url,
      username: auth?.username ?? null,
      password: auth?.password ?? null,
    };
  }

  return {
    page: stored.page,
    session,
    proxy,
  };
}
