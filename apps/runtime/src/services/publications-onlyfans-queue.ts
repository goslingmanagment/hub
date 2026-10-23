import type { OfapiAction, PublicationQueueSnapshotWire, PublicationWithdrawResult } from "@agency_hub_core/contracts";
import {
  getPagePublishingSettings,
  getPublication,
  getPublicationDispatch,
  insertPublicationDispatch,
  listOnlyfansQueuePages,
  listPublicationQueueSnapshots,
  listPublicationsByPlatformPostRef,
  listScheduledPublicationIds,
  recordPublicationQueueFailure,
  savePublicationQueueSnapshot,
  transitionPublication,
  type Database,
  type PublicationQueueEntryFacts,
  type PublicationRecord,
} from "@agency_hub_core/db";
import {
  PUBLICATION_QUEUE_READ_DAYS,
  PUBLICATION_QUEUE_READ_IDLE_MINUTES,
  PUBLICATION_QUEUE_READ_IN_FLIGHT_MINUTES,
  PUBLICATION_WITHDRAW_MIN_LEAD_MINUTES,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { dispatchOfapiAction, getOfapiAction, prepareOfapiAction } from "./ofapi-actions.ts";
import { normalizePostText } from "./publications-onlyfans-checks.ts";
import { publicationActionId } from "./publications-onlyfans.ts";
import {
  addUtcDays,
  readOnlyfansQueue,
  utcDay,
  type OnlyfansPlatformItem,
  type OnlyfansQueueRead,
} from "./publications-onlyfans-reads.ts";
import { toPublicationWire } from "./publications.ts";

// OnlyFans' own schedule for wall posts (docs/plans/2026-10-23-wall-posts,
// spec §6, §8.2, §8.4, §9; plan PR 5b):
//
// - Hub reads each OnlyFans page's schedule hourly while the page has Hub
//   posts in it, otherwise daily for pages with publishing on, and when the
//   owner presses "Обновить". The latest read per page is kept; the screen
//   shows from it the posts scheduled by hand and whether it was complete.
// - Withdrawal of a Hub post (one, or "Снять всё, что поставил Hub", one
//   command per post with its own outcome): only 15 minutes or more before its
//   time, and only after a fresh, complete read of the schedule shows it
//   still there — OnlyFansAPI's post delete removes live posts too. Allowed
//   while publishing is switched off; refused while the page is stopped for
//   its authorization (the schedule then stays on the platform). Sent once:
//   a lost answer is "unknown", never sent again. Confirmed only when a fresh
//   complete read no longer shows the post.

const MINUTE_MS = 60_000;
/** Pages whose schedule is read per minute: each read is one to six requests. */
const QUEUE_PAGES_PER_TICK = 2;
const QUEUE_LIST_READS = 5;
const WITHDRAW_LIST_READS = 8;
const CAPTION_HEAD = 300;

export function entryFacts(entry: OnlyfansPlatformItem): PublicationQueueEntryFacts {
  return {
    queueId: entry.id,
    postRef: entry.entityId,
    publishAt: entry.at?.toISOString() ?? null,
    text: normalizePostText(entry.text ?? "").slice(0, CAPTION_HEAD),
    mediaCount: entry.mediaIds?.length ?? entry.mediaCount,
  };
}

/** Whether the page's schedule is due a read at `now`: asked for, or older than its cadence. */
export function queueReadDue(input: {
  inFlight: boolean;
  publishingEnabled: boolean;
  lastAttemptAt: Date | null;
  refreshRequestedAt: Date | null;
  now: Date;
}): boolean {
  // Every read, good or failed, clears the press it answered: a press still there is due.
  if (input.refreshRequestedAt) return true;
  const cadence = input.inFlight ? PUBLICATION_QUEUE_READ_IN_FLIGHT_MINUTES : input.publishingEnabled ? PUBLICATION_QUEUE_READ_IDLE_MINUTES : null;
  if (cadence === null) return false;
  return !input.lastAttemptAt || input.now.getTime() - input.lastAttemptAt.getTime() >= cadence * MINUTE_MS;
}

function latest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/** The minutely job's share: read the schedules that are due, a couple of pages at a time. */
export async function refreshOnlyfansQueueSnapshots(app: AppContext, now = new Date()): Promise<number> {
  if (!app.ofapi?.dispatchGovernedRaw) return 0;
  const pages = await listOnlyfansQueuePages(app.db, now);
  const snapshots = new Map((await listPublicationQueueSnapshots(app.db, pages.map((page) => page.pageId))).map((row) => [row.pageId, row]));
  let read = 0;
  for (const page of pages) {
    if (read >= QUEUE_PAGES_PER_TICK) break;
    const snapshot = snapshots.get(page.pageId);
    const due = queueReadDue({
      inFlight: page.inFlight,
      publishingEnabled: page.publishingEnabled,
      lastAttemptAt: latest(snapshot?.readAt ?? null, snapshot?.lastFailedAt ?? null),
      refreshRequestedAt: snapshot?.refreshRequestedAt ?? null,
      now,
    });
    const actorUserId = snapshot?.refreshRequestedByUserId ?? page.defaultActorUserId;
    if (!due || actorUserId === null) continue;
    read += 1;
    const from = utcDay(now);
    const answeredRequestAt = snapshot?.refreshRequestedAt ?? null;
    const result = await readOnlyfansQueue({ app, pageId: page.pageId, actorUserId }, {
      from, to: addUtcDays(from, PUBLICATION_QUEUE_READ_DAYS), maxListReads: QUEUE_LIST_READS, now,
    }).catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error), intentIds: [] as string[] }));
    if (!result.ok) {
      await recordPublicationQueueFailure(app.db, { pageId: page.pageId, answeredRequestAt, failedAt: now, reason: result.reason });
      continue;
    }
    await savePublicationQueueSnapshot(app.db, {
      pageId: page.pageId, answeredRequestAt, readAt: result.readAt, windowFrom: result.from, windowTo: result.to,
      complete: result.complete, incompleteReasons: result.incompleteReasons, postsPerDay: result.postsPerDay,
      entries: result.entries.map(entryFacts), evidence: { intentIds: result.intentIds },
    });
  }
  return read;
}

