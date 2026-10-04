import { findPageByLabel } from "@agency_hub_core/db";
import {
  buildProxyEgressKey,
  normalizeProxyConfig,
  type ProxyConfig,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { BadRequestError, NotFoundError } from "./errors.ts";
import { removeProxy, resolvePageContext, saveProxy } from "./page-context.ts";
import { assertAllowedProxyTarget } from "./proxy-validation.ts";
import { assertFanslyPageOnEngine, checkFanslyIdentityThroughEngine, saveVerifiedFanslyCredentials } from "./sync-engine-account.ts";

export async function setPageProxy(
  app: AppContext,
  pageLabel: string,
  proxy: ProxyConfig,
) {
  const known = await findPageByLabel(app.db, pageLabel);
  if (!known) {
    throw new NotFoundError(`Page "${pageLabel}" not found`);
  }
  if (known.page.platform !== "fansly") {
    // Stage 18: OnlyFans egress happens at the OFAPI vendor — a hub-side
    // proxy would never carry that traffic, so assigning one is an error.
    throw new BadRequestError(
      `Page "${known.page.label}" is an OnlyFans page: its egress is vendor-side (OFAPI), hub proxies do not apply`,
    );
  }
  // Step-3 design §3.5 item 6: the session check is the engine's
  // (`account.identity` with the candidate proxy). A page being switched, or
  // one the engine does not run, refuses (409) before anything is resolved or
  // sent — no legacy `/account/me` is left to check it with (step 4, S4-19).
  await assertFanslyPageOnEngine(app, known.page);
  const normalizedProxy = normalizeProxyConfig(proxy);
  await assertAllowedProxyTarget(normalizedProxy);
  // allowMissingProxy: resolving here must not refuse a proxyless page (or
  // open its incident) — the candidate is not the stored proxy. The check
  // egresses through the NEW proxy; the engine builds it over the stored pair.
  const pageContext = await resolvePageContext(app, pageLabel, { allowMissingProxy: true });
  const storedProxyRouteKey = pageContext.proxy ? buildProxyEgressKey(pageContext.proxy) : null;
  const preservesStoredProxyRoute = Boolean(
    storedProxyRouteKey && buildProxyEgressKey(normalizedProxy) === storedProxyRouteKey,
  );

  const verified = await checkFanslyIdentityThroughEngine(app, pageContext.page, { proxy: normalizedProxy });
  // Stored and trusted together, a CAS on the session the check rode with:
  // the new digest (the proxy is part of it) is the engine's from now on.
  await saveVerifiedFanslyCredentials(app, pageContext.page, verified, async (tx) => {
    await saveProxy({ config: app.config, db: tx }, pageContext.page.id, normalizedProxy,
      preservesStoredProxyRoute ? { rateLimitScopeKey: pageContext.egressKey } : {});
  });
}

export async function removePageProxy(
  app: AppContext,
  pageLabel: string,
) {
  const stored = await findPageByLabel(app.db, pageLabel);
  if (!stored) {
    throw new NotFoundError(`Page "${pageLabel}" not found`);
  }

  await removeProxy(app, stored.page.id);
}
