import { routeSchemas } from "@agency_hub_core/contracts";
import {
  classifyProviderStreamFailure,
  formatObservedError,
} from "@agency_hub_core/shared";

// Stage 30: the migrated prompt unit's public surface (tests and feature
// services reach it through this module index — boundary rule).
export * from "./prompts/index.ts";
export * from "./context/index.ts";
export * from "./features/index.ts";
import {
  getAiGenerationContentByRef,
  listAiGenerationContent,
  archiveAiPersona,
  AiPersonaVersionConflictError,
  listAiPersonaStates,
  listAiPersonas,
  upsertAiPersona,
} from "@agency_hub_core/db";

import {
  prepareAiGatewayStream,
  serializeAiGatewaySseFrame,
} from "../../services/ai-gateway.ts";
import { prepareAiFeatureStream } from "./features/index.ts";
import { getAdminChatterUsageReport, ingestAiUsageBatch } from "../../services/ai-usage.ts";
import { requireApiKeyUser, requireOwner } from "../../services/auth.ts";
import { ConflictError, NotFoundError } from "../../services/errors.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";
import { hasDebugInputCapability } from "./prompt-debug-echo.ts";
import { aiPersonaDefinitionId } from "./persona-definition.ts";

export {
  hasDebugInputCapability,
  isPromptDebugEchoEnabled,
} from "./prompt-debug-echo.ts";

interface PersonaRecord {
  key: string;
  displayName: string;
  systemBlock: string;
  updatedAt: Date;
  archivedAt: Date | null;
  revision: number;
}

const ADMIN_PERSONA_MUTATIONS_ENABLED = false;

function requireAdminPersonaMutationsEnabled(): void {
  if (!ADMIN_PERSONA_MUTATIONS_ENABLED) {
    throw new ConflictError(
      "AI persona administration is read-only until legacy client write access is closed",
    );
  }
}

function serializePersona(persona: PersonaRecord) {
  return {
    key: persona.key,
    displayName: persona.displayName,
    systemBlock: persona.systemBlock,
    updatedAt: persona.updatedAt.toISOString(),
    version: persona.revision,
  };
}

