import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import type { OfapiAction } from "@agency_hub_core/contracts";
import {
  abandonUnsentOnlyfansVaultUpload,
  applyOnlyfansVaultListWalk,
  autostopPagePublishing,
  getFanslyWriteFileFacts,
  getOfapiKeyDeclaration,
  getOnlyfansVaultAlbumRun,
  getOnlyfansVaultUpload,
  getPagePublishingSettings,
  getPublication,
  getPublicationRevision,
  insertOnlyfansVaultAlbumRun,
  insertPublicationDispatch,
  listDueOnlyfansVaultAlbums,
  listOnlyfansVaultUploadsOf,
  listOnlyfansVaultUploadsOfPublication,
  listRunningOnlyfansVaultAlbumRuns,
  notePublicationHeld,
  ONLYFANS_VAULT_UPLOAD_FINAL_STOPS,
  readOnlyfansVaultCreditFacts,
  resumeUnsentOnlyfansVaultUpload,
  saveOnlyfansVaultAlbumRun,
  setPublicationVaultAlbumRef,
  transitionPublication,
  type Database,
  type OnlyfansVaultAlbumFile,
  type OnlyfansVaultAlbumRun,
  type OnlyfansVaultUploadFacts,
  type PublicationRecord,
  type PublicationRevisionRecord,
} from "@agency_hub_core/db";
import type { PublicationStatus } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { parseApprovedForm, type ApprovedForm } from "../sync/fansly/publish/derive.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import { BadRequestError } from "./errors.ts";
import { notifyPublishingStoppedIncident } from "./notification-incidents.ts";
import { executeOfapiCaptureJobChunk } from "./ofapi-capture-jobs.ts";
import { cancelOfapiAction, dispatchOfapiAction, getOfapiAction, prepareOfapiAction } from "./ofapi-actions.ts";
import { capturePublicationFileOfapiSource, createOwnerOfapiMediaUpload, OFAPI_LINK_UPLOAD_MAX_BYTES_DEFAULT } from "./ofapi-media-sources.ts";
import { onlyfansUploadCredits, stableUuid } from "./publications-onlyfans.ts";
import {
  readOnlyfansVaultListById,
  readOnlyfansVaultListMedia,
  readOnlyfansVaultLists,
  readOnlyfansVaultMediaById,
  type OnlyfansReadContext,
  type OnlyfansVaultMedia,
} from "./publications-onlyfans-reads.ts";
import { onlyfansVaultSpendCap, onlyfansVaultSwitchesHold, onlyfansVaultWriteHold } from "./publications-onlyfans-vault-hold.ts";
import { vaultAlbumReason } from "./publications-vault-album-reason.ts";
import { verifyApprovedPublication } from "./publications.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

// The executor of an OnlyFans vault album (8-docs 2026-11-12-of-vault-album,
// plan §2 and PR 4). One album is one publication of kind `vault_album` on an
// OnlyFans page. Its own minutely queue walks it, apart from the post sender:
//
//   admission → the album (a fresh full walk of the page's lists and the
//   exact title among them, or a create — one attempt) → what it already
//   holds → the files one at a time from the folder's end → one request that
//   adds every id → the album read back → the status and its reason.
//
// Every write to OnlyFans gets one attempt: the create and the add are owner
// actions under ids fixed by the publication and its approval (their own
// state machine sends each at most once); an upload is a capture job under a
// fixed request id, sent by the runner once. An answer Hub cannot confirm is
// "unknown" and is never sent again by itself. Reads may be repeated.
//
// The price is fixed when the album is admitted and kept with its run; the
// uploads stop when the spend would pass it by 10 %. Nothing leaves while a
// switch is off: the run waits, and the upload runner asks the same question
// right before an upload's write (publications-onlyfans-vault-hold.ts).

export const PUBLICATIONS_ONLYFANS_VAULT_QUEUE = "publications.onlyfans.vault";

/** An album starts within this long after its time, or is "not sent" (as Fansly's, 0323). */
export const ONLYFANS_VAULT_ALBUM_WINDOW_MINUTES = 12 * 60;
/** Inside one minute's run the executor works up to this long, so photos go one after another. */
export const ONLYFANS_VAULT_TICK_BUDGET_MS = 45_000;
/** The album's own requests besides uploads (walk, create, contents, add, read back): about 15 credits (plan §3). */
export const ONLYFANS_VAULT_ALBUM_OVERHEAD_CREDITS = 15;
/** A file still processing this long after its upload started is no longer waited for (its job lives on). */
export const ONLYFANS_VAULT_PROCESSING_WAIT_MS = 90 * 60_000;
/** This many failed or unknown uploads in a row stop the uploads. */
export const ONLYFANS_VAULT_FAILURES_IN_A_ROW = 3;
/** Reads of the album back that fail before it is "not confirmed". */
export const ONLYFANS_VAULT_READ_FAILURES_MAX = 3;
/** Reads again while a file the album holds is not ready yet, a few minutes apart. */
export const ONLYFANS_VAULT_NOT_READY_REREADS = 5;
const NOT_READY_REREAD_GAP_MS = 2 * 60_000;
/** A step's read that failed is tried again no sooner than this (reads cost the common account's credits)… */
export const ONLYFANS_VAULT_STEP_READ_GAP_MS = 5 * 60_000;
/** …and after this many failures the step gives up. */
export const ONLYFANS_VAULT_STEP_READ_FAILURES_MAX = 3;
/** The walk made for a create not sent yet is reused this long: past it, someone may have made the album by hand. */
export const ONLYFANS_VAULT_CREATE_WALK_REUSE_MS = 10 * 60_000;
/** A create or an add still not sent this long after its first try is cancelled: it can never leave later. */
export const ONLYFANS_VAULT_WRITE_NOT_SENT_MS = 90 * 60_000;

const MINUTE_MS = 60_000;

export async function ensurePublicationsOnlyfansVaultQueue(boss: QueueCreationClient, createdQueues?: Set<string>) {
  await ensureQueueCreated(boss, PUBLICATIONS_ONLYFANS_VAULT_QUEUE, { policy: "exclusive" }, createdQueues);
}

export async function ensurePublicationsOnlyfansVaultSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) return;
  await boss.schedule(PUBLICATIONS_ONLYFANS_VAULT_QUEUE, "* * * * *", null, { tz: "UTC" });
}

/** The ids of an album's two writes: one per publication and approval, so a retry finds the same action. */
export function onlyfansVaultActionId(publicationId: number, revisionId: number, kind: "vault_list_create" | "vault_list_add_media"): string {
  return stableUuid(`publication:${publicationId}:revision:${revisionId}:${kind}`);
}

/** The upload request of one file of one approval: a retry finds the same upload job. */
export function onlyfansVaultUploadRequestId(publicationId: number, revisionId: number, position: number): string {
  return stableUuid(`publication:${publicationId}:revision:${revisionId}:vault_upload:${position}`);
}

// ---------------------------------------------------------------------------
// Pure: the files, the price, the admission, the next file, the outcome
// ---------------------------------------------------------------------------

/** A file of the approval as the executor reads it. */
export interface VaultAlbumFileFacts {
  byteSize: number | null;
  mimeType: string | null;
  originalName: string | null;
}

/**
 * The album's files in the approval's order (`media:N`, first file first),
 * each with what its upload would cost: a file the page's vault already holds
 * from Hub's earlier upload (`reusable`, by its bytes) costs the one read that
 * it is still there; a file over 100 MB goes by a link to Hub at the same
 * tariff (plan PR 7); a file over the link's limit (`linkMaxBytes`, the
 * setting onlyfansVaultLinkMaxMb) goes by hand and costs nothing; a vault
 * media the draft named costs its read.
 */
