import { findPageSummaryByLabel } from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { canAccessPage, type AuthPrincipal } from "../../services/auth.ts";
import { ForbiddenError, NotFoundError } from "../../services/errors.ts";

/**
 * Stage 23 platform neutrality: the workboard serves BOTH platforms — the
 * engine has always scored OnlyFans pages (recompute selects fansly OR
 * onlyfans-with-ofapi); this accessor drops the read-side platform throw that
 * made them compute-but-can't-serve. Access = the Stage 22 grant expansion
 * through canAccessPage.
 */
export async function resolveAccessibleWorkboardPage(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
) {
  const page = await findPageSummaryByLabel(app.db, pageLabel);
  if (!page) {
    throw new NotFoundError(`Page "${pageLabel}" was not found`);
  }
  if (!canAccessPage(principal, page.id)) {
    throw new ForbiddenError();
  }
  return page;
}
