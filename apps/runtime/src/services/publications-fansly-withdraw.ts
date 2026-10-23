import type { PublicationWithdrawResult } from "@agency_hub_core/contracts";
import {
  getPagePublishingSettings,
  getPublication,
  getPublicationDispatch,
  insertPublicationDispatch,
  listFanslyWithdrawals,
  listFanslyWriteCommandsOfDispatch,
  listPublicationQueueSnapshots,
  listScheduledPublicationIds,
  transitionPublication,
  type Database,
  type PublicationRecord,
} from "@agency_hub_core/db";
import { FANSLY_PUBLISH_FACTS_VERIFIED, isFanslyWriteSendable, type FanslyPublishFacts, type FanslyWireId } from "@agency_hub_core/fansly";
import { PUBLICATION_WITHDRAW_MIN_LEAD_MINUTES } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { enqueueFanslyWriteCommand, FanslyWriteRefusedError } from "../sync/fansly/publish/enqueue.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import { askScheduleRead } from "./publications-fansly-checks.ts";
import { toPublicationWire } from "./publications.ts";

// Withdrawal of Hub's posts from Fansly's own schedule (docs/plans/2026-10-23-
// wall-posts, spec §8.2, §8.4; plan PR 9) — the same rules as OnlyFans', on the
// page's engine:
//
// - The owner presses «Снять» (one post, or «Снять всё, что поставил Hub», one
//   command per post with its own outcome). Hub refuses without a request when
//   the post is less than 15 minutes from its time, the page is stopped (a lost
//   login, a Fansly check, a 401/403/429 — the schedule stays on Fansly), the
//   cancel route is not verified by the stand, or a cancel already went.
//   Otherwise it records the withdrawal (`publication_dispatches` kind
//   withdraw) and queues its one `post_cancel` command, and asks for a fresh
//   read of the page's schedule: the command goes only once a read taken after
//   it still shows the post (publish/module.ts, publish/derive.ts), and never
//   closer than 15 minutes to the time. Allowed while publishing is off.
// - This job follows it: Fansly answered the cancel → a fresh read again; a
//   complete read that no longer shows the post while its time is ahead →
//   "Снят"; still shown, or a read that is not complete (every read, until the
//   stand confirms the list is the whole schedule) → "Неизвестно" — a person
//   looks, and no replacement is allowed (only a withdrawn post is replaced).
//   A lost answer → "Неизвестно", never sent again; Fansly's refusal → the post
//   stays scheduled; a cancel that never left → the owner may press again.

const MINUTE_MS = 60_000;
/** After the cancel, a fresh read must land within this long, or the withdrawal stays unconfirmed. */
export const FANSLY_WITHDRAW_CONFIRM_WAIT_MS = 30 * MINUTE_MS;

type Refusal = { ok: false; reason: string };
type Eligible = { ok: true; record: PublicationRecord; revisionId: number };

/** Why a Fansly post cannot be withdrawn now, or the facts to withdraw it with. */
export async function fanslyWithdrawEligibility(
  db: Database,
  record: PublicationRecord | null,
  now: Date,
  isSendable: (spec: FanslyWireId) => boolean = isFanslyWriteSendable,
): Promise<Eligible | Refusal> {
  if (record === null) return { ok: false, reason: "not_found" };
  if (record.platform !== "fansly") return { ok: false, reason: "not_fansly" };
  if (record.kind === "story") return { ok: false, reason: "story_has_no_schedule" };
  if (record.status !== "scheduled") return { ok: false, reason: `status_${record.status}` };
  if (record.platformPostRef === null || record.approvedRevisionId === null) return { ok: false, reason: "no_platform_ref" };
  if (record.publishAt.getTime() - now.getTime() < PUBLICATION_WITHDRAW_MIN_LEAD_MINUTES * MINUTE_MS) return { ok: false, reason: "too_close_to_publish_time" };
  const settings = await getPagePublishingSettings(db, record.pageId);
  // Stopped (a lost login, a Fansly check, a 401/403/429): nothing may be sent
  // for the page; what Hub scheduled stays on Fansly.
  if (settings.autostoppedAt !== null) return { ok: false, reason: "publishing_stopped_schedule_stays" };
  if (!isSendable("publish.post_cancel")) return { ok: false, reason: "route_unverified" };
  const previous = await getPublicationDispatch(db, record.id, "withdraw");
  if (previous !== null) {
    const cancels = (await listFanslyWriteCommandsOfDispatch(db, previous.id)).filter((command) => command.step === "post_cancel");
    const last = cancels.at(-1);
    if (last !== undefined && (last.state === "queued" || last.state === "sending")) return { ok: false, reason: "withdraw_in_progress" };
    // One that never left (refused) may be asked again; any other went.
    if (last !== undefined && last.state !== "refused") return { ok: false, reason: "withdraw_already_sent" };
  }
  return { ok: true, record, revisionId: record.approvedRevisionId };
}

