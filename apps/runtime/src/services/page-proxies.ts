import { findPageByLabel } from "@agency_hub_core/db";
import {
  buildProxyEgressKey,
  normalizeProxyConfig,
  type ProxyConfig,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { NotFoundError } from "./errors.ts";
import { getOnlyMonsterAccountId } from "./onlyfans.ts";
import { removeProxy, resolvePageContext, saveProxy } from "./page-context.ts";
import { assertAllowedProxyTarget } from "./proxy-validation.ts";
import { createSyncRateLimitWaiter } from "./sync/rate-limiter.ts";

export async function setPageProxy(
  app: AppContext,
  pageLabel: string,
  proxy: ProxyConfig,
) {
  const normalizedProxy = normalizeProxyConfig(proxy);
  await assertAllowedProxyTarget(normalizedProxy);
  const pageContext = await resolvePageContext(app, pageLabel);
  const storedProxyRouteKey = pageContext.proxy ? buildProxyEgressKey(pageContext.proxy) : null;
  const proxyRouteKey = buildProxyEgressKey(normalizedProxy);
  const preservesStoredProxyRoute = Boolean(
    storedProxyRouteKey && proxyRouteKey === storedProxyRouteKey,
  );
  const proxyEgressKey = preservesStoredProxyRoute
    ? pageContext.egressKey
    : proxyRouteKey;
  const rateLimitWaiter = createSyncRateLimitWaiter(app, {
    egressKey: proxyEgressKey,
  });

  if (pageContext.platform === "fansly") {
    await app.adapter.verifySession({
      session: pageContext.session,
      proxy: normalizedProxy,
      egressKey: proxyEgressKey,
      rateLimitWaiter,
    });
  } else {
    await app.onlyFansAdapter.getAccount(
      {
        auth: pageContext.auth,
        proxy: normalizedProxy,
        egressKey: proxyEgressKey,
        requestObserver: null,
        rateLimitWaiter,
      },
      getOnlyMonsterAccountId(pageContext.page.metadata),
    );
  }

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
