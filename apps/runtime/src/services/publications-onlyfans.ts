import { createHash } from "node:crypto";

import type { OfapiAction } from "@agency_hub_core/contracts";
import {
  autostopPagePublishing,
  countPagePublicationDispatchesSince,
  countPlatformPublicationDispatchesSince,
  getPublication,
  getPublicationDispatch,
  getPublicationRevision,
  insertPublicationDispatch,
  listDueOnlyfansPublications,
  listSubmittingOnlyfansPublications,
  transitionPublication,
  type Database,
  type PublicationDispatchMode,
  type PublicationRecord,
} from "@agency_hub_core/db";
import {
  PUBLICATION_BATCH_GAP_MINUTES,
  PUBLICATION_BATCH_SIZE,
  PUBLICATION_POST_NOW_LEAD_MINUTES,
  PUBLICATION_SCHEDULE_HORIZON_DAYS,
  PUBLICATION_START_WINDOW_MINUTES,
  type PublicationKind,
  type PublicationStatus,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import { notifyPublishingStoppedIncident } from "./notification-incidents.ts";
import { cancelOfapiAction, dispatchOfapiAction, getOfapiAction, prepareOfapiAction } from "./ofapi-actions.ts";
import { verifyApprovedPublication } from "./publications.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

// Wall posts on OnlyFans (docs/plans/2026-10-23-wall-posts, plan PR 4b): every
// minute the worker turns approved OnlyFans publications into OnlyFansAPI owner
// actions and sends them itself — posts into OnlyFans' own schedule up to 7 days
// ahead, five per page in a row and the next five 10 minutes later; a story at
// its time, and never later than 30 minutes after it.
//
// One attempt, always (spec §8.2). The action's own state machine sends it at
// most once (ofapi-actions.ts: prepared → dispatching under a row lock), and
// `publication_dispatches` holds one create per publication. A response that is
// lost or not the documented one is "unknown" and waits for a person; Hub never
// sends again by itself. An action that provably never left (still "prepared":
// the slot was busy, the transport down) is tried again only inside its window,
// then it is missed.

export const PUBLICATIONS_ONLYFANS_QUEUE = "publications.onlyfans";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export async function ensurePublicationsOnlyfansQueue(boss: QueueCreationClient, createdQueues?: Set<string>) {
  await ensureQueueCreated(boss, PUBLICATIONS_ONLYFANS_QUEUE, { policy: "exclusive" }, createdQueues);
}

export async function ensurePublicationsOnlyfansSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) return;
  await boss.schedule(PUBLICATIONS_ONLYFANS_QUEUE, "* * * * *", null, { tz: "UTC" });
}

