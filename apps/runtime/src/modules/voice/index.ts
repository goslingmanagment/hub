import { routeSchemas } from "@agency_hub_core/contracts";

import type { AppContext } from "../../bootstrap.ts";
import type { HumanAuthPrincipal } from "../../services/auth.ts";
import { requireClientFeatureOnLabel, type ClientFeatureRequest } from "../../services/client-switches.ts";
import {
  createVoiceNote,
  getVoiceNoteAudio,
  getVoiceNoteStatus,
} from "../../services/voice-notes.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * chat-extension R20 HF-4б: the narrow chat-extension device token reaches the
 * voice notes behind its page's `voice` flag (a Fansly flag; `voice-notes-v1`).
 * The full check of a flagged client route (requireClientFeature: the page
 * granted, its platform, the master switch, the flag, the binding, the served
 * capability, the minimum version), first, on each of the three routes and on
 * every call, a replay's included: 409 `client_feature_disabled` with its
 * reason. It decides whether the extension uses voice on the page at all; what
 * a `clientRequestId` already admitted stays as it is (a refused replay admits
 * nothing, and the same id replays the same render once the flag is back).
 * Past it the lane answers as for every client, with its own switches and
 * codes. A full device token passes untouched: the released clients are not
 * affected.
 */
async function requireNarrowTokenVoice(
  app: AppContext,
  request: ClientFeatureRequest,
  principal: HumanAuthPrincipal,
  pageLabel: string,
): Promise<void> {
  if (principal.clientProfile === undefined) {
    return;
  }
  await requireClientFeatureOnLabel(app, request, principal, pageLabel, "voice");
}

// Voice-notes module (Task 6): the three page-scoped chatter-lane routes over
// the Task 5 service. Page access is checked twice — the declarative
// scope:"page" middleware (server.ts) AND the in-handler requireApiKeyUser plus
// the service's own resolveAccessiblePage; the service stays authoritative.
// All three carry a `:pageLabel` path param that the scope check resolves.
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
    await requireNarrowTokenVoice(appContext, request, principal, request.params.pageLabel);
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
    await requireNarrowTokenVoice(appContext, request, principal, request.params.pageLabel);
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
    await requireNarrowTokenVoice(appContext, request, principal, request.params.pageLabel);
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