export function buildVaultAlbumFiles(
  form: Pick<ApprovedForm, "media">,
  facts: ReadonlyMap<number, VaultAlbumFileFacts>,
  reusable: ReadonlyMap<string, { mediaRef: string; uploadedAt: Date | null }>,
  options: { linkMaxBytes?: number } = {},
): OnlyfansVaultAlbumFile[] {
  const maxBytes = options.linkMaxBytes ?? OFAPI_LINK_UPLOAD_MAX_BYTES_DEFAULT;
  return form.media
    .filter((media) => media.role === "media")
    .sort((a, b) => a.position - b.position)
    .map((media): OnlyfansVaultAlbumFile => {
      const item = `media:${media.position}`;
      const base = {
        item, position: media.position, jobId: null, startedAt: null, reason: null,
      };
      if (media.source === "vault") {
        return {
          ...base, fileId: null, sha256: null, bytes: 0, mimeType: null, name: media.mediaRef ?? item,
          credits: 1, state: "pending", mediaRef: media.mediaRef, uploadedAt: null,
        };
      }
      const file = media.fileId === null ? undefined : facts.get(media.fileId);
      const bytes = file?.byteSize ?? 0;
      const name = (media.name ?? file?.originalName ?? "").trim() || item;
      const common = { ...base, fileId: media.fileId, sha256: media.fileSha256, bytes, mimeType: file?.mimeType ?? null, name };
      if (bytes > maxBytes) {
        return { ...common, credits: 0, state: "too_big", mediaRef: null, uploadedAt: null, reason: `over_${maxBytes}_bytes` };
      }
      const known = media.fileSha256 === null ? undefined : reusable.get(media.fileSha256);
      if (known) {
        return { ...common, credits: 1, state: "pending", mediaRef: known.mediaRef, uploadedAt: known.uploadedAt?.toISOString() ?? null };
      }
      return { ...common, credits: onlyfansUploadCredits(Math.max(1, bytes)), state: "pending", mediaRef: null, uploadedAt: null };
    });
}

/** The album's price in credits: its files' uploads and reads and the album's own requests (plan §3). */
export function onlyfansVaultAlbumPrice(files: ReadonlyArray<Pick<OnlyfansVaultAlbumFile, "credits">>): number {
  return files.reduce((sum, file) => sum + file.credits, ONLYFANS_VAULT_ALBUM_OVERHEAD_CREDITS);
}

export type VaultAlbumAdmission =
  | { kind: "go" }
  | { kind: "wait"; reason: string }
  /** Its 12 hours passed without starting: "not sent", with what held it. */
  | { kind: "missed"; reason: string }
  /** Dearer than a whole day allows: back to a person. */
  | { kind: "draft"; reason: string };

/**
 * Whether an approved album starts now (plan §2.1): its time came and passed
 * by at most 12 hours; every switch on; the key lets vault writes through;
 * its whole price fits what is left of the albums' day ceiling beside the
 * albums already running; the balance stays above the reserve after it. A
 * price above a whole non-zero ceiling returns it to a person; a ceiling of 0
 * is a pause — it waits.
 */
/** "Not sent" when its 12 hours passed without starting, with what held it; null: still inside them. */
export function onlyfansVaultAlbumMissed(input: { now: Date; publishAt: Date; heldBefore: string | null }): string | null {
  if (input.now.getTime() - input.publishAt.getTime() <= ONLYFANS_VAULT_ALBUM_WINDOW_MINUTES * MINUTE_MS) return null;
  const held = input.heldBefore?.startsWith("held: ") ? input.heldBefore.slice("held: ".length) : null;
  return `not_sent:${held ?? "window_passed"}`.slice(0, 300);
}

export function onlyfansVaultAlbumAdmission(input: {
  now: Date;
  publishAt: Date;
  /** Why it was held before (the publication's `held: …` note), for the miss. */
  heldBefore: string | null;
  switchesHold: string | null;
  pageEnabled: boolean;
  keyAllowsVault: boolean;
  priceCredits: number;
  dailyCredits: number;
  spentToday: number;
  /** What the albums running now may still spend. */
  runningCredits: number;
  balance: number | null;
  reserve: number;
}): VaultAlbumAdmission {
  if (input.now.getTime() < input.publishAt.getTime()) return { kind: "wait", reason: "not_yet" };
  const missed = onlyfansVaultAlbumMissed(input);
  if (missed !== null) return { kind: "missed", reason: missed };
  if (input.dailyCredits > 0 && input.priceCredits > input.dailyCredits) {
    return { kind: "draft", reason: `album_over_daily_credits: the album costs ${input.priceCredits} credits, the albums' day allows ${input.dailyCredits}` };
  }
  if (input.switchesHold !== null) return { kind: "wait", reason: input.switchesHold };
  if (!input.pageEnabled) return { kind: "wait", reason: "page_publishing_off" };
  if (!input.keyAllowsVault) return { kind: "wait", reason: "key_scope_no_vault" };
  if (input.dailyCredits <= 0) return { kind: "wait", reason: "vault_credits_paused" };
  const left = input.dailyCredits - input.spentToday - input.runningCredits;
  if (input.priceCredits > left) return { kind: "wait", reason: `vault_credits_day_left:${Math.max(0, left)}<${input.priceCredits}` };
  if (input.balance === null) return { kind: "wait", reason: "balance_unknown" };
  if (input.balance - input.priceCredits < input.reserve) return { kind: "wait", reason: `balance_low:${input.balance}` };
  return { kind: "go" };
}

/** Whether the declared key lets vault writes through (ofapi-vendor-usage.ts): no declaration, `vault`, or both `uploads` and `commands`. */
export function onlyfansKeyAllowsVault(capabilities: readonly string[] | null): boolean {
  if (capabilities === null) return true;
  return capabilities.includes("vault") || (capabilities.includes("uploads") && capabilities.includes("commands"));
}

/** What an album may still spend: its price less what it spent, never below 0. */
export function onlyfansVaultRunCreditsLeft(run: Pick<OnlyfansVaultAlbumRun, "priceCredits" | "spentCredits">): number {
  return Math.max(0, run.priceCredits - run.spentCredits);
}

/** The file worked on next: the one uploading now, else the last one not worked on yet (from the folder's end). Null: none left. */
export function nextVaultAlbumFile(files: readonly OnlyfansVaultAlbumFile[]): number | null {
  const current = files.findIndex((file) => file.state === "uploading");
  if (current >= 0) return current;
  for (let index = files.length - 1; index >= 0; index -= 1) {
    if (files[index]!.state === "pending") return index;
  }
  return null;
}

/** An upload job as an album sees it. */
export type VaultUploadOutcome =
  | { kind: "done"; mediaRef: string; at: Date | null }
  /** Refused for itself, or it never left and will not. */
  | { kind: "failed"; why: string }
  /** It may have gone: never sent again by itself. */
  | { kind: "unknown"; why: string }
  /** Queued, or accepted and still processing (`left`). */
  | { kind: "waiting"; left: boolean }
  /** Stopped before its write and never left: it may go once whatever stopped it is gone. */
  | { kind: "stopped"; why: string };

const RESUMABLE_STOPS = new Set(["background_paused", "job_unavailable", "collection_off", "on_demand_only"]);

/** An upload job's outcome from its row (ofapi-media-uploads.ts writes the cursor). */
export function vaultUploadOutcome(job: Pick<OnlyfansVaultUploadFacts, "state" | "reasonCode" | "cursor" | "dispatchCount" | "completedAt">): VaultUploadOutcome {
  const cursor = job.cursor;
  const mediaRef = typeof cursor?.mediaRef === "string" && /^[1-9]\d{0,19}$/.test(cursor.mediaRef) ? cursor.mediaRef : null;
  // Completed, even past its ceiling (blocked `upload_budget_exceeded`): the media is in the vault.
  if (cursor?.status === "completed" && mediaRef !== null) return { kind: "done", mediaRef, at: job.completedAt };
  if (cursor?.status === "failed") return { kind: "failed", why: "upload_failed" };
  if (job.state === "complete") return { kind: "unknown", why: "completed_without_media_id" };
  if (job.state === "blocked" || job.state === "failed") {
    const reason = job.reasonCode ?? job.state;
    const left = job.dispatchCount > 0 || cursor !== null;
    if (!left) {
      return ONLYFANS_VAULT_UPLOAD_FINAL_STOPS.includes(reason) ? { kind: "failed", why: `not_sent:${reason}` } : { kind: "stopped", why: reason };
    }
    // A definite refusal of the start (4xx but a rate limit): nothing was taken.
    const http = /^upload_http_(\d{3})$/.exec(reason);
    if (http && Number(http[1]) >= 400 && Number(http[1]) < 500 && http[1] !== "429") return { kind: "failed", why: reason };
    // A status read paused by the collection policy: still processing.
    if (cursor?.phase === "poll" && RESUMABLE_STOPS.has(reason)) return { kind: "waiting", left: true };
    return { kind: "unknown", why: reason };
  }
  return { kind: "waiting", left: job.dispatchCount > 0 || cursor !== null };
}

