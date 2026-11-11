import { routeSchemas } from "@agency_hub_core/contracts";
import type { AgentReadAuditSummary } from "@agency_hub_core/db";

import { createMediaLook, readMediaLook, type MediaLookAnswer } from "../../services/media-looks/index.ts";
import { beginAgentRequest, staticNotFound, writeAgentAudit } from "../agent-read/index.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Media looks (owner 2026-11-11): an agent key with look:media looks at a file
 * of a post in its page's Fansly schedule — frames (≤ 512 px) Hub pulls through
 * the page's own session, never the file, never a link — and reads a look
 * again by its id. look:media on the create and the read alike; a page outside
 * the grant, and a look or publication of another page, is the plane's one
 * static 404. Each answer leaves an audit row of ids and Hub's own words.
 */

const CREATE_OPERATION = "agentMediaLookCreate";
const GET_OPERATION = "agentMediaLookGet";

/** The audit's closed vocabulary (agent-read-audit.ts) of one look. */
function lookSummary(answer: MediaLookAnswer, cached: boolean): AgentReadAuditSummary {
  const { look, wire } = answer;
  return {
    lookId: look.id,
    ...(look.publicationId === null ? {} : { publicationId: look.publicationId }),
    postRef: look.postRef,
    attachmentIndex: look.attachmentIndex,
    mediaVariant: look.variant,
    lookStatus: wire.status,
    cached,
    frameCount: wire.frames.length,
    ...(wire.failure === null ? {} : { reasonCode: wire.failure }),
  };
}

export function registerMediaLookRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requireAgentKeyPrincipal } = ctx.auth;

  async function agentScope(request: Parameters<typeof requireAgentKeyPrincipal>[0], operation: string) {
    const principal = await requireAgentKeyPrincipal(request);
    const scope = await beginAgentRequest(appContext, principal, { operation, requiredCapabilities: ["look:media"] });
    return { principal, scope };
  }

  async function settled<T>(scope: { finish(rows: number): Promise<void> }, body: () => Promise<T>, rows: (result: T) => number) {
    let delivered = 0;
    try {
      const result = await body();
      delivered = rows(result);
      return result;
    } finally {
      await scope.finish(delivered);
    }
  }

  server.post("/api/v1/agent/pages/:pageLabel/media-looks", { schema: routeSchemas.agentMediaLookCreate }, async (request) => {
    const { principal, scope } = await agentScope(request, CREATE_OPERATION);
    return settled(scope, async () => {
      const page = scope.pages.find((candidate) => candidate.pageLabel === request.params.pageLabel);
      if (!page) throw staticNotFound();
      const answer = await createMediaLook(appContext, {
        page: { id: page.id, pageLabel: page.pageLabel, platform: page.platform },
        agentKeyId: principal.agentKeyId,
        body: request.body,
        notFound: staticNotFound,
      });
      await writeAgentAudit(appContext.db, {
        agentKeyId: principal.agentKeyId,
        operation: CREATE_OPERATION,
        pageIds: [page.id],
        verbatimText: false,
        requestSummary: lookSummary(answer, answer.cached),
      });
      return answer.wire;
    }, (wire) => wire.frames.length);
  });

  server.get("/api/v1/agent/pages/:pageLabel/media-looks/:lookId", { schema: routeSchemas.agentMediaLookGet }, async (request) => {
    const { principal, scope } = await agentScope(request, GET_OPERATION);
    return settled(scope, async () => {
      const page = scope.pages.find((candidate) => candidate.pageLabel === request.params.pageLabel);
      if (!page) throw staticNotFound();
      const answer = await readMediaLook(appContext, {
        page: { id: page.id, pageLabel: page.pageLabel, platform: page.platform },
        lookId: request.params.lookId,
        frames: request.query.frames,
        notFound: staticNotFound,
      });
      await writeAgentAudit(appContext.db, {
        agentKeyId: principal.agentKeyId,
        operation: GET_OPERATION,
        pageIds: [page.id],
        verbatimText: false,
        requestSummary: lookSummary(answer, false),
      });
      return answer.wire;
    }, (wire) => wire.frames.length);
  });
}
