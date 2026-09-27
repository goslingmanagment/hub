import {rebuildOfapiMarketingState, getOfapiMarketingDashboard, prepareOfapiMarketingCommand, dispatchOfapiMarketingCommand, refreshOfapiMarketingPostbacks} from "../../services/ofapi-smart-links.ts";
import { cancelOfapiAction, dispatchOfapiAction, getOfapiAction, listOfapiActions, prepareOfapiAction, repairOfapiAction } from "../../services/ofapi-actions.ts";
import { readOfapiWebhookEventCatalog, refreshOfapiWebhookEventCatalog } from "../../services/ofapi-webhook-event-catalog.ts";
import {
  applyOfapiWebhookCollectionPolicy, listOfapiWebhookDeliveryHistory, redeliverOfapiWebhook,
  replayLocalOfapiWebhook, saveOfapiWebhookCollectionPolicy, syncOfapiWebhookDeliveries,
  webhookCollectionPolicyStatus,
} from "../../services/ofapi-webhook-recovery.ts";
import { getOfapiBannedDictionary } from "@agency_hub_core/db";
import { getOfapiBannedWordsPreview, refreshOfapiBannedWords } from "../../services/ofapi-banned-words.ts";
import { ServiceUnavailableError } from "../../services/errors.ts";
import { refreshOfapiBinding } from "../../services/ofapi-binding-refresh.ts";
import { routeSchemas } from "@agency_hub_core/contracts";

import {
  requireApiKeyUser,
  requireHarvestDeviceToken,
  requireOwner,
} from "../../services/auth.ts";
import {
  ingestClientObservations,
  InvalidIngestEventError,
  isHarvestClientVersion,
} from "../../services/ingest-observations.ts";
import {
  cancelOfapiCommand,
  createOfapiCommand,
  getOfapiCommand,
} from "../../services/ofapi-command-outbox.ts";
import {
  isOfapiCommandExecutionEnabled,
  sendOfapiCommandExecuteJob,
} from "../../services/ofapi-command-executor.ts";
import { executeOfapiReadGatewayRequest } from "../../services/ofapi-read-gateway.ts";
import { reportOfapiMediaFetches, resolveOfapiMedia } from "../../services/ofapi-media-resolve.ts";
import { createHash } from "node:crypto";
import {
  getOfapiWebhookStatus,
  receiveOfapiWebhook,
  reconcileOfapiWebhookRegistration,
  registerOfapiWebhook,
} from "../../services/ofapi-webhooks.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

// Ingest module (target §6.1): the observation front doors — OFAPI webhook
// receiver (HMAC over raw bytes, own plugin scope with the repo's only
// buffer-mode body parser), the Stage 11 client-capture lane, webhook admin,
// and the OFAPI custody lanes whose every response/settlement is journaled
// (Stage 9 read gateway capture-through, command outbox). Handlers relocated
// verbatim from server.ts (Stage 19 Task 3).