/** One step's failed reads, kept in the run's notes under the step's key. */
export interface VaultStepReads {
  failures: number;
  lastFailedAt: string | null;
}

/**
 * Whether a step may read now: never before 5 minutes after its last failed
 * read; "give_up" once it failed 3 times (the step settles by what has left).
 */
export function vaultStepReadTurn(reads: VaultStepReads | undefined, nowMs: number): "read" | "wait" | "give_up" {
  if (reads === undefined || reads.failures === 0) return "read";
  if (reads.failures >= ONLYFANS_VAULT_STEP_READ_FAILURES_MAX) return "give_up";
  const last = reads.lastFailedAt === null ? 0 : Date.parse(reads.lastFailedAt);
  return nowMs - last >= ONLYFANS_VAULT_STEP_READ_GAP_MS ? "read" : "wait";
}

/** A step's reads after one more failure at `nowMs`, and whether the step gives up now. */
export function vaultStepReadFailed(reads: VaultStepReads | undefined, nowMs: number): { reads: VaultStepReads; giveUp: boolean } {
  const failures = (reads?.failures ?? 0) + 1;
  return { reads: { failures, lastFailedAt: new Date(nowMs).toISOString() }, giveUp: failures >= ONLYFANS_VAULT_STEP_READ_FAILURES_MAX };
}

/** What a run of failed or unknown uploads in a row does: three stop the uploads. */
export function vaultFailuresInARow(previous: number, outcome: "done" | "failed" | "unknown" | "skipped"): number {
  if (outcome === "done") return 0;
  if (outcome === "skipped") return previous;
  return previous + 1;
}

/**
 * The order the album should show the files in, top first, as shown before
 * «да» (plan §1): OnlyFans orders an album by its files' upload dates, newest
 * on top. The files this run uploaded went from the folder's end, so the
 * folder's first is newest: they come first, in the folder's order. Files the
 * page had before (reused, or in the album already) keep their old dates:
 * below every new one, newest first.
 */
export function onlyfansVaultExpectedOrder(files: readonly OnlyfansVaultAlbumFile[]): Array<{ item: string; mediaRef: string }> {
  const fresh = files.filter((file) => file.state === "uploaded" && file.mediaRef !== null).sort((a, b) => a.position - b.position);
  const old = files
    .filter((file) => (file.state === "reused" || file.state === "in_album") && file.mediaRef !== null)
    .sort((a, b) => {
      const at = (file: OnlyfansVaultAlbumFile) => (file.uploadedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(file.uploadedAt));
      if (at(a) !== at(b)) return at(b) - at(a);
      const ids = BigInt(b.mediaRef as string) - BigInt(a.mediaRef as string);
      return ids === 0n ? a.position - b.position : ids > 0n ? 1 : -1;
    });
  return [...fresh, ...old].map((file) => ({ item: file.item, mediaRef: file.mediaRef as string }));
}

/** The album's files that did not land, in the reason's groups. */
export function vaultFileGroups(files: readonly OnlyfansVaultAlbumFile[], stopped: string | null) {
  return {
    failures: files.filter((file) => file.state === "failed").map((file) => ({ item: file.item, why: file.reason ?? "failed" })),
    names: new Map(files.map((file) => [file.item, file.name])),
    members: files.length,
    unknown: files.filter((file) => file.state === "unknown").map((file) => ({ item: file.item, why: file.reason ?? "unknown" })),
    tooBig: files.filter((file) => file.state === "too_big").map((file) => file.item),
    notTried: files.filter((file) => file.state === "not_tried" || file.state === "pending").map((file) => file.item),
    stopped,
  };
}

export type VaultAlbumRead = { ok: true; items: readonly OnlyfansVaultMedia[] } | { ok: false; reason: string };

export interface VaultAlbumOutcome {
  to: Extract<PublicationStatus, "published" | "unknown" | "rejected">;
  reason: string | null;
  /** Items the album holds but OnlyFans has not finished: the executor may read again before it settles. */
  notReady: string[];
}

/**
 * The album's status from its files and its read back (plan §2.6, §1's
 * table): every file it should hold present, ready and in the order shown
 * before «да» — "published", the reason naming the files that did not land
 * (refused, unknown, too big, not tried). A file it does not hold, one not
 * ready, another order, or no read at all — "unknown": a person looks. No
 * file landed at all — "rejected" (or "unknown" when one may have gone).
 */
export function onlyfansVaultAlbumOutcome(input: {
  files: readonly OnlyfansVaultAlbumFile[];
  read: VaultAlbumRead | null;
  stopped: string | null;
}): VaultAlbumOutcome {
  const groups = vaultFileGroups(input.files, input.stopped);
  const unknown = groups.unknown;
  const expected = onlyfansVaultExpectedOrder(input.files);
  if (expected.length === 0) {
    return { to: unknown.length > 0 ? "unknown" : "rejected", reason: vaultAlbumReason(groups) ?? "no_file_landed", notReady: [] };
  }
  if (input.read === null || !input.read.ok) {
    return { to: "unknown", reason: vaultAlbumReason({ ...groups, unread: input.read?.ok === false ? input.read.reason : "not_read" }), notReady: [] };
  }
  const shown = new Map(input.read.items.map((media) => [media.id, media]));
  const missing = expected.filter((file) => !shown.has(file.mediaRef)).map((file) => file.item);
  const notReady = expected
    .filter((file) => {
      const media = shown.get(file.mediaRef);
      return media !== undefined && (media.isReady !== true || media.hasError === true);
    })
    .map((file) => file.item);
  // Our files as the album shows them, top first; anything else in it is not ours to place.
  const ours = new Set(expected.map((file) => file.mediaRef));
  const order = input.read.items.filter((media) => ours.has(media.id)).map((media) => media.id);
  const at = missing.length > 0 ? -1 : expected.findIndex((file, index) => order[index] !== file.mediaRef);
  const misplaced = at < 0 ? null : { position: at + 1, item: expected[at]!.item };
  const reason = vaultAlbumReason({ ...groups, missing, notReady, misplaced });
  const asApproved = missing.length === 0 && notReady.length === 0 && misplaced === null;
  return { to: asApproved ? "published" : "unknown", reason, notReady };
}

// ---------------------------------------------------------------------------
// The minute's run
// ---------------------------------------------------------------------------

export interface OnlyfansVaultReport {
  sending: boolean;
  started: number;
  settled: number;
  missed: number;
  returnedToDraft: number;
  uploadsStarted: number;
  held: number;
}

export interface OnlyfansVaultTickOptions {
  now?: Date;
  /** How long the run may work (45 s). */
  budgetMs?: number;
  /** Runs one upload job's chunks (the request, then the parse of its answer). Tests replace it with a fake OnlyFansAPI. */
  runUpload?: (app: AppContext, pageId: number, jobId: string) => Promise<void>;
}

/** The upload runner's two chunks: the request, and the parse of its captured answer. */
async function runUploadNow(app: AppContext, pageId: number, jobId: string): Promise<void> {
  for (let chunk = 0; chunk < 2; chunk += 1) {
    const result = await executeOfapiCaptureJobChunk(app, pageId, jobId);
    if (result.kind === "idle" || result.kind === "blocked") return;
  }
}

