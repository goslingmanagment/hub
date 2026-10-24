import type { PublicationWithdrawResult } from "@agency_hub_core/contracts";
import {
  getLatestFanslyVerifyWork,
  getPagePublishingSettings,
  getPublication,
  getPublicationDispatch,
  insertPublicationCheck,
  insertPublicationDispatch,
  listFanslyDeletions,
  listFanslyWriteCommandsOfDispatch,
  transitionPublication,
  type Database,
  type FanslyVerifyWorkFacts,
  type PublicationRecord,
} from "@agency_hub_core/db";
import { isFanslyWriteSendable, type FanslyWireId } from "@agency_hub_core/fansly";

import type { AppContext } from "../bootstrap.ts";
import { enqueueFanslyWriteCommand, FanslyWriteRefusedError } from "../sync/fansly/publish/enqueue.ts";
import { parsePublicationReads } from "../sync/fansly/publish/reads.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import { askVerifyReads } from "./publications-fansly-checks.ts";
import { toPublicationWire } from "./publications.ts";

// The owner deletes a Fansly post Hub published (owner, 2026-10-24; 0305) —
// «Удалить с площадки» on the Publications screen, or `publications:delete-post`
// for the owner's word in chat. On the page's engine, as every write:
//
// - Hub refuses without a request when the publication is not a published
//   Fansly post with its post id, the page is stopped (a lost login, a Fansly
//   check, a 401/403/429), the route is not verified, or a delete already
//   went. Otherwise it records the deletion (`publication_dispatches` kind
//   delete) and queues its ONE `post_delete` command: `POST /post/<id>/delete`
//   with no body (the contract §5), the id the post is on the wall under — the
//   publication's after "published" (a scheduled post that went out took a new
//   id; the check recorded the one it found). Allowed while publishing is off;
//   it goes within 30 minutes of the press or never (then press again).
// - This job follows it: Fansly answered → a fresh `GET /post?ids=<id>` asked
//   for after the answer (`publish.verify`, mode deleted); it lists nothing →
//   "Снят" (withdrawn, reason deleted_after_publish); it still lists the post,
//   or no fresh read within 30 minutes → "Неизвестно" — a person looks. A lost
//   answer → "Неизвестно", never sent again; Fansly's refusal → the post stays
//   published, the refusal on its deletion (`deletion.errorCode`); a delete
//   that never left → the owner may press again.

const MINUTE_MS = 60_000;
/** The delete goes within this long of the owner's press, or not at all (refused: press again). */
export const FANSLY_DELETE_SEND_WINDOW_MS = 30 * MINUTE_MS;
/** After Fansly's answer, a fresh read by the post's id must land within this long, or the deletion stays unconfirmed. */
export const FANSLY_DELETE_CONFIRM_WAIT_MS = 30 * MINUTE_MS;

type Refusal = { ok: false; reason: string };
type Eligible = { ok: true; record: PublicationRecord; revisionId: number };

/** Why a published Fansly post cannot be deleted now, or the facts to delete it with. */
export async function fanslyDeleteEligibility(
  db: Database,
  record: PublicationRecord | null,
  isSendable: (spec: FanslyWireId) => boolean = isFanslyWriteSendable,
): Promise<Eligible | Refusal> {
  if (record === null) return { ok: false, reason: "not_found" };
  if (record.platform !== "fansly") return { ok: false, reason: "not_fansly" };
  if (record.kind === "story") return { ok: false, reason: "story_not_deleted_here" };
  if (record.status !== "published") return { ok: false, reason: `status_${record.status}` };
  if (record.platformPostRef === null || record.approvedRevisionId === null) return { ok: false, reason: "no_platform_ref" };
  const settings = await getPagePublishingSettings(db, record.pageId);
  // Stopped (a lost login, a Fansly check, a 401/403/429): nothing may be sent for the page.
  if (settings.autostoppedAt !== null) return { ok: false, reason: "publishing_stopped" };
  if (!isSendable("publish.post_delete")) return { ok: false, reason: "route_unverified" };
  const previous = await getPublicationDispatch(db, record.id, "delete");
  if (previous !== null) {
    const deletes = (await listFanslyWriteCommandsOfDispatch(db, previous.id)).filter((command) => command.step === "post_delete");
    const last = deletes.at(-1);
    if (last !== undefined && (last.state === "queued" || last.state === "sending")) return { ok: false, reason: "delete_in_progress" };
    // One that never left (refused) may be asked again; any other went.
    if (last !== undefined && last.state !== "refused") return { ok: false, reason: "delete_already_sent" };
  }
  return { ok: true, record, revisionId: record.approvedRevisionId };
}

export interface FanslyDeleteOptions {
  now?: Date;
  /** Default `isFanslyWriteSendable` (the one list); integration tests pass their own. */
  isSendable?: (spec: FanslyWireId) => boolean;
}

/**
 * Delete one published Fansly post: refused now, or accepted — its one
 * command is queued on the page's engine, and its result comes as the
 * publication's status within minutes.
 */
