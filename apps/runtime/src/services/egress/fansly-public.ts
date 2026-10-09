import {
  deleteFanslyPublicEgress,
  insertAuditEvent,
  listPageEgressEndpoints,
  readFanslyPublicEgress,
  storeFanslyPublicEgress,
  type Database,
} from "@agency_hub_core/db";
import type { EgressContext } from "@agency_hub_core/platform-core";
import {
  buildProxyEgressKey,
  createProxyRequestDispatcher,
  decryptJsonWithKeyVersion,
  encryptJson,
  formatMaskedProxyUrl,
  normalizeProxyConfig,
  type AppConfig,
  type ProxyConfig,
} from "@agency_hub_core/shared";
import type { Dispatcher } from "undici";

import { assertAllowedProxyTarget } from "../proxy-validation.ts";

// The egress of the session-less public Fansly account reader (arena "vanished
// chat" R5, plan §7, owner decision Р1: «да, через прокси»). The reader asks
// Fansly whether an account exists without any session; its requests leave
// through ONE proxy of its own, which the owner configures and no page holds:
//
//   - stored like a page's proxy (`fansly_public_egress`: the URL and the
//     encrypted auth), set and removed by the owner (`pnpm cli sync
//     public-lookup proxy set | remove`), the secret read from 1Password at
//     the moment of setting — never from the repository;
//   - never a page's proxy: a candidate equal to a page's (the same address
//     and user) is refused when it is set, and the resolver refuses it again
//     should a page get it later;
//   - never direct: no proxy, no transport — the reader sends nothing;
//   - Fansly's API host only: the dispatcher refuses any other origin before
//     it opens a connection (`restrictToFanslyPublicHost`).
//
// The page scope of the resolver is untouched: a request that carries a
// page's session rides that page's proxy, and nothing here can reach it.

/** The one host the public egress lets through: Fansly's API. */
export const FANSLY_PUBLIC_API_HOST = "apiv3.fansly.com";

/** Why the public egress has no transport now. */
export type FanslyPublicEgressUnavailableReason = "not_configured" | "shares_page_proxy" | "invalid";

export class FanslyPublicEgressUnavailableError extends Error {
  constructor(readonly reason: FanslyPublicEgressUnavailableReason, detail: string) {
    super(`The Fansly public egress is unavailable (${reason}): ${detail}`);
    this.name = "FanslyPublicEgressUnavailableError";
  }
}

/** A request the public egress refused before connecting: not Fansly's API. */
export class FanslyPublicHostRefusedError extends Error {
  constructor(readonly origin: string) {
    super(`The Fansly public egress refuses ${origin}: only https://${FANSLY_PUBLIC_API_HOST} is let through`);
    this.name = "FanslyPublicHostRefusedError";
  }
}

type EgressApp = { db: Database; config: Pick<AppConfig, "encryptionKey" | "encryptionKeyVersion" | "encryptionKeysByVersion"> };

/** The identity of a proxy: its address and its user (two users of one
 *  provider gateway are two exits). */
function proxyIdentity(proxy: ProxyConfig): string {
  return `${buildProxyEgressKey(proxy)}|${proxy.username ?? ""}`;
}

function decryptAuth(app: EgressApp, encryptedAuth: string | null): { username: string | null; password: string | null } | null {
  return encryptedAuth === null
    ? null
    : decryptJsonWithKeyVersion<{ username: string | null; password: string | null }>(
      encryptedAuth,
      app.config.encryptionKeysByVersion,
    );
}

/** The labels of the pages whose stored proxy is `proxy` (address and user). */
async function pagesSharingProxy(app: EgressApp, proxy: ProxyConfig): Promise<string[]> {
  const identity = proxyIdentity(proxy);
  const sharing: string[] = [];
  for (const endpoint of await listPageEgressEndpoints(app.db)) {
    let pageProxy: ProxyConfig;
    try {
      const auth = decryptAuth(app, endpoint.encryptedAuth);
      pageProxy = normalizeProxyConfig({ url: endpoint.url, username: auth?.username ?? null, password: auth?.password ?? null });
    } catch {
      // A page proxy this process cannot read is compared by address alone:
      // a doubt refuses.
      if (buildProxyEgressKey({ url: endpoint.url }) === buildProxyEgressKey(proxy)) sharing.push(endpoint.pageLabel);
      continue;
    }
    if (proxyIdentity(pageProxy) === identity) sharing.push(endpoint.pageLabel);
  }
  return sharing;
}

