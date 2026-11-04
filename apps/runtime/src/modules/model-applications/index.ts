import { routeSchemas } from "@agency_hub_core/contracts";

import { submitModelApplication } from "../../services/model-applications.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

// The agency site's model questionnaire (services/model-applications.ts).
// Public: gosling-agency.ru's nginx proxies /api/ here, so the page posts
// same-origin. request.ip is the client's own address behind that nginx
// (TRUST_PROXY=1).

const MODEL_APPLICATION_BODY_LIMIT_BYTES = 128 * 1024;

export function registerModelApplicationRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;

  server.post("/api/v1/model-applications", {
    schema: routeSchemas.modelApplicationSubmit,
    bodyLimit: MODEL_APPLICATION_BODY_LIMIT_BYTES,
    // A flood bound before the body is read; the hourly limit of stored
    // questionnaires is the service's own (5 an address).
    config: { rateLimit: { max: 30, timeWindow: 60_000 } },
  }, async (request, reply) => {
    const userAgent = request.headers["user-agent"];
    const result = await submitModelApplication(appContext, {
      submission: request.body,
      clientAddress: request.ip,
      userAgent: typeof userAgent === "string" && userAgent !== "" ? userAgent : null,
    });
    reply.code(201);
    return { ok: true as const, id: result.id };
  });
}