/** One minute's work: miss what waited too long; with every switch on, follow the running albums, then admit new ones. */
export async function runOnlyfansVaultAlbumTick(app: AppContext, options: OnlyfansVaultTickOptions = {}): Promise<OnlyfansVaultReport> {
  const startedAt = Date.now();
  const deadline = startedAt + (options.budgetMs ?? ONLYFANS_VAULT_TICK_BUDGET_MS);
  const now = options.now ?? new Date();
  const config = await loadEffectiveConfig(app.db, app.config);
  const switchesHold = onlyfansVaultSwitchesHold(config);
  const report: OnlyfansVaultReport = { sending: switchesHold === null, started: 0, settled: 0, missed: 0, returnedToDraft: 0, uploadsStarted: 0, held: 0 };
  const ctx: RunContext = { app, now, deadline, report, runUpload: options.runUpload ?? runUploadNow };

  const running = await listRunningOnlyfansVaultAlbumRuns(app.db);
  const busyPages = new Set(running.map((run) => run.pageId));
  if (switchesHold === null) {
    for (const run of running) {
      if (Date.now() >= deadline) break;
      await followRun(ctx, run).catch((error: unknown) => {
        app.logger?.warn({ error, publicationId: run.publicationId }, "publications: OnlyFans vault album step failed; the next minute goes on");
      });
    }
  }

  // Admission: the albums whose time came, one running album per page.
  let runningCredits = (await listRunningOnlyfansVaultAlbumRuns(app.db)).reduce((sum, run) => sum + onlyfansVaultRunCreditsLeft(run), 0);
  const credit = await readOnlyfansVaultCreditFacts(app.db, now);
  const keyAllowsVault = await vaultKeyAllows(app);
  for (const candidate of await listDueOnlyfansVaultAlbums(app.db, now)) {
    if (Date.now() >= deadline) break;
    const missed = onlyfansVaultAlbumMissed({ now, publishAt: candidate.publishAt, heldBefore: candidate.statusReason });
    if (missed !== null) {
      if (await transitionPublication(app.db, { id: candidate.id, from: "approved", to: "missed", actor: { kind: "hub" }, reason: missed })) report.missed += 1;
      continue;
    }
    if (busyPages.has(candidate.pageId)) {
      await notePublicationHeld(app.db, candidate.id, "page_busy_with_album");
      continue;
    }
    const admitted = await admitOne(ctx, candidate.id, {
      switchesHold, keyAllowsVault, dailyCredits: Math.max(0, config.onlyfansVaultDailyCredits ?? 0),
      reserve: Math.max(Math.max(0, app.config.ofapiCreditFloor ?? 500), config.onlyfansVaultReserveCredits ?? 2000),
      spentToday: credit.spentToday, balance: credit.balance, runningCredits,
    });
    if (admitted !== null) {
      busyPages.add(candidate.pageId);
      runningCredits += admitted;
    }
  }
  return report;
}

interface RunContext {
  app: AppContext;
  now: Date;
  deadline: number;
  report: OnlyfansVaultReport;
  runUpload: (app: AppContext, pageId: number, jobId: string) => Promise<void>;
}

async function vaultKeyAllows(app: AppContext): Promise<boolean> {
  if (!app.config.ofapiApiKey) return false;
  const fingerprint = createHash("sha256").update(app.config.ofapiApiKey).digest("hex");
  const declaration = await getOfapiKeyDeclaration(app.db, fingerprint).catch(() => undefined);
  if (declaration === undefined) return false;
  return onlyfansKeyAllowsVault(declaration?.capabilities ?? null);
}

/** Admit one approved album: its price fixed, its run and dispatch written, the publication submitting. Returns its price, or null when it did not start. */
async function admitOne(ctx: RunContext, publicationId: number, facts: {
  switchesHold: string | null; keyAllowsVault: boolean; dailyCredits: number; reserve: number;
  spentToday: number; balance: number | null; runningCredits: number;
}): Promise<number | null> {
  const { app, now, report } = ctx;
  const check = await verifyApprovedPublication(app.db, publicationId);
  if (!check.ok) {
    report.returnedToDraft += check.reason === "not_approved" ? 0 : 1;
    return null;
  }
  const record = check.record;
  // Only an OnlyFans page's vault album: never a post.
  if (record.kind !== "vault_album" || record.platform !== "onlyfans") return null;
  const revisionId = record.approvedRevisionId as number;
  const revision = await getPublicationRevision(app.db, revisionId);
  const form = revision === null ? null : parseApprovedForm(revision.form);
  if (revision === null || form === null || form.kind !== "vault_album") {
    if (await transitionPublication(app.db, {
      id: record.id, from: "approved", to: "draft", actor: { kind: "hub" }, clearApproval: true, reason: "approval_form_unreadable",
    })) report.returnedToDraft += 1;
    return null;
  }
  const files = await albumFiles(app, record.pageId, form);
  const priceCredits = onlyfansVaultAlbumPrice(files);
  const settings = await getPagePublishingSettings(app.db, record.pageId);
  const decision = onlyfansVaultAlbumAdmission({
    now, publishAt: record.publishAt, heldBefore: record.statusReason, switchesHold: facts.switchesHold,
    pageEnabled: settings.enabled && settings.autostoppedAt === null, keyAllowsVault: facts.keyAllowsVault,
    priceCredits, dailyCredits: facts.dailyCredits, spentToday: facts.spentToday, runningCredits: facts.runningCredits,
    balance: facts.balance, reserve: facts.reserve,
  });
  if (decision.kind === "wait") {
    if (decision.reason !== "not_yet") {
      await notePublicationHeld(app.db, record.id, decision.reason);
      report.held += 1;
    }
    return null;
  }
  if (decision.kind === "missed") {
    if (await transitionPublication(app.db, { id: record.id, from: "approved", to: "missed", actor: { kind: "hub" }, reason: decision.reason })) report.missed += 1;
    return null;
  }
  if (decision.kind === "draft") {
    if (await transitionPublication(app.db, {
      id: record.id, from: "approved", to: "draft", actor: { kind: "hub" }, clearApproval: true, reason: decision.reason.slice(0, 300),
    })) report.returnedToDraft += 1;
    return null;
  }
  const claimed = await app.db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const dispatch = await insertPublicationDispatch(tx, {
      publicationId: record.id, revisionId, kind: "create", platform: "onlyfans", ofapiActionIntentId: null, mode: "vault",
    });
    if (!dispatch) return false;
    if (!await transitionPublication(tx, { id: record.id, from: "approved", to: "submitting", actor: { kind: "hub" }, onlyIfRevisionId: revisionId })) {
      throw new PublicationMovedError();
    }
    await insertOnlyfansVaultAlbumRun(tx, { publicationId: record.id, pageId: record.pageId, revisionId, priceCredits, files });
    return true;
  }).catch((error: unknown) => {
    if (error instanceof PublicationMovedError) return false;
    throw error;
  });
  if (!claimed) return null;
  report.started += 1;
  return priceCredits;
}

class PublicationMovedError extends Error {}

/** The approval's files with what the page's vault already holds of them from Hub's uploads. */
async function albumFiles(app: AppContext, pageId: number, form: ApprovedForm): Promise<OnlyfansVaultAlbumFile[]> {
  const fileIds = form.media.flatMap((media) => (media.source === "file" && media.fileId !== null ? [media.fileId] : []));
  const facts = new Map((await getFanslyWriteFileFacts(app.db, fileIds)).map((file) => [file.id, file]));
  const shas = form.media.flatMap((media) => (media.fileSha256 === null ? [] : [media.fileSha256]));
  const reusable = new Map<string, { mediaRef: string; uploadedAt: Date | null }>();
  for (const upload of await listOnlyfansVaultUploadsOf(app.db, pageId, shas)) {
    const outcome = vaultUploadOutcome(upload);
    if (outcome.kind === "done" && !reusable.has(upload.sha256)) reusable.set(upload.sha256, { mediaRef: outcome.mediaRef, uploadedAt: outcome.at });
  }
  return buildVaultAlbumFiles(form, facts, reusable, { linkMaxBytes: await vaultLinkMaxBytes(app) });
}

/** The largest file an album sends by a link, from the live setting onlyfansVaultLinkMaxMb (decimal MB). */
export async function vaultLinkMaxBytes(app: AppContext): Promise<number> {
  const config = await loadEffectiveConfig(app.db, app.config);
  const mb = config.onlyfansVaultLinkMaxMb;
  return typeof mb === "number" && Number.isFinite(mb) && mb > 0 ? Math.floor(mb) * 1_000_000 : OFAPI_LINK_UPLOAD_MAX_BYTES_DEFAULT;
}

// ---------------------------------------------------------------------------
// Following one run, step by step
// ---------------------------------------------------------------------------

type StepResult = "next" | "wait" | "settled";

interface Followed {
  run: OnlyfansVaultAlbumRun;
  record: PublicationRecord;
  revision: PublicationRevisionRecord;
  form: ApprovedForm;
  read: OnlyfansReadContext;
}

