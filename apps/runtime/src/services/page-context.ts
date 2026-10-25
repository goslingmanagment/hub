import {
  buildProxyEgressKey,
  normalizeProxyConfig,
  decryptJsonWithKeyVersion,
  encryptJson,
  type ProxyConfig,
} from "@agency_hub_core/shared";
import {
  deleteProxyConfig,
  findPageById,
  findPageByLabel,
  storeProxyConfig,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { BadRequestError, NotFoundError } from "./errors.ts";

function decryptStoredJson<T>(
  app: Pick<AppContext, "config">,
  payload: string,
) {
  return decryptJsonWithKeyVersion<T>(payload, app.config.encryptionKeysByVersion);
}

export async function saveProxy(
  app: Pick<AppContext, "config" | "db">,
  platformAccountId: number,
  proxy: ProxyConfig,
  options?: {
    rateLimitScopeKey?: string | null;
  },
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
    rateLimitScopeKey: options?.rateLimitScopeKey ?? buildProxyEgressKey(normalized),
  });
}

export async function removeProxy(
  app: Pick<AppContext, "db">,
  platformAccountId: number,
) {
  await deleteProxyConfig(app.db, platformAccountId);
}

export function resolveStoredProxyConfig(
  app: Pick<AppContext, "config">,
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

  const proxy = normalizeProxyConfig({
    url: storedProxy.url,
    username: auth?.username ?? null,
    password: auth?.password ?? null,
  });
  return proxy;
}

export function resolveStoredProxyEgressKey(
  storedProxy: NonNullable<Awaited<ReturnType<typeof findPageByLabel>>>["proxy"],
) {
  if (!storedProxy) {
    return "direct";
  }

  return storedProxy.rateLimitScopeKey ?? buildProxyEgressKey({ url: storedProxy.url });
}

/** The context of a page the legacy executor serves (OnlyFans). A Fansly
 *  page has none: it sends through its own browser, with its browser's
 *  session. */
export async function resolvePageContext(app: AppContext, label: string) {
  const stored = await findPageByLabel(app.db, label);
  return resolveStoredPageContext(app, stored, label);
}

export async function resolvePageContextById(app: AppContext, platformAccountId: number) {
  const stored = await findPageById(app.db, platformAccountId);
  return resolveStoredPageContext(app, stored, String(platformAccountId));
}

async function resolveStoredPageContext(
  app: AppContext,
  stored: Awaited<ReturnType<typeof findPageByLabel>> | Awaited<ReturnType<typeof findPageById>>,
  label: string,
) {
  if (!stored) {
    throw new NotFoundError(`Page "${label}" not found`);
  }

  if (stored.page.platform === "onlyfans") {
    // OnlyMonster retired — OnlyFans pages hold no hub-side session
    // material (OFAPI streams authenticate vendor-side; everything else
    // skips). The empty token keeps the context shape stable for callers.
    return {
      page: stored.page,
      platform: "onlyfans" as const,
      auth: { token: "" },
      proxy: resolveStoredProxyConfig(app, stored.proxy),
      egressKey: resolveStoredProxyEgressKey(stored.proxy),
    };
  }

  if (stored.page.platform === "fansly") {
    throw new BadRequestError(`Page "${label}" is a Fansly page: it sends through its own browser, with no context in Hub`);
  }

  throw new BadRequestError(`Page "${label}" has an unknown platform`);
}

export type ResolvedPageContext = Awaited<ReturnType<typeof resolvePageContext>>;
