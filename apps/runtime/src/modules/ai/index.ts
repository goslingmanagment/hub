import { AI_FEATURE_STREAM_BODY_LIMIT_BYTES, routeSchemas } from "@agency_hub_core/contracts";
import {
  sanitizeError,
  normalizeProviderStreamFailure,
  type AiProviderFailureClassification,
} from "@agency_hub_core/shared";

// Stage 30: the migrated prompt unit's public surface (tests and feature
// services reach it through this module index — boundary rule).
export * from "./prompts/index.ts";
export * from "./context/index.ts";
export * from "./features/index.ts";
import {
  getAiGenerationContentByRef,
  getFreshestUsableRecaps,
  listAiGenerationContent,
  findPageByLabel,
  listAiPersonaStates,
  listAiPersonas,
} from "@agency_hub_core/db";

import {
  AiGatewayTerminalStreamConsumer,
  buildAiGatewayTerminalRecord,
  prepareAiGatewayStream,
  providerStreamFailureFrame,
  serializeAiGatewaySseFrame,
} from "../../services/ai-gateway.ts";
import { prepareAiFeatureStream } from "./features/index.ts";
import { getAdminChatterUsageReport, ingestAiUsageBatch } from "../../services/ai-usage.ts";
import { canAccessPage, requireApiKeyUser, requireOwner } from "../../services/auth.ts";
import { requireClientTokenAiFeature } from "../../services/client-ai-switch.ts";
import { ConflictError, NotFoundError } from "../../services/errors.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";
import { parseAiStreamCapabilities } from "./prompt-debug-echo.ts";
import {
  archiveAiPersonaAsOwner,
  createAiPersonaAsOwner,
  updateAiPersonaAsOwner,
} from "./persona-admin.ts";
import { aiPersonaDefinitionId } from "./persona-definition.ts";

export {
  hasDebugInputCapability,
  isPromptDebugEchoEnabled,
  parseAiStreamCapabilities,
} from "./prompt-debug-echo.ts";

interface PersonaRecord {
  key: string;
  displayName: string;
  systemBlock: string;
  updatedAt: Date;
  archivedAt: Date | null;
  revision: number;
}

