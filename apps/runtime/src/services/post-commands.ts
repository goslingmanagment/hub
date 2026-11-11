import type { AgentPostCommandResponse, OfapiAction, PublicationWire } from "@agency_hub_core/contracts";
import {
  countAgentPostDeleteSlots,
  findFanslyPostCommand,
  findPublicationIdByPlatformPostRef,
  getLatestFanslyPostVerifyWork,
  getPagePublishingSettings,
  getPublication,
  getPublicationDispatch,
  listFanslyPostCommandsSettledSince,
  listFanslyWriteCommandsOfDispatch,
  listPublicationQueueSnapshots,
  pageHasCreatorPost,
  releaseAgentPostDeleteSlot,
  reserveAgentPostDeleteSlot,
  type FanslyWriteCommandRecord,
  type PublicationQueueSnapshotRecord,
} from "@agency_hub_core/db";
import { isFanslyWriteSendable, type FanslyWireId } from "@agency_hub_core/fansly";
import { POST_WITHDRAW_SCHEDULE_MAX_AGE_MINUTES, PUBLICATION_WITHDRAW_MIN_LEAD_MINUTES } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { enqueueFanslyPostCommand, FanslyWriteRefusedError } from "../sync/fansly/publish/enqueue.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import { askPostVerifyRead, askScheduleRead } from "./publications-fansly-checks.ts";
import { deleteFanslyPublication, FANSLY_DELETE_SEND_WINDOW_MS, fanslyDeleteConclusion } from "./publications-fansly-delete.ts";
import { fanslyWithdrawConclusion, withdrawFanslyPublications } from "./publications-fansly-withdraw.ts";
import {
  sendOnlyfansPostDelete,
  withdrawOnlyfansPost,
  withdrawOnlyfansPublications,
  type OnlyfansPostSend,
} from "./publications-onlyfans-queue.ts";
import { listOfapiActionsOfCommand } from "./ofapi-actions.ts";
import { toPublicationWire, type PublicationWithdrawer } from "./publications.ts";

// Any post of a page, by the platform's post id (owner 2026-11-11). An agent
// key takes a post off the platform's schedule — one put there by hand too —
// and, with delete:posts, deletes a published one, only on the owner's «да»
// for that post (the agent's rules hold that word; Hub does not check it, but
// makes a runaway or mistaken deletion hard and visible):
//
// - Only a post Hub itself has seen on THIS page: a withdrawal's post in Hub's
//   own read of the page's schedule, an hour old at most (else: refresh
//   first); a deletion's among the page's own synced posts (`creator_posts`),
//   and not in the schedule (that is a withdrawal). Never an id Hub has not
//   seen here, never another account's post.
// - A Hub post goes through its publication — the owner's own withdrawal and
//   Fansly deletion — so its status follows. A post with no publication: its
//   own command — on Fansly a `fansly_write_commands` row naming the post
//   (0369), on the page's engine as every write; on OnlyFans the owner action
//   `post_delete`, as the key's owner.
// - ONE command per post and action, whichever route asked (0369: a unique
//   index on Fansly, the action's body on OnlyFans): a repeat answers the
//   stored command's state and sends nothing. After an unknown end nothing is
//   sent again — only a read: the schedule (a cancel), the post by its id (a
//   Fansly delete).
// - A deletion: a daily ceiling per key (AGENT_POST_DELETE_DAILY_LIMIT_PER_KEY),
//   its slot reserved before the command and never given back once one exists;
//   and a reason, kept in the owner's audit (the route's).
// - Honest outcomes: withdrawn / deleted only when the platform's answer or a
//   read after it proves it; otherwise unknown, with what a person checks.

const MINUTE_MS = 60_000;
const LEAD_MS = PUBLICATION_WITHDRAW_MIN_LEAD_MINUTES * MINUTE_MS;
/** The minutely job asks the deciding reads of commands settled this long ago at most. */
const FOLLOW_WINDOW_MS = 35 * MINUTE_MS;

export type PostAction = "withdraw" | "delete";
export type PostCommandResult = AgentPostCommandResponse;

