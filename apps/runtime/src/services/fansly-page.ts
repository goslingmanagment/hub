import { findPageSummaryByLabel } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { canAccessPage, type AuthPrincipal } from "./auth.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "./errors.ts";

export async function resolveAccessibleFanslyPage(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
  unsupportedFeatureLabel: string,
) {
  const page = await findPageSummaryByLabel(app.db, pageLabel);
  if (!page) {
    throw new NotFoundError(`Page "${pageLabel}" was not found`);
  }
  if (!canAccessPage(principal, page.id)) {
    throw new ForbiddenError();
  }
  if (page.platform !== "fansly") {
    throw new BadRequestError(`${unsupportedFeatureLabel} is only supported for Fansly pages`);
  }

  return page;
}

/**
 * Like resolveAccessibleFanslyPage, but for features backed by core's
 * platform-agnostic DM store (page_dm_threads / page_dm_messages): these
 * work for OnlyFans pages too once OFAPI feeds them (decision #49). Pages
 * without DM data simply yield empty results.
 */
export async function resolveAccessibleDmPage(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
  unsupportedFeatureLabel: string,
) {
  const page = await findPageSummaryByLabel(app.db, pageLabel);
  if (!page) {
    throw new NotFoundError(`Page "${pageLabel}" was not found`);
  }
  if (!canAccessPage(principal, page.id)) {
    throw new ForbiddenError();
  }
  if (page.platform !== "fansly" && page.platform !== "onlyfans") {
    throw new BadRequestError(`${unsupportedFeatureLabel} is not supported on ${page.platform} pages`);
  }

  return page;
}