// The legacy bearer write lane is closed (owner-session + retired): persona
// writes go through the versioned, audited admin routes only, so there is
// exactly one write lane.
const LEGACY_PERSONA_WRITE_RETIRED_MESSAGE =
  "Legacy AI persona writes are retired; use /api/v1/admin/ai/personas";

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

  // Raw prompt lane: owner cookie session only. A raw prompt on the agency's
  // provider keys is owner content; clients stream through the feature route
  // below, where the hub assembles the prompt. The declared policy and this
  // guard must agree (owner-session <-> requireOwner), or log mode would differ.
  server.post("/api/v1/ai/gateway/stream", {
    schema: routeSchemas.aiGatewayStream,
  }, async (request, reply) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const stream = await prepareAiGatewayStream(appContext, principal, request.body);
    await pipeAiGatewaySse(request, reply, stream);
  });

  // Legacy full-text list: owner cookie session only. Prompt text never
  // reaches a device token of any role; clients read the catalog below.
  server.get("/api/v1/ai/personas", {
    schema: routeSchemas.aiPersonasList,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
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

  // Recap-status metadata read (spec §3): the extension's "recap status line"
  // source. Same apiKey lane and page resolution as the feature stream, but
  // metadata ONLY — it reads the freshest usable recap rows and returns their
  // provenance; it never generates and never spends. Access is checked exactly
  // like the stream (findPageByLabel + canAccessPage): an unknown page and an
  // unauthorized page are the same 404 to the caller.
  server.get("/api/v1/ai/recap-status", {
    schema: routeSchemas.aiRecapStatus,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireApiKeyUser(principal);
    const { pageLabel, conversationRef, fanRef, personaDefinitionId } = request.query;
    const stored = await findPageByLabel(appContext.db, pageLabel);
    if (!stored || !canAccessPage(principal, stored.page.id)) {
      throw new NotFoundError("Page not found");
    }
    const conversationRefs = [conversationRef, ...(fanRef ? [fanRef] : [])];
    const found = await getFreshestUsableRecaps(appContext.db, {
      pageId: stored.page.id,
      conversationRefs,
      ...(personaDefinitionId ? { personaDefinitionId } : {}),
    });
    const now = Date.now();
    const slot = (row: typeof found.full) =>
      row === null
        ? null
        : {
          generatedAt: row.createdAt.toISOString(),
          ageMs: Math.max(0, now - row.createdAt.getTime()),
          transcriptCoverage:
            (row.params["transcriptCoverage"] as "full-history" | "window" | null) ?? null,
          requestedCount: (row.params["requestedCount"] as number | null) ?? null,
          keptCount: (row.params["keptCount"] as number | null) ?? null,
        };
    return { full: slot(found.full), short: slot(found.short) };
  });

  // Retired legacy write lane. Registered so the vendored client SDKs keep
  // their operation table, but nobody writes through it: a device token gets
  // 403 from the owner-session policy, the owner gets a 409 naming the admin
  // routes. It wrote last-write-wins without an audit row.
  server.put("/api/v1/ai/personas/:key", {
    schema: routeSchemas.aiPersonaUpsert,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    throw new ConflictError(LEGACY_PERSONA_WRITE_RETIRED_MESSAGE);
  });

  server.delete("/api/v1/ai/personas/:key", {
    schema: routeSchemas.aiPersonaArchive,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    throw new ConflictError(LEGACY_PERSONA_WRITE_RETIRED_MESSAGE);
  });

  // The owner namespace: full reads and the only persona write lane. Cookie
  // session + owner role only; every mutation is compare-and-set on the
  // persona revision and commits its audit row in the same transaction.
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
    const persona = await createAiPersonaAsOwner(appContext, principal, {
      key: request.body.key,
      displayName: request.body.displayName,
      systemBlock: request.body.systemBlock,
    });
    return serializeAdminPersona(persona);
  });

  server.put("/api/v1/admin/ai/personas/:key", {
    schema: routeSchemas.adminAiPersonaUpdate,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const persona = await updateAiPersonaAsOwner(appContext, principal, {
      key: request.params.key,
      displayName: request.body.displayName,
      systemBlock: request.body.systemBlock,
      expectedVersion: request.body.expectedVersion,
    });
    return serializeAdminPersona(persona);
  });

  server.delete("/api/v1/admin/ai/personas/:key", {
    schema: routeSchemas.adminAiPersonaArchive,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const persona = await archiveAiPersonaAsOwner(appContext, principal, {
      key: request.params.key,
      expectedVersion: request.query.expectedVersion,
    });
    return serializeAdminPersona(persona);
  });

  // Stage 30: kernel-side prompt assembly — same auth, same SSE pump, same
  // gateway internals; only the prompt is built here instead of the client.
  server.post("/api/v1/ai/features/:feature", {
    schema: routeSchemas.aiFeatureStream,
    // Coach transport headroom (spec §7, option "c"): the worst-case
    // schema-valid coach body is ~1.69M chars — 20 history entries × (2k
    // question + 64k answer) + a 300k transcript + spend/subscription/bio/draft —
    // which at 3-byte UTF-8 chars serializes to ~5.06MB, over Fastify's 1MB
    // default AND over the former 4 MiB cap (Blocker 4). A SCOPED route bodyLimit
    // (not a global raise) gives that worst case room; the exact byte budget and
    // its worst-case math live with the schema (AI_FEATURE_STREAM_BODY_LIMIT_BYTES
    // in contracts). Genuine transport abuse still 413s here.
    bodyLimit: AI_FEATURE_STREAM_BODY_LIMIT_BYTES,
  }, async (request, reply) => {
    const principal = await requirePrincipal(request);
    requireApiKeyUser(principal);
    // Parsed once per request; unknown or malformed values are ignored.
    const capabilities = parseAiStreamCapabilities(request.headers["x-kernel-ai-capabilities"]);
    // chat-extension H-3: the owner's switches decide a narrow token's AI.
    await requireClientTokenAiFeature(appContext, request, principal, {
      feature: request.params.feature,
      pageLabel: request.body.pageLabel,
    });
    const stream = await prepareAiFeatureStream(
      appContext,
      principal,
      request.params.feature,
      request.body,
      {
        capabilities,
        debugPromptEcho: capabilities.has("debug-input-v1"),
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
    let terminalFailure: AiProviderFailureClassification | null = null;
    // Shared terminal accounting + coach transport ceiling (P1-5): the CLI smoke
    // path drives the SAME consumer so the two lanes cannot drift on what counts
    // as a committed, usable generation. `ceilingExceeded` pins the outcome to
    // "failed" even if tearing down the aborted provider iterator rejects into
    // the catch below (which would otherwise reclassify an abort as cancelled).
    const consumer = new AiGatewayTerminalStreamConsumer(stream.visibleOutputCeilingChars);
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
      if (stream.contextFrame) {
        writeFrame(stream.contextFrame);
      }
      // Coach transport ceiling (spec §3/§7, option "c"): a coach answer whose
      // accumulated visible output crosses COACH_ANSWER_MAX_CHARS is aborted
      // mid-stream and errors WITHOUT a `done` frame, so the attempt is
      // terminal-recorded as failed (never completed) and can never be
      // attached/committed — the consumer owns that decision (shared with the
      // CLI). A committed answer is therefore always ≤ the ceiling and replays
      // verbatim within schema. Only coach-chat carries the ceiling.
      for await (const frame of stream.stream(abort.signal)) {
        const { emit, ceilingCrossed } = consumer.note(frame);
        for (const out of emit) {
          writeFrame(out);
        }
        if (ceilingCrossed) {
          abortProvider();
          break;
        }
      }
      const finished = consumer.finish();
      if (finished.usageMissing) {
        request.log.warn({
          requestId: stream.requestId,
        }, "AI gateway provider stream ended without usage metadata");
      }
      for (const out of finished.emit) {
        writeFrame(out);
      }
      terminalOutcome = consumer.outcome;
    } catch (error) {
      if (consumer.ceilingExceeded) {
        // The ceiling handler already recorded failed, wrote the error frame,
        // and aborted; a rejection while tearing down the aborted provider
        // stream must not reclassify this as cancelled or double-write an error.
        terminalOutcome = "failed";
      } else if (abort.signal.aborted) {
        terminalOutcome = "cancelled";
      } else {
        terminalOutcome = "failed";
        // The frame code NAMES the failure class for clients (a dead page
        // proxy is escalate-not-retry); the redacted cause chain goes to the
        // log only — frame messages stay static, no provider text leaks.
        terminalFailure = normalizeProviderStreamFailure(error, {
          provider: stream.provider,
          ...(consumer.streamedContent ? { failurePhase: "stream" as const } : {}),
        });
        const failureFrame = providerStreamFailureFrame(terminalFailure);
        request.log.warn({
          requestId: stream.requestId,
          errorName: error instanceof Error ? error.name : "UnknownError",
          observedError: sanitizeError(error, { format: "chain" }).message,
          code: failureFrame.code,
          failurePhase: terminalFailure.failurePhase,
          providerHttpStatus: terminalFailure.providerHttpStatus,
        }, "AI gateway provider stream failed");
        writeFrame(failureFrame);
      }
    } finally {
      raw.off("close", abortProvider);
      try {
        await stream.recordTerminal(buildAiGatewayTerminalRecord(consumer, {
          outcome: terminalOutcome,
          failure: terminalFailure,
          durationMs: Date.now() - startedAt,
          completedAt: new Date(),
        }));
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