export async function registerIngestRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext, boss } = ctx;
  const { requirePrincipal } = ctx.auth;

  // Stage 11: client-capture lane. Bearer-only, size-capped, rate-limited;
  // backpressure = 429 with retry headers from the limiter — the desktop
  // spool absorbs and resends the whole batch until 2xx.
  server.post("/api/v1/ingest/observations", {
    schema: routeSchemas.ingestObservations,
    bodyLimit: 1_048_576,
    config: {
      rateLimit: {
        max: 120,
        timeWindow: "1 minute",
      },
    },
  }, async (request, reply) => {
    const principal = await requirePrincipal(request);
    requireApiKeyUser(principal);
    const clientVersion = request.headers["x-client-version"];
    if (typeof clientVersion !== "string" || clientVersion.trim().length === 0) {
      return reply.code(400).send({
        error: "missing_client_version",
        message: "The x-client-version header is required on the capture lane",
        statusCode: 400,
      });
    }
    const normalizedClientVersion = clientVersion.trim();
    const harvestCapability = isHarvestClientVersion(normalizedClientVersion)
      ? requireHarvestDeviceToken(principal)
      : null;
    try {
      return await ingestClientObservations(appContext, {
        principalUserId: principal.user.id,
        // Page scope mirrors canAccessPage: owner keys are unrestricted,
        // everyone else attributes only to their assigned pages.
        allowedPageIds: principal.user.role === "owner" ? null : principal.assignedPageIds,
        clientVersion: normalizedClientVersion,
        authorizedHarvestMachineId: harvestCapability?.machineId ?? null,
        events: request.body.events,
      });
    } catch (error) {
      if (error instanceof InvalidIngestEventError) {
        return reply.code(400).send({
          error: "invalid_ingest_event",
          message: error.message,
          statusCode: 400,
        });
      }
      throw error;
    }
  });

  // The receiver authenticates by HMAC over the raw request bytes, so this route
  // lives in its own plugin scope with the repo's only buffer-mode body parser.
  await server.register(async (instance) => {
    instance.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => {
        done(null, body);
      },
    );

    // No route-level rate limit ON PURPOSE (fast-reply freshness PR1): a 429
    // here drops signed deliveries BEFORE the journal — OFAPI stops retrying
    // after 3 attempts and the fact is lost. receiveOfapiWebhook already
    // implements the full target order (HMAC → validate → journal+observation
    // in one tx → 200 incl. duplicates → best-effort boss.send with sweep
    // recovery; journal-tx failure → 5xx retried by OFAPI).
    instance.post("/api/v1/ofapi/webhook", {
      schema: routeSchemas.ofapiWebhookReceive,
    }, async (request) => {
      return receiveOfapiWebhook(appContext, boss, {
        rawBody: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
        signatureHeader: request.headers.signature,
        idempotencyKeyHeader: request.headers["x-ofapi-idempotency-key"],
        redeliveryOfHeader: request.headers["x-ofapi-redelivery-of"],
      });
    });
  });

  server.get("/api/v1/admin/ofapi/webhook", {
    schema: routeSchemas.adminOfapiWebhookStatus,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);

    return getOfapiWebhookStatus(appContext);
  });

  server.get("/api/v1/admin/ofapi/webhook/event-catalog", {schema:routeSchemas.adminOfapiWebhookEventCatalog}, async request=>{
    const principal=await requirePrincipal(request);requireOwner(principal);
    return readOfapiWebhookEventCatalog(appContext);
  });
  server.post("/api/v1/admin/ofapi/webhook/event-catalog/refresh", {schema:routeSchemas.adminOfapiWebhookEventCatalogRefresh}, async request=>{
    const principal=await requirePrincipal(request);requireOwner(principal);
    return refreshOfapiWebhookEventCatalog(appContext,principal.user.id);
  });
  server.get("/api/v1/admin/ofapi/webhook/deliveries", { schema: routeSchemas.adminOfapiWebhookDeliveries }, async request => {
    const principal = await requirePrincipal(request); requireOwner(principal);
    return listOfapiWebhookDeliveryHistory(appContext, { limit: request.query.limit, offset: request.query.offset, failedOnly: request.query.failedOnly === "true" });
  });
  server.post("/api/v1/admin/ofapi/webhook/deliveries/sync", { schema: routeSchemas.adminOfapiWebhookDeliverySync }, async request => {
    const principal = await requirePrincipal(request); requireOwner(principal);
    return syncOfapiWebhookDeliveries(appContext, { ...request.body, actorUserId: principal.user.id });
  });
  server.post("/api/v1/admin/ofapi/webhook/deliveries/redeliver", { schema: routeSchemas.adminOfapiWebhookRedeliver }, async request => {
    const principal = await requirePrincipal(request); requireOwner(principal);
    return redeliverOfapiWebhook(appContext, { ...request.body, actorUserId: principal.user.id });
  });
  server.post("/api/v1/admin/ofapi/webhook/replay", { schema: routeSchemas.adminOfapiWebhookReplay }, async request => {
    const principal = await requirePrincipal(request); requireOwner(principal);
    return replayLocalOfapiWebhook(appContext, { ...request.body, actorUserId: principal.user.id });
  });
  server.get("/api/v1/admin/ofapi/webhook/collection-policy", { schema: routeSchemas.adminOfapiWebhookCollectionPolicy }, async request => {
    const principal = await requirePrincipal(request); requireOwner(principal);
    return webhookCollectionPolicyStatus(appContext);
  });
  server.put("/api/v1/admin/ofapi/webhook/collection-policy", { schema: routeSchemas.adminOfapiWebhookCollectionPolicySave }, async request => {
    const principal = await requirePrincipal(request); requireOwner(principal);
    return saveOfapiWebhookCollectionPolicy(appContext, { ...request.body, actorUserId: principal.user.id });
  });
  server.post("/api/v1/admin/ofapi/webhook/collection-policy/apply", { schema: routeSchemas.adminOfapiWebhookCollectionPolicyApply }, async request => {
    const principal = await requirePrincipal(request); requireOwner(principal);
    return applyOfapiWebhookCollectionPolicy(appContext, { ...request.body, actorUserId: principal.user.id });
  });

  server.post("/api/v1/admin/ofapi/webhook/bindings", {
    schema: routeSchemas.adminOfapiBindingRefresh,
  }, async request => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return refreshOfapiBinding(appContext, request.body, principal.user.id);
  });
  server.get("/api/v1/admin/ofapi/webhook/preflight", {
    schema: routeSchemas.adminOfapiCredentialPreflight,
  }, async request => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const proof = await appContext.ofapi?.getCredentialPreflight?.();
    if (!proof) throw new ServiceUnavailableError("OFAPI preflight unavailable");
    return proof;
  });

  server.post("/api/v1/admin/ofapi/webhook", {
    schema: routeSchemas.adminOfapiWebhookRegister,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);

    return registerOfapiWebhook(appContext, { endpointUrl: request.body.endpointUrl });
  });

  server.post("/api/v1/admin/ofapi/webhook/reconcile", {
    schema: routeSchemas.adminOfapiWebhookReconcile,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);

    return reconcileOfapiWebhookRegistration(appContext, request.body);
  });

  server.get("/api/v1/ofapi/read/*", {
    schema: routeSchemas.ofapiReadGateway,
    config: {
      rateLimit: {
        max: 120,
        timeWindow: "1 minute",
      },
    },
  }, async (request, reply) => {
    const principal = await requirePrincipal(request);
    requireApiKeyUser(principal);

    const response = await executeOfapiReadGatewayRequest(appContext, principal, {
      rawPath: request.params["*"],
      rawQuery: request.query as Record<string, unknown>,
      readIntent: typeof request.headers["x-agency-hub-read-intent"] === "string"
        ? request.headers["x-agency-hub-read-intent"]
        : null,
    });
    for (const [name, value] of Object.entries(response.headers)) {
      reply.header(name, value);
    }
    return reply.code(response.status as 200).send(response.body);
  });

  // Desktop media images (docs/runbooks/ofapi-media.md). Per-device limits:
  // a 40-cell gallery scrolled needs far more than the gateway's 120/min, and
  // the key is the bearer credential (one device token), not the address.
  const perDevice = (request: { headers: Record<string, string | string[] | undefined>; ip: string }) => {
    const authorization = request.headers.authorization;
    return typeof authorization === "string" && authorization.length > 0
      ? `media:${createHash("sha256").update(authorization).digest("hex").slice(0, 32)}`
      : `media-ip:${request.ip}`;
  };
  server.post("/api/v1/ofapi/media/resolve", {
    schema: routeSchemas.ofapiMediaResolve,
    config: { rateLimit: { max: 300, timeWindow: "1 minute", keyGenerator: perDevice } },
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireApiKeyUser(principal);
    return resolveOfapiMedia(appContext, principal, request.body);
  });
  server.post("/api/v1/ofapi/media/reports", {
    schema: routeSchemas.ofapiMediaReports,
    config: { rateLimit: { max: 120, timeWindow: "1 minute", keyGenerator: perDevice } },
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireApiKeyUser(principal);
    return reportOfapiMediaFetches(appContext, principal, request.body.reports);
  });

  server.post("/api/v1/admin/ofapi/marketing/rebuild", {schema:routeSchemas.ofapiMarketingRebuild}, async request => {
    const principal=await requirePrincipal(request); requireOwner(principal);
    return rebuildOfapiMarketingState(appContext,principal.user.id);
  });
  server.post("/api/v1/admin/ofapi/actions", { schema: routeSchemas.ofapiActionPrepare }, async request => {
    const principal = await requirePrincipal(request); requireOwner(principal);
    return prepareOfapiAction(appContext, request.body, principal.user.id);
  });
  server.get("/api/v1/admin/ofapi/actions", { schema: routeSchemas.ofapiActionList }, async request => {
    requireOwner(await requirePrincipal(request)); return listOfapiActions(appContext, request.query.pageId);
  });
  server.get("/api/v1/admin/ofapi/actions/:id", { schema: routeSchemas.ofapiActionGet }, async request => {
    requireOwner(await requirePrincipal(request)); return getOfapiAction(appContext, request.params.id);
  });
  server.post("/api/v1/admin/ofapi/actions/:id/dispatch", { schema: routeSchemas.ofapiActionDispatch }, async request => {
    const principal = await requirePrincipal(request); requireOwner(principal);
    return dispatchOfapiAction(appContext, request.params.id, principal.user.id);
  });
  server.post("/api/v1/admin/ofapi/actions/:id/cancel", { schema: routeSchemas.ofapiActionCancel }, async request => {
    const principal = await requirePrincipal(request); requireOwner(principal);
    return cancelOfapiAction(appContext, request.params.id, principal.user.id);
  });
  server.post("/api/v1/admin/ofapi/actions/:id/repair", { schema: routeSchemas.ofapiActionRepair }, async request => {
    requireOwner(await requirePrincipal(request)); return repairOfapiAction(appContext, request.params.id);
  });
  server.get("/api/v1/admin/ofapi/marketing", {schema:routeSchemas.ofapiMarketingGet}, async request => {
    requireOwner(await requirePrincipal(request)); return getOfapiMarketingDashboard(appContext);
  });
  server.post("/api/v1/admin/ofapi/marketing/intents", {schema:routeSchemas.ofapiMarketingPrepare}, async request => {
    const principal = await requirePrincipal(request); requireOwner(principal);
    return prepareOfapiMarketingCommand(appContext, request.body, principal.user.id);
  });
  server.post("/api/v1/admin/ofapi/marketing/intents/:id/dispatch", {schema:routeSchemas.ofapiMarketingDispatch}, async request => {
    const principal = await requirePrincipal(request); requireOwner(principal);
    return dispatchOfapiMarketingCommand(appContext, {...request.body,id:request.params.id}, principal.user.id);
  });
  server.post("/api/v1/admin/ofapi/marketing/postbacks/refresh", {schema:routeSchemas.ofapiMarketingPostbacksRefresh}, async request => {
    const principal = await requirePrincipal(request); requireOwner(principal);
    return refreshOfapiMarketingPostbacks(appContext, principal.user.id, request.body.postbackId);
  });

  server.get("/api/v1/admin/ofapi/banned-words", { schema: routeSchemas.ofapiBannedWordsAdminGet }, async request => {
    requireOwner(await requirePrincipal(request)); return getOfapiBannedDictionary(appContext.db);
  });
  server.get("/api/v1/ofapi/banned-words", { schema: routeSchemas.ofapiBannedWordsGet }, async request => {
    requireApiKeyUser(await requirePrincipal(request));
    return getOfapiBannedDictionary(appContext.db);
  });
  server.post("/api/v1/ofapi/banned-words/preview", { schema: routeSchemas.ofapiBannedWordsPreview }, async request => {
    requireApiKeyUser(await requirePrincipal(request));
    return getOfapiBannedWordsPreview(appContext, request.body.text);
  });
  server.post("/api/v1/admin/ofapi/banned-words/refresh", { schema: routeSchemas.ofapiBannedWordsRefresh }, async request => {
    requireOwner(await requirePrincipal(request));
    return refreshOfapiBannedWords(appContext, request.body.maxPages);
  });

  server.post("/api/v1/ofapi/commands", {
    schema: routeSchemas.createOfapiCommand,
    config: {
      rateLimit: {
        max: 60,
        timeWindow: "1 minute",
      },
    },
  }, async (request, reply) => {
    const principal = await requirePrincipal(request);
    requireApiKeyUser(principal);
    const result = await createOfapiCommand(appContext, principal, request.body);
    if (result.status === 202 && boss && isOfapiCommandExecutionEnabled(appContext.config)) {
      try {
        await sendOfapiCommandExecuteJob(boss, result.command.commandId);
      } catch (error) {
        request.log.warn(
          { err: error, commandId: result.command.commandId },
          "Failed to enqueue OFAPI command; sweep will retry",
        );
      }
    }
    return reply.code(result.status).send(result.command);
  });

  server.get("/api/v1/ofapi/commands/:commandId", {
    schema: routeSchemas.getOfapiCommand,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireApiKeyUser(principal);
    return getOfapiCommand(appContext, principal, request.params.commandId);
  });

  server.post("/api/v1/ofapi/commands/:commandId/cancel", {
    schema: routeSchemas.cancelOfapiCommand,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireApiKeyUser(principal);
    return cancelOfapiCommand(appContext, principal, request.params.commandId);
  });
}