/** The action id of a publication's command: one per publication, approval and kind, so a retry after a crash finds the same prepared action. */
export function publicationActionId(publicationId: number, revisionId: number, kind: "create" | "withdraw"): string {
  const hex = createHash("sha256").update(`publication:${publicationId}:revision:${revisionId}:${kind}`).digest("hex");
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type OnlyfansDispatchPlan = { action: "send"; mode: PublicationDispatchMode } | { action: "wait" } | { action: "missed" };

/**
 * How a due publication goes out at `now`: a story at its time, within the start
 * window; a post into OnlyFans' schedule, or right now when its time is minutes
 * away or just passed. Past the window it is missed: it never goes out late.
 */
export function onlyfansDispatchPlan(input: { kind: PublicationKind; publishAt: Date; now: Date }): OnlyfansDispatchPlan {
  const untilMs = input.publishAt.getTime() - input.now.getTime();
  if (-untilMs > PUBLICATION_START_WINDOW_MINUTES * MINUTE_MS) return { action: "missed" };
  if (input.kind === "story") return untilMs > 0 ? { action: "wait" } : { action: "send", mode: "story" };
  if (untilMs > PUBLICATION_SCHEDULE_HORIZON_DAYS * DAY_MS) return { action: "wait" };
  return { action: "send", mode: untilMs <= PUBLICATION_POST_NOW_LEAD_MINUTES * MINUTE_MS ? "now" : "scheduled" };
}

/** Whether a command that never left may still be tried at `now`. */
export function onlyfansStillInWindow(mode: PublicationDispatchMode, publishAt: Date, now: Date): boolean {
  // A scheduled post's date is frozen in its action and must stay in the future.
  if (mode === "scheduled") return publishAt.getTime() - now.getTime() > MINUTE_MS;
  return now.getTime() - publishAt.getTime() <= PUBLICATION_START_WINDOW_MINUTES * MINUTE_MS;
}

/** The OnlyFansAPI owner action for an approved publication. Vault media only (spec §6: ids reusable). */
export function onlyfansCommandFor(record: PublicationRecord, mode: PublicationDispatchMode): OfapiAction {
  const refs = (role: "media" | "preview") => record.media
    .filter((item) => item.role === role)
    .sort((a, b) => a.position - b.position)
    .map((item) => {
      if (item.source !== "vault" || item.platformMediaRef === null) {
        throw new Error(`publication ${record.id}: OnlyFans takes vault media only`);
      }
      return item.platformMediaRef;
    });
  const mediaFiles = refs("media");
  if (record.kind === "story") {
    return { action: "story_create", pageId: record.pageId, mediaFiles, reuseProviderOperation: false } as OfapiAction;
  }
  const expireDays = record.expiresAt === null
    ? undefined
    : Math.round((record.expiresAt.getTime() - record.publishAt.getTime()) / DAY_MS);
  return {
    action: "post_create",
    pageId: record.pageId,
    text: record.text,
    ...(mediaFiles.length > 0 ? { mediaFiles } : {}),
    ...(mode === "scheduled" ? { scheduledDate: record.publishAt.toISOString() } : {}),
    ...(expireDays === undefined ? {} : { expireDays }),
    // OnlyFans refuses a post with a banned word and says which (spec §6).
    blockBannedWords: "strict_ban",
    reuseProviderOperation: false,
  } as OfapiAction;
}

export type OnlyfansOutcome =
  | { kind: "pending" }
  | { kind: "settled"; to: PublicationStatus; platformPostRef: string | null; reason: string | null; autostop: boolean };

/**
 * The publication's status from its action. Accepted is "scheduled" — even a
 * post sent "now": "published" needs a fresh read of the post (plan PR 5). A
 * story OnlyFans still prepares is "processing". A response Hub cannot confirm
 * is "unknown"; a refusal of the account's authorization stops the page.
 */
export function onlyfansOutcome(intent: { state: string; remoteId: string | null; errorCode: string | null; responseData: unknown }, mode: PublicationDispatchMode): OnlyfansOutcome {
  switch (intent.state) {
    case "prepared":
    case "dispatching":
      return { kind: "pending" };
    case "cancelled":
      return { kind: "settled", to: "missed", platformPostRef: null, reason: "not_sent", autostop: false };
    case "confirmed": {
      const ready = (intent.responseData as { isReady?: unknown } | null)?.isReady;
      const to: PublicationStatus = mode === "story" && ready === false ? "processing" : "scheduled";
      return { kind: "settled", to, platformPostRef: intent.remoteId, reason: null, autostop: false };
    }
    case "rejected": {
      const autostop = intent.errorCode === "vendor_http_401" || intent.errorCode === "vendor_http_403";
      return { kind: "settled", to: "rejected", platformPostRef: null, reason: intent.errorCode ?? "rejected", autostop };
    }
    default:
      return { kind: "settled", to: "unknown", platformPostRef: null, reason: intent.errorCode ?? intent.state, autostop: false };
  }
}

export interface OnlyfansPublishingReport {
  sending: boolean;
  sent: number;
  settled: number;
  missed: number;
  returnedToDraft: number;
  /** Pages stopped this minute (autostop): nothing more goes for them, even from a list read before. */
  stoppedPageIds: number[];
}

/** One minute's work: settle what is in flight (always), then send what is due (when every switch is on). */
export async function runOnlyfansPublishingTick(app: AppContext, now = new Date()): Promise<OnlyfansPublishingReport> {
  const config = await loadEffectiveConfig(app.db, app.config);
  const sending = config.publishingEnabled === true && config.publishingOnlyfansEnabled === true;
  const report: OnlyfansPublishingReport = { sending, sent: 0, settled: 0, missed: 0, returnedToDraft: 0, stoppedPageIds: [] };

  const busyPages = new Set<number>();
  for (const item of await listSubmittingOnlyfansPublications(app.db)) {
    const state = await settleOne(app, item.publicationId, now, sending && item.pageEnabled, report);
    if (state === "in_flight") busyPages.add(item.pageId);
  }
  if (!sending) return report;

  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let creditsUsed = await countPlatformPublicationDispatchesSince(app.db, "onlyfans", dayStart);
  const creditLimit = config.publishingOnlyfansDailyCredits ?? 50;
  const due = await listDueOnlyfansPublications(app.db, {
    now, postsUntil: new Date(now.getTime() + PUBLICATION_SCHEDULE_HORIZON_DAYS * DAY_MS),
  });
  for (const candidate of due) {
    if (busyPages.has(candidate.pageId) || report.stoppedPageIds.includes(candidate.pageId)) continue;
    const plan = onlyfansDispatchPlan({ kind: candidate.kind, publishAt: candidate.publishAt, now });
    if (plan.action === "wait") continue;
    if (plan.action === "missed") {
      if (await transitionPublication(app.db, {
        id: candidate.id, from: "approved", to: "missed", actor: { kind: "hub" }, reason: "window_passed",
      })) report.missed += 1;
      continue;
    }
    const recent = await countPagePublicationDispatchesSince(app.db, candidate.pageId, new Date(now.getTime() - PUBLICATION_BATCH_GAP_MINUTES * MINUTE_MS));
    if (recent >= PUBLICATION_BATCH_SIZE) {
      busyPages.add(candidate.pageId);
      continue;
    }
    if (creditsUsed >= creditLimit) break;
    const result = await sendOne(app, candidate.id, plan.mode, now, report);
    if (result === "sent") {
      creditsUsed += 1;
      report.sent += 1;
    }
    if (result === "in_flight") {
      creditsUsed += 1;
      report.sent += 1;
      busyPages.add(candidate.pageId);
    }
  }
  return report;
}

type SendResult = "sent" | "in_flight" | "returned" | "raced";

async function sendOne(app: AppContext, publicationId: number, mode: PublicationDispatchMode, now: Date, report: OnlyfansPublishingReport): Promise<SendResult> {
  // What the person approved must still be exactly what goes (spec §3.3).
  const check = await verifyApprovedPublication(app.db, publicationId);
  if (!check.ok) {
    report.returnedToDraft += check.reason === "not_approved" ? 0 : 1;
    return "returned";
  }
  const record = check.record;
  const revisionId = record.approvedRevisionId as number;
  const revision = await getPublicationRevision(app.db, revisionId);
  if (!revision) return "returned";
  const intentId = publicationActionId(record.id, revisionId, "create");
  try {
    await prepareOfapiAction(app, { id: intentId, command: onlyfansCommandFor(record, mode) }, revision.approvedByUserId);
  } catch (error) {
    // Refused before anything left: the person looks at it again.
    await transitionPublication(app.db, {
      id: record.id, from: "approved", to: "draft", actor: { kind: "hub" }, clearApproval: true,
      reason: `refused_before_send: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
    });
    report.returnedToDraft += 1;
    return "returned";
  }
  const claimed = await app.db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const dispatch = await insertPublicationDispatch(tx, {
      publicationId: record.id, revisionId, kind: "create", platform: "onlyfans", ofapiActionIntentId: intentId, mode,
    });
    if (!dispatch) return false;
    if (!await transitionPublication(tx, { id: record.id, from: "approved", to: "submitting", actor: { kind: "hub" } })) {
      throw new PublicationMovedError();
    }
    return true;
  }).catch(async (error: unknown) => {
    if (!(error instanceof PublicationMovedError)) throw error;
    // Cancelled or edited between the check and now: the prepared action never leaves.
    await cancelOfapiAction(app, intentId, revision.approvedByUserId).catch(() => undefined);
    return false;
  });
  if (!claimed) return "raced";
  try {
    await dispatchOfapiAction(app, intentId, revision.approvedByUserId);
  } catch {
    // Not sent (the action is still prepared): the next minute tries again inside its window.
  }
  const state = await settleOne(app, record.id, now, false, report);
  return state === "in_flight" ? "in_flight" : "sent";
}

class PublicationMovedError extends Error {}

/** Map one in-flight publication's action to its status. `retry` re-sends an action that never left, inside its window. */
async function settleOne(app: AppContext, publicationId: number, now: Date, retry: boolean, report: OnlyfansPublishingReport): Promise<"in_flight" | "settled"> {
  const [record, dispatch] = await Promise.all([
    getPublication(app.db, publicationId),
    getPublicationDispatch(app.db, publicationId, "create"),
  ]);
  if (!record || record.status !== "submitting" || !dispatch?.ofapiActionIntentId) return "settled";
  const revision = await getPublicationRevision(app.db, dispatch.revisionId);
  if (!revision) return "in_flight";
  const intentId = dispatch.ofapiActionIntentId;
  let intent = await getOfapiAction(app, intentId);
  if (intent.state === "prepared") {
    if (!onlyfansStillInWindow(dispatch.mode, record.publishAt, now)) {
      await cancelOfapiAction(app, intentId, revision.approvedByUserId).catch(() => undefined);
      intent = await getOfapiAction(app, intentId);
    } else if (retry) {
      try {
        intent = await dispatchOfapiAction(app, intentId, revision.approvedByUserId);
      } catch {
        return "in_flight";
      }
    }
  }
  const outcome = onlyfansOutcome(intent, dispatch.mode);
  if (outcome.kind === "pending") return "in_flight";
  const moved = await transitionPublication(app.db, {
    id: publicationId, from: "submitting", to: outcome.to, actor: { kind: "hub" },
    reason: outcome.reason, platformPostRef: outcome.platformPostRef,
  });
  if (moved) {
    report.settled += 1;
    if (outcome.to === "missed") report.missed += 1;
  }
  if (outcome.autostop) {
    report.stoppedPageIds.push(record.pageId);
    await stopPage(app, record, outcome.reason ?? "authorization_refused", now);
  }
  return "settled";
}

async function stopPage(app: AppContext, record: PublicationRecord, reason: string, now: Date) {
  if (!await autostopPagePublishing(app.db, record.pageId, reason)) return;
  await notifyPublishingStoppedIncident(app, {
    pageId: record.pageId, pageLabel: record.pageLabel, platform: "onlyfans", reason, occurredAt: now,
  }).catch((error: unknown) => {
    app.logger?.warn({ error, pageId: record.pageId }, "publications: autostop notice failed");
  });
}
