import { readFanslyDmShadowMaterial, type DmShadowMaterialReceipt } from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";

export async function readDmShadowMaterial(
  app: Pick<AppContext, "db" | "logger">,
  heads: ReadonlyArray<{ conversationId: number; messageId: string }>,
): Promise<Map<number, DmShadowMaterialReceipt> | null> {
  try {
    return await readFanslyDmShadowMaterial(app.db, heads);
  } catch (error) {
    app.logger.warn({ err: error }, "DM shadow material check unavailable; full sweep continues");
    return null;
  }
}
