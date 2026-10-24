import { createHash } from "node:crypto";

import {
  CLIENT_WIN_BACK_MAX_ITEMS,
  IN_CONVERSATION_MINUTES,
  type ClientWinBackAttemptBody,
  type ClientWinBackAttemptResponse,
  type ClientWinBackResponse,
  type TeamWinBackApproachSaveBody,
  type TeamWinBackApproachesResponse,
  type TeamWinBackResultsQuery,
  type TeamWinBackResultsResponse,
} from "@agency_hub_core/contracts";
import {
  findPageSummaryByLabel,
  insertObservation,
  insertWinBackAttempt,
  listWinBackApproaches,
  listWinBackCandidates,
  listWinBackResults,
  saveWinBackApproach,
  type Database,
  type WinBackRules,
} from "@agency_hub_core/db";
import { addUtcDays, startOfBusinessDay } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { requireApiKeyUser, requireDashboardUser, requireOwner, type AuthPrincipal, type HumanAuthPrincipal } from "./auth.ts";
import { clientTokenIngestProducer } from "./client-token-profile.ts";
import { requireClientGrantedPage } from "./client-switches.ts";
import { ConflictError, NotFoundError } from "./errors.ts";
import { ingestProducerForClientVersion } from "./ingest-observations.ts";

/**
 * Chat Memory week 3 (docs/plans/2026-10-24-chat-memory/week-3.md §2–3): win
 * back. The list (`clientWinBack`), a chatter's pick (`clientWinBackAttempt`,
 * journaled first like a «who sent» fact), the results by approach and chatter
 * (`teamWinBackResults`) and the owner's list of approaches. Hub records and
 * counts; it never assigns an approach and credits no sale (roadmap «Not doing»).
 *
 * Database only: nothing here asks a platform or sends anything.
 */

export const WIN_BACK_FEATURE = "win-back";
export const WIN_BACK_ATTEMPT_OBSERVATION_KIND = "client.winback_attempt.v1";

export const WIN_BACK_RULES: WinBackRules = {
  silentDays: 14,
  expiringDays: 3,
  newDays: 7,
  cooldownDays: 7,
  inConversationMinutes: IN_CONVERSATION_MINUTES,
  limit: CLIENT_WIN_BACK_MAX_ITEMS,
};

async function listOf(app: AppContext, page: { id: number; label: string }, now: Date): Promise<ClientWinBackResponse> {
  const [approaches, items] = await Promise.all([
    listWinBackApproaches(app.db, { activeOnly: true }),
    listWinBackCandidates(app.db, { pageId: page.id, now, ...WIN_BACK_RULES }),
  ]);
  return {
    pageLabel: page.label,
    approaches: approaches.map(({ id, label }) => ({ id, label })),
    items: items.map((item) => ({
      fanRef: item.fanRef,
      conversationRef: item.conversationRef,
      username: item.username,
      displayName: item.displayName,
      alias: item.alias,
      lifetimeGrossMills: item.lifetimeGrossMills,
      reason: item.reason,
      reasonAt: item.reasonAt === null ? null : item.reasonAt.toISOString(),
    })),
    serverNow: now.toISOString(),
  };
}

export async function readClientWinBack(
  app: AppContext,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string },
): Promise<ClientWinBackResponse> {
  // A cookie session → 403: the list is a client's.
  requireApiKeyUser(principal);
  const page = await requireClientGrantedPage(app, principal, await findPageSummaryByLabel(app.db, input.pageLabel), WIN_BACK_FEATURE);
  return listOf(app, page, new Date());
}

