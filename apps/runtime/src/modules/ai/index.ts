import { routeSchemas } from "@agency_hub_core/contracts";
import {
  getAiGenerationContentByRef,
  listAiGenerationContent,
} from "@agency_hub_core/db";

import {
  prepareAiGatewayStream,
  serializeAiGatewaySseFrame,
} from "../../services/ai-gateway.ts";
import { getAdminChatterUsageReport, ingestAiUsageBatch } from "../../services/ai-usage.ts";
import { requireApiKeyUser, requireOwner } from "../../services/auth.ts";
import { NotFoundError } from "../../services/errors.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

// AI module (target §6.1): gateway stream, usage ledger intake, usage
// reporting. Handlers relocated verbatim from server.ts (Stage 19 Task 3).

export function registerAiRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.post("/api/v1/ai-usage/batch", {
    schema: routeSchemas.aiUsageBatch,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return ingestAiUsageBatch(appContext, principal, request.body);
  });

  server.post("/api/v1/ai/gateway/stream", {
    schema: routeSchemas.aiGatewayStream,
  }, async (request, reply) => {
    const principal = await requirePrincipal(request);
    requireApiKeyUser(principal);
    const stream = await prepareAiGatewayStream(appContext, principal, request.body);

    reply.hijack();
    const raw = reply.raw;
    const startedAt = Date.now();
    let terminalOutcome: "completed" | "failed" | "cancelled" = "completed";
    let terminalUsage: Parameters<typeof stream.recordTerminal>[0]["usage"] = null;
    let terminalProviderResponseId: string | null = null;
    let terminalCacheHit = false;
    let streamedContent = false;
    let completionText = "";
    let terminalStopReason: string | null = null;
    let terminalDoneFrame: Parameters<typeof serializeAiGatewaySseFrame>[0] | null = null;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const abort = new AbortController();
    function abortProvider() {
      abort.abort();
    }
    function writeFrame(frame: Parameters<typeof serializeAiGatewaySseFrame>[0]) {
      if (!raw.writableEnded && !raw.destroyed) {
        raw.write(serializeAiGatewaySseFrame(frame));
      }
    }

    raw.on("close", abortProvider);
    try {
      writeFrame(stream.meta);
      for await (const frame of stream.stream(abort.signal)) {
        if (frame.type === "usage") {
          terminalUsage = frame.usage;
          terminalProviderResponseId = frame.providerResponseId;
          terminalCacheHit = frame.cacheHit;
        } else if (frame.type === "content_delta" && frame.text.length > 0) {
          streamedContent = true;
          completionText += frame.text;
        } else if (frame.type === "error") {
          terminalOutcome = "failed";
        } else if (frame.type === "done") {
          terminalDoneFrame = frame;
          terminalStopReason = frame.stopReason ?? null;
          continue;
        }
        writeFrame(frame);
      }
      if (terminalOutcome === "completed" && streamedContent && !terminalUsage) {
        terminalOutcome = "failed";
        request.log.warn({
          requestId: stream.requestId,
        }, "AI gateway provider stream ended without usage metadata");
        writeFrame({
          type: "error",
          code: "provider_usage_missing",
          message: "AI gateway provider ended without usage metadata",
          retryAfterMs: null,
        });
      } else if (terminalDoneFrame) {
        writeFrame(terminalDoneFrame);
      }
    } catch (error) {
      if (abort.signal.aborted) {
        terminalOutcome = "cancelled";
      } else {
        terminalOutcome = "failed";
        request.log.warn({
          requestId: stream.requestId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        }, "AI gateway provider stream failed");
        writeFrame({
          type: "error",
          code: "provider_stream_failed",
          message: "AI gateway provider stream failed",
          retryAfterMs: null,
        });
      }
    } finally {
      raw.off("close", abortProvider);
      try {
        await stream.recordTerminal({
          outcome: terminalOutcome,
          usage: terminalUsage,
          providerResponseId: terminalProviderResponseId,
          cacheHit: terminalCacheHit,
          durationMs: Date.now() - startedAt,
          completedAt: new Date(),
          completionText,
          stopReason: terminalStopReason,
        });
      } catch (error) {
        request.log.error({
          requestId: stream.requestId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        }, "AI gateway terminal ledger write failed");
      }
      if (!raw.writableEnded && !raw.destroyed) {
        raw.end();
      }
    }
  });

  server.get("/api/v1/admin/usage/chatters", {
    schema: routeSchemas.adminChatterUsage,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return getAdminChatterUsageReport(appContext, request.query);
  });

  // Stage 29 restricted capture class (DP 6-A): owner-only — never
  // team_lead/chatter (assumption 5; grant machinery is the later upgrade).
  server.get("/api/v1/ai/restricted/generations", {
    schema: routeSchemas.aiRestrictedGenerations,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const rows = await listAiGenerationContent(appContext.db, request.query);
    return { generations: rows.map(serializeRestrictedGeneration) };
  });

  server.get("/api/v1/ai/restricted/generations/:generationRef", {
    schema: routeSchemas.aiRestrictedGenerationDetail,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const found = await getAiGenerationContentByRef(
      appContext.db,
      request.params.generationRef,
    );
    if (!found) {
      throw new NotFoundError("Generation not found");
    }
    return {
      generation: serializeRestrictedGeneration(found.generation),
      acceptance: found.acceptance.map((event) => ({
        lifecycle: event.lifecycle,
        userId: event.userId,
        occurredAt: event.occurredAt.toISOString(),
      })),
    };
  });
}

function serializeRestrictedGeneration(
  row: Awaited<ReturnType<typeof listAiGenerationContent>>[number],
) {
  return {
    generationRef: row.generationRef,
    feature: row.feature,
    model: row.model,
    provider: row.provider,
    userId: row.userId,
    pageId: row.pageId,
    conversationRef: row.conversationRef,
    promptBlocks: row.promptBlocks,
    completion: row.completion,
    params: row.params,
    createdAt: row.createdAt.toISOString(),
  };
}