async function followRun(ctx: RunContext, initial: OnlyfansVaultAlbumRun): Promise<void> {
  const { app } = ctx;
  const record = await getPublication(app.db, initial.publicationId);
  if (record === null || record.status !== "submitting" || record.approvedRevisionId !== initial.revisionId) {
    // Settled or moved by a person meanwhile: the run is over.
    await saveRun(app, { ...initial, step: "done" });
    return;
  }
  const settings = await getPagePublishingSettings(app.db, record.pageId);
  if (!settings.enabled || settings.autostoppedAt !== null) {
    ctx.report.held += 1;
    return;
  }
  const revision = await getPublicationRevision(app.db, initial.revisionId);
  const form = revision === null ? null : parseApprovedForm(revision.form);
  if (revision === null || form === null) return;
  const state: Followed = {
    run: initial, record, revision, form,
    read: { app, pageId: record.pageId, actorUserId: revision.approvedByUserId },
  };
  for (let guard = 0; guard < 1000 && Date.now() < ctx.deadline; guard += 1) {
    const result = await step(ctx, state);
    if (result !== "next") return;
  }
}

async function step(ctx: RunContext, state: Followed): Promise<StepResult> {
  switch (state.run.step) {
    case "album": return albumStep(ctx, state);
    case "contents": return contentsStep(ctx, state);
    case "uploads": return uploadsStep(ctx, state);
    case "add": return addStep(ctx, state);
    case "read": return readStep(ctx, state);
    case "done": return "settled";
  }
}

async function saveRun(app: AppContext, run: OnlyfansVaultAlbumRun): Promise<void> {
  await saveOnlyfansVaultAlbumRun(app.db, run);
}

async function moveTo(ctx: RunContext, state: Followed, patch: Partial<OnlyfansVaultAlbumRun>): Promise<StepResult> {
  state.run = { ...state.run, ...patch };
  await saveRun(ctx.app, state.run);
  return "next";
}

function countReads(state: Followed, requests: number) {
  state.run = { ...state.run, actionCredits: state.run.actionCredits + requests };
}

function stepReads(state: Followed, key: string): VaultStepReads | undefined {
  const all = state.run.notes.stepReads as Record<string, VaultStepReads> | undefined;
  return all?.[key];
}

/** Count one failed read of the step `key`; true: it gave up (3 failures). */
function stepReadFailed(ctx: RunContext, state: Followed, key: string): boolean {
  const next = vaultStepReadFailed(stepReads(state, key), ctx.now.getTime());
  const all = { ...(state.run.notes.stepReads as Record<string, VaultStepReads> | undefined), [key]: next.reads };
  state.run = { ...state.run, notes: { ...state.run.notes, stepReads: all } };
  return next.giveUp;
}

/** Whether the step `key` may read now; "give_up" after its third failure. */
function stepReadTurn(ctx: RunContext, state: Followed, key: string): "read" | "wait" | "give_up" {
  return vaultStepReadTurn(stepReads(state, key), ctx.now.getTime());
}

/** Gives up the album's lookup (the walk or the named album): nothing left, so "not sent" — unless a create's answer was lost. */
async function albumNotRead(ctx: RunContext, state: Followed, what: "lists" | "album", why: string): Promise<StepResult> {
  const createId = onlyfansVaultActionId(state.record.id, state.run.revisionId, "vault_list_create");
  if (state.run.notes.createLost === true) return settle(ctx, state, "unknown", `album_create:${what}_not_read`);
  // A create prepared but never sent can never leave later.
  if ((await existingAction(ctx.app, createId))?.state === "prepared") {
    await cancelOfapiAction(ctx.app, createId, state.revision.approvedByUserId).catch(() => undefined);
    const after = await existingAction(ctx.app, createId);
    if (after !== null && after.state !== "cancelled") return "wait";
  }
  return settle(ctx, state, "missed", `not_sent:${what}_not_read:${why}`.slice(0, 300));
}

/**
 * A create or an add still prepared 90 minutes after its first try is
 * cancelled. "cancelled": it can never leave; "left": it left meanwhile, its
 * real state is followed; "keep": still inside its 90 minutes.
 */
async function giveUpUnsentWrite(ctx: RunContext, state: Followed, id: string, firstTryKey: string): Promise<"cancelled" | "left" | "keep"> {
  const firstTry = typeof state.run.notes[firstTryKey] === "string" ? Date.parse(state.run.notes[firstTryKey] as string) : null;
  if (firstTry === null || ctx.now.getTime() - firstTry < ONLYFANS_VAULT_WRITE_NOT_SENT_MS) return "keep";
  await cancelOfapiAction(ctx.app, id, state.revision.approvedByUserId).catch(() => undefined);
  const after = await existingAction(ctx.app, id);
  return after?.state === "cancelled" ? "cancelled" : "left";
}

/** The first try of a write, for its 90 minutes. */
function noteFirstTry(ctx: RunContext, state: Followed, key: string) {
  if (typeof state.run.notes[key] === "string") return;
  state.run = { ...state.run, notes: { ...state.run.notes, [key]: ctx.now.toISOString() } };
}

/** The album, before any file (plan §2.2): named, found by its exact title in a fresh full walk, or created — one attempt. */
async function albumStep(ctx: RunContext, state: Followed): Promise<StepResult> {
  const { app } = ctx;
  const { run, record, form } = state;
  if (run.albumRef !== null) return moveTo(ctx, state, { step: run.albumExisted ? "contents" : "uploads" });
  // An album the draft names by id: read it (1 credit); gone — refused.
  if (form.albumRef !== null) {
    const turn = stepReadTurn(ctx, state, "named");
    if (turn === "wait") return "wait";
    if (turn === "give_up") return albumNotRead(ctx, state, "album", String(state.run.notes.namedWhy ?? "read_failed"));
    const named = await readOnlyfansVaultListById(state.read, form.albumRef);
    countReads(state, named.intentIds.length);
    if (!named.ok) {
      state.run = { ...state.run, notes: { ...state.run.notes, namedWhy: named.reason } };
      if (stepReadFailed(ctx, state, "named")) return albumNotRead(ctx, state, "album", named.reason);
      await saveRun(app, state.run);
      return "wait";
    }
    if (named.found === null) return settle(ctx, state, "rejected", `album_gone:${form.albumRef}`);
    await setPublicationVaultAlbumRef(app.db, { id: record.id, albumRef: named.found.id });
    return moveTo(ctx, state, { albumRef: named.found.id, albumExisted: true, step: "contents" });
  }
  const createId = onlyfansVaultActionId(record.id, run.revisionId, "vault_list_create");
  const createLost = run.notes.createLost === true;
  const created = await existingAction(app, createId);
  // On the wire this very moment (another minute's request): its answer comes first.
  if (created?.state === "dispatching") return "wait";
  if (created?.state === "prepared" && !createLost) {
    const unsent = await giveUpUnsentWrite(ctx, state, createId, "createFirstTryAt");
    if (unsent === "cancelled") return settle(ctx, state, "missed", "not_sent:album_create_not_sent");
    if (unsent === "left") return "next";
    // The walk made for it is reused for 10 minutes: the write is tried again without a new walk.
    const walkedAt = typeof state.run.notes.createWalkAt === "string" ? Date.parse(state.run.notes.createWalkAt) : null;
    if (walkedAt !== null && ctx.now.getTime() - walkedAt < ONLYFANS_VAULT_CREATE_WALK_REUSE_MS) {
      const write = await albumWrite(ctx, state, createId, { action: "vault_list_create", pageId: record.pageId, name: record.text.trim() } as OfapiAction);
      await saveRun(app, state.run);
      return write === "sent" ? "next" : "wait";
    }
  }
  if (created !== null && created.state !== "prepared" && !createLost) {
    if (created.state === "confirmed" && created.remoteId !== null && /^[1-9]\d{0,19}$/.test(created.remoteId)) {
      // Written on the publication at once: everything after goes into it.
      await setPublicationVaultAlbumRef(app.db, { id: record.id, albumRef: created.remoteId });
      return moveTo(ctx, state, { albumRef: created.remoteId, albumExisted: false, step: "uploads" });
    }
    if (created.state === "rejected") {
      await autostopOn(ctx, record, created.errorCode);
      return settle(ctx, state, "rejected", `album_create:${created.errorCode ?? "rejected"}`);
    }
    // The answer is lost or not the documented one: one more walk decides (below).
    state.run = { ...state.run, notes: { ...state.run.notes, createLost: true } };
  }
  // A fresh full walk of the page's lists (8–9 reads of 30); a walk cut short
  // is tried again no sooner than 5 minutes later, 3 times at most.
  const turn = stepReadTurn(ctx, state, "walk");
  if (turn === "wait") return "wait";
  if (turn === "give_up") return albumNotRead(ctx, state, "lists", String(state.run.notes.walkWhy ?? "read_failed"));
  const walk = await readOnlyfansVaultLists(state.read);
  countReads(state, walk.requests);
  await applyOnlyfansVaultListWalk(app.db, {
    pageId: record.pageId, seenAt: new Date(), complete: walk.complete, requests: walk.requests, failure: walk.reason, answeredRequestAt: null,
    lists: walk.lists.map((list) => ({ listRef: list.id, name: list.name, type: list.type, mediaCount: list.mediaCount })),
  });
  if (!walk.complete) {
    const why = walk.reason ?? "incomplete";
    state.run = { ...state.run, notes: { ...state.run.notes, walkWhy: why } };
    if (stepReadFailed(ctx, state, "walk")) return albumNotRead(ctx, state, "lists", why);
    await saveRun(app, state.run);
    return "wait";
  }
  const title = record.text.trim();
  const matches = walk.lists.filter((list) => list.type === "custom" && list.name === title).map((list) => list.id).sort();
  if (state.run.notes.createLost === true) {
    // After a lost create answer: exactly one album with the title is the one it made.
    if (matches.length !== 1) return settle(ctx, state, "unknown", `album_create:${created?.errorCode ?? "unknown"}:${matches.length}_found`);
    await setPublicationVaultAlbumRef(app.db, { id: record.id, albumRef: matches[0]! });
    return moveTo(ctx, state, { albumRef: matches[0]!, albumExisted: true, step: "contents" });
  }
  // An album with the title appeared (made by hand meanwhile): a create prepared before never leaves.
  if (matches.length > 0 && created?.state === "prepared") {
    await cancelOfapiAction(app, createId, state.revision.approvedByUserId).catch(() => undefined);
    if ((await existingAction(app, createId))?.state !== "cancelled") return "next";
  }
  if (matches.length > 1) return settle(ctx, state, "missed", `not_sent:album_title_ambiguous:${matches.length}:${matches.join(",")}`);
  if (matches.length === 1) {
    await setPublicationVaultAlbumRef(app.db, { id: record.id, albumRef: matches[0]! });
    return moveTo(ctx, state, { albumRef: matches[0]!, albumExisted: true, step: "contents" });
  }
  // None: created — one attempt; the first write, 1 credit, before thousands go on files.
  state.run = { ...state.run, notes: { ...state.run.notes, createWalkAt: ctx.now.toISOString() } };
  noteFirstTry(ctx, state, "createFirstTryAt");
  const write = await albumWrite(ctx, state, createId, { action: "vault_list_create", pageId: record.pageId, name: title } as OfapiAction);
  await saveRun(app, state.run);
  return write === "sent" ? "next" : "wait";
}

