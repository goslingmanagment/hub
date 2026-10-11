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
  server.get("/api/v1/ops/live", {
    schema: opsLiveRouteSchemas.opsLive,
    // The screen asks every two seconds. The two lines a served request
    // writes at `info` were three quarters of the API's log within a day of
    // the first monitor asking; from `warn` up they are not written.
    logLevel: "warn",
    // A refusal is answered without a log line anywhere else, and with the
    // route this quiet a rejected key would then leave no trace at all. Only
    // the status: no header, no token, no address beyond the request's own.
    onResponse: async (request, reply) => {
      if (reply.statusCode >= 400 && reply.statusCode < 500) {
        request.log.warn({ statusCode: reply.statusCode }, "ops/live request refused");
      }
    },
  }, async (request) => {
    await requireOpsLiveAccess(request);
    return readOpsLive(request.query.cursor);
  });
}
