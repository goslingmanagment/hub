import { routeSchemas } from "@agency_hub_core/contracts";

import { requireApiKeyUser } from "../../services/auth.ts";
import {
  createVoiceNote,
  getVoiceNoteAudio,
  getVoiceNoteStatus,
} from "../../services/voice-notes.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

// Voice-notes module (Task 6): the three page-scoped chatter-lane routes over
// the Task 5 service. Page access is enforced twice — the declarative
// scope:"page" middleware (server.ts) AND the in-handler requireApiKeyUser plus
// the service's own resolveAccessiblePage — because the middleware may run in
// log mode; the service stays authoritative. All three carry a `:pageLabel`
// path param that the scope check resolves.
export function registerVoiceRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  // Admit (or idempotently replay) a render. 202: the queued/dispatched view is
  // returned immediately; the ElevenLabs synthesis runs detached. Structured
  // AppErrors from the service flow through the shared error handler unchanged.
  server.post("/api/v1/pages/:pageLabel/voice-notes", {
    schema: routeSchemas.voiceNoteCreate,
  }, async (request, reply) => {
    const principal = await requirePrincipal(request);
    requireApiKeyUser(principal);
    const view = await createVoiceNote(
      appContext,
      principal,
      request.params.pageLabel,
      request.body,
    );
    reply.code(202);
    return view;
  });

  // Status projection for a single render — page-scoped (id, page, user) lookup;
  // a miss is an indistinguishable 404.
  server.get("/api/v1/pages/:pageLabel/voice-notes/:id", {
    schema: routeSchemas.voiceNoteStatus,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireApiKeyUser(principal);
    return getVoiceNoteStatus(
      appContext,
      principal,
      request.params.pageLabel,
      request.params.id,
    );
  });

  // Binary audio download. Buffer the bytes FIRST (the service may still throw
  // 403/404/410/500 as a normal JSON error), then hijack and write the raw
  // audio/mpeg body — a half-written response can never carry an error.
  server.get("/api/v1/pages/:pageLabel/voice-notes/:id/audio", {
    schema: routeSchemas.voiceNoteAudio,
  }, async (request, reply) => {
    const principal = await requirePrincipal(request);
    requireApiKeyUser(principal);
    const { bytes } = await getVoiceNoteAudio(
      appContext,
      principal,
      request.params.pageLabel,
      request.params.id,
    );

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "audio/mpeg",
      "content-length": String(bytes.byteLength),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    raw.end(bytes);
  });
}