/** The screen's view of every OnlyFans page's schedule: Hub's posts in it and the ones put there by hand. */
export async function listOnlyfansQueueWire(app: AppContext, now = new Date()): Promise<PublicationQueueSnapshotWire[]> {
  const pages = await listOnlyfansQueuePages(app.db, now);
  const snapshots = new Map((await listPublicationQueueSnapshots(app.db, pages.map((page) => page.pageId))).map((row) => [row.pageId, row]));
  const out: PublicationQueueSnapshotWire[] = [];
  for (const page of pages) {
    const snapshot = snapshots.get(page.pageId);
    const claimed = await listPublicationsByPlatformPostRef(app.db, page.pageId);
    const cadence = page.inFlight ? PUBLICATION_QUEUE_READ_IN_FLIGHT_MINUTES : PUBLICATION_QUEUE_READ_IDLE_MINUTES;
    const readAt = snapshot?.readAt ?? null;
    out.push({
      pageLabel: page.pageLabel,
      readAt: readAt?.toISOString() ?? null,
      windowFrom: snapshot?.windowFrom ?? null,
      windowTo: snapshot?.windowTo ?? null,
      complete: snapshot?.complete ?? false,
      incompleteReasons: snapshot?.incompleteReasons ?? [],
      // A read older than twice its cadence (or none) is not fresh.
      stale: !readAt || now.getTime() - readAt.getTime() > 2 * cadence * MINUTE_MS,
      postsPerDay: snapshot?.postsPerDay ?? {},
      refreshRequestedAt: snapshot?.refreshRequestedAt?.toISOString() ?? null,
      lastFailure: snapshot?.lastFailure ?? null,
      lastFailedAt: snapshot?.lastFailedAt?.toISOString() ?? null,
      entries: (snapshot?.entries ?? []).map((entry) => {
        const publication = (entry.postRef ? claimed.get(entry.postRef) : undefined) ?? claimed.get(entry.queueId) ?? null;
        return { ...entry, publicationId: publication?.id ?? null };
      }),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Withdrawal
// ---------------------------------------------------------------------------

type Refusal = { ok: false; reason: string };
type Eligible = { ok: true; record: PublicationRecord; ref: string; revisionId: number };

/** Why a publication cannot be withdrawn now, or the facts to withdraw it with. */
export async function withdrawEligibility(db: Database, record: PublicationRecord | null, now: Date): Promise<Eligible | Refusal> {
  if (!record) return { ok: false, reason: "not_found" };
  if (record.platform !== "onlyfans") return { ok: false, reason: "not_onlyfans" };
  if (record.kind === "story") return { ok: false, reason: "story_has_no_schedule" };
  if (record.status !== "scheduled") return { ok: false, reason: `status_${record.status}` };
  if (!record.platformPostRef || record.approvedRevisionId === null) return { ok: false, reason: "no_platform_ref" };
  if (record.publishAt.getTime() - now.getTime() < PUBLICATION_WITHDRAW_MIN_LEAD_MINUTES * MINUTE_MS) return { ok: false, reason: "too_close_to_publish_time" };
  const settings = await getPagePublishingSettings(db, record.pageId);
  // Stopped for its authorization: nothing may be sent for the page; what Hub scheduled stays on OnlyFans.
  if (settings.autostoppedAt !== null) return { ok: false, reason: "publishing_stopped_schedule_stays" };
  const previous = await getPublicationDispatch(db, record.id, "withdraw");
  if (previous && previous.ofapiActionIntentId) {
    const state = record.withdrawal?.state ?? null;
    if (state !== "prepared") return { ok: false, reason: "withdraw_already_sent" };
  }
  return { ok: true, record, ref: record.platformPostRef, revisionId: record.approvedRevisionId };
}

const inSchedule = (read: OnlyfansQueueRead, ref: string) => read.entries.filter((entry) => entry.id === ref || entry.entityId === ref);

/**
 * Withdraw Hub posts from OnlyFans' schedule, one command per post, each with
 * its own outcome. A page's schedule is read fresh and whole before (it must
 * show the post) and after (it must no longer show it).
 */
export async function withdrawOnlyfansPublications(app: AppContext, input: { ids: readonly number[]; userId: number; clock?: () => Date }): Promise<PublicationWithdrawResult[]> {
  const clock = input.clock ?? (() => new Date());
  const results = new Map<number, PublicationWithdrawResult>();
  const refuse = async (id: number, reason: string) => {
    const record = await getPublication(app.db, id);
    results.set(id, { id, outcome: "refused", reason, publication: record ? toPublicationWire(record) : null });
  };
  const byPage = new Map<number, Eligible[]>();
  for (const id of [...new Set(input.ids)]) {
    const eligible = await withdrawEligibility(app.db, await getPublication(app.db, id), clock());
    if (!eligible.ok) {
      await refuse(id, eligible.reason);
      continue;
    }
    byPage.set(eligible.record.pageId, [...(byPage.get(eligible.record.pageId) ?? []), eligible]);
  }

  for (const [pageId, items] of byPage) {
    items.sort((a, b) => a.record.publishAt.getTime() - b.record.publishAt.getTime());
    const window = { from: utcDay(items[0]!.record.publishAt), to: utcDay(items.at(-1)!.record.publishAt) };
    const ctx = { app, pageId, actorUserId: input.userId };
    const before = await readOnlyfansQueue(ctx, { ...window, maxListReads: WITHDRAW_LIST_READS, now: clock() });
    if (!before.ok || !before.complete) {
      const reason = before.ok ? `schedule_incomplete:${before.incompleteReasons.join(",")}` : `schedule_read_failed:${before.reason}`;
      for (const item of items) await refuse(item.record.id, reason);
      continue;
    }
    const sent: Eligible[] = [];
    for (const item of items) {
      const { record, ref } = item;
      const entries = inSchedule(before, ref);
      if (entries.length !== 1) {
        await refuse(record.id, entries.length === 0 ? "not_in_schedule" : "schedule_ambiguous");
        continue;
      }
      // The reads take time: the 15 minutes are checked again right before the send.
      if (record.publishAt.getTime() - clock().getTime() < PUBLICATION_WITHDRAW_MIN_LEAD_MINUTES * MINUTE_MS) {
        await refuse(record.id, "too_close_to_publish_time");
        continue;
      }
      // The post inside the schedule entry, when the entry names one (ASSUMPTION
      // until the owner's check, plan §12: post delete takes the post's id).
      const postId = entries[0]!.entityId ?? ref;
      const outcome = await sendWithdraw(app, item, postId, input.userId);
      if (outcome === "confirmed") {
        sent.push(item);
        continue;
      }
      results.set(record.id, outcome);
    }
    if (sent.length === 0) continue;
    const after = await readOnlyfansQueue(ctx, { ...window, maxListReads: WITHDRAW_LIST_READS, now: clock() });
    for (const { record, ref } of sent) {
      const gone = after.ok && after.complete && inSchedule(after, ref).length === 0
        && record.publishAt.getTime() > clock().getTime();
      const to = gone ? "withdrawn" : "unknown";
      const reason = gone ? "withdrawn" : after.ok ? (after.complete ? "withdraw_still_in_schedule" : "withdraw_unconfirmed_incomplete") : "withdraw_unconfirmed_read_failed";
      await transitionPublication(app.db, { id: record.id, from: "scheduled", to, actor: { kind: "hub" }, reason });
      const fresh = await getPublication(app.db, record.id);
      results.set(record.id, { id: record.id, outcome: to, reason, publication: fresh ? toPublicationWire(fresh) : null });
    }
  }
  return input.ids.filter((id, index, all) => all.indexOf(id) === index).map((id) => results.get(id) as PublicationWithdrawResult);
}

/** One post delete, sent at most once. Confirmed waits for the read after; anything else is its result now. */
async function sendWithdraw(app: AppContext, item: Eligible, postId: string, userId: number): Promise<"confirmed" | PublicationWithdrawResult> {
  const { record } = item;
  const intentId = publicationActionId(record.id, item.revisionId, "withdraw");
  const result = async (outcome: PublicationWithdrawResult["outcome"], reason: string | null) => {
    const fresh = await getPublication(app.db, record.id);
    return { id: record.id, outcome, reason, publication: fresh ? toPublicationWire(fresh) : null };
  };
  try {
    await prepareOfapiAction(app, { id: intentId, command: { action: "post_delete", pageId: record.pageId, postId } as OfapiAction }, userId);
  } catch (error) {
    return result("refused", `not_prepared: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
  }
  const dispatch = await insertPublicationDispatch(app.db, {
    publicationId: record.id, revisionId: item.revisionId, kind: "withdraw", platform: "onlyfans", ofapiActionIntentId: intentId, mode: "withdraw",
  }) ?? await getPublicationDispatch(app.db, record.id, "withdraw");
  if (dispatch?.ofapiActionIntentId !== intentId) return result("refused", "withdraw_already_recorded");
  let intent;
  try {
    intent = await dispatchOfapiAction(app, intentId, userId);
  } catch (error) {
    intent = await getOfapiAction(app, intentId).catch(() => null);
    // Never left: the owner may press again; the guards run again then.
    if (!intent || intent.state === "prepared") return result("not_sent", `${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
  }
  if (intent.state === "confirmed") return "confirmed";
  if (intent.state === "rejected") {
    // A definite "no": nothing was removed and the post stays in the schedule.
    return result("rejected", intent.errorCode ?? "rejected");
  }
  // Lost or unexpected answer: it may or may not be gone. Never sent again (spec §8.2).
  await transitionPublication(app.db, { id: record.id, from: "scheduled", to: "unknown", actor: { kind: "hub" }, reason: `withdraw_${intent.errorCode ?? intent.state}` });
  return result("unknown", `withdraw_${intent.errorCode ?? intent.state}`);
}

/** "Снять всё, что поставил Hub" on a page: every Hub post in its schedule, one command each. */
export async function withdrawAllOnlyfansPublications(app: AppContext, input: { pageId: number; userId: number; clock?: () => Date }): Promise<PublicationWithdrawResult[]> {
  const ids = await listScheduledPublicationIds(app.db, input.pageId);
  return withdrawOnlyfansPublications(app, { ids, userId: input.userId, ...(input.clock ? { clock: input.clock } : {}) });
}