export async function deleteFanslyPublication(
  app: AppContext,
  input: { id: number; userId: number } & FanslyDeleteOptions,
): Promise<PublicationWithdrawResult> {
  const now = input.now ?? new Date();
  const isSendable = input.isSendable ?? isFanslyWriteSendable;
  const result = async (outcome: "accepted" | "refused", reason: string): Promise<PublicationWithdrawResult> => {
    const fresh = await getPublication(app.db, input.id);
    return { id: input.id, outcome, reason, publication: fresh === null ? null : toPublicationWire(fresh) };
  };
  const eligible = await fanslyDeleteEligibility(app.db, await getPublication(app.db, input.id), isSendable);
  if (!eligible.ok) return result("refused", eligible.reason);
  const { record } = eligible;
  const config = await loadEffectiveConfig(app.db, app.config);
  const outcome = await app.db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const dispatch = await insertPublicationDispatch(tx, {
      publicationId: record.id, revisionId: eligible.revisionId, kind: "delete", platform: "fansly", ofapiActionIntentId: null, mode: "delete",
    }) ?? await getPublicationDispatch(tx, record.id, "delete");
    if (dispatch === null || dispatch.platform !== "fansly") return "delete_already_recorded";
    const queued = await enqueueFanslyWriteCommand(tx, {
      dispatchId: dispatch.id, step: "post_delete", item: "", priority: "background",
      notBefore: now, notAfter: new Date(now.getTime() + FANSLY_DELETE_SEND_WINDOW_MS),
      config, now, isSendable,
    });
    return queued === null ? "delete_in_progress" : "accepted";
  }).catch((error: unknown) => {
    // The guard said no before anything was written (the page stopped, Node).
    if (error instanceof FanslyWriteRefusedError) return error.reason;
    throw error;
  });
  if (outcome !== "accepted") return result("refused", outcome);
  return result("accepted", "delete_then_read");
}

// ---------------------------------------------------------------------------
// Following a deletion (the minutely job)
// ---------------------------------------------------------------------------

export type FanslyDeleteConclusion =
  | { kind: "wait"; askRead: boolean }
  | { kind: "settle"; to: "withdrawn" | "unknown"; reason: string; evidence: Record<string, unknown> };

/**
 * Where one deletion stands, from its delete command and the publication's
 * newest `publish.verify` work (pure). Queued or on the wire: it waits. A lost
 * answer: "Неизвестно". Answered: a read by the post's id asked for after the
 * answer decides — nothing listed is "Снят", the post still listed
 * "Неизвестно"; a read that failed is asked again, and none within 30
 * minutes of the answer is "Неизвестно".
 */
export function fanslyDeleteConclusion(input: {
  command: { state: string; stateReason: string | null; settledAt: Date | null };
  postRef: string | null;
  work: Pick<FanslyVerifyWorkFacts, "id" | "createdAt" | "closedAt" | "result"> | null;
  now: Date;
}): FanslyDeleteConclusion {
  const { command } = input;
  if (command.state === "unknown") return { kind: "settle", to: "unknown", reason: `delete_${command.stateReason ?? "unknown"}`, evidence: {} };
  if (command.state !== "answered") return { kind: "wait", askRead: false };
  const settledAt = command.settledAt ?? input.now;
  const late = input.now.getTime() - settledAt.getTime() > FANSLY_DELETE_CONFIRM_WAIT_MS;
  const unconfirmed: FanslyDeleteConclusion = { kind: "settle", to: "unknown", reason: "delete_unconfirmed_read_failed", evidence: {} };
  // Only a read asked for after Fansly's answer says anything of it.
  const fresh = input.work !== null && input.work.createdAt.getTime() > settledAt.getTime() ? input.work : null;
  if (fresh === null) return late ? unconfirmed : { kind: "wait", askRead: true };
  if (fresh.closedAt === null) return late ? { ...unconfirmed, evidence: { workId: fresh.id } } : { kind: "wait", askRead: false };
  const reads = parsePublicationReads(fresh.result);
  const byId = reads?.mode === "deleted" && reads.gaveUp === undefined ? reads.byId : undefined;
  if (byId === undefined || byId.ref !== input.postRef) {
    // The read did not come whole: once more, while there is time.
    return late ? { ...unconfirmed, evidence: { workId: fresh.id } } : { kind: "wait", askRead: true };
  }
  const evidence = { workId: fresh.id, postRef: byId.ref, listed: byId.answered };
  if (byId.found !== null) return { kind: "settle", to: "unknown", reason: "delete_still_listed", evidence };
  return { kind: "settle", to: "withdrawn", reason: "deleted_after_publish", evidence };
}

export interface FanslyDeleteReport {
  followed: number;
  deleted: number;
  unknown: number;
  readsAsked: number;
}

/** One minute's share: follow every deletion of a published Fansly post in flight. Runs whatever the switches say. */
export async function followFanslyDeletions(app: AppContext, options: { now?: Date } = {}): Promise<FanslyDeleteReport> {
  const now = options.now ?? new Date();
  const report: FanslyDeleteReport = { followed: 0, deleted: 0, unknown: 0, readsAsked: 0 };
  for (const item of await listFanslyDeletions(app.db)) {
    report.followed += 1;
    const work = item.command.state === "answered" ? await getLatestFanslyVerifyWork(app.db, { pageId: item.pageId, publicationId: item.publicationId }) : null;
    const conclusion = fanslyDeleteConclusion({ command: item.command, postRef: item.platformPostRef, work, now });
    if (conclusion.kind === "wait") {
      if (conclusion.askRead && await askVerifyReads(app, { pageId: item.pageId, publicationId: item.publicationId, mode: "deleted", now })) report.readsAsked += 1;
      continue;
    }
    if (!await transitionPublication(app.db, {
      id: item.publicationId, from: "published", to: conclusion.to, actor: { kind: "hub" }, reason: conclusion.reason,
    })) continue;
    // What the outcome was read from, beside the status.
    await insertPublicationCheck(app.db, {
      publicationId: item.publicationId, kind: "verify", outcome: conclusion.to, reason: conclusion.reason,
      platformPostRef: item.platformPostRef, evidence: { deletion: true, commandId: item.command.id, ...conclusion.evidence }, at: now,
    });
    if (conclusion.to === "withdrawn") report.deleted += 1;
    else report.unknown += 1;
  }
  return report;
}