/** What the album already holds (plan §2.3): those files are neither uploaded nor added. */
async function contentsStep(ctx: RunContext, state: Followed): Promise<StepResult> {
  const notRead = (why: string) => state.run.notes.createLost === true
    // A create left: the album may be its — a person looks.
    ? settle(ctx, state, "unknown", `album_contents_not_read:${why}`.slice(0, 300))
    // Nothing was written: "not sent" is true.
    : settle(ctx, state, "missed", `not_sent:album_contents_not_read:${why}`.slice(0, 300));
  const turn = stepReadTurn(ctx, state, "contents");
  if (turn === "wait") return "wait";
  if (turn === "give_up") return notRead(String(state.run.notes.contentsWhy ?? "read_failed"));
  const read = await readOnlyfansVaultListMedia(state.read, state.run.albumRef as string);
  countReads(state, read.intentIds.length);
  if (!read.ok) {
    state.run = { ...state.run, notes: { ...state.run.notes, contentsWhy: read.reason } };
    if (stepReadFailed(ctx, state, "contents")) return notRead(read.reason);
    await saveRun(ctx.app, state.run);
    return "wait";
  }
  const held = new Map(read.items.map((media) => [media.id, media]));
  const files = state.run.files.map((file): OnlyfansVaultAlbumFile => (
    file.state === "pending" && file.mediaRef !== null && held.has(file.mediaRef) ? { ...file, state: "in_album", reason: null } : file
  ));
  return moveTo(ctx, state, { files, step: "uploads" });
}

/** The files one at a time from the folder's end (plan §2.4). */
async function uploadsStep(ctx: RunContext, state: Followed): Promise<StepResult> {
  while (Date.now() < ctx.deadline) {
    const files = [...state.run.files];
    const next = nextVaultAlbumFile(files);
    // Stopped: the one uploading is still followed to its outcome, nothing new starts.
    const index = next !== null && (state.run.stopReason === null || files[next]!.state === "uploading") ? next : null;
    if (index === null) {
      // Stopped, or nothing left: what did not go is "not tried"; then the add.
      const rest = files.map((file): OnlyfansVaultAlbumFile => (file.state === "pending" ? { ...file, state: "not_tried" } : file));
      return moveTo(ctx, state, { files: rest, step: "add" });
    }
    const file = files[index]!;
    const outcome = file.state === "uploading" ? await followUpload(ctx, state, file) : await startFile(ctx, state, file);
    if (outcome === "wait") return "wait";
  }
  return "wait";
}

type FileStep = "moved" | "wait";

/** Record one file's new state, the spend and the failures in a row. */
async function fileSettled(ctx: RunContext, state: Followed, file: OnlyfansVaultAlbumFile, patch: Partial<OnlyfansVaultAlbumFile>, kind: "done" | "failed" | "unknown" | "skipped"): Promise<FileStep> {
  const files = state.run.files.map((entry) => (entry.item === file.item ? { ...entry, ...patch } : entry));
  const inARow = vaultFailuresInARow(Number(state.run.notes.failuresInARow ?? 0), kind);
  const stopReason = state.run.stopReason ?? (inARow >= ONLYFANS_VAULT_FAILURES_IN_A_ROW ? "three_failures" : null);
  state.run = { ...state.run, files, stopReason, notes: { ...state.run.notes, failuresInARow: inARow } };
  state.run = { ...state.run, spentCredits: await runSpent(ctx.app, state.run) };
  await saveRun(ctx.app, state.run);
  return "moved";
}

