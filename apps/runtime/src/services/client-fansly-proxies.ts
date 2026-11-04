import type { ClientFanslyProxiesResponse } from "@agency_hub_core/contracts";
import { findPageById, listClientBootstrapPages } from "@agency_hub_core/db";
import { normalizeProxyConfigWithMetadata } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { requireApiKeyUser, type HumanAuthPrincipal } from "./auth.ts";
import { resolveStoredProxyConfig } from "./page-context.ts";

/**
 * The proxies of the caller's Fansly pages, with their logins (`clientFanslyProxies`, capability `fansly-proxies-v1`).
 *
 * WHY THE LOGIN LEAVES THE HUB. Firefox Multi-Account Containers puts a container's proxy only on requests that have a
 * tab; Fansly's service worker, another add-on's content script and the extension's background leave from the chatter's
 * own line. Firefox shows an extension another add-on's proxy without its password, so the extension takes it from
 * here and routes those requests itself (owner, 2026-11-04). The chatters of a page already work behind this proxy.
 *
 * WHO MAY READ. A device token's (a cookie session is 403), and only the active Fansly pages granted to the caller: the
 * scope is the caller's, so another page's login is never in the answer. No owner switch.
 *
 * WHAT. One row per such page with a proxy; a page without one is absent, and so is a row the hub cannot read (logged):
 * one bad row must not take the others' proxies away. Database only: no platform request, no queued work.
 */
export async function readClientFanslyProxies(
  app: AppContext,
  principal: HumanAuthPrincipal,
  pageIds: readonly number[] | null,
): Promise<ClientFanslyProxiesResponse> {
  // A cookie session → 403: the read is a client's.
  requireApiKeyUser(principal);
  const rows = await listClientBootstrapPages(app.db, pageIds);
  const proxies: ClientFanslyProxiesResponse["proxies"] = [];
  for (const row of rows) {
    if (row.platform !== "fansly") continue;
    try {
      const stored = await findPageById(app.db, row.id);
      const proxy = stored === null ? null : resolveStoredProxyConfig(app, stored.proxy);
      if (proxy === null) continue;
      const normalized = normalizeProxyConfigWithMetadata(proxy);
      proxies.push({
        pageLabel: row.label,
        platformAccountId: row.platformAccountId,
        scheme: normalized.protocol.replace(/:$/, ""),
        host: normalized.hostname,
        port: normalized.port,
        username: normalized.username,
        password: normalized.password,
      });
    } catch (error) {
      // Never the error's own text: it may quote the stored address.
      app.logger.warn({ pageLabel: row.label, errorName: error instanceof Error ? error.name : "unknown" }, "client fansly proxy unreadable");
    }
  }
  return { proxies, serverNow: new Date().toISOString() };
}
