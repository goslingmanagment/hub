import { readFanslyDmShadowSnapshot } from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";

export async function readDmShadowMaterial(
  app: Pick<AppContext, "db" | "logger">,
  input: Parameters<typeof readFanslyDmShadowSnapshot>[1],
) {
  try {
    return await readFanslyDmShadowSnapshot(app.db, input);
  } catch (error) {
    app.logger.warn({ err: error }, "DM shadow material check unavailable; full sweep continues");
    return null;
  }
}