/** A file not worked on yet: a vault media or a file the page holds from Hub's upload goes by its id after one read; else its upload starts. */
async function startFile(ctx: RunContext, state: Followed, file: OnlyfansVaultAlbumFile): Promise<FileStep> {
  const { app, now } = ctx;
  const { run, record } = state;
  // A file Hub's earlier upload left unresolved (an answer lost, still processing):
  // its bytes may be in the vault already — never uploaded again by itself.
  if (file.fileId !== null && file.sha256 !== null) {
    const earlier = (await listOnlyfansVaultUploadsOf(app.db, record.pageId, [file.sha256])).filter((upload) => upload.publicationId !== record.id);
    const done = earlier.map((upload) => ({ upload, outcome: vaultUploadOutcome(upload) })).find((entry) => entry.outcome.kind === "done");
    if (done && done.outcome.kind === "done" && file.mediaRef === null) {
      file = { ...file, mediaRef: done.outcome.mediaRef, uploadedAt: done.outcome.at?.toISOString() ?? null };
    }
    if (!done && earlier.some((upload) => ["unknown", "waiting", "stopped"].includes(vaultUploadOutcome(upload).kind))) {
      return fileSettled(ctx, state, file, { state: "unknown", reason: "earlier_upload_unresolved" }, "skipped");
    }
  }
  if (file.mediaRef !== null) {
    // Its read failed 3 times: not uploaded again by itself — it may be in the vault.
    const key = `media:${file.item}`;
    const turn = stepReadTurn(ctx, state, key);
    if (turn === "wait") return "wait";
    if (turn === "give_up") return fileSettled(ctx, state, file, { state: "unknown", reason: "vault_media_not_read" }, "skipped");
    const media = await readOnlyfansVaultMediaById(state.read, file.mediaRef);
    countReads(state, media.intentIds.length);
    if (!media.ok) {
      if (stepReadFailed(ctx, state, key)) return fileSettled(ctx, state, file, { state: "unknown", reason: "vault_media_not_read" }, "skipped");
      await saveRun(app, state.run);
      return "wait";
    }
    if (media.found !== null) return fileSettled(ctx, state, file, { state: "reused", mediaRef: file.mediaRef, uploadedAt: file.uploadedAt, reason: null }, "skipped");
    // Gone from the vault: a vault media is refused; Hub's file goes up anew.
    if (file.fileId === null) return fileSettled(ctx, state, file, { state: "failed", reason: "vault_media_gone" }, "failed");
    file = { ...file, mediaRef: null, uploadedAt: null, credits: onlyfansUploadCredits(Math.max(1, file.bytes)) };
  }
  // The price kept with the run: an upload that would pass it by 10 % never starts.
  const spent = await runSpent(app, state.run);
  if (spent + file.credits > onlyfansVaultSpendCap(run.priceCredits)) {
    state.run = { ...state.run, spentCredits: spent, stopReason: "price_exceeded" };
    await saveRun(app, state.run);
    return "moved";
  }
  // Saved before the check the runner repeats right before the write.
  state.run = { ...state.run, spentCredits: spent };
  await saveRun(app, state.run);
  const hold = await onlyfansVaultWriteHold(app, { publicationId: record.id, revisionId: run.revisionId, upload: { credits: file.credits } });
  if (hold !== null) {
    await saveRun(app, state.run);
    return "wait";
  }
  const actorUserId = state.revision.approvedByUserId;
  let jobId: string;
  try {
    const source = await capturePublicationFileOfapiSource(app, { pageId: record.pageId, fileId: file.fileId as number, actorUserId }, { linkMaxBytes: await vaultLinkMaxBytes(app) });
    const policy = (await app.db.execute<{ revision: number }>(sql`select revision from ofapi_collection_state where id=1`)).rows[0];
    const isPhoto = source.mimeType.startsWith("image/");
    const job = await createOwnerOfapiMediaUpload(app, {
      pageId: record.pageId, sourceId: source.id, destination: "vault",
      requestId: onlyfansVaultUploadRequestId(record.id, run.revisionId, file.position),
      expectedPolicyRevision: Number(policy?.revision ?? 0), maxCredits: file.credits, dryRun: false,
    }, actorUserId, {
      budgetScope: "vault_album",
      // A photo answers at once; a video's outcome comes by its status read (or OnlyFansAPI's event).
      async: !isPhoto,
      album: { publicationId: record.id, revisionId: run.revisionId },
    });
    if (!job.jobId) throw new Error("the upload was not recorded");
    jobId = job.jobId;
  } catch (error) {
    // Nothing left. Its bytes or their type refused: refused for itself. Anything
    // else (the policy moved, the binding) is tried again next minute, for up to
    // 90 minutes from the first try.
    const why = `not_sent:${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`;
    const firstTry = file.startedAt === null ? Date.now() : Date.parse(file.startedAt);
    if (error instanceof BadRequestError || Date.now() - firstTry > ONLYFANS_VAULT_PROCESSING_WAIT_MS) {
      return fileSettled(ctx, state, file, { state: "failed", reason: why }, "failed");
    }
    app.logger?.warn({ error, publicationId: record.id, item: file.item }, "publications: OnlyFans vault upload not queued; the next minute tries again");
    state.run = { ...state.run, files: state.run.files.map((entry) => (entry.item === file.item ? { ...file, startedAt: new Date(firstTry).toISOString(), reason: why } : entry)) };
    await saveRun(app, state.run);
    return "wait";
  }
  state.run = {
    ...state.run,
    files: state.run.files.map((entry) => (entry.item === file.item ? { ...file, state: "uploading", jobId, startedAt: now.toISOString(), reason: null } : entry)),
  };
  await saveRun(app, state.run);
  ctx.report.uploadsStarted += 1;
  await ctx.runUpload(app, record.pageId, jobId).catch((error: unknown) => {
    app.logger?.warn({ error, jobId }, "publications: OnlyFans vault upload chunk failed; its job is retained");
  });
  const current = state.run.files.find((entry) => entry.item === file.item)!;
  return followUpload(ctx, state, current);
}

/** The current file's upload: its outcome, or waiting (processing, a stop that may lift) up to 90 minutes. */
async function followUpload(ctx: RunContext, state: Followed, file: OnlyfansVaultAlbumFile): Promise<FileStep> {
  const { app } = ctx;
  const job = file.jobId === null ? null : await getOnlyfansVaultUpload(app.db, file.jobId);
  if (job === null) return fileSettled(ctx, state, file, { state: "unknown", reason: "upload_job_missing" }, "unknown");
  const outcome = vaultUploadOutcome(job);
  const startedAt = file.startedAt === null ? job.createdAt.getTime() : Date.parse(file.startedAt);
  const waitedTooLong = Date.now() - startedAt > ONLYFANS_VAULT_PROCESSING_WAIT_MS;
  switch (outcome.kind) {
    case "done":
      return fileSettled(ctx, state, file, { state: "uploaded", mediaRef: outcome.mediaRef, uploadedAt: (outcome.at ?? new Date()).toISOString(), reason: null }, "done");
    case "failed": {
      const http = /^upload_http_(\d{3})$/.exec(outcome.why);
      if (http && (http[1] === "401" || http[1] === "403")) {
        await autostopOn(ctx, state.record, `vendor_http_${http[1]}`);
        state.run = { ...state.run, stopReason: "authorization_refused" };
      }
      return fileSettled(ctx, state, file, { state: "failed", reason: outcome.why }, "failed");
    }
    case "unknown":
      return fileSettled(ctx, state, file, { state: "unknown", reason: outcome.why }, "unknown");
    case "stopped": {
      if (waitedTooLong && await abandonUnsentOnlyfansVaultUpload(app.db, job.jobId, `the album stopped waiting: ${outcome.why}`)) {
        return fileSettled(ctx, state, file, { state: "failed", reason: `not_sent:${outcome.why}` }, "failed");
      }
      // Never left: back to the runner while the album's own check lets it go.
      const hold = await onlyfansVaultWriteHold(app, { publicationId: state.record.id, revisionId: state.run.revisionId, upload: { credits: job.maxCredits } });
      if (hold === null && await resumeUnsentOnlyfansVaultUpload(app.db, job.jobId)) {
        await ctx.runUpload(app, state.record.pageId, job.jobId).catch(() => undefined);
        const again = await getOnlyfansVaultUpload(app.db, job.jobId);
        if (again !== null && vaultUploadOutcome(again).kind !== "stopped") return followUpload(ctx, state, file);
      }
      return "wait";
    }
    case "waiting": {
      if (!waitedTooLong) return "wait";
      // Not waited for any more. One that never left is let go for good (the
      // sweep never sends it later); one processing keeps its job, and its late
      // outcome is kept for a re-send.
      if (!outcome.left && await abandonUnsentOnlyfansVaultUpload(app.db, job.jobId, "the album stopped waiting for it")) {
        return fileSettled(ctx, state, file, { state: "failed", reason: "not_sent:queued_too_long" }, "failed");
      }
      return fileSettled(ctx, state, file, { state: "unknown", reason: "still_processing" }, "unknown");
    }
  }
}

/** What an album spent: its uploads (their actual credits, or their ceiling once sent) and its own requests. */
export function onlyfansVaultRunSpent(actionCredits: number, jobs: ReadonlyArray<Pick<OnlyfansVaultUploadFacts, "cursor" | "dispatchCount" | "maxCredits">>): number {
  let spent = actionCredits;
  for (const job of jobs) {
    const actual = job.cursor?.actualCredits;
    if (typeof actual === "number" && Number.isFinite(actual)) spent += actual;
    else if (job.dispatchCount > 0 || job.cursor !== null) spent += job.maxCredits;
  }
  return spent;
}

async function runSpent(app: AppContext, run: OnlyfansVaultAlbumRun): Promise<number> {
  return onlyfansVaultRunSpent(run.actionCredits, await listOnlyfansVaultUploadsOfPublication(app.db, run.publicationId));
}