function serializeAdminPersona(persona: PersonaRecord) {
  return {
    ...serializePersona(persona),
    status: persona.archivedAt === null ? "active" as const : "archived" as const,
  };
}

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
    await pipeAiGatewaySse(request, reply, stream);
  });

  // Transitional legacy full-text route. Shipped clients still read this
  // contract while the read-only catalog releases roll out.
  server.get("/api/v1/ai/personas", {
    schema: routeSchemas.aiPersonasList,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireApiKeyUser(principal);
    const personas = await listAiPersonas(appContext.db);
    return {
      personas: personas.map(serializePersona),
    };
  });

  // Client-facing steady-state contract: metadata only. Prompt instructions
  // never cross this route, including for archived tombstones.
  server.get("/api/v1/ai/persona-catalog", {
    schema: routeSchemas.aiPersonaCatalog,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireApiKeyUser(principal);
    const personas = await listAiPersonaStates(appContext.db);
    return {
      personas: personas.map((persona) => ({
        key: persona.key,
        displayName: persona.displayName,
        version: persona.revision,
        // Opaque content identity. Unlike the monotonic database revision, it
        // remains correct if disaster recovery restores an older definition.
        definitionId: aiPersonaDefinitionId(persona),
        status: persona.archivedAt === null ? "active" as const : "archived" as const,
      })),
    };
  });

  // Transitional legacy write lane. Omitted expectedVersion retains the
  // shipped clients' last-write-wins behavior until preservation coverage is
  // proven. Numeric tokens remain additive for already-built newer clients.
  server.put("/api/v1/ai/personas/:key", {
    schema: routeSchemas.aiPersonaUpsert,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireApiKeyUser(principal);
    let persona;
    try {
      persona = await upsertAiPersona(appContext.db, {
        key: request.params.key,
        displayName: request.body.displayName,
        systemBlock: request.body.systemBlock,
        ...(request.body.expectedVersion !== undefined
          ? { expectedVersion: request.body.expectedVersion }
          : {}),
      });
    } catch (error) {
      if (error instanceof AiPersonaVersionConflictError) {
        throw new ConflictError(error.message);
      }
      throw error;
    }
    return serializePersona(persona);
  });

  server.delete("/api/v1/ai/personas/:key", {
    schema: routeSchemas.aiPersonaArchive,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireApiKeyUser(principal);
    let archived;
    try {
      archived = await archiveAiPersona(
        appContext.db,
        request.params.key,
        request.query.expectedVersion === undefined
          ? undefined
          : request.query.expectedVersion === 0
            ? null
            : request.query.expectedVersion,
      );
    } catch (error) {
      if (error instanceof AiPersonaVersionConflictError) {
        throw new ConflictError(error.message);
      }
      throw error;
    }
    if (archived === null) {
      throw new NotFoundError("Persona not found");
    }
    return { archived: true, version: archived.revision };
  });

  // Future permanent owner namespace. Full reads are cookie-session + owner
  // only; mutations stay registered but fail closed until the legacy bearer
  // write lane is removed. Bearer credentials cannot read prompt text here.
  server.get("/api/v1/admin/ai/personas", {
    schema: routeSchemas.adminAiPersonasList,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const personas = await listAiPersonaStates(appContext.db);
    return { personas: personas.map(serializeAdminPersona) };
  });

  server.post("/api/v1/admin/ai/personas", {
    schema: routeSchemas.adminAiPersonaCreate,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    requireAdminPersonaMutationsEnabled();
    try {
      const persona = await upsertAiPersona(appContext.db, {
        key: request.body.key,
        displayName: request.body.displayName,
        systemBlock: request.body.systemBlock,
        expectedVersion: null,
      });
      return serializeAdminPersona(persona);
    } catch (error) {
      if (error instanceof AiPersonaVersionConflictError) {
        throw new ConflictError(error.message);
      }
      throw error;
    }
  });

  server.put("/api/v1/admin/ai/personas/:key", {
    schema: routeSchemas.adminAiPersonaUpdate,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    requireAdminPersonaMutationsEnabled();
    try {
      const persona = await upsertAiPersona(appContext.db, {
        key: request.params.key,
        displayName: request.body.displayName,
        systemBlock: request.body.systemBlock,
        expectedVersion: request.body.expectedVersion,
      });
      return serializeAdminPersona(persona);
    } catch (error) {
      if (error instanceof AiPersonaVersionConflictError) {
        throw new ConflictError(error.message);
      }
      throw error;
    }
  });

  server.delete("/api/v1/admin/ai/personas/:key", {
    schema: routeSchemas.adminAiPersonaArchive,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    requireAdminPersonaMutationsEnabled();
    let persona;
    try {
      persona = await archiveAiPersona(
        appContext.db,
        request.params.key,
        request.query.expectedVersion,
      );
    } catch (error) {
      if (error instanceof AiPersonaVersionConflictError) {
        throw new ConflictError(error.message);
      }
      throw error;
    }
    if (persona === null) {
      throw new NotFoundError("Persona not found");
    }
    return serializeAdminPersona(persona);
  });

  // Stage 30: kernel-side prompt assembly — same auth, same SSE pump, same
  // gateway internals; only the prompt is built here instead of the client.
  server.post("/api/v1/ai/features/:feature", {
    schema: routeSchemas.aiFeatureStream,
  }, async (request, reply) => {
    const principal = await requirePrincipal(request);
    requireApiKeyUser(principal);
    const stream = await prepareAiFeatureStream(
      appContext,
      principal,
      request.params.feature,
      request.body,
      {
        debugPromptEcho: hasDebugInputCapability(
          request.headers["x-kernel-ai-capabilities"],
        ),
      },
    );
    await pipeAiGatewaySse(request, reply, stream);
  });
}

/** The gateway SSE pump — shared by the raw stream route and Stage 30's
 * feature-service route (identical framing, terminal record, hijack). */
export async function pipeAiGatewaySse(
  request: { log: { warn: (obj: unknown, msg: string) => void; error: (obj: unknown, msg: string) => void } },
  reply: { hijack(): void; raw: NodeJS.WritableStream & { writableEnded: boolean; destroyed: boolean; writeHead(status: number, headers: Record<string, string>): void; on(event: string, cb: () => void): void; off(event: string, cb: () => void): void; end(): void } },
  stream: Awaited<ReturnType<typeof prepareAiGatewayStream>>,
) {
  {
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
      "cache-control": "no-store, no-cache, no-transform",
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
      if (stream.debugFrame) {
        writeFrame(stream.debugFrame);
      }
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
        // The frame code NAMES the failure class for clients (a dead page
        // proxy is escalate-not-retry); the redacted cause chain goes to the
        // log only — frame messages stay static, no provider text leaks.
        const code = classifyProviderStreamFailure(error);
        request.log.warn({
          requestId: stream.requestId,
          errorName: error instanceof Error ? error.name : "UnknownError",
          observedError: formatObservedError(error),
          code,
        }, "AI gateway provider stream failed");
        writeFrame({
          type: "error",
          code,
          message: code === "provider_proxy_unreachable"
            ? "AI gateway could not reach the page's egress proxy"
            : "AI gateway provider stream failed",
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
  }
}

export function registerAiAdminRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

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
