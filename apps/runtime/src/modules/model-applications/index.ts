import { routeSchemas } from "@agency_hub_core/contracts";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { BadRequestError } from "../../services/errors.ts";
import {
  getModelApplicationConsoleEntry,
  listModelApplicationConsole,
} from "../../services/model-application-console.ts";
import { recordModelApplicationProgressPost } from "../../services/model-application-sessions.ts";
import { submitModelApplication } from "../../services/model-applications.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

// The agency site's model questionnaire (services/model-applications.ts) and
// its fillings' progress (services/model-application-sessions.ts). Public:
// gosling-agency.ru's nginx proxies /api/ here, so the page posts
// same-origin. request.ip is the client's own address behind that nginx
// (TRUST_PROXY=1).

const MODEL_APPLICATION_BODY_LIMIT_BYTES = 128 * 1024;
const MODEL_APPLICATION_PROGRESS_BODY_LIMIT_BYTES = 128 * 1024;

export async function registerModelApplicationRoutes(server: ApiServer, ctx: ApiModuleContext) {
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

  // The owner's console (Команда → Анкеты): read-only, polled while open.
  server.get("/api/v1/admin/model-applications", {
    schema: routeSchemas.adminModelApplications,
  }, async () => listModelApplicationConsole(appContext));

  server.get("/api/v1/admin/model-applications/:ref", {
    schema: routeSchemas.adminModelApplication,
  }, async (request) => getModelApplicationConsoleEntry(appContext, request.params.ref));

  // The progress post has its own body-parser scope: navigator.sendBeacon with
  // a string sends the same JSON as text/plain, so text/plain is read as JSON.
  await server.register(async (plugin) => {
    const instance = plugin.withTypeProvider<ZodTypeProvider>();
    instance.removeContentTypeParser("text/plain");
    instance.addContentTypeParser("text/plain", { parseAs: "string" }, (_request, body, done) => {
      try {
        done(null, JSON.parse(body as string) as unknown);
      } catch {
        done(new BadRequestError("Invalid request body"), undefined);
      }
    });

    instance.post("/api/v1/model-applications/progress", {
      schema: routeSchemas.modelApplicationProgress,
      bodyLimit: MODEL_APPLICATION_PROGRESS_BODY_LIMIT_BYTES,
      // 1000 posts an address an hour (the page posts at most every 5 s while
      // the model types); 50 new fillings an address a day is the service's.
      config: { rateLimit: { max: 1000, timeWindow: 60 * 60_000 } },
    }, async (request, reply) => {
      await recordModelApplicationProgressPost(appContext, {
        progress: request.body,
        clientAddress: request.ip,
      });
      reply.code(204);
      return null;
    });
  });
}