export async function recordClientWinBackAttempt(
  app: AppContext,
  request: { headers: Record<string, string | string[] | undefined> },
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; body: ClientWinBackAttemptBody },
): Promise<ClientWinBackAttemptResponse> {
  requireApiKeyUser(principal);
  const page = await requireClientGrantedPage(app, principal, await findPageSummaryByLabel(app.db, input.pageLabel), WIN_BACK_FEATURE);
  const now = new Date();
  const approaches = await listWinBackApproaches(app.db, { activeOnly: true });
  if (!approaches.some((approach) => approach.id === input.body.approachId)) {
    throw new ConflictError("The approach is not on the owner's list", { reason: "approach_inactive" });
  }
  // Only a fan the list shows right now: a pick is about the list, not any fan.
  const candidates = await listWinBackCandidates(app.db, { pageId: page.id, now, ...WIN_BACK_RULES });
  const candidate = candidates.find((one) => one.fanRef === input.body.fanRef);
  if (candidate === undefined) throw new ConflictError("The fan is not on the win-back list", { reason: "not_listed" });

  const header = request.headers["x-client-version"];
  const clientVersion = typeof header === "string" ? header : null;
  const producer = principal.clientProfile === undefined
    ? ingestProducerForClientVersion(clientVersion ?? "unknown")
    : clientTokenIngestProducer(principal.clientProfile, clientVersion);
  const attemptId = await app.db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    const payload = {
      pageLabel: page.label, fanRef: candidate.fanRef, conversationRef: candidate.conversationRef,
      approachId: input.body.approachId, reason: candidate.reason, pickedAt: now.toISOString(),
    };
    const journaled = await insertObservation(tx, {
      source: "client_capture",
      producer,
      platform: page.platform,
      accountId: page.id,
      kind: WIN_BACK_ATTEMPT_OBSERVATION_KIND,
      payload,
      payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
      idempotencyKey: `${principal.user.id}:winback_attempt:${page.id}:${candidate.fanRef}:${now.toISOString()}`,
      observedAt: now,
      actorPrincipalId: principal.user.id,
    });
    return insertWinBackAttempt(tx, {
      pageId: page.id, fanId: candidate.fanId, fanRef: candidate.fanRef, conversationRef: candidate.conversationRef,
      userId: principal.user.id, approachId: input.body.approachId, reason: candidate.reason, pickedAt: now,
      observationId: journaled.observationId,
    });
  });
  return { attemptId, list: await listOf(app, page, new Date()) };
}

export async function readTeamWinBackResults(
  app: AppContext,
  principal: AuthPrincipal,
  input: { query: TeamWinBackResultsQuery; pageScope: readonly number[] | undefined },
): Promise<TeamWinBackResultsResponse> {
  requireDashboardUser(principal);
  const now = new Date();
  const from = addUtcDays(startOfBusinessDay(now), -(input.query.days - 1));
  const rows = await listWinBackResults(app.db, { from, to: now, now, pages: input.pageScope ?? "all" });
  return {
    from: from.toISOString(),
    to: now.toISOString(),
    rows: rows.map((row) => ({
      approachId: row.approachId,
      approach: row.approachLabel,
      userId: row.userId,
      username: row.username,
      attempts: row.attempts,
      sent: row.sent,
      matured72h: row.matured72h,
      replied72h: row.replied72h,
      matured7d: row.matured7d,
      bought7d: row.bought7d,
      matured30d: row.matured30d,
      spent30dMills: row.spent30dMills,
    })),
    serverNow: now.toISOString(),
  };
}

export async function readTeamWinBackApproaches(app: AppContext, principal: AuthPrincipal): Promise<TeamWinBackApproachesResponse> {
  requireOwner(principal);
  return { approaches: await listWinBackApproaches(app.db, { activeOnly: false }) };
}

export async function saveTeamWinBackApproach(
  app: AppContext,
  principal: AuthPrincipal,
  body: TeamWinBackApproachSaveBody,
): Promise<TeamWinBackApproachesResponse> {
  requireOwner(principal);
  try {
    await saveWinBackApproach(app.db, {
      id: body.id ?? null, label: body.label, sortOrder: body.sortOrder, active: body.active, userId: principal.user.id,
    });
  } catch (error) {
    const text = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : "";
    if (/winback_approaches_label_unique/.test(text)) {
      throw new ConflictError("An approach with this name exists", { reason: "label_taken" });
    }
    if (/winback approach not found/.test(text)) throw new NotFoundError("The approach was not found");
    throw error;
  }
  return { approaches: await listWinBackApproaches(app.db, { activeOnly: false }) };
}
