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
import { fanslyPageSendGuard } from "./fansly-send-guard/index.ts";

export async function setPageProxy(
  app: AppContext,
  pageLabel: string,
  proxy: ProxyConfig,
) {
  const normalizedProxy = normalizeProxyConfig(proxy);
  await assertAllowedProxyTarget(normalizedProxy);
  // allowMissingProxy: assigning a proxy is the REPAIR for the fail-closed
  // proxyless state — resolving here must not refuse it. Verification below
  // egresses through the NEW proxy, never the stored (possibly null) one.
  const pageContext = await resolvePageContext(app, pageLabel, { allowMissingProxy: true });
  const storedProxyRouteKey = pageContext.proxy ? buildProxyEgressKey(pageContext.proxy) : null;
  const proxyRouteKey = buildProxyEgressKey(normalizedProxy);
  const preservesStoredProxyRoute = Boolean(
    storedProxyRouteKey && proxyRouteKey === storedProxyRouteKey,
  );
  const proxyEgressKey = preservesStoredProxyRoute
    ? pageContext.egressKey
    : proxyRouteKey;
  if (pageContext.platform !== "fansly") {
    // Stage 18: OnlyFans egress happens at the OFAPI vendor — a hub-side
    // proxy would never carry that traffic, so assigning one is an error.
    throw new BadRequestError(
      `Page "${pageContext.page.label}" is an OnlyFans page: its egress is vendor-side (OFAPI), hub proxies do not apply`,
    );
  }

  await app.adapter.verifySession({
    session: pageContext.session,
    proxy: normalizedProxy,
    egressKey: proxyEgressKey,
    // The page's own guard, whatever proxy the check rides (plan §2.4).
    sendGuard: fanslyPageSendGuard(app, pageContext.page.id, "account_me_cli"),
  });

  await saveProxy(app, pageContext.page.id, normalizedProxy, {
    rateLimitScopeKey: preservesStoredProxyRoute ? proxyEgressKey : undefined,
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