export interface FanslyWithdrawOptions {
  now?: Date;
  /** Default `isFanslyWriteSendable` (the one list); integration tests pass their own. */
  isSendable?: (spec: FanslyWireId) => boolean;
}

/**
 * Withdraw Hub posts from Fansly's schedule, one command per post, each with
 * its own outcome: refused now, or accepted — its result comes as the
 * publication's status within minutes.
 */
export async function withdrawFanslyPublications(
  app: AppContext,
  input: { ids: readonly number[]; userId: number } & FanslyWithdrawOptions,
): Promise<PublicationWithdrawResult[]> {
  const now = input.now ?? new Date();
  const isSendable = input.isSendable ?? isFanslyWriteSendable;
  const config = await loadEffectiveConfig(app.db, app.config);
  const results: PublicationWithdrawResult[] = [];
  const result = async (id: number, outcome: PublicationWithdrawResult["outcome"], reason: string | null) => {
    const fresh = await getPublication(app.db, id);
    results.push({ id, outcome, reason, publication: fresh === null ? null : toPublicationWire(fresh) });
  };
  const pagesToRead = new Set<number>();
  for (const id of [...new Set(input.ids)]) {
    const eligible = await fanslyWithdrawEligibility(app.db, await getPublication(app.db, id), now, isSendable);
    if (!eligible.ok) {
      await result(id, "refused", eligible.reason);
      continue;
    }
    const { record } = eligible;
    const outcome = await app.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Database;
      const dispatch = await insertPublicationDispatch(tx, {
        publicationId: record.id, revisionId: eligible.revisionId, kind: "withdraw", platform: "fansly", ofapiActionIntentId: null, mode: "withdraw",
      }) ?? await getPublicationDispatch(tx, record.id, "withdraw");
      if (dispatch === null || dispatch.platform !== "fansly") return "withdraw_already_recorded";
      const queued = await enqueueFanslyWriteCommand(tx, {
        dispatchId: dispatch.id, step: "post_cancel", item: "", priority: "background",
        // Never sent closer than 15 minutes to the time (the engine checks it again before the send).
        notBefore: now, notAfter: new Date(record.publishAt.getTime() - PUBLICATION_WITHDRAW_MIN_LEAD_MINUTES * MINUTE_MS),
        config, now, isSendable,
      });
      return queued === null ? "withdraw_in_progress" : "accepted";
    }).catch((error: unknown) => {
      // The guard said no before anything was written (the page stopped, Node, the window).
      if (error instanceof FanslyWriteRefusedError) return error.reason;
      throw error;
    });
    if (outcome !== "accepted") {
      await result(id, "refused", outcome);
      continue;
    }
    pagesToRead.add(record.pageId);
    await result(id, "accepted", "schedule_read_then_cancel");
  }
  // The cancel waits for a fresh read of the schedule: ask for it now.
  for (const pageId of pagesToRead) await askScheduleRead(app, pageId, now, "publication:withdraw");
  return results;
}

/** «Снять всё, что поставил Hub» on a Fansly page: every Hub post in its schedule, one command each. */
export async function withdrawAllFanslyPublications(app: AppContext, input: { pageId: number; userId: number } & FanslyWithdrawOptions): Promise<PublicationWithdrawResult[]> {
  const ids = await listScheduledPublicationIds(app.db, input.pageId);
  return withdrawFanslyPublications(app, { ...input, ids });
}

// ---------------------------------------------------------------------------
// Following a withdrawal (the minutely job)
// ---------------------------------------------------------------------------

export type FanslyWithdrawConclusion =
  | { kind: "wait"; askRead: boolean }
  | { kind: "settle"; to: "withdrawn" | "unknown"; reason: string };

