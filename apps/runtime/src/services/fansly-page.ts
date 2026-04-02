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