/** A page of the key's grant, on a platform with posts. */
export interface PostCommandPage {
  id: number;
  pageLabel: string;
  platform: "fansly" | "onlyfans";
}

/** The agent key, and the person its platform commands go as (the key's owner). */
export interface PostCommandActor {
  agentKeyId: number;
  ownerUserId: number;
  allowedPageIds: readonly number[];
}

export interface PostCommandOptions {
  now?: Date;
  /** Default `isFanslyWriteSendable`; integration tests pass their own. */
  isSendable?: (spec: FanslyWireId) => boolean;
}

/** What a person checks when the outcome is unknown. */
export const POST_COMMAND_CHECKS = {
  withdraw: "Hub does not know whether the post left the platform's schedule: it may still go out at its time. A person"
    + " opens the page's scheduled posts on the platform, finds this post and takes it off by hand if it is there.",
  delete: "Hub does not know whether the post is gone: a person opens this post on the platform and deletes it by hand"
    + " if it is still there.",
} as const;

/** Refusals that mean the publication's command exists already: answered from it. */
const PUBLICATION_REPEAT_REASONS = new Set([
  "withdraw_in_progress", "withdraw_already_sent", "withdraw_already_recorded", "delete_in_progress", "delete_already_sent",
]);

type Fields = Partial<PostCommandResult> & Pick<PostCommandResult, "outcome">;

function answer(page: PostCommandPage, postRef: string, action: PostAction, fields: Fields): PostCommandResult {
  return {
    pageLabel: page.pageLabel, platform: page.platform, postRef, action,
    reason: null, repeat: false, publicationId: null, publication: null, command: null, check: null, dailyLimit: null,
    ...fields,
  };
}

function commandWire(command: Pick<FanslyWriteCommandRecord, "state" | "stateReason" | "createdAt" | "settledAt">) {
  return {
    state: command.state, stateReason: command.stateReason,
    createdAt: command.createdAt.toISOString(), settledAt: command.settledAt?.toISOString() ?? null,
  };
}

function postDeleteCommand(page: PostCommandPage, postRef: string): OfapiAction {
  return { action: "post_delete", pageId: page.id, postId: postRef } as OfapiAction;
}

/** The page's latest read of its schedule, and its entries naming `postRef`
 *  (the post an entry holds, or the entry when it names none). */
async function scheduleEntries(app: AppContext, page: PostCommandPage, postRef: string) {
  const snapshot: PublicationQueueSnapshotRecord | undefined = (await listPublicationQueueSnapshots(app.db, [page.id]))[0];
  const entries = (snapshot?.entries ?? []).filter((entry) => (entry.postRef ?? entry.queueId) === postRef);
  return { snapshot: snapshot ?? null, entries };
}

// ---------------------------------------------------------------------------
// A Hub publication's post: through its publication
// ---------------------------------------------------------------------------

/** Where a publication's withdrawal or deletion stands, from its status. */
function publicationStored(action: PostAction, publication: PublicationWire): Fields {
  const base = { publicationId: publication.id, publication, repeat: true } as const;
  if (action === "withdraw") {
    if (publication.status === "withdrawn") return { ...base, outcome: "withdrawn", reason: publication.statusReason };
    if (publication.status === "unknown") return { ...base, outcome: "unknown", reason: publication.statusReason, check: POST_COMMAND_CHECKS.withdraw };
    if (publication.withdrawal?.state === "rejected") return { ...base, outcome: "rejected", reason: publication.withdrawal.errorCode };
    return { ...base, outcome: "accepted", reason: `withdrawal_${publication.withdrawal?.state ?? "in_progress"}` };
  }
  if (publication.status === "withdrawn") return { ...base, outcome: "deleted", reason: publication.statusReason };
  if (publication.status === "unknown") return { ...base, outcome: "unknown", reason: publication.statusReason, check: POST_COMMAND_CHECKS.delete };
  if (publication.deletion?.state === "rejected") return { ...base, outcome: "rejected", reason: publication.deletion.errorCode };
  return { ...base, outcome: "accepted", reason: `deletion_${publication.deletion?.state ?? "in_progress"}` };
}