/**
 * Where one withdrawal stands, from its cancel command and the page's latest
 * schedule read (pure). A cancel queued waits for its fresh read; answered,
 * it waits for a read taken after the answer — then a complete read without
 * the post, its time still ahead, is "Снят", anything else "Неизвестно"; a
 * lost answer is "Неизвестно". Refused and rejected leave the post scheduled.
 */
export function fanslyWithdrawConclusion(input: {
  command: { state: string; stateReason: string | null; settledAt: Date | null } | null;
  postRef: string | null;
  publishAt: Date;
  schedule: { readAt: Date; complete: boolean; postRefs: readonly string[] } | null;
  now: Date;
  facts?: FanslyPublishFacts;
}): FanslyWithdrawConclusion {
  const { command } = input;
  if (command === null || command.state === "refused" || command.state === "rejected") return { kind: "wait", askRead: false };
  if (command.state === "queued" || command.state === "sending") return { kind: "wait", askRead: command.state === "queued" };
  if (command.state === "unknown") return { kind: "settle", to: "unknown", reason: `withdraw_${command.stateReason ?? "unknown"}` };
  // Answered: Fansly said it cancelled. A read taken after says whether it is gone.
  const settledAt = command.settledAt ?? input.now;
  const fresh = input.schedule !== null && input.schedule.readAt.getTime() > settledAt.getTime() ? input.schedule : null;
  if (fresh === null) {
    if (input.now.getTime() - settledAt.getTime() > FANSLY_WITHDRAW_CONFIRM_WAIT_MS) return { kind: "settle", to: "unknown", reason: "withdraw_unconfirmed_read_failed" };
    return { kind: "wait", askRead: true };
  }
  if (input.postRef !== null && fresh.postRefs.includes(input.postRef)) return { kind: "settle", to: "unknown", reason: "withdraw_still_in_schedule" };
  const whole = (input.facts ?? FANSLY_PUBLISH_FACTS_VERIFIED).scheduleListWhole && fresh.complete;
  if (!whole) return { kind: "settle", to: "unknown", reason: "withdraw_unconfirmed_incomplete" };
  // Gone from a whole schedule while its time is still ahead: it did not go out, it was withdrawn.
  if (input.publishAt.getTime() <= fresh.readAt.getTime()) return { kind: "settle", to: "unknown", reason: "withdraw_unconfirmed_time_passed" };
  return { kind: "settle", to: "withdrawn", reason: "withdrawn" };
}

export interface FanslyWithdrawReport {
  followed: number;
  withdrawn: number;
  unknown: number;
  readsAsked: number;
}

/** One minute's share: follow every Fansly withdrawal in flight. Runs whatever the switches say (spec §8.4). */
export async function followFanslyWithdrawals(app: AppContext, options: { now?: Date; facts?: FanslyPublishFacts } = {}): Promise<FanslyWithdrawReport> {
  const now = options.now ?? new Date();
  const report: FanslyWithdrawReport = { followed: 0, withdrawn: 0, unknown: 0, readsAsked: 0 };
  const withdrawals = await listFanslyWithdrawals(app.db);
  const snapshots = new Map((await listPublicationQueueSnapshots(app.db, [...new Set(withdrawals.map((item) => item.pageId))])).map((row) => [row.pageId, row]));
  const asked = new Set<number>();
  for (const item of withdrawals) {
    report.followed += 1;
    const snapshot = snapshots.get(item.pageId);
    const conclusion = fanslyWithdrawConclusion({
      command: item.command,
      postRef: item.platformPostRef,
      publishAt: item.publishAt,
      schedule: snapshot?.readAt == null ? null : {
        readAt: snapshot.readAt, complete: snapshot.complete, postRefs: snapshot.entries.flatMap((entry) => (entry.postRef === null ? [] : [entry.postRef])),
      },
      now,
      ...(options.facts === undefined ? {} : { facts: options.facts }),
    });
    if (conclusion.kind === "wait") {
      if (conclusion.askRead && !asked.has(item.pageId)) {
        asked.add(item.pageId);
        if (await askScheduleRead(app, item.pageId, now, "publication:withdraw")) report.readsAsked += 1;
      }
      continue;
    }
    if (await transitionPublication(app.db, {
      id: item.publicationId, from: "scheduled", to: conclusion.to, actor: { kind: "hub" }, reason: conclusion.reason,
    })) {
      if (conclusion.to === "withdrawn") report.withdrawn += 1;
      else report.unknown += 1;
    }
  }
  return report;
}