/** The stored proxy, decrypted, or null when none is configured. */
export async function readFanslyPublicProxy(app: EgressApp): Promise<ProxyConfig | null> {
  const stored = await readFanslyPublicEgress(app.db);
  if (stored === null) return null;
  try {
    const auth = decryptAuth(app, stored.encryptedAuth);
    return normalizeProxyConfig({ url: stored.url, username: auth?.username ?? null, password: auth?.password ?? null });
  } catch (error) {
    throw new FanslyPublicEgressUnavailableError(
      "invalid",
      `the stored proxy cannot be read (${error instanceof Error ? error.name : "error"})`,
    );
  }
}

/** The owner's view of the public egress: masked, never the password. */
export interface FanslyPublicEgressView {
  configured: boolean;
  /** `scheme//host:port (auth)`, as `page` commands print a page's proxy. */
  route: string | null;
  egressKey: string | null;
  updatedAt: string | null;
  /** Pages whose proxy it is: non-empty means the resolver refuses it. */
  sharedWithPages: string[];
}

export async function describeFanslyPublicEgress(app: EgressApp): Promise<FanslyPublicEgressView> {
  const stored = await readFanslyPublicEgress(app.db);
  if (stored === null) {
    return { configured: false, route: null, egressKey: null, updatedAt: null, sharedWithPages: [] };
  }
  const proxy = await readFanslyPublicProxy(app);
  return {
    configured: true,
    route: proxy === null ? null : formatMaskedProxyUrl(proxy),
    egressKey: proxy === null ? null : fanslyPublicEgressKey(proxy),
    updatedAt: stored.updatedAt.toISOString(),
    sharedWithPages: proxy === null ? [] : await pagesSharingProxy(app, proxy),
  };
}

/** The audit events of the owner's two levers. */
export const FANSLY_PUBLIC_EGRESS_SET_AUDIT_EVENT = "admin.fansly_public_egress_set";
export const FANSLY_PUBLIC_EGRESS_REMOVE_AUDIT_EVENT = "admin.fansly_public_egress_remove";

/**
 * Set (or replace) the public egress: the proxy validated (a supported
 * scheme, not a loopback or private target), refused when it is a page's,
 * its auth encrypted with the current key, stored and audited (the masked
 * route, never the password) in one transaction. Sends nothing.
 */
export async function saveFanslyPublicProxy(
  app: EgressApp,
  input: { proxy: ProxyConfig; actor: string; note: string },
): Promise<FanslyPublicEgressView> {
  const proxy = normalizeProxyConfig(input.proxy);
  await assertAllowedProxyTarget(proxy);
  const sharing = await pagesSharingProxy(app, proxy);
  if (sharing.length > 0) {
    throw new FanslyPublicEgressUnavailableError(
      "shares_page_proxy",
      `the proxy is the one of page(s) ${sharing.join(", ")}; the public reader needs a proxy no page uses`,
    );
  }
  const encryptedAuth = proxy.username || proxy.password
    ? JSON.stringify(encryptJson(
      { username: proxy.username ?? null, password: proxy.password ?? null },
      app.config.encryptionKey,
      app.config.encryptionKeyVersion,
    ))
    : null;
  await app.db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await storeFanslyPublicEgress(txDb, {
      url: proxy.url,
      encryptedAuth,
      keyVersion: encryptedAuth === null ? null : app.config.encryptionKeyVersion,
    });
    await insertAuditEvent(txDb, {
      source: "cli",
      eventType: FANSLY_PUBLIC_EGRESS_SET_AUDIT_EVENT,
      metadata: { actor: input.actor, note: input.note, route: formatMaskedProxyUrl(proxy) },
    });
  });
  return describeFanslyPublicEgress(app);
}

/** Remove the public egress (audited): the reader has no transport from its
 *  next pass. False when none was configured. */