async function withdrawPublicationPost(
  app: AppContext,
  page: PostCommandPage,
  postRef: string,
  publicationId: number,
  actor: PostCommandActor,
  options: PostCommandOptions,
): Promise<PostCommandResult> {
  const withdrawer: PublicationWithdrawer = { kind: "agent", agentKeyId: actor.agentKeyId, ownerUserId: actor.ownerUserId, allowedPageIds: actor.allowedPageIds };
  const [result] = page.platform === "fansly"
    ? await withdrawFanslyPublications(app, { ids: [publicationId], withdrawer, ...options })
    : await withdrawOnlyfansPublications(app, { ids: [publicationId], withdrawer, ...(options.now === undefined ? {} : { clock: () => options.now! }) });
  const publication = result?.publication ?? null;
  if (result === undefined || publication === null) return answer(page, postRef, "withdraw", { outcome: "refused", reason: result?.reason ?? "not_found", publicationId });
  // Its withdrawal went (or is under way), or it is off already: the stored state, nothing sent now.
  if (result.outcome === "refused" && (PUBLICATION_REPEAT_REASONS.has(result.reason ?? "") || (publication.withdrawal !== null && publication.status !== "scheduled"))) {
    return answer(page, postRef, "withdraw", publicationStored("withdraw", publication));
  }
  return answer(page, postRef, "withdraw", {
    outcome: result.outcome, reason: result.reason, publicationId, publication,
    check: result.outcome === "unknown" ? POST_COMMAND_CHECKS.withdraw : null,
  });
}

// ---------------------------------------------------------------------------
// A post with no publication: its own command, and where it stands
// ---------------------------------------------------------------------------

/**
 * Where a Fansly command of a post with no publication stands (and, when a
 * read decides it and none is there yet, that read asked for: read-only, the
 * command is never sent again). A cancel: Fansly's answer and the schedule's
 * read after it (`fanslyWithdrawConclusion`); a delete: the post read by its
 * id after the answer — or, after a lost answer, a read that no longer lists
 * it (`fanslyDeleteConclusion`).
 */
export async function fanslyPostCommandStanding(
  app: AppContext,
  command: FanslyWriteCommandRecord,
  now: Date,
): Promise<{ outcome: PostCommandResult["outcome"]; reason: string | null; askedRead: boolean }> {
  const postRef = command.postRef ?? "";
  if (command.state === "queued" || command.state === "sending") return { outcome: "accepted", reason: `command_${command.state}`, askedRead: false };
  if (command.state === "rejected") return { outcome: "rejected", reason: command.stateReason, askedRead: false };
  if (command.state === "refused") return { outcome: "refused", reason: command.stateReason, askedRead: false };
  if (command.step === "post_cancel") {
    const snapshot = (await listPublicationQueueSnapshots(app.db, [command.pageId]))[0];
    const listedStatus = command.result?.listedStatus;
    const conclusion = fanslyWithdrawConclusion({
      command: {
        state: command.state, stateReason: command.stateReason, settledAt: command.settledAt,
        listedStatus: typeof listedStatus === "number" ? listedStatus : null,
      },
      postRef,
      // Queued no later than 15 minutes before its time (`notAfter`): that time.
      publishAt: new Date((command.notAfter ?? now).getTime() + LEAD_MS),
      schedule: snapshot?.readAt == null ? null : {
        readAt: snapshot.readAt,
        complete: snapshot.complete,
        incompleteReasons: snapshot.incompleteReasons,
        postRefs: snapshot.entries.flatMap((entry) => (entry.postRef === null ? [] : [entry.postRef])),
      },
      now,
    });
    if (conclusion.kind === "wait") {
      const askedRead = conclusion.askRead && await askScheduleRead(app, command.pageId, now, "post:withdraw");
      return { outcome: "accepted", reason: "cancel_answered_read_pending", askedRead };
    }
    return { outcome: conclusion.to, reason: conclusion.reason, askedRead: false };
  }
  const work = await getLatestFanslyPostVerifyWork(app.db, { pageId: command.pageId, postRef });
  // A lost answer is read like an answered one: only a read that no longer lists the post says it is gone.
  const conclusion = fanslyDeleteConclusion({
    command: { state: "answered", stateReason: command.stateReason, settledAt: command.settledAt }, postRef, work, now,
  });
  if (conclusion.kind === "wait") {
    const askedRead = conclusion.askRead && await askPostVerifyRead(app, { pageId: command.pageId, postRef, now });
    if (command.state === "unknown") return { outcome: "unknown", reason: `delete_${command.stateReason ?? "unknown"}`, askedRead };
    return { outcome: "accepted", reason: "delete_answered_read_pending", askedRead };
  }
  if (conclusion.to === "withdrawn") return { outcome: "deleted", reason: "deleted_confirmed_by_read", askedRead: false };
  return {
    outcome: "unknown",
    reason: command.state === "unknown" ? `delete_${command.stateReason ?? "unknown"}:${conclusion.reason}` : conclusion.reason,
    askedRead: false,
  };
}

