import {
  countPagePublicationDispatchesSince,
  getPublication,
  getPublicationRevision,
  insertPublicationDispatch,
  listDueFanslyPublications,
  listFanslyUploadedMedia,
  listFanslyWriteCommandsOfDispatch,
  listSubmittingFanslyPublications,
  transitionPublication,
  type Database,
  type FanslyWriteCommandRecord,
  type FanslyWritePriority,
  type FanslyWriteStep,
  type PublicationDispatchMode,
  type PublicationDispatchRecord,
} from "@agency_hub_core/db";
import { FANSLY_PUBLISH_FACTS_VERIFIED, isFanslyWriteSendable, type FanslyWireId } from "@agency_hub_core/fansly";
import {
  PUBLICATION_BATCH_GAP_MINUTES,
  PUBLICATION_BATCH_SIZE,
  PUBLICATION_POST_NOW_LEAD_MINUTES,
  PUBLICATION_SCHEDULE_HORIZON_DAYS,
  PUBLICATION_START_WINDOW_MINUTES,
  type AppConfig,
  type PublicationKind,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { FANSLY_WRITE_STEP_ROUTES } from "../sync/fansly/publish/commands.ts";
import { FANSLY_SCHEDULE_LEAD_MS, fanslyAttachmentItem, parseApprovedForm, type ApprovedForm } from "../sync/fansly/publish/derive.ts";
import { enqueueFanslyWriteCommand, FanslyWriteRefusedError } from "../sync/fansly/publish/enqueue.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import { verifyApprovedPublication } from "./publications.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

// Wall posts on Fansly (docs/plans/2026-10-23-wall-posts, plan PR 9): every
// minute the worker turns approved Fansly publications into the page's write
// commands — posts into Fansly's own schedule up to 7 days ahead, five per
// page in a row and the next five 10 minutes later; a story at its time, never
// later than 30 minutes after it — and follows each one's chain to its status.
//
// A publication's create is ONE dispatch (`publication_dispatches`, platform
// fansly: the "once" of spec §8.1) and a chain of requests inside it, each a
// command of the page's engine (`fansly_write_commands`, PR 6) with its own
// single attempt: the account media its one vault file becomes (with who sees
// it and the price in mills) or the bundle of its several files (the contract
// §3: the site makes one whenever a post has more than one file), then the
// post (`scheduledFor`, `expiresAt`, its walls as the site picks them,
// `fypFlags`) or the story. A step is queued only once the
// one before it is answered — its request is derived from that answer (PR 6,
// `publish/derive.ts`) — so this job queues the next step each minute.
//
// The publication follows its commands exactly as OnlyFans follows its owner
// action: the post or story answered with its id → "scheduled" (a fresh read
// later says whether it went out); Fansly refused a step → "rejected"; the
// post's or story's own answer lost → "unknown" (never sent again, a person or
// a read decides, spec §8.2); a step before it lost or never sent → "missed":
// the post's request surely never left. A step a switch or a stop held back is
// queued again while its window lasts; the window passed → "missed".
//
// Nothing goes while a route is unverified (`FANSLY_VERIFIED_WRITE_ROUTES`,
// packages/fansly/src/wire/publish.ts — the contract of 2026-10-24 verified
// account media, bundles, the scheduled post, the story and the cancel): such
// a publication stays approved, no dispatch is written. A post goes only into
// Fansly's schedule: one sent now (`scheduledFor: 0`) is not captured, so a
// post closer to its time than `FANSLY_SCHEDULE_LEAD_MS` is missed, never sent
// now.
//
// A new file goes up first (plan PR 8, the contract §2), each its own chain of
// commands inside the dispatch: its upload's create, its parts — one PUT a
// part to the storage the create named, one at a time, each sent once — its
// completion, then reads of the upload by its id until it is done (`status 6`
// and the media id) — the read that also settles a completion whose answer
// was lost. Files go up one after another (the next file's create after the
// completion of the one before); their processing runs on. A part that failed
// or whose answer was lost is the upload that failed: the post never left —
// "missed". A story's files go up ahead of it — its dispatch begins
// `FANSLY_STORY_UPLOAD_LEAD_MINUTES` before its time — and never inside its
// 30-minute window: the upload's requests end at its time.

export const PUBLICATIONS_FANSLY_QUEUE = "publications.fansly";

/** A story with new files begins this long before its time: its files go up
 *  in the background ahead of it, never inside its window (plan PR 8). */
export const FANSLY_STORY_UPLOAD_LEAD_MINUTES = 120;
/** A read of an upload's processing, at most this many (the contract §2: a
 *  photo is done in seconds, a 45 MB video in ~20 s). */
export const FANSLY_UPLOAD_STATUS_MAX_READS = 30;
/** …each at least this long after the one before (the site polls every
 *  2–3 s; the job runs once a minute anyway). */
export const FANSLY_UPLOAD_STATUS_GAP_MS = 5_000;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export async function ensurePublicationsFanslyQueue(boss: QueueCreationClient, createdQueues?: Set<string>) {
  await ensureQueueCreated(boss, PUBLICATIONS_FANSLY_QUEUE, { policy: "exclusive" }, createdQueues);
}

export async function ensurePublicationsFanslySchedule(boss: QueueCreationClient) {
  if (!boss.schedule) return;
  await boss.schedule(PUBLICATIONS_FANSLY_QUEUE, "* * * * *", null, { tz: "UTC" });
}

// ---------------------------------------------------------------------------
// The chain and its windows (pure)
// ---------------------------------------------------------------------------

/** One request of a create's chain: its step and item. */
export interface FanslyChainStep {
  step: FanslyWriteStep;
  item: string;
}

/**
 * The requests of a publication's create, in order (spec §5, the contract
 * §3), once its new files are up (`fanslyUploadItems`): each attachment with
 * files (the post's own, then the extra ones, §12.2) becomes account media
 * when it is one file (with its preview), one bundle when it is several, then
 * the post or the story. A post without files is the post alone. Null: a
 * medium of the form is neither a vault media nor an uploaded file it names
 * whole.
 */
export function fanslyCreateChain(form: Pick<ApprovedForm, "kind" | "media" | "extraAttachments">): FanslyChainStep[] | null {
  if (fanslyUploadItems(form) === null) return null;
  if (form.kind === "story") return [{ step: "account_media", item: "" }, { step: "story", item: "" }];
  const chain: FanslyChainStep[] = [];
  for (const attachment of [0, ...form.extraAttachments.map((extra) => extra.attachment).sort((a, b) => a - b)]) {
    const files = form.media.filter((media) => media.role === "media" && media.attachment === attachment).length;
    if (files === 0) continue;
    chain.push({ step: files > 1 ? "account_media_bundle" : "account_media", item: fanslyAttachmentItem(attachment) });
  }
  return [...chain, { step: "post", item: "" }];
}

/** The new files of a create, uploaded first, in the form's order (`media:N`,
 *  `preview:N`); null: a medium the form does not name whole. Bytes the
 *  page's account already has (`onAccount`, by sha256) are the media they
 *  became and go up no more (the contract §12.7) — unless this dispatch
 *  already began their upload (`begun`, by item). */
export function fanslyUploadItems(
  form: Pick<ApprovedForm, "media">,
  onAccount: ReadonlySet<string> = new Set(),
  begun: ReadonlySet<string> = new Set(),
): string[] | null {
  const items: string[] = [];
  for (const media of form.media) {
    if (media.source === "vault") {
      if (media.mediaRef === null) return null;
      continue;
    }
    if (media.fileId === null || media.fileSha256 === null) return null;
    const item = `${media.role}:${media.position}`;
    if (onAccount.has(media.fileSha256) && !begun.has(item)) continue;
    items.push(item);
  }
  return items;
}

/** The sha256 of a form's new files, to ask which the page's account already has. */
function fileSha256s(form: Pick<ApprovedForm, "media">): string[] {
  return form.media.flatMap((media) => (media.source === "file" && media.fileSha256 !== null ? [media.fileSha256] : []));
}

export type FanslyDispatchPlan =
  | { action: "send"; mode: PublicationDispatchMode }
  | { action: "wait" }
  /** `too_close_to_schedule`: a post whose time came closer than the
   *  schedule's lead, never sent now (the contract §10). */
  | { action: "missed"; reason: "window_passed" | "too_close_to_schedule" };

/**
 * How a due publication goes out at `now` (as on OnlyFans, plan PR 4b): a story
 * at its time, within the start window; a post into Fansly's schedule. A post
 * sent right now (its time minutes away or just passed) is not captured (the
 * contract §10): until it is, a post goes into the schedule only while its
 * time is at least `FANSLY_SCHEDULE_LEAD_MS` ahead, and is missed after —
 * never sent now. Past the window it is missed: it never goes out late.
 */
export function fanslyDispatchPlan(input: { kind: PublicationKind; publishAt: Date; now: Date; immediatePost?: boolean; uploads?: boolean }): FanslyDispatchPlan {
  const untilMs = input.publishAt.getTime() - input.now.getTime();
  if (-untilMs > PUBLICATION_START_WINDOW_MINUTES * MINUTE_MS) return { action: "missed", reason: "window_passed" };
  if (input.kind === "story" && input.uploads === true) {
    // Its files go up ahead of it, never inside its window (plan PR 8).
    if (untilMs > FANSLY_STORY_UPLOAD_LEAD_MINUTES * MINUTE_MS) return { action: "wait" };
    return untilMs > 0 ? { action: "send", mode: "story" } : { action: "missed", reason: "window_passed" };
  }
  if (input.kind === "story") return untilMs > 0 ? { action: "wait" } : { action: "send", mode: "story" };
  if (untilMs > PUBLICATION_SCHEDULE_HORIZON_DAYS * DAY_MS) return { action: "wait" };
  if (!(input.immediatePost ?? FANSLY_PUBLISH_FACTS_VERIFIED.immediatePost)) {
    return untilMs > FANSLY_SCHEDULE_LEAD_MS ? { action: "send", mode: "scheduled" } : { action: "missed", reason: "too_close_to_schedule" };
  }
  return { action: "send", mode: untilMs <= PUBLICATION_POST_NOW_LEAD_MINUTES * MINUTE_MS ? "now" : "scheduled" };
}

/**
 * The window every request of a create is sent in, and its priority (spec
 * §3.5, §8.3): a story's chain is urgent and ends 30 minutes after its time;
 * a post sent now ends there too; a post into Fansly's schedule carries its
 * time as `scheduledFor`, which must stay well ahead — its chain ends
 * `FANSLY_SCHEDULE_LEAD_MS` before it.
 */
export function fanslyCommandWindow(mode: PublicationDispatchMode, publishAt: Date): { notAfter: Date; priority: FanslyWritePriority } {
  if (mode === "scheduled") return { notAfter: new Date(publishAt.getTime() - FANSLY_SCHEDULE_LEAD_MS), priority: "background" };
  const notAfter = new Date(publishAt.getTime() + PUBLICATION_START_WINDOW_MINUTES * MINUTE_MS);
  return { notAfter, priority: mode === "story" ? "urgent" : "background" };
}

/**
 * The window an upload's requests are sent in (plan PR 8): a story's end at
 * its time — its files go up before its window, never in it; a post's are its
 * chain's. Always in the background.
 */
export function fanslyUploadWindow(mode: PublicationDispatchMode, publishAt: Date): { notAfter: Date; priority: FanslyWritePriority } {
  if (mode === "story") return { notAfter: publishAt, priority: "background" };
  return { notAfter: fanslyCommandWindow(mode, publishAt).notAfter, priority: "background" };
}

/** Refusals that say a switch or a stop held the request back, not the
 *  request itself: the step is queued again, while its window lasts, once the
 *  guard lets it (the enqueue refuses before writing anything until then). */
const SWITCH_REFUSAL = /^(publishing_off|page_publishing_off|route_unverified|page_stopped:.*)$/;

/** A step refused this many times for anything else (its request derived
 *  wrong, the browser would not let it go) is given up: the post is missed. */
export const FANSLY_STEP_MAX_REFUSALS = 3;

export type FanslyCreateNext =
  /** Queue this step (the first, the one after an answered step, or again
   *  after a switch held it back). */
  | { kind: "enqueue"; step: FanslyWriteStep; item: string }
  /** Queue these requests of the new files' uploads (`notBefore`: not
   *  before then; null: now). */
  | { kind: "enqueue_uploads"; items: FanslyUploadEnqueue[] }
  /** A step is queued or on the wire. */
  | { kind: "in_flight" }
  | { kind: "settle"; to: "scheduled" | "rejected" | "unknown" | "missed"; reason: string | null; platformPostRef: string | null };

function answeredId(command: FanslyWriteCommandRecord): string | null {
  const value = command.step === "story" ? command.result?.storyId : command.result?.postId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface FanslyUploadEnqueue {
  step: FanslyWriteStep;
  item: string;
  notBefore: Date | null;
}

type Settle = Extract<FanslyCreateNext, { kind: "settle" }>;

const missed = (reason: string): Settle => ({ kind: "settle", to: "missed", reason: reason.slice(0, 300), platformPostRef: null });

/** Where one request of an upload stands: its live row, or what to do when
 *  none is (queue it, or its window passed, or it keeps being refused). */
type StepState =
  | { kind: "answered" | "unknown"; row: FanslyWriteCommandRecord }
  | { kind: "in_flight" }
  | { kind: "enqueue" }
  | { kind: "settle"; next: Settle };

function stepState(step: FanslyWriteStep, item: string, commands: readonly FanslyWriteCommandRecord[], now: Date, notAfter: Date): StepState {
  const rows = commands.filter((command) => command.step === step && command.item === item);
  const live = rows.find((command) => command.state !== "refused");
  if (live !== undefined) {
    switch (live.state) {
      case "queued":
      case "sending":
        return { kind: "in_flight" };
      case "answered":
      case "unknown":
        return { kind: live.state, row: live };
      case "rejected":
        return { kind: "settle", next: { kind: "settle", to: "rejected", reason: `${step}:${live.stateReason ?? "rejected"}`, platformPostRef: null } };
      case "refused":
        break;
    }
  }
  if (rows.some((command) => command.stateReason === "window_passed") || now.getTime() >= notAfter.getTime()) return { kind: "settle", next: missed("window_passed") };
  const counted = rows.filter((command) => !SWITCH_REFUSAL.test(command.stateReason ?? ""));
  if (counted.length >= FANSLY_STEP_MAX_REFUSALS) return { kind: "settle", next: missed(`not_sent:${step}:${counted.at(-1)?.stateReason ?? "refused"}`) };
  return { kind: "enqueue" };
}

type UploadNext =
  | { kind: "done" }
  /** Its create, parts or completion are queued or due (the next file waits). */
  | { kind: "blocking"; items: FanslyUploadEnqueue[] }
  /** Its bytes went; its processing is read until it is done. */
  | { kind: "processing"; items: FanslyUploadEnqueue[] }
  | Settle;

/** One new file's upload (the contract §2): create → parts in order → complete → reads until done. */
function uploadNext(item: string, commands: readonly FanslyWriteCommandRecord[], now: Date, notAfter: Date): UploadNext {
  const enqueue = (step: FanslyWriteStep, at: string, notBefore: Date | null = null): FanslyUploadEnqueue => ({ step, item: at, notBefore });
  const create = stepState("upload_create", item, commands, now, notAfter);
  switch (create.kind) {
    case "in_flight":
      return { kind: "blocking", items: [] };
    case "enqueue":
      return { kind: "blocking", items: [enqueue("upload_create", item)] };
    case "settle":
      return create.next;
    case "unknown":
      // No upload id to read it by: nothing of the post went.
      return missed(`not_sent:upload_create_unknown:${create.row.stateReason ?? "unknown"}`);
    case "answered":
      break;
  }
  const partCount = create.row.result?.partCount;
  if (typeof partCount !== "number" || !Number.isSafeInteger(partCount) || partCount < 1) return missed("not_sent:upload_create_without_parts");
  const parts: FanslyUploadEnqueue[] = [];
  let pending = false;
  for (let index = 0; index < partCount; index += 1) {
    const part = stepState("upload_part", `${item}/part:${index}`, commands, now, notAfter);
    switch (part.kind) {
      case "answered":
        continue;
      case "unknown":
        // A part is sent once: one that may or may not have reached the
        // storage is the upload that failed.
        return missed(`not_sent:upload_part_unknown:${part.row.stateReason ?? "unknown"}`);
      case "settle":
        return part.next;
      case "in_flight":
        pending = true;
        continue;
      case "enqueue":
        // Every part is queued at once; each goes after the one before it.
        parts.push(enqueue("upload_part", `${item}/part:${index}`));
        pending = true;
        continue;
    }
  }
  if (pending) return { kind: "blocking", items: parts };
  const complete = stepState("upload_complete", item, commands, now, notAfter);
  switch (complete.kind) {
    case "in_flight":
      return { kind: "blocking", items: [] };
    case "enqueue":
      return { kind: "blocking", items: [enqueue("upload_complete", item)] };
    case "settle":
      return complete.next;
    case "answered":
    case "unknown":
      // Its answer lost: the reads of the upload by its id say whether it
      // completed (the contract §2), never a completion sent again.
      break;
  }
  const reads = commands.filter((command) => command.step === "upload_status" && command.item.startsWith(`${item}/poll:`));
  if (reads.some((read) => read.state === "answered" && read.result?.done === true && typeof read.result.mediaId === "string")) return { kind: "done" };
  const live = reads.filter((read) => read.state !== "refused");
  if (live.some((read) => read.state === "queued" || read.state === "sending")) return { kind: "processing", items: [] };
  // A completion Fansly answered 500 (the contract §12.7: so it answers bytes
  // the account already has, on every try): once a read says the upload is
  // not done, it never will be — nothing of the post went.
  if (complete.kind === "unknown" && complete.row.httpStatus === 500 && live.some((read) => read.state === "answered")) {
    return missed("not_sent:upload_complete_500");
  }
  const lost = complete.kind === "unknown" ? `not_sent:upload_complete_unknown:${complete.row.stateReason ?? "unknown"}` : null;
  if (now.getTime() >= notAfter.getTime()) return missed(lost ?? "window_passed");
  if (live.length >= FANSLY_UPLOAD_STATUS_MAX_READS) return missed(lost ?? "not_sent:upload_processing_not_done");
  const refused = reads.filter((read) => read.state === "refused" && !SWITCH_REFUSAL.test(read.stateReason ?? ""));
  if (refused.length >= FANSLY_STEP_MAX_REFUSALS) return missed(`not_sent:upload_status:${refused.at(-1)?.stateReason ?? "refused"}`);
  const last = Math.max(complete.row.settledAt?.getTime() ?? now.getTime(), ...live.map((read) => read.settledAt?.getTime() ?? 0));
  return { kind: "processing", items: [enqueue("upload_status", `${item}/poll:${live.length}`, new Date(last + FANSLY_UPLOAD_STATUS_GAP_MS))] };
}

/**
 * Where a create's chain stands, from its commands (every row of the dispatch,
 * refused ones too). One live row per step and item at most (the table's
 * unique index). The new files' uploads come first (`uploads`, within
 * `uploadNotAfter`), then the chain's steps.
 */
export function fanslyCreateNext(input: {
  chain: readonly FanslyChainStep[];
  commands: readonly FanslyWriteCommandRecord[];
  now: Date;
  notAfter: Date;
  uploads?: readonly string[];
  uploadNotAfter?: Date;
}): FanslyCreateNext {
  const items: FanslyUploadEnqueue[] = [];
  let uploading = false;
  for (const item of input.uploads ?? []) {
    const next = uploadNext(item, input.commands, input.now, input.uploadNotAfter ?? input.notAfter);
    if (next.kind === "settle") return next;
    if (next.kind === "done") continue;
    items.push(...next.items);
    uploading = true;
    // One file's bytes at a time: the next one's create after this one's completion.
    if (next.kind === "blocking") break;
  }
  if (uploading) return items.length > 0 ? { kind: "enqueue_uploads", items } : { kind: "in_flight" };
  for (const [index, { step, item }] of input.chain.entries()) {
    const last = index === input.chain.length - 1;
    const rows = input.commands.filter((command) => command.step === step && command.item === item);
    const live = rows.find((command) => command.state !== "refused");
    if (live !== undefined) {
      switch (live.state) {
        case "queued":
        case "sending":
          return { kind: "in_flight" };
        case "answered": {
          if (!last) continue;
          const ref = answeredId(live);
          // The apply answers a post or story only with its id: anything else
          // is no proof of what Fansly made of it.
          return ref === null
            ? { kind: "settle", to: "unknown", reason: `${step}:answer_without_id`, platformPostRef: null }
            : { kind: "settle", to: "scheduled", reason: null, platformPostRef: ref };
        }
        case "rejected":
          return { kind: "settle", to: "rejected", reason: `${step}:${live.stateReason ?? "rejected"}`, platformPostRef: null };
        case "unknown":
          // The post or story itself may have gone: a person or a read
          // decides. A step before it: the post was never sent.
          return last
            ? { kind: "settle", to: "unknown", reason: `${step}:${live.stateReason ?? "unknown"}`, platformPostRef: null }
            : { kind: "settle", to: "missed", reason: `not_sent:${step}_unknown:${live.stateReason ?? "unknown"}`, platformPostRef: null };
        case "refused":
          break;
      }
    }
    // Nothing of this step is queued or went: queue it, unless its window
    // passed or it keeps being refused.
    if (rows.some((command) => command.stateReason === "window_passed") || input.now.getTime() >= input.notAfter.getTime()) {
      return { kind: "settle", to: "missed", reason: "window_passed", platformPostRef: null };
    }
    const counted = rows.filter((command) => !SWITCH_REFUSAL.test(command.stateReason ?? ""));
    if (counted.length >= FANSLY_STEP_MAX_REFUSALS) {
      return { kind: "settle", to: "missed", reason: `not_sent:${step}:${counted.at(-1)?.stateReason ?? "refused"}`.slice(0, 300), platformPostRef: null };
    }
    return { kind: "enqueue", step, item };
  }
  return { kind: "in_flight" };
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export interface FanslyPublishingReport {
  sending: boolean;
  /** Creates begun this minute (a dispatch and its first request). */
  dispatched: number;
  /** Later steps queued this minute. */
  queued: number;
  settled: number;
  missed: number;
  returnedToDraft: number;
  /** Due publications left approved because a route of their chain is not
   *  verified (`FANSLY_VERIFIED_WRITE_ROUTES`): nothing was written. */
  routesUnverified: number;
  /** Creates the enqueue's guard refused before anything was written. */
  refused: number;
}

export interface FanslyPublishingOptions {
  now?: Date;
  /** Whether a route's contract is verified (default `isFanslyWriteSendable`,
   *  the one list); integration tests pass their own. */
  isSendable?: (spec: FanslyWireId) => boolean;
}

/** One minute's work: follow every create in flight (always), then begin the due ones (when the global switch is on). */
export async function runFanslyPublishingTick(app: AppContext, options: FanslyPublishingOptions = {}): Promise<FanslyPublishingReport> {
  const now = options.now ?? new Date();
  const isSendable = options.isSendable ?? isFanslyWriteSendable;
  const config = await loadEffectiveConfig(app.db, app.config);
  const sending = config.publishingEnabled === true;
  const report: FanslyPublishingReport = {
    sending, dispatched: 0, queued: 0, settled: 0, missed: 0, returnedToDraft: 0, routesUnverified: 0, refused: 0,
  };

  // One create of a page at a time, as a person makes posts one after another.
  const busyPages = new Set<number>();
  for (const item of await listSubmittingFanslyPublications(app.db)) {
    const state = await followCreate(app, item.publicationId, item.dispatch, { now, config, isSendable }, report);
    if (state === "in_flight") busyPages.add(item.pageId);
  }
  if (!sending) return report;

  const due = await listDueFanslyPublications(app.db, {
    now,
    postsUntil: new Date(now.getTime() + PUBLICATION_SCHEDULE_HORIZON_DAYS * DAY_MS),
    // A story with new files begins ahead of its time (its files go up first).
    storiesUntil: new Date(now.getTime() + FANSLY_STORY_UPLOAD_LEAD_MINUTES * MINUTE_MS),
  });
  for (const candidate of due) {
    if (busyPages.has(candidate.pageId)) continue;
    const uploads = candidate.kind === "story" && candidate.publishAt.getTime() > now.getTime() ? await hasUploads(app, candidate.id) : undefined;
    const plan = fanslyDispatchPlan({ kind: candidate.kind, publishAt: candidate.publishAt, now, ...(uploads === undefined ? {} : { uploads }) });
    if (plan.action === "wait") continue;
    if (plan.action === "missed") {
      if (await transitionPublication(app.db, {
        id: candidate.id, from: "approved", to: "missed", actor: { kind: "hub" }, reason: plan.reason,
      })) report.missed += 1;
      continue;
    }
    const recent = await countPagePublicationDispatchesSince(app.db, candidate.pageId, new Date(now.getTime() - PUBLICATION_BATCH_GAP_MINUTES * MINUTE_MS));
    if (recent >= PUBLICATION_BATCH_SIZE) {
      busyPages.add(candidate.pageId);
      continue;
    }
    const result = await beginCreate(app, candidate.id, plan.mode, { now, config, isSendable }, report);
    if (result === "dispatched") busyPages.add(candidate.pageId);
  }
  return report;
}

/** The requests of a new file's upload (plan PR 8). */
const FANSLY_UPLOAD_STEPS: readonly FanslyWriteStep[] = ["upload_create", "upload_part", "upload_complete", "upload_status"];

/** When a create's own steps may go: a story's at its time (its files went
 *  up before), a post's now. */
function publishNotBefore(mode: PublicationDispatchMode, publishAt: Date, now: Date): Date {
  return mode === "story" && publishAt.getTime() > now.getTime() ? publishAt : now;
}

/** Whether an approved publication's form has new files to upload. */
async function hasUploads(app: AppContext, publicationId: number): Promise<boolean> {
  const record = await getPublication(app.db, publicationId);
  const revision = record?.approvedRevisionId == null ? null : await getPublicationRevision(app.db, record.approvedRevisionId);
  const form = revision === null ? null : parseApprovedForm(revision.form);
  return form !== null && (fanslyUploadItems(form)?.length ?? 0) > 0;
}

interface TickContext {
  now: Date;
  config: Pick<AppConfig, "publishingEnabled">;
  isSendable: (spec: FanslyWireId) => boolean;
}

class PublicationMovedError extends Error {}

/**
 * Begin one approved publication's create: what the person approved must
 * still be exactly what goes (spec §3.3); every route of its chain verified;
 * then, in one transaction, its dispatch, "submitting", and its first request
 * queued — or nothing at all.
 */
async function beginCreate(
  app: AppContext,
  publicationId: number,
  mode: PublicationDispatchMode,
  ctx: TickContext,
  report: FanslyPublishingReport,
): Promise<"dispatched" | "returned" | "unverified" | "refused" | "raced"> {
  const check = await verifyApprovedPublication(app.db, publicationId);
  if (!check.ok) {
    report.returnedToDraft += check.reason === "not_approved" ? 0 : 1;
    return "returned";
  }
  const record = check.record;
  const revisionId = record.approvedRevisionId as number;
  const revision = await getPublicationRevision(app.db, revisionId);
  const form = revision === null ? null : parseApprovedForm(revision.form);
  if (form === null) return "raced";
  const chain = fanslyCreateChain(form);
  const onAccount = new Set((await listFanslyUploadedMedia(app.db, record.pageId, fileSha256s(form))).map((media) => media.sha256));
  const uploads = fanslyUploadItems(form, onAccount);
  if (chain === null || uploads === null) {
    // A medium the form does not name whole: it never goes.
    if (await transitionPublication(app.db, {
      id: record.id, from: "approved", to: "draft", actor: { kind: "hub" }, clearApproval: true, reason: "approval_form_unreadable",
    })) report.returnedToDraft += 1;
    return "returned";
  }
  const steps = [...chain.map((link) => link.step), ...(uploads.length > 0 ? FANSLY_UPLOAD_STEPS : [])];
  if (!steps.every((step) => ctx.isSendable(FANSLY_WRITE_STEP_ROUTES[step]))) {
    report.routesUnverified += 1;
    return "unverified";
  }
  // The first request: the first file's upload, or the chain's first step.
  const window = uploads.length > 0 ? fanslyUploadWindow(mode, record.publishAt) : fanslyCommandWindow(mode, record.publishAt);
  const first = uploads.length > 0 ? { step: "upload_create" as const, item: uploads[0]! } : chain[0]!;
  const notBefore = uploads.length === 0 ? publishNotBefore(mode, record.publishAt, ctx.now) : ctx.now;
  if (ctx.now.getTime() >= window.notAfter.getTime()) return "raced";
  const outcome = await app.db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const dispatch = await insertPublicationDispatch(tx, {
      publicationId: record.id, revisionId, kind: "create", platform: "fansly", ofapiActionIntentId: null, mode,
    });
    if (dispatch === null) return "raced" as const;
    if (!await transitionPublication(tx, { id: record.id, from: "approved", to: "submitting", actor: { kind: "hub" } })) {
      throw new PublicationMovedError();
    }
    await enqueueFanslyWriteCommand(tx, {
      dispatchId: dispatch.id, step: first.step, item: first.item, priority: window.priority,
      notBefore, notAfter: window.notAfter, config: ctx.config, now: ctx.now, isSendable: ctx.isSendable,
    });
    return "dispatched" as const;
  }).catch((error: unknown) => {
    // Cancelled or edited between the check and now, or the guard said no:
    // the transaction rolled back, nothing was written.
    if (error instanceof PublicationMovedError) return "raced" as const;
    if (error instanceof FanslyWriteRefusedError) return "refused" as const;
    throw error;
  });
  if (outcome === "dispatched") report.dispatched += 1;
  if (outcome === "refused") report.refused += 1;
  return outcome;
}

/** Follow one create in flight: queue its next step, or settle the publication from its commands. */
async function followCreate(
  app: AppContext,
  publicationId: number,
  dispatch: PublicationDispatchRecord,
  ctx: TickContext,
  report: FanslyPublishingReport,
): Promise<"in_flight" | "settled"> {
  const record = await getPublication(app.db, publicationId);
  if (record === null || record.status !== "submitting") return "settled";
  const [revision, commands] = await Promise.all([
    getPublicationRevision(app.db, dispatch.revisionId),
    listFanslyWriteCommandsOfDispatch(app.db, dispatch.id),
  ]);
  const form = revision === null ? null : parseApprovedForm(revision.form);
  const chain = form === null ? null : fanslyCreateChain(form);
  const onAccount = form === null ? new Set<string>() : new Set((await listFanslyUploadedMedia(app.db, record.pageId, fileSha256s(form))).map((media) => media.sha256));
  const begun = new Set(commands.filter((command) => command.step === "upload_create" && command.state !== "refused").map((command) => command.item));
  const uploads = form === null ? null : fanslyUploadItems(form, onAccount, begun);
  const window = fanslyCommandWindow(dispatch.mode, record.publishAt);
  const uploadWindow = fanslyUploadWindow(dispatch.mode, record.publishAt);
  const next: FanslyCreateNext = chain === null || uploads === null
    // Never dispatched so: a request that may have left is a person's to
    // decide; none did — nothing went.
    ? commands.some((command) => command.state !== "queued" && command.state !== "refused")
      ? { kind: "settle", to: "unknown", reason: "approval_form_unreadable", platformPostRef: null }
      : { kind: "settle", to: "missed", reason: "not_sent:approval_form_unreadable", platformPostRef: null }
    : fanslyCreateNext({ chain, commands, now: ctx.now, notAfter: window.notAfter, uploads, uploadNotAfter: uploadWindow.notAfter });
  if (next.kind === "in_flight") return "in_flight";
  const queue = async (input: { step: FanslyWriteStep; item: string; notBefore: Date; window: { notAfter: Date; priority: FanslyWritePriority } }): Promise<"queued" | "held" | "window_passed"> => {
    try {
      const queued = await enqueueFanslyWriteCommand(app.db, {
        dispatchId: dispatch.id, step: input.step, item: input.item, priority: input.window.priority,
        notBefore: input.notBefore, notAfter: input.window.notAfter, config: ctx.config, now: ctx.now, isSendable: ctx.isSendable,
      });
      if (queued !== null) report.queued += 1;
      return "queued";
    } catch (error) {
      if (!(error instanceof FanslyWriteRefusedError)) throw error;
      // A switch is off or the page stopped: it waits inside its window.
      return error.reason === "window_passed" ? "window_passed" : "held";
    }
  };
  const windowPassed = () => settle(app, record.id, { kind: "settle", to: "missed", reason: "window_passed", platformPostRef: null }, report);
  if (next.kind === "enqueue") {
    const queued = await queue({ step: next.step, item: next.item, notBefore: publishNotBefore(dispatch.mode, record.publishAt, ctx.now), window });
    return queued === "window_passed" ? windowPassed() : "in_flight";
  }
  if (next.kind === "enqueue_uploads") {
    for (const item of next.items) {
      const queued = await queue({ step: item.step, item: item.item, notBefore: item.notBefore === null || item.notBefore < ctx.now ? ctx.now : item.notBefore, window: uploadWindow });
      if (queued === "window_passed") return windowPassed();
      if (queued === "held") break;
    }
    return "in_flight";
  }
  return settle(app, record.id, next, report);
}

async function settle(
  app: AppContext,
  publicationId: number,
  next: Extract<FanslyCreateNext, { kind: "settle" }>,
  report: FanslyPublishingReport,
): Promise<"settled"> {
  const moved = await transitionPublication(app.db, {
    id: publicationId, from: "submitting", to: next.to, actor: { kind: "hub" }, reason: next.reason,
    ...(next.platformPostRef === null ? {} : { platformPostRef: next.platformPostRef }),
  }).catch((error: unknown) => {
    // publications_page_platform_post_uidx: the id Fansly answered is already
    // another publication's. The publication waits for a person or a read.
    if ((error as { code?: string }).code !== "23505") throw error;
    return transitionPublication(app.db, {
      id: publicationId, from: "submitting", to: "unknown", actor: { kind: "hub" },
      reason: `answered_id_claimed:${next.platformPostRef ?? ""}`.slice(0, 300),
    });
  });
  if (moved) {
    report.settled += 1;
    if (next.to === "missed") report.missed += 1;
  }
  return "settled";
}
