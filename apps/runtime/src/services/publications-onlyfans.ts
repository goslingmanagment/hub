import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import type { OfapiAction } from "@agency_hub_core/contracts";
import {
  autostopPagePublishing,
  countPagePublicationDispatchesSince,
  countPlatformPublicationDispatchesSince,
  getPagePublishingSettings,
  getPublication,
  getPublicationDispatch,
  getPublicationFiles,
  getPublicationRevision,
  insertPublicationDispatch,
  insertPublicationUpload,
  listDueOnlyfansPublications,
  listOnlyfansPublicationsForUpload,
  listOnlyfansPublicationsWithUploads,
  listPublicationUploads,
  listSubmittingOnlyfansPublications,
  notePublicationHeld,
  sumPublicationUploadCreditsSince,
  transitionPublication,
  type Database,
  type PublicationDispatchMode,
  type PublicationMediaItem,
  type PublicationRecord,
  type PublicationRevisionRecord,
  type PublicationUploadRecord,
} from "@agency_hub_core/db";
import {
  ONLYFANS_STORY_UPLOAD_LEAD_MINUTES,
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
import { BadRequestError } from "./errors.ts";
import { notifyPublishingStoppedIncident } from "./notification-incidents.ts";
import { cancelOfapiAction, dispatchOfapiAction, getOfapiAction, prepareOfapiAction } from "./ofapi-actions.ts";
import { capturePublicationFileOfapiSource, createOwnerOfapiMediaUpload } from "./ofapi-media-sources.ts";
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

function stableUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The action id of a publication's command: one per publication, approval and kind, so a retry after a crash finds the same prepared action. */
export function publicationActionId(publicationId: number, revisionId: number, kind: "create" | "withdraw"): string {
  return stableUuid(`publication:${publicationId}:revision:${revisionId}:${kind}`);
}

/** The upload request of one new file of one approval (plan PR 4c): a retry finds the same upload, a new approval makes a new one. */
export function publicationUploadRequestId(publicationId: number, revisionId: number, role: string, position: number): string {
  return stableUuid(`publication:${publicationId}:revision:${revisionId}:upload:${role}:${position}`);
}

/** OnlyFansAPI's documented upload tariff: 3 credits per started MB (as the owner's own uploads estimate it). */
export function onlyfansUploadCredits(byteSize: number): number {
  return Math.max(1, Math.ceil((byteSize * 3) / 1_000_000));
}

const fileKey = (item: Pick<PublicationMediaItem, "role" | "position">) => `${item.role}:${item.position}`;
/** Upload stops the owner can resume (the collection policy paused it): the post waits, nothing failed. */
const RESUMABLE_UPLOAD_STOPS = new Set(["background_paused", "job_unavailable", "collection_off", "on_demand_only"]);

export type OnlyfansUploadReadiness =
  | { state: "ready"; tokens: ReadonlyMap<string, string> }
  | { state: "waiting"; reason: string }
  | { state: "failed"; reason: string };

/**
 * Where the new files of one approval stand (plan PR 4c): every upload done
 * with its one-use id → ready; one failed, refused or left without an answer
 * → failed (never sent again: a person approves again, which uploads anew);
 * otherwise waiting.
 */
export function onlyfansUploadReadiness(record: Pick<PublicationRecord, "media">, uploads: readonly PublicationUploadRecord[]): OnlyfansUploadReadiness {
  const tokens = new Map<string, string>();
  for (const item of record.media.filter((media) => media.source === "file")) {
    const upload = uploads.find((candidate) => candidate.role === item.role && candidate.position === item.position);
    if (!upload) return { state: "waiting", reason: "upload_not_started" };
    if (upload.jobState === "complete" && upload.uploadStatus === "completed" && /^ofapi_media_[A-Za-z0-9_-]{1,128}$/.test(upload.mediaRef ?? "")) {
      tokens.set(fileKey(item), upload.mediaRef as string);
      continue;
    }
    if (upload.jobState === "blocked" && RESUMABLE_UPLOAD_STOPS.has(upload.jobReason ?? "")) {
      return { state: "waiting", reason: `upload_paused:${upload.jobReason}` };
    }
    if (upload.jobState === null || upload.jobState === "blocked" || upload.jobState === "failed" || upload.jobState === "complete") {
      return { state: "failed", reason: `upload_${upload.jobReason ?? upload.uploadStatus ?? upload.jobState ?? "missing"}` };
    }
    return { state: "waiting", reason: "uploading" };
  }
  return { state: "ready", tokens };
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

/**
 * The OnlyFansAPI owner action for an approved publication: vault media by
 * their reusable ids (spec §6), new files by the one-use ids their uploads
 * returned (plan PR 4c).
 */
export function onlyfansCommandFor(record: PublicationRecord, mode: PublicationDispatchMode, uploaded: ReadonlyMap<string, string> = new Map()): OfapiAction {
  // Never a free post of what was approved with a price, nor one file set of
  // several attachments: OnlyFans' command here carries neither (spec §6).
  if (record.priceMills !== null) throw new BadRequestError(`publication ${record.id}: an OnlyFans post with a price is not sent until its price at creation is verified`);
  if (record.extraAttachments.length > 0 || record.media.some((item) => item.attachment > 0)) {
    throw new BadRequestError(`publication ${record.id}: extra attachments are a Fansly post's`);
  }
  const refs = (role: "media" | "preview") => record.media
    .filter((item) => item.role === role)
    .sort((a, b) => a.position - b.position)
    .map((item) => {
      if (item.source === "vault" && item.platformMediaRef !== null) return item.platformMediaRef;
      const token = item.source === "file" ? uploaded.get(fileKey(item)) : undefined;
      if (token === undefined) throw new Error(`publication ${record.id}: ${fileKey(item)} has no uploaded OnlyFans id`);
      return token;
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
  /** New files whose upload to OnlyFans started this minute. */
  uploadsStarted: number;
  /** Publications waiting for their files' uploads. */
  waitingForUploads: number;
  settled: number;
  missed: number;
  returnedToDraft: number;
  /** Pages stopped this minute (autostop): nothing more goes for them, even from a list read before. */
  stoppedPageIds: number[];
  /** Sends held back this minute (the page's account, an erasure, a lock, media not ready): still approved. */
  held: number;
}

/** Thrown by the binding check when the page's OnlyFans account is gone (or rebound). */
const ACCOUNT_GONE = "ofapi_account_not_found_or_binding_changed";

/** A refusal of the publication itself — its command does not hold — not of
 *  the page, its account binding, an erasure or a lock: only then does the
 *  person look at it again. */
function refusedForItsContent(error: unknown): boolean {
  return error instanceof BadRequestError || (error instanceof Error && error.name === "ZodError");
}

/** One minute's work: settle what is in flight (always), then send what is due (when every switch is on). */
export async function runOnlyfansPublishingTick(app: AppContext, now = new Date()): Promise<OnlyfansPublishingReport> {
  const config = await loadEffectiveConfig(app.db, app.config);
  const sending = config.publishingEnabled === true && config.publishingOnlyfansEnabled === true;
  const report: OnlyfansPublishingReport = { sending, sent: 0, uploadsStarted: 0, waitingForUploads: 0, settled: 0, missed: 0, returnedToDraft: 0, stoppedPageIds: [], held: 0 };

  const busyPages = new Set<number>();
  for (const item of await listSubmittingOnlyfansPublications(app.db)) {
    const retry = sending && item.pageEnabled && !report.stoppedPageIds.includes(item.pageId);
    const state = await settleOne(app, item.publicationId, now, retry, report);
    if (state === "in_flight") busyPages.add(item.pageId);
  }
  if (!sending) return report;

  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // A post or story is 1 credit; a new file's upload its byte tariff (plan PR 4c).
  let creditsUsed = await countPlatformPublicationDispatchesSince(app.db, "onlyfans", dayStart)
    + await sumPublicationUploadCreditsSince(app.db, dayStart);
  const creditLimit = config.publishingOnlyfansDailyCredits ?? 50;
  // A publication whose files started going up keeps 1 credit for its own
  // create: uploads paid for never leave their post without the credit to go.
  const keptForCreate = new Set(await listOnlyfansPublicationsWithUploads(app.db));

  // New files go up first: a post's when it enters the schedule's 7 days, a
  // story's an hour before its time. Each upload is sent once by the media
  // sweep (ofapi-media-worker.ts); the post waits until all its files are up.
  for (const candidate of await listOnlyfansPublicationsForUpload(app.db, {
    postsUntil: new Date(now.getTime() + PUBLICATION_SCHEDULE_HORIZON_DAYS * DAY_MS),
    storiesUntil: new Date(now.getTime() + ONLYFANS_STORY_UPLOAD_LEAD_MINUTES * MINUTE_MS),
  })) {
    if (report.stoppedPageIds.includes(candidate.pageId)) continue;
    creditsUsed += await startUploads(app, candidate.id, creditLimit - creditsUsed - keptForCreate.size, creditLimit, keptForCreate, report);
  }
  const due = await listDueOnlyfansPublications(app.db, {
    now, postsUntil: new Date(now.getTime() + PUBLICATION_SCHEDULE_HORIZON_DAYS * DAY_MS),
  });
  for (const candidate of due) {
    if (busyPages.has(candidate.pageId) || report.stoppedPageIds.includes(candidate.pageId)) continue;
    const plan = onlyfansDispatchPlan({ kind: candidate.kind, publishAt: candidate.publishAt, now });
    if (plan.action === "wait") continue;
    if (plan.action === "missed") {
      // A send held back until its window passed says what held it.
      const held = (await getPublication(app.db, candidate.id))?.statusReason ?? null;
      const reason = held?.startsWith("held: ") ? `window_passed after ${held}`.slice(0, 300) : "window_passed";
      if (await transitionPublication(app.db, {
        id: candidate.id, from: "approved", to: "missed", actor: { kind: "hub" }, reason,
      })) report.missed += 1;
      keptForCreate.delete(candidate.id);
      continue;
    }
    const recent = await countPagePublicationDispatchesSince(app.db, candidate.pageId, new Date(now.getTime() - PUBLICATION_BATCH_GAP_MINUTES * MINUTE_MS));
    if (recent >= PUBLICATION_BATCH_SIZE) {
      busyPages.add(candidate.pageId);
      continue;
    }
    if (creditsUsed >= creditLimit) break;
    // A send without a kept credit takes only a credit no post with uploads is owed.
    if (!keptForCreate.has(candidate.id) && creditsUsed + keptForCreate.size >= creditLimit) continue;
    const result = await sendOne(app, candidate.id, plan.mode, { kind: candidate.kind, publishAt: candidate.publishAt }, now, report);
    // Still approved (its files still going up, held): it keeps its credit.
    if (result !== "waiting" && result !== "held") keptForCreate.delete(candidate.id);
    if (result === "sent") {
      creditsUsed += 1;
      report.sent += 1;
    }
    if (result === "in_flight") {
      creditsUsed += 1;
      report.sent += 1;
      busyPages.add(candidate.pageId);
    }
    // Held back this minute (its media not ready, a lock): the page's others
    // still go; a gone account stopped the page in `holdPage`.
  }
  return report;
}

type SendResult = "sent" | "in_flight" | "returned" | "raced" | "waiting" | "held";

/**
 * Start the uploads an approved publication's new files still lack, only when
 * all of them and its own create fit `creditsLeft` (what nothing is kept
 * for): the create's credit is kept from the first upload on, in
 * `keptForCreate`. Returns the credits the started uploads may spend. A file
 * OnlyFansAPI cannot take returns the publication to draft with the reason.
 */
async function startUploads(
  app: AppContext,
  publicationId: number,
  creditsLeft: number,
  dailyCredits: number,
  keptForCreate: Set<number>,
  report: OnlyfansPublishingReport,
): Promise<number> {
  const check = await verifyApprovedPublication(app.db, publicationId);
  if (!check.ok) {
    report.returnedToDraft += check.reason === "not_approved" ? 0 : 1;
    return 0;
  }
  const { record } = check;
  const revision = await getPublicationRevision(app.db, record.approvedRevisionId as number);
  if (!revision) return 0;
  const uploads = await listPublicationUploads(app.db, record.id, revision.id);
  const missing = record.media.filter((item) => item.source === "file"
    && !uploads.some((upload) => upload.role === item.role && upload.position === item.position));
  if (missing.length === 0) return 0;
  const files = new Map((await getPublicationFiles(app.db, missing.map((item) => item.fileId as number))).map((file) => [file.id, file]));
  const costs = missing.map((item) => onlyfansUploadCredits(files.get(item.fileId as number)?.byteSize ?? 1));
  const wholeCost = costs.reduce((sum, credits) => sum + credits, keptForCreate.has(record.id) ? 0 : 1);
  // A post whose new files and own create cost more than a whole day allows
  // never goes up: the person sees why now, not a "missed" at its time (3
  // credits a MB). A ceiling of 0 is a pause, not a price: everything waits then.
  if (dailyCredits > 0 && wholeCost > dailyCredits) {
    if (await transitionPublication(app.db, {
      id: record.id, from: "approved", to: "draft", actor: { kind: "hub" }, clearApproval: true,
      reason: `upload_over_daily_credits: its new files' uploads and its create cost ${wholeCost} credits, the day allows ${dailyCredits}`,
    })) report.returnedToDraft += 1;
    return 0;
  }
  // All its files and its create today, or none of them yet.
  if (wholeCost > creditsLeft) return 0;
  let spent = 0;
  for (const [index, item] of missing.entries()) {
    const credits = costs[index] as number;
    try {
      await startUpload(app, record, revision, item, credits);
      spent += credits;
      keptForCreate.add(record.id);
      report.uploadsStarted += 1;
    } catch (error) {
      if (!refusedForItsContent(error)) {
        await holdPage(app, record, error, report);
        break;
      }
      // Refused before anything left for the bytes or their type: the person looks again.
      await transitionPublication(app.db, {
        id: record.id, from: "approved", to: "draft", actor: { kind: "hub" }, clearApproval: true,
        reason: `upload_refused: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
      });
      keptForCreate.delete(record.id);
      report.returnedToDraft += 1;
      break;
    }
  }
  return spent;
}

async function startUpload(app: AppContext, record: PublicationRecord, revision: PublicationRevisionRecord, item: PublicationMediaItem, credits: number) {
  const actorUserId = revision.approvedByUserId;
  const source = await capturePublicationFileOfapiSource(app, { pageId: record.pageId, fileId: item.fileId as number, actorUserId });
  const policy = (await app.db.execute<{ revision: number }>(sql`select revision from ofapi_collection_state where id=1`)).rows[0];
  // The upload job is keyed by its request id: a crash between here and the
  // record below finds the same job, never a second upload.
  const job = await createOwnerOfapiMediaUpload(app, {
    pageId: record.pageId, sourceId: source.id, destination: "cdn",
    requestId: publicationUploadRequestId(record.id, revision.id, item.role, item.position),
    expectedPolicyRevision: Number(policy?.revision ?? 0), maxCredits: credits, dryRun: false,
  }, actorUserId);
  if (!job.jobId) throw new Error("the upload was not recorded");
  await insertPublicationUpload(app.db, {
    publicationId: record.id, revisionId: revision.id, role: item.role, position: item.position,
    fileId: item.fileId as number, ofapiMediaSourceId: source.id, captureJobId: job.jobId, estimatedCredits: credits,
  });
}

/**
 * The last word before a publication's request leaves — after any wait for
 * the transport (up to a minute): every switch still on, the page not
 * stopped, the publication still sending the approval it was claimed with,
 * and its window not passed. A reason holds it (the action stays prepared:
 * the next minute tries again, or cancels it past the window); null lets it go.
 */
async function onlyfansSendHold(app: AppContext, input: {
  publicationId: number; pageId: number; revisionId: number; mode: PublicationDispatchMode; publishAt: Date;
}): Promise<string | null> {
  const [config, settings, record] = await Promise.all([
    loadEffectiveConfig(app.db, app.config),
    getPagePublishingSettings(app.db, input.pageId),
    getPublication(app.db, input.publicationId),
  ]);
  if (config.publishingEnabled !== true || config.publishingOnlyfansEnabled !== true) return "publishing_off";
  if (!settings.enabled || settings.autostoppedAt !== null) return "page_publishing_off";
  if (record === null || record.status !== "submitting" || record.approvedRevisionId !== input.revisionId) return "approval_moved";
  if (!onlyfansStillInWindow(input.mode, input.publishAt, new Date())) return "window_passed";
  return null;
}

async function sendOne(
  app: AppContext,
  publicationId: number,
  mode: PublicationDispatchMode,
  planned: { kind: PublicationKind; publishAt: Date },
  now: Date,
  report: OnlyfansPublishingReport,
): Promise<SendResult> {
  // What the person approved must still be exactly what goes (spec §3.3).
  const check = await verifyApprovedPublication(app.db, publicationId);
  if (!check.ok) {
    report.returnedToDraft += check.reason === "not_approved" ? 0 : 1;
    return "returned";
  }
  const record = check.record;
  // The mode was planned from the publication as listed: one edited and
  // approved again since (another time, another kind) is planned anew next minute.
  if (record.kind !== planned.kind || record.publishAt.getTime() !== planned.publishAt.getTime()) return "raced";
  const revisionId = record.approvedRevisionId as number;
  const revision = await getPublicationRevision(app.db, revisionId);
  if (!revision) return "returned";
  // New files first: the post waits until every one is up, and a failed upload sends nothing.
  let uploaded: ReadonlyMap<string, string> = new Map();
  if (record.media.some((item) => item.source === "file")) {
    const readiness = onlyfansUploadReadiness(record, await listPublicationUploads(app.db, record.id, revisionId));
    if (readiness.state === "waiting") {
      report.waitingForUploads += 1;
      return "waiting";
    }
    if (readiness.state === "failed") {
      await transitionPublication(app.db, {
        id: record.id, from: "approved", to: "draft", actor: { kind: "hub" }, clearApproval: true, reason: readiness.reason.slice(0, 300),
      });
      report.returnedToDraft += 1;
      return "returned";
    }
    uploaded = readiness.tokens;
  }
  const intentId = publicationActionId(record.id, revisionId, "create");
  try {
    await prepareOfapiAction(app, { id: intentId, command: onlyfansCommandFor(record, mode, uploaded) }, revision.approvedByUserId);
  } catch (error) {
    if (!refusedForItsContent(error)) {
      await holdPage(app, record, error, report);
      return "held";
    }
    // Refused before anything left for what it says: the person looks at it again.
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
    // Only the approval checked above: one edited and approved again since
    // is another revision, and its own action (spec §3.3).
    if (!await transitionPublication(tx, { id: record.id, from: "approved", to: "submitting", actor: { kind: "hub" }, onlyIfRevisionId: revisionId })) {
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
    await dispatchOfapiAction(app, intentId, revision.approvedByUserId, {
      beforeSend: () => onlyfansSendHold(app, { publicationId: record.id, pageId: record.pageId, revisionId, mode, publishAt: record.publishAt }),
    });
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
        intent = await dispatchOfapiAction(app, intentId, revision.approvedByUserId, {
          beforeSend: () => onlyfansSendHold(app, { publicationId, pageId: record.pageId, revisionId: dispatch.revisionId, mode: dispatch.mode, publishAt: record.publishAt }),
        });
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
  }).catch((error: unknown) => {
    // publications_page_platform_post_uidx: the id OnlyFans answered is already
    // another publication's (a schedule id may share digits with a post id).
    // The publication waits for the search by content (plan PR 5a), not stuck.
    if ((error as { code?: string }).code !== "23505") throw error;
    return transitionPublication(app.db, {
      id: publicationId, from: "submitting", to: "unknown", actor: { kind: "hub" },
      reason: `answered_id_claimed:${outcome.platformPostRef ?? ""}`.slice(0, 300),
    });
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

/**
 * The page, its account binding, an erasure or a lock refused a send before
 * anything left: the publication keeps its approval (the next minute tries
 * again; past its window it is missed). An account OnlyFansAPI no longer
 * finds stops the page's publishing and tells the owner (spec §8.3).
 */
async function holdPage(app: AppContext, record: PublicationRecord, error: unknown, report: OnlyfansPublishingReport) {
  report.held += 1;
  app.logger?.warn({ error, publicationId: record.id, pageId: record.pageId }, "publications: OnlyFans send held back by the page");
  await notePublicationHeld(app.db, record.id, error instanceof Error ? error.message : String(error));
  if (error instanceof Error && error.message === ACCOUNT_GONE && !report.stoppedPageIds.includes(record.pageId)) {
    report.stoppedPageIds.push(record.pageId);
    await stopPage(app, record, "ofapi_account_not_found", new Date());
  }
}

async function stopPage(app: AppContext, record: PublicationRecord, reason: string, now: Date) {
  if (!await autostopPagePublishing(app.db, record.pageId, reason)) return;
  await notifyPublishingStoppedIncident(app, {
    pageId: record.pageId, pageLabel: record.pageLabel, platform: "onlyfans", reason, occurredAt: now,
  }).catch((error: unknown) => {
    app.logger?.warn({ error, pageId: record.pageId }, "publications: autostop notice failed");
  });
}
