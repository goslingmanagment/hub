import { opsLiveRouteSchemas } from "@agency_hub_core/contracts";

import { createOpsLiveReader } from "../../services/ops-live.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/** `GET /api/v1/ops/live`: the operator screen's one read of what Hub is
 * doing now (`services/ops-live.ts`). The monitoring token or the owner's
 * dashboard session; read-only — it writes no audit row and no metric. */
export function registerOpsLiveRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext, auth: { requireOpsLiveAccess } } = ctx;
  // One reader for the process: its caches are what keeps a two-second poll
  // from reading the slow parts on every request.
  const readOpsLive = createOpsLiveReader(appContext);
  server.get("/api/v1/ops/live", { schema: opsLiveRouteSchemas.opsLive }, async (request) => {
    await requireOpsLiveAccess(request);
    return readOpsLive(request.query.cursor);
  });
}
