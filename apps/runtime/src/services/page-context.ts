import { readFile } from "node:fs/promises";

import {
  FANSLY_CLIENT_CHECK_ROUTES,
  buildProxyEgressKey,
  normalizeProxyConfig,
  decryptJsonWithKeyVersion,
  encryptJson,
  type FanslySessionBundle,
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
import { BadRequestError, NotFoundError, ProxyMissingError } from "./errors.ts";
import { notifyProxyMissingIncident } from "./notification-incidents.ts";

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

function normalizeRouteChecks(value: unknown): FanslySessionBundle["routeChecks"] {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error('Session file field "routeChecks" must be an object when provided');
  }
  const allowed = new Set<string>(FANSLY_CLIENT_CHECK_ROUTES);
  const normalized: NonNullable<FanslySessionBundle["routeChecks"]> = {};
  for (const [route, check] of Object.entries(value)) {
    if (!allowed.has(route) || typeof check !== "string" || check.length === 0) {
      throw new Error(`Session file field "routeChecks.${route}" is invalid`);
    }
    normalized[route as keyof typeof normalized] = check;
  }
  return normalized;
}

function normalizeSessionBundle(input: Record<string, unknown>): FanslySessionBundle {
  const authorization = input.authorization ?? input.token;
  const fanslyClientId = input.fanslyClientId ?? input["fansly-client-id"];
  const fanslyClientCheck = input.fanslyClientCheck ?? input["fansly-client-check"];
  const fanslySessionId = input.fanslySessionId ?? input["fansly-session-id"];
  const routeChecks = input.routeChecks;

  if (typeof authorization !== "string") {
    throw new Error("Session file must include authorization");
  }

  return {
    authorization,
    fanslyClientId: normalizeOptionalSessionValue(fanslyClientId, "fansly-client-id"),
    fanslyClientCheck: normalizeOptionalSessionValue(fanslyClientCheck, "fansly-client-check"),
    fanslySessionId: normalizeOptionalSessionValue(fanslySessionId, "fansly-session-id"),
    routeChecks: normalizeRouteChecks(routeChecks),
  };
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

export interface ResolvePageContextOptions {
  /** W3.1 escape hatch for the proxy-ASSIGNMENT flow only (setPageProxy):
   * resolving there must not fail closed on the very state it repairs. The
   * caller must never egress with the stored (null) proxy. */
  allowMissingProxy?: boolean;
}

export async function resolvePageContext(
  app: AppContext,
  label: string,
  options?: ResolvePageContextOptions,
) {
  const stored = await findPageByLabel(app.db, label);
  return resolveStoredPageContext(app, stored, label, options);
}

export async function resolvePageContextById(app: AppContext, platformAccountId: number) {
  const stored = await findPageById(app.db, platformAccountId);
  return resolveStoredPageContext(app, stored, String(platformAccountId));
}

async function resolveStoredPageContext(
  app: AppContext,
  stored: Awaited<ReturnType<typeof findPageByLabel>> | Awaited<ReturnType<typeof findPageById>>,
  label: string,
  options?: ResolvePageContextOptions,
) {
  if (!stored) {
    throw new NotFoundError(`Page "${label}" not found`);
  }

  if (stored.page.platform === "onlyfans") {
    // Stage 18: OnlyMonster retired — OnlyFans pages hold no hub-side session
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

  if (!stored.credentials) {
    throw new BadRequestError(`Page "${label}" has no stored platform credentials`);
  }

  let decrypted: StoredPlatformCredentialBundle | Record<string, unknown>;
  try {
    decrypted = decryptStoredJson<StoredPlatformCredentialBundle | Record<string, unknown>>(
      app,
      stored.credentials.encryptedSession,
    );
  } catch (error) {
    throw new BadRequestError(
      `Page "${label}" has invalid stored platform credentials: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    );
  }

  const proxy = resolveStoredProxyConfig(app, stored.proxy);
  const egressKey = resolveStoredProxyEgressKey(stored.proxy);

  if (stored.page.platform === "fansly") {
    let session: FanslySessionBundle;
    try {
      session = isStoredPlatformCredentialBundle(decrypted)
        ? decrypted.platform === "fansly"
          ? decrypted.session
          : (() => {
            throw new BadRequestError(
              `Page "${label}" has OnlyFans credentials stored for a Fansly page`,
            );
          })()
        : normalizeSessionBundle(asRecord(decrypted));
    } catch (error) {
      if (error instanceof BadRequestError) {
        throw error;
      }
      throw new BadRequestError(
        `Page "${label}" has invalid stored platform credentials: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }

    if (!proxy && !options?.allowMissingProxy) {
      // W3.1 (decision #124): Fansly egress fails CLOSED. Every real request
      // path resolves through this context; without the page's proxy the
      // request would ride the shared VPS IP (model-ban class risk — erasure
      // purges egress_endpoints, so an erased-but-syncing page used to go
      // direct silently). Refuse the resolution and page the owner; the
      // incident open never throws, so the refusal itself cannot be lost to
      // a Telegram hiccup.
      await notifyProxyMissingIncident(app, {
        platformAccountId: stored.page.id,
        pageLabel: stored.page.label,
        errorSummary: `Page "${label}" has no assigned proxy; Fansly egress refused (fail-closed)`,
      });
      throw new ProxyMissingError(
        `Page "${label}" has no assigned proxy; Fansly egress is refused (fail-closed). ` +
          "Assign a proxy on the Credentials tab to resume sync.",
      );
    }

    return {
      page: stored.page,
      platform: "fansly" as const,
      session,
      proxy,
      egressKey,
    };
  }

  throw new BadRequestError(`Page "${label}" has an unknown platform`);
}

export type ResolvedPageContext = Awaited<ReturnType<typeof resolvePageContext>>;
export type ResolvedFanslyPageContext = Extract<ResolvedPageContext, { platform: "fansly" }>;
export type ResolvedOnlyFansPageContext = Extract<ResolvedPageContext, { platform: "onlyfans" }>;
