import { findPageByLabel } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { NotFoundError } from "./errors.ts";
import { removeProxy } from "./page-context.ts";

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