export async function removeFanslyPublicProxy(app: EgressApp, input: { actor: string; note: string }): Promise<boolean> {
  return app.db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    const removed = await deleteFanslyPublicEgress(txDb);
    if (removed) {
      await insertAuditEvent(txDb, {
        source: "cli",
        eventType: FANSLY_PUBLIC_EGRESS_REMOVE_AUDIT_EVENT,
        metadata: { actor: input.actor, note: input.note },
      });
    }
    return removed;
  });
}

/** The egress key of the public egress: never one of a page's keys. */
export function fanslyPublicEgressKey(proxy: ProxyConfig): string {
  return `fansly-public:${buildProxyEgressKey(proxy)}`;
}

function originOf(options: Dispatcher.DispatchOptions): string {
  const origin = options.origin;
  return typeof origin === "string" ? origin : origin instanceof URL ? origin.origin : String(origin);
}

/** Whether `origin` is Fansly's API over HTTPS on its default port. */
export function isFanslyPublicOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.hostname === FANSLY_PUBLIC_API_HOST && (url.port === "" || url.port === "443")
    && url.username === "" && url.password === "";
}

/**
 * `dispatcher`, letting through only requests to Fansly's API: any other
 * origin throws `FanslyPublicHostRefusedError` from the dispatch itself —
 * before a connection or a proxy tunnel is opened — so the request rejects
 * and nothing leaves. The view closes the dispatcher it wraps.
 */
export function restrictToFanslyPublicHost(dispatcher: Dispatcher): Dispatcher {
  return dispatcher.compose((dispatch) => (options, handler) => {
    const origin = originOf(options);
    if (!isFanslyPublicOrigin(origin)) {
      throw new FanslyPublicHostRefusedError(origin);
    }
    return dispatch(options, handler);
  });
}

/**
 * The `fansly_public` scope: the stored proxy, its target checked, never a
 * page's, behind the host restriction. Unpaced here — the reader paces
 * itself. Throws `FanslyPublicEgressUnavailableError` when there is none to
 * use; nothing is sent then.
 */
export async function resolveFanslyPublicEgress(app: EgressApp): Promise<EgressContext<Dispatcher>> {
  const proxy = await readFanslyPublicProxy(app);
  if (proxy === null) {
    throw new FanslyPublicEgressUnavailableError("not_configured", "the owner has not set the public reader's proxy");
  }
  await assertAllowedProxyTarget(proxy).catch((error: unknown) => {
    throw new FanslyPublicEgressUnavailableError("invalid", error instanceof Error ? error.message : "invalid proxy target");
  });
  const sharing = await pagesSharingProxy(app, proxy);
  if (sharing.length > 0) {
    throw new FanslyPublicEgressUnavailableError(
      "shares_page_proxy",
      `the stored proxy is now the one of page(s) ${sharing.join(", ")}`,
    );
  }
  const base = createProxyRequestDispatcher(proxy);
  return {
    egressKey: fanslyPublicEgressKey(proxy),
    dispatcher: restrictToFanslyPublicHost(base),
    pace: async () => 0,
    close: async () => {
      await closeDispatcherWithin(base, FANSLY_PUBLIC_EGRESS_CLOSE_GRACE_MS);
    },
  };
}

/** How long the public egress lets its dispatcher close gracefully before it
 *  destroys it. */
export const FANSLY_PUBLIC_EGRESS_CLOSE_GRACE_MS = 2_000;

/**
 * Close `dispatcher`, gracefully for at most `graceMs`, then destroy it. A
 * proxy that accepted the TCP connection and never answered CONNECT keeps a
 * graceful close waiting long after the request itself timed out (undici
 * waits for the pending tunnel); the request is already settled by then, so
 * nothing is lost by tearing the connection down.
 */
export async function closeDispatcherWithin(
  dispatcher: Pick<Dispatcher, "close" | "destroy">,
  graceMs: number,
): Promise<"closed" | "destroyed"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = dispatcher.close().then(() => true, () => true);
  const finished = await Promise.race([
    closed,
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), graceMs);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
  if (finished) return "closed";
  await dispatcher.destroy().catch(() => undefined);
  return "destroyed";
}
