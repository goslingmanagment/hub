import { findPageByLabel } from "@agency_hub_core/db";
import { normalizeProxyConfig, type ProxyConfig } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { NotFoundError } from "./errors.ts";
import { getOnlyMonsterAccountId } from "./onlyfans.ts";
import { removeProxy, resolvePageContext, saveProxy } from "./page-context.ts";
import { assertAllowedProxyTarget } from "./proxy-validation.ts";

export async function setPageProxy(
  app: AppContext,
  pageLabel: string,
  proxy: ProxyConfig,
) {
  const normalizedProxy = normalizeProxyConfig(proxy);
  await assertAllowedProxyTarget(normalizedProxy);
  const pageContext = await resolvePageContext(app, pageLabel);

  if (pageContext.platform === "fansly") {
    await app.adapter.verifySession({
      session: pageContext.session,
      proxy: normalizedProxy,
    });
  } else {
    await app.onlyFansAdapter.getAccount(
      {
        auth: pageContext.auth,
        proxy: normalizedProxy,
        requestObserver: null,
      },
      getOnlyMonsterAccountId(pageContext.page.metadata),
    );
  }

  await saveProxy(app, pageContext.page.id, normalizedProxy);
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