/** One request that adds every id (plan §2.5); nothing to add goes straight to the read. */
async function addStep(ctx: RunContext, state: Followed): Promise<StepResult> {
  const { app } = ctx;
  const { run, record } = state;
  const asked = Array.isArray(run.notes.addMediaIds) ? run.notes.addMediaIds as string[] : null;
  // The ids to add are fixed before the request: a retry after a crash sends the same.
  const mediaIds = asked ?? run.files.filter((file) => (file.state === "uploaded" || file.state === "reused") && file.mediaRef !== null).map((file) => file.mediaRef as string);
  if (asked === null) state.run = { ...state.run, notes: { ...state.run.notes, addMediaIds: mediaIds } };
  if (mediaIds.length === 0) return moveTo(ctx, state, { step: "read" });
  const addId = onlyfansVaultActionId(record.id, run.revisionId, "vault_list_add_media");
  const existing = await existingAction(app, addId);
  if (existing?.state === "prepared") {
    const unsent = await giveUpUnsentWrite(ctx, state, addId, "addFirstTryAt");
    if (unsent === "cancelled") {
      // The files are in the vault: a re-send takes them without a second payment.
      const files = vaultAlbumReason(vaultFileGroups(state.run.files, state.run.stopReason));
      return settle(ctx, state, "rejected", ["album_media:not_sent", files].filter((part) => part !== null).join(";"));
    }
  }
  const current = existing?.state === "prepared" ? await existingAction(app, addId) : existing;
  if (current === null || current.state === "prepared") {
    noteFirstTry(ctx, state, "addFirstTryAt");
    const write = await albumWrite(ctx, state, addId, { action: "vault_list_add_media", pageId: record.pageId, listId: run.albumRef as string, mediaIds } as OfapiAction);
    await saveRun(app, state.run);
    if (write !== "sent") return "wait";
  }
  const added = await getOfapiAction(app, addId);
  if (added.state === "prepared" || added.state === "dispatching") return "wait";
  if (added.state === "rejected") {
    await autostopOn(ctx, record, added.errorCode);
    const files = vaultAlbumReason(vaultFileGroups(state.run.files, state.run.stopReason));
    const reason = [`album_media:${added.errorCode ?? "rejected"}`, files].filter((part) => part !== null).join(";");
    return settle(ctx, state, "rejected", reason);
  }
  // Confirmed — or an answer lost: the read back decides (plan §2.6).
  return moveTo(ctx, state, { step: "read", notes: { ...state.run.notes, addedAt: new Date().toISOString(), addState: added.state } });
}

/** The album read back (plan §2.6): the status and its reason. */
async function readStep(ctx: RunContext, state: Followed): Promise<StepResult> {
  const { app } = ctx;
  const { run } = state;
  const expected = onlyfansVaultExpectedOrder(run.files);
  if (expected.length === 0 || run.albumRef === null) {
    const outcome = onlyfansVaultAlbumOutcome({ files: run.files, read: null, stopped: run.stopReason });
    return settle(ctx, state, outcome.to, outcome.reason);
  }
  const lastReadAt = typeof run.notes.lastReadAt === "string" ? Date.parse(run.notes.lastReadAt) : 0;
  const rereads = Number(run.notes.notReadyRereads ?? 0);
  if (rereads > 0 && Date.now() - lastReadAt < NOT_READY_REREAD_GAP_MS) return "wait";
  const read = await readOnlyfansVaultListMedia(state.read, run.albumRef);
  countReads(state, read.intentIds.length);
  state.run = { ...state.run, notes: { ...state.run.notes, lastReadAt: new Date().toISOString() } };
  if (!read.ok) {
    const failures = Number(state.run.notes.readFailures ?? 0) + 1;
    state.run = { ...state.run, notes: { ...state.run.notes, readFailures: failures } };
    if (failures < ONLYFANS_VAULT_READ_FAILURES_MAX) {
      await saveRun(app, state.run);
      return "wait";
    }
    const outcome = onlyfansVaultAlbumOutcome({ files: state.run.files, read: { ok: false, reason: read.reason }, stopped: state.run.stopReason });
    return settle(ctx, state, outcome.to, outcome.reason);
  }
  const outcome = onlyfansVaultAlbumOutcome({ files: state.run.files, read: { ok: true, items: read.items }, stopped: state.run.stopReason });
  if (outcome.notReady.length > 0 && rereads < ONLYFANS_VAULT_NOT_READY_REREADS) {
    state.run = { ...state.run, notes: { ...state.run.notes, notReadyRereads: rereads + 1 } };
    await saveRun(app, state.run);
    return "wait";
  }
  return settle(ctx, state, outcome.to, outcome.reason);
}

/** The album's status, its album recorded, the run done. */
async function settle(ctx: RunContext, state: Followed, to: PublicationStatus, reason: string | null): Promise<StepResult> {
  const { app } = ctx;
  state.run = { ...state.run, step: "done", spentCredits: await runSpent(app, state.run) };
  await saveRun(app, state.run);
  const moved = await transitionPublication(app.db, {
    id: state.record.id, from: "submitting", to, actor: { kind: "hub" }, reason: reason?.slice(0, 20_000) ?? null,
    ...(state.run.albumRef === null ? {} : { vaultAlbumRef: state.run.albumRef }),
  });
  if (moved) {
    ctx.report.settled += 1;
    if (to === "missed") ctx.report.missed += 1;
  }
  return "settled";
}

interface ActionFacts {
  state: string;
  remoteId: string | null;
  errorCode: string | null;
}

/** The album's write by its fixed id, as it stands; null: never prepared. */
async function existingAction(app: AppContext, id: string): Promise<ActionFacts | null> {
  const known = await app.db.execute<{ id: string }>(sql`select id from ofapi_action_intents where id = ${id}`);
  if (known.rows.length === 0) return null;
  const intent = await getOfapiAction(app, id);
  return { state: intent.state, remoteId: intent.remoteId, errorCode: intent.errorCode };
}

/**
 * The album's create or add: prepared under its fixed id and sent once. The
 * action's own state machine never sends it twice; one that never left (the
 * lock busy, the transport down, a switch off right before) stays prepared
 * and goes on a later minute. "sent": it left (whatever its answer).
 */
async function albumWrite(ctx: RunContext, state: Followed, id: string, command: OfapiAction): Promise<"sent" | "not_sent"> {
  const { app } = ctx;
  const actorUserId = state.revision.approvedByUserId;
  try {
    await prepareOfapiAction(app, { id, command }, actorUserId);
  } catch (error) {
    app.logger?.warn({ error, publicationId: state.record.id }, "publications: OnlyFans vault album write not prepared; the next minute tries again");
    return "not_sent";
  }
  try {
    const intent = await dispatchOfapiAction(app, id, actorUserId, {
      beforeSend: () => onlyfansVaultWriteHold(app, { publicationId: state.record.id, revisionId: state.run.revisionId, upload: null }),
    });
    if (intent.state === "prepared") return "not_sent";
  } catch {
    const intent = await getOfapiAction(app, id);
    if (intent.state === "prepared") return "not_sent";
  }
  state.run = { ...state.run, actionCredits: state.run.actionCredits + 1 };
  return "sent";
}

/** A refusal of the account's authorization stops the page's publishing, as a post's does (spec §8.3). */
async function autostopOn(ctx: RunContext, record: PublicationRecord, errorCode: string | null): Promise<void> {
  if (errorCode !== "vendor_http_401" && errorCode !== "vendor_http_403") return;
  if (!await autostopPagePublishing(ctx.app.db, record.pageId, errorCode)) return;
  await notifyPublishingStoppedIncident(ctx.app, {
    pageId: record.pageId, pageLabel: record.pageLabel, platform: "onlyfans", reason: errorCode, occurredAt: new Date(),
  }).catch((error: unknown) => {
    ctx.app.logger?.warn({ error, pageId: record.pageId }, "publications: autostop notice failed");
  });
}

/** The run of an album, for a card or a CLI (later PRs read it). */
export async function getOnlyfansVaultAlbumProgress(app: AppContext, publicationId: number): Promise<OnlyfansVaultAlbumRun | null> {
  return getOnlyfansVaultAlbumRun(app.db, publicationId);
}