async function fanslyStoredAnswer(
  app: AppContext,
  page: PostCommandPage,
  postRef: string,
  action: PostAction,
  command: FanslyWriteCommandRecord,
  now: Date,
  repeat: boolean,
  dailyLimit: PostCommandResult["dailyLimit"],
): Promise<PostCommandResult> {
  const standing = await fanslyPostCommandStanding(app, command, now);
  return answer(page, postRef, action, {
    outcome: standing.outcome, reason: standing.reason, repeat, command: commandWire(command), dailyLimit,
    publicationId: command.publicationId,
    publication: command.publicationId === null ? null : await publicationWire(app, command.publicationId),
    check: standing.outcome === "unknown" ? POST_COMMAND_CHECKS[action] : null,
  });
}

async function publicationWire(app: AppContext, id: number): Promise<PublicationWire | null> {
  const record = await getPublication(app.db, id);
  return record === null ? null : toPublicationWire(record);
}

/** An OnlyFans owner action's state as this post's outcome: OnlyFans' own answer decides. */
function onlyfansOutcome(action: PostAction, state: string, errorCode: string | null): Pick<PostCommandResult, "outcome" | "reason" | "check"> {
  if (state === "confirmed") return { outcome: action === "withdraw" ? "withdrawn" : "deleted", reason: "onlyfans_confirmed_delete", check: null };
  if (state === "rejected") return { outcome: "rejected", reason: errorCode ?? "rejected", check: null };
  if (state === "prepared") return { outcome: "not_sent", reason: "not_dispatched", check: null };
  return { outcome: "unknown", reason: `${action}_${errorCode ?? state}`, check: POST_COMMAND_CHECKS[action] };
}

/** The OnlyFans delete of this post that left (any id: a publication's or this route's), or null. */
async function onlyfansStored(app: AppContext, page: PostCommandPage, postRef: string) {
  return (await listOfapiActionsOfCommand(app, postDeleteCommand(page, postRef))).find((action) => action.state !== "prepared") ?? null;
}

function onlyfansStoredAnswer(
  page: PostCommandPage,
  postRef: string,
  action: PostAction,
  stored: { state: string; errorCode: string | null; createdAt: Date; settledAt: Date | null },
  dailyLimit: PostCommandResult["dailyLimit"],
): PostCommandResult {
  return answer(page, postRef, action, {
    ...onlyfansOutcome(action, stored.state, stored.errorCode), repeat: true, dailyLimit,
    command: { state: stored.state, stateReason: stored.errorCode, createdAt: stored.createdAt.toISOString(), settledAt: stored.settledAt?.toISOString() ?? null },
  });
}

