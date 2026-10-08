import type {
  AgentThreadAvailabilityEpisode,
  AgentThreadAvailabilityResponse,
} from "@agency_hub_core/contracts";
import {
  readAgentThreadCoverage,
  readOpenChatUnavailability,
  type ChatUnavailabilityEpisode,
} from "@agency_hub_core/db";
import type { Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import type { AgentAuthPrincipal } from "../../services/auth.ts";
import { buildAgentEvidence } from "./epistemics.ts";
import { staticNotFound } from "./errors.ts";
import {
  AGENT_TIMEOUT_MS,
  beginAgentRequest,
  computeScopeFieldStates,
  isoOrNull,
  singletonDelivery,
  withAgentTimeout,
} from "./runtime.ts";

/**
 * `agentThreadAvailability`: whether Fansly stopped serving ONE chat to its page
 * (arena "vanished chat", plan §5) — the chat's open unavailability episode
 * (`page_dm_thread_unavailability`, written by the page's actor:
 * `repositories/sync/chat-unavailability.ts`), or null.
 *
 * A null episode is "no open episode recorded", never "Fansly serves the
 * chat": an episode opens only when a read of the chat's head is refused.
 *
 * Read like the transcript (#6): the page out of the key's grant is the
 * plane's one static 404, the conversation ref is resolved to this page's
 * thread the way the transcript's `threadCoverage` is, and `read:messages` is
 * required (a chat ref names a fan's chat, the rule of `hub threads`). Unlike
 * the transcript, a ref this page holds no thread for is the static 404 too —
 * inside the grant, so it is no oracle across it — because "no episode" about
 * a chat that does not exist would read as a fact about a chat. No message
 * text is read, nothing is audited as verbatim, nothing is sent to Fansly.
 *
 * The episode is the engine's own record, not captured platform data, so the
 * envelope reads no plane and carries `capture_floor_unknown`, as the engine's
 * status and "why waiting" do (`handlers-sync.ts`).
 */

/**
 * Why Fansly stopped serving the chat (plan §8). The public account check
 * without a session that tells `probably_blocked` from `probably_deleted`
 * (plan §7) does not exist yet and neither do its columns, so every episode
 * is `unchecked` until it lands.
 */
const EPISODE_CAUSE = "unchecked" as const;

function toWireEpisode(episode: ChatUnavailabilityEpisode): AgentThreadAvailabilityEpisode {
  return {
    state: episode.state,
    openedAt: episode.openedAt.toISOString(),
    establishedAt: isoOrNull(episode.establishedAt),
    lastRefusalAt: episode.lastRefusalAt.toISOString(),
    refusals: episode.refusals,
    retryNotBefore: isoOrNull(episode.retryNotBefore),
    ownerNote: episode.ownerNote === null || episode.ownerNoteAt === null
      ? null
      : { text: episode.ownerNote, at: episode.ownerNoteAt.toISOString() },
    cause: EPISODE_CAUSE,
  };
}

export async function handleAgentThreadAvailability(
  appContext: AppContext,
  principal: AgentAuthPrincipal,
  params: { pageLabel: string; conversationRef: string },
): Promise<AgentThreadAvailabilityResponse> {
  const scope = await beginAgentRequest(appContext, principal, {
    operation: "agentThreadAvailability",
    requiredCapabilities: ["read:messages"],
  });
  let delivered = 0;
  try {
    // In-handler grant guard (dual-layer law #143): the declarative middleware
    // may run in `log` mode, so the page grant is re-checked here, and a miss
    // answers the SAME static 404 the middleware would have produced.
    const page = scope.pages.find((candidate) => candidate.pageLabel === params.pageLabel);
    if (!page) {
      throw staticNotFound();
    }
    const { thread, episode } = await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.short, async (tx) => {
      const coverage = await readAgentThreadCoverage(tx, { pageId: page.id, conversationRef: params.conversationRef });
      if (coverage.coverage === null) {
        return { thread: false, episode: null };
      }
      const open = await readOpenChatUnavailability(tx, { pageId: page.id, groupIds: [params.conversationRef] });
      return { thread: true, episode: open.get(params.conversationRef) ?? null };
    }, "agent_thread_availability");
    if (!thread) {
      throw staticNotFound();
    }
    const returned = episode === null ? 0 : 1;
    // One episode is a bundle: served whole or refused, never clamped.
    await scope.reserveExactRows(returned);
    const evidence = buildAgentEvidence({
      planeMode: scope.planeMode,
      claimFields: null,
      operationPlanes: [],
      planeReads: [],
      planesNotRead: [],
      delivery: { snapshotExhausted: true, nextCursor: null },
      cursorConsumed: false,
      cursorCapable: false,
      frozenSnapshot: true,
      requestWindow: null,
      gaps: [],
      scopeFieldStates: computeScopeFieldStates({ fields: [], platforms: [page.platform as Platform] }),
      sourceErrors: [],
      scopeNarrowing: scope.scopeNarrowing,
      observedRowFloor: null,
      captureFloor: { at: null, kind: "unknown" },
      inventoryUnprovenPages: 0,
    });
    delivered = returned;
    return {
      scope: {
        pageLabel: page.pageLabel,
        platform: page.platform as Platform,
        conversationRef: params.conversationRef,
      },
      episode: episode === null ? null : toWireEpisode(episode),
      delivery: singletonDelivery(returned),
      capture: evidence.capture,
      conclusion: evidence.conclusion,
    };
  } finally {
    await scope.finish(delivered);
  }
}
