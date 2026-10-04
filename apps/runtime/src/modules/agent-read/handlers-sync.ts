import {
  AGENT_SYNC_WHY_MAX_ROWS,
  type AgentCapability,
  type AgentSyncResourceKey,
  type AgentSyncStatusResponse,
  type AgentSyncWhyResponse,
} from "@agency_hub_core/contracts";
import { listSyncPages } from "@agency_hub_core/db";
import type { Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import type { AgentAuthPrincipal } from "../../services/auth.ts";
import { fanslyResourceSpec } from "../../sync/fansly/registry.ts";
import { explainSyncWork, readSyncPageStatuses } from "../../sync/inspect.ts";
import { toSyncPageStatusWire, toSyncWorkWire } from "../../sync/requests/wire.ts";
import { buildAgentEvidence, type AgentPlaneMode } from "./epistemics.ts";
import { staticNotFound } from "./errors.ts";
import {
  AGENT_TIMEOUT_MS,
  beginAgentRequest,
  buildDelivery,
  computeScopeFieldStates,
  singletonDelivery,
  withAgentTimeout,
  type AgentRequestScope,
} from "./runtime.ts";

/**
 * The Fansly Sync Engine's status and "why waiting" on the agent plane (plan
 * §10, design §3.9, §7.4): `agentSyncStatus` (the key's pages) and
 * `agentSyncWhy` (one page's work of one registry key). The owner routes
 * (`modules/sync-engine`) and the owner CLI read the same functions
 * (`sync/inspect.ts`) and the same wire (`sync/requests/wire.ts`).
 *
 * Both need `read:datasets` (design D9, the `sync_streams` precedent). A work
 * row's subject of a chat or a fan is a chat or fan reference, so "why" for
 * such a key needs `read:messages` as well — the rule history requests follow
 * for chat refs (D9).
 *
 * Neither reads an evidence plane: the engine's queue and journal are not
 * captured platform data. The envelope therefore lists no plane, establishes
 * no capture floor, and carries `capture_floor_unknown` honestly; a reason to
 * wait is a body field, never a blocker.
 */

/** Registry subject kinds whose ids name a fan's chat or the fan. */
const MESSAGE_SUBJECTS = new Set(["thread", "fan"]);

function syncEvidence(scope: AgentRequestScope, planeMode: AgentPlaneMode) {
  return buildAgentEvidence({
    planeMode,
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
    scopeFieldStates: computeScopeFieldStates({ fields: [], platforms: ["fansly" as Platform] }),
    sourceErrors: [],
    scopeNarrowing: scope.scopeNarrowing,
    observedRowFloor: null,
    captureFloor: { at: null, kind: "unknown" },
    inventoryUnprovenPages: 0,
  });
}

/** The capabilities "why" needs for `resource` (see the header). */
export function agentSyncWhyCapabilities(resource: AgentSyncResourceKey): AgentCapability[] {
  const subject = fanslyResourceSpec(resource)?.subject;
  return subject !== undefined && MESSAGE_SUBJECTS.has(subject)
    ? ["read:datasets", "read:messages"]
    : ["read:datasets"];
}

// ---------------------------------------------------------------------------
// agentSyncStatus
// ---------------------------------------------------------------------------

export async function handleAgentSyncStatus(
  appContext: AppContext,
  principal: AgentAuthPrincipal,
  query: { pageLabel?: string | undefined },
): Promise<AgentSyncStatusResponse> {
  const scope = await beginAgentRequest(appContext, principal, {
    operation: "agentSyncStatus",
    requiredCapabilities: ["read:datasets"],
  });
  let delivered = 0;
  try {
    // A label outside the grant narrows to nothing; it never widens the read.
    const granted = new Set(
      scope.pages
        .filter((page) => query.pageLabel === undefined || page.pageLabel === query.pageLabel)
        .map((page) => page.id),
    );
    const pages = await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.short, async (tx) =>
      (await listSyncPages(tx)).filter((page) => granted.has(page.pageId)), "agent_sync_status");
    // A page's status is a bundle: served whole or refused, never clamped.
    await scope.reserveExactRows(pages.length);
    const statuses = await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.long, (tx) =>
      readSyncPageStatuses(tx, appContext.config, pages), "agent_sync_status");
    const evidence = syncEvidence(scope, scope.planeMode);
    delivered = statuses.length;
    return {
      pages: statuses.map(toSyncPageStatusWire),
      delivery: singletonDelivery(statuses.length),
      capture: evidence.capture,
      conclusion: evidence.conclusion,
    };
  } finally {
    await scope.finish(delivered);
  }
}

// ---------------------------------------------------------------------------
// agentSyncWhy
// ---------------------------------------------------------------------------

export async function handleAgentSyncWhy(
  appContext: AppContext,
  principal: AgentAuthPrincipal,
  params: { pageLabel: string },
  query: { resource: AgentSyncResourceKey; subject?: string | undefined },
): Promise<AgentSyncWhyResponse> {
  const scope = await beginAgentRequest(appContext, principal, {
    operation: "agentSyncWhy",
    requiredCapabilities: agentSyncWhyCapabilities(query.resource),
  });
  let delivered = 0;
  try {
    // In-handler grant guard (dual-layer law #143): a page outside the grant,
    // or one the engine has no row for, is the plane's one static 404.
    const page = scope.pages.find((candidate) => candidate.pageLabel === params.pageLabel);
    if (!page) {
      throw staticNotFound();
    }
    const syncPage = await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.short, async (tx) =>
      (await listSyncPages(tx)).find((row) => row.pageId === page.id) ?? null, "agent_sync_why");
    if (syncPage === null) {
      throw staticNotFound();
    }
    const { limit, cappedByBudget } = await scope.limitWithinRowBudget(AGENT_SYNC_WHY_MAX_ROWS);
    // One row past the page tells a truncated answer from a complete one.
    const rows = await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.long, (tx) =>
      explainSyncWork(tx, appContext.config, syncPage, {
        resource: query.resource,
        ...(query.subject === undefined ? {} : { subject: query.subject }),
        limit: limit + 1,
      }), "agent_sync_why");
    const truncated = rows.length > limit;
    const work = rows.slice(0, limit).map(toSyncWorkWire);
    const evidence = syncEvidence(scope, scope.planeMode);
    delivered = work.length;
    return {
      work,
      delivery: truncated
        ? buildDelivery({
          returned: work.length,
          matched: { value: work.length, exact: false },
          cappedBy: cappedByBudget ? "budget" : "limit",
          nextCursor: null,
          snapshotExhausted: false,
          caveats: [],
        })
        : singletonDelivery(work.length),
      capture: evidence.capture,
      conclusion: evidence.conclusion,
    };
  } finally {
    await scope.finish(delivered);
  }
}