function onlyfansSentAnswer(page: PostCommandPage, postRef: string, action: PostAction, sent: OnlyfansPostSend, dailyLimit: PostCommandResult["dailyLimit"]): PostCommandResult {
  if (sent.kind === "refused") return answer(page, postRef, action, { outcome: "refused", reason: sent.reason, dailyLimit });
  if (sent.kind === "not_sent") return answer(page, postRef, action, { outcome: "not_sent", reason: sent.reason, dailyLimit });
  return answer(page, postRef, action, {
    ...onlyfansOutcome(action, sent.state, sent.errorCode), dailyLimit,
    command: { state: sent.state, stateReason: sent.errorCode, createdAt: sent.createdAt.toISOString(), settledAt: null },
  });
}

// ---------------------------------------------------------------------------
// Withdraw
// ---------------------------------------------------------------------------

/**
 * Take a post of the page off the platform's schedule by its id: a Hub post
 * through its publication's withdrawal; one with no publication by its own
 * command, only once Hub's fresh read of the schedule shows it waiting. Never
 * a delete of a published post.
 */
export async function withdrawPagePost(
  app: AppContext,
  input: { page: PostCommandPage; postRef: string; actor: PostCommandActor } & PostCommandOptions,
): Promise<PostCommandResult> {
  const { page, postRef, actor } = input;
  const now = input.now ?? new Date();
  const isSendable = input.isSendable ?? isFanslyWriteSendable;
  const refused = (reason: string) => answer(page, postRef, "withdraw", { outcome: "refused", reason });

  const publicationId = await findPublicationIdByPlatformPostRef(app.db, { pageId: page.id, postRef });
  if (publicationId !== null) return withdrawPublicationPost(app, page, postRef, publicationId, actor, { now, isSendable });

  // The command this post has already: its state, nothing sent.
  if (page.platform === "fansly") {
    const stored = await findFanslyPostCommand(app.db, { pageId: page.id, step: "post_cancel", postRef });
    if (stored !== null) return fanslyStoredAnswer(app, page, postRef, "withdraw", stored, now, true, null);
  } else {
    const stored = await onlyfansStored(app, page, postRef);
    if (stored !== null) return onlyfansStoredAnswer(page, postRef, "withdraw", stored, null);
  }

  // Hub's own read of THIS page's schedule shows it waiting, and is fresh enough to name it by.
  const { snapshot, entries } = await scheduleEntries(app, page, postRef);
  if (snapshot?.readAt == null) return refused("schedule_not_read_refresh_first");
  if (now.getTime() - snapshot.readAt.getTime() > POST_WITHDRAW_SCHEDULE_MAX_AGE_MINUTES * MINUTE_MS) return refused("schedule_stale_refresh_first");
  if (entries.length === 0) return refused("not_in_schedule");
  if (entries.length > 1) return refused("schedule_ambiguous");
  const publishAtText = entries[0]!.publishAt;
  if (publishAtText === null) return refused("publish_time_unknown");
  const publishAt = new Date(publishAtText);
  if (publishAt.getTime() - now.getTime() < LEAD_MS) return refused("too_close_to_publish_time");
  const settings = await getPagePublishingSettings(app.db, page.id);
  // Stopped (a lost login, a platform check, 401/403/429): nothing may be sent; the schedule stays.
  if (settings.autostoppedAt !== null) return refused("publishing_stopped_schedule_stays");

  if (page.platform === "onlyfans") {
    const sent = await withdrawOnlyfansPost(app, { pageId: page.id, postRef, userId: actor.ownerUserId, publishAt, clock: () => input.now ?? new Date() });
    return onlyfansSentAnswer(page, postRef, "withdraw", sent, null);
  }
  if (!isSendable("publish.post_cancel")) return refused("route_unverified");
  const config = await loadEffectiveConfig(app.db, app.config);
  let queued: FanslyWriteCommandRecord | null;
  try {
    queued = await enqueueFanslyPostCommand(app.db, {
      pageId: page.id, step: "post_cancel", postRef,
      // Never sent closer than 15 minutes to its time (the engine checks the fresh read's time again).
      notBefore: now, notAfter: new Date(publishAt.getTime() - LEAD_MS),
      config, now, isSendable,
    });
  } catch (error) {
    // The guard said no before anything was written (the page stopped, Node, the window).
    if (error instanceof FanslyWriteRefusedError) return refused(error.reason);
    throw error;
  }
  if (queued === null) {
    // Another request queued it a moment ago: that one is the command.
    const stored = await findFanslyPostCommand(app.db, { pageId: page.id, step: "post_cancel", postRef });
    return stored === null ? refused("withdraw_in_progress") : fanslyStoredAnswer(app, page, postRef, "withdraw", stored, now, true, null);
  }
  // The cancel waits for a read of the schedule taken after it: ask for it now.
  await askScheduleRead(app, page.id, now, "post:withdraw");
  return answer(page, postRef, "withdraw", { outcome: "accepted", reason: "schedule_read_then_cancel", command: commandWire(queued) });
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete a published post of the page by its id: a Hub post through the
 * owner's Fansly deletion; one with no publication by its own command — only
 * a post Hub has among the page's own posts, not in its schedule. A daily
 * ceiling per key: the slot is reserved before anything is queued or sent and
 * given back only when Hub refused before any command existed.
 */
export async function deletePagePost(
  app: AppContext,
  input: { page: PostCommandPage; postRef: string; actor: PostCommandActor } & PostCommandOptions,
): Promise<PostCommandResult> {
  const { page, postRef, actor } = input;
  const now = input.now ?? new Date();
  const isSendable = input.isSendable ?? isFanslyWriteSendable;
  const config = await loadEffectiveConfig(app.db, app.config);
  const limit = config.agentPostDeleteDailyLimitPerKey ?? 10;
  const ceiling = async (used?: number) => (limit === 0 ? null : { limit, used: used ?? await countAgentPostDeleteSlots(app.db, { agentKeyId: actor.agentKeyId, now }) });
  const refused = async (reason: string, fields: Partial<Fields> = {}) => answer(page, postRef, "delete", { outcome: "refused", reason, dailyLimit: await ceiling(), ...fields });
  /** The slot, reserved right before the command (refused when the ceiling is reached). */
  const reserve = () => reserveAgentPostDeleteSlot(app.db, { agentKeyId: actor.agentKeyId, pageId: page.id, platform: page.platform, postRef, limit, now });
  const release = (slotId: number, reason: string) => releaseAgentPostDeleteSlot(app.db, { slotId, reason });

  const publicationId = await findPublicationIdByPlatformPostRef(app.db, { pageId: page.id, postRef });
  if (publicationId !== null) {
    const record = await getPublication(app.db, publicationId);
    const publication = record === null ? null : toPublicationWire(record);
    if (page.platform !== "fansly" || publication === null) {
      // Hub has no deletion of an OnlyFans publication's post: the owner deletes it by hand.
      return refused("onlyfans_publication_delete_not_in_hub", { publicationId, publication });
    }
    // Its deletion went (or is under way): the stored state, nothing sent, no slot taken.
    const dispatch = await getPublicationDispatch(app.db, publicationId, "delete");
    const last = dispatch === null ? undefined : (await listFanslyWriteCommandsOfDispatch(app.db, dispatch.id)).filter((command) => command.step === "post_delete").at(-1);
    if (last !== undefined && last.state !== "refused") {
      return answer(page, postRef, "delete", { ...publicationStored("delete", publication), command: commandWire(last), dailyLimit: await ceiling() });
    }
    const slot = await reserve();
    if (!slot.ok) return refused("daily_delete_limit_reached", { publicationId, publication, dailyLimit: { limit, used: slot.used } });
    const result = await deleteFanslyPublication(app, { id: publicationId, userId: actor.ownerUserId, now, isSendable });
    if (result.outcome === "refused") {
      await release(slot.slotId, result.reason ?? "refused");
      if (PUBLICATION_REPEAT_REASONS.has(result.reason ?? "") && result.publication !== null) {
        return answer(page, postRef, "delete", { ...publicationStored("delete", result.publication), dailyLimit: await ceiling() });
      }
      return refused(result.reason ?? "refused", { publicationId, publication: result.publication });
    }
    return answer(page, postRef, "delete", {
      outcome: result.outcome, reason: result.reason, publicationId, publication: result.publication, dailyLimit: { limit, used: slot.used },
    });
  }

  // The command this post has already: its state, nothing sent, no slot taken.
  if (page.platform === "fansly") {
    const stored = await findFanslyPostCommand(app.db, { pageId: page.id, step: "post_delete", postRef });
    if (stored !== null) return fanslyStoredAnswer(app, page, postRef, "delete", stored, now, true, await ceiling());
  } else {
    const stored = await onlyfansStored(app, page, postRef);
    if (stored !== null) return onlyfansStoredAnswer(page, postRef, "delete", stored, await ceiling());
  }

  // Only a post Hub has among THIS page's own posts, out on the wall.
  if (!await pageHasCreatorPost(app.db, { pageId: page.id, postRef })) return refused("post_not_seen_on_page");
  const { entries } = await scheduleEntries(app, page, postRef);
  if (entries.length > 0) return refused("post_in_schedule_use_withdraw");
  const settings = await getPagePublishingSettings(app.db, page.id);
  if (settings.autostoppedAt !== null) return refused("publishing_stopped");
  if (page.platform === "fansly" && !isSendable("publish.post_delete")) return refused("route_unverified");

  const slot = await reserve();
  if (!slot.ok) return refused("daily_delete_limit_reached", { dailyLimit: { limit, used: slot.used } });
  const dailyLimit = limit === 0 ? null : { limit, used: slot.used };

  if (page.platform === "onlyfans") {
    const sent = await sendOnlyfansPostDelete(app, { pageId: page.id, postRef, userId: actor.ownerUserId });
    // Nothing left: the slot goes back.
    if (sent.kind !== "sent") await release(slot.slotId, sent.kind === "refused" ? sent.reason : `not_sent:${sent.reason}`);
    return onlyfansSentAnswer(page, postRef, "delete", sent, sent.kind === "sent" ? dailyLimit : await ceiling());
  }
  let queued: FanslyWriteCommandRecord | null;
  try {
    queued = await enqueueFanslyPostCommand(app.db, {
      pageId: page.id, step: "post_delete", postRef,
      // It goes within 30 minutes or never (then ask again), as the owner's deletion.
      notBefore: now, notAfter: new Date(now.getTime() + FANSLY_DELETE_SEND_WINDOW_MS),
      config, now, isSendable,
    });
  } catch (error) {
    if (error instanceof FanslyWriteRefusedError) {
      await release(slot.slotId, error.reason);
      return refused(error.reason);
    }
    throw error;
  }
  if (queued === null) {
    await release(slot.slotId, "already_queued");
    const stored = await findFanslyPostCommand(app.db, { pageId: page.id, step: "post_delete", postRef });
    return stored === null ? refused("delete_in_progress") : fanslyStoredAnswer(app, page, postRef, "delete", stored, now, true, await ceiling());
  }
  return answer(page, postRef, "delete", { outcome: "accepted", reason: "delete_then_read", command: commandWire(queued), dailyLimit });
}

// ---------------------------------------------------------------------------
// Following (the minutely job)
// ---------------------------------------------------------------------------

/**
 * One minute's share: for each Fansly command of a post with no publication
 * that Fansly answered (or that ended unknown) in the last 35 minutes, ask the
 * read that decides it, if it is not there yet — the schedule after a cancel,
 * the post by its id after a delete. Reads only; the outcome is worked out
 * when the agent asks again.
 */
export async function followFanslyPostCommands(app: AppContext, options: { now?: Date } = {}): Promise<{ followed: number; readsAsked: number }> {
  const now = options.now ?? new Date();
  const report = { followed: 0, readsAsked: 0 };
  for (const command of await listFanslyPostCommandsSettledSince(app.db, new Date(now.getTime() - FOLLOW_WINDOW_MS))) {
    report.followed += 1;
    if ((await fanslyPostCommandStanding(app, command, now)).askedRead) report.readsAsked += 1;
  }
  return report;
}
