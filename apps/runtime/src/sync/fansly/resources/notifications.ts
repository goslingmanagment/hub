import { sql } from "drizzle-orm";

import {
  getSyncAttempt,
  type CaptureCoverageProof,
  type CaptureCoverageStatus,
  type Database,
  type SyncAttemptRow,
  type SyncWorkRow,
} from "@agency_hub_core/db";
import { FANSLY_HEAD_CURSOR } from "@agency_hub_core/fansly";
import {
  CAPTURE_COVERAGE_PLANES,
  FANSLY_NOTIFICATION_DECLARED_TYPE_CODES,
  FANSLY_NOTIFICATION_TYPE_GROUPS,
} from "@agency_hub_core/shared";

import { writeFanslyLaneCoverage } from "../lib/lane.ts";
import {
  classifyNotificationResponse,
  compareNotificationRefs,
  notificationRows,
  oldestCreatedAtIso,
  pageReachesOverlap,
  pageRefBounds,
  typesForFilterMode,
  type FanslyNotificationsFilterMode,
} from "../lib/notifications-rules.ts";
import { ApplyQuarantine } from "../../engine/commit.ts";
import type {
  ApplyInput,
  ApplyResult,
  RequestPlan,
  ResourceModule,
  ShadowResult,
  StepPlan,
} from "../../engine/resource.ts";
import { replayByCanonicalDrafts } from "../lib/family-replay.ts";
import { advanceShadowWalk, type ShadowWalkProgress } from "../lib/offset-walk.ts";

// `notifications.forward` and `notifications.backfill` (plan §5, design §5.14):
// `GET /notifications?before=<id|0>&after=0[&type=<csv>]`, journaled as
// `notifications` through the [A20] `accounts[]` trim, exactly as the legacy
// lane journals it. The rows themselves become events by inline
// canonicalization (`pull/engagement`); this module moves the walks and writes
// the capture coverage the Analytics panels read.
//
// THE ONLY LOSSY SOURCE: Fansly announces a liker, a reply, a purchase once,
// here. So the head poll is a hard 30-minute poll (a due poll goes before any
// walk in the planned class) and it never trades a page for backfill progress.
//
// forward (poll): from the head down until a page reaches the newest id the
// last completed poll saw (overlap), an empty page, or — on the very first
// poll — one page (everything older is the backfill's). The new head commits
// only when the walk completes; a page that does not move below its cursor
// ends the walk as a provider gap (`partial_provider_surface`), never a loop.
// An empty unfiltered page is checked once per page with the declared type
// CSV (the "is the unfiltered form filtering?" probe).
//
// backfill (goal, owner or legacy import): `before = oldest id` down to an
// empty page — the retention floor (`provider_exhausted`, the empty page's
// observation as the proof).
//
// THE TYPE FORM. Unfiltered first; a 4xx refusal (the engine's subject
// breaker spaces the retry) widens to the declared CSV, then to one filter
// group per call, rotating at walk boundaries. The form of the last served
// request is durable in the cursor, the two walks share the narrower one, and
// anything captured through a narrowed form claims `partial_provider_surface`.
//
// Retired from the legacy lane: the UTC-day cap and its head reserve, the
// 20-page forward slice, the jittered continuations (the pacer and the
// scheduler pace the walks now).

export type NotificationsVariant = "forward" | "backfill";

const FORWARD_KEY = "notifications.forward";
const BACKFILL_KEY = "notifications.backfill";
const HEAD = FANSLY_HEAD_CURSOR;

// ── the type form ───────────────────────────────────────────────────────────

export interface NotificationsForm {
  mode: FanslyNotificationsFilterMode;
  groupIndex: number;
}

export const UNFILTERED_FORM: NotificationsForm = Object.freeze({ mode: "unfiltered", groupIndex: 0 });
const DECLARED_FORM: NotificationsForm = Object.freeze({ mode: "declared_csv", groupIndex: 0 });

const FORM_RANK: Record<FanslyNotificationsFilterMode, number> = { unfiltered: 0, declared_csv: 1, type_groups: 2 };

function sameCodes(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((code, index) => code === right[index]);
}

/** The `type` parameter of a form (null: the unfiltered form). */
export function formTypes(form: NotificationsForm): readonly number[] | null {
  return typesForFilterMode(form.mode, form.groupIndex);
}

/** The form a request was sent in, from its `type` parameter; null for a
 *  code list this module never sends. */
export function formOfTypes(types: readonly number[] | null | undefined): NotificationsForm | null {
  if (types === null || types === undefined || types.length === 0) return UNFILTERED_FORM;
  if (sameCodes(types, FANSLY_NOTIFICATION_DECLARED_TYPE_CODES)) return DECLARED_FORM;
  const index = FANSLY_NOTIFICATION_TYPE_GROUPS.findIndex((group) => sameCodes(types, group));
  return index === -1 ? null : { mode: "type_groups", groupIndex: index };
}

/** The next form after a refusal: never the eight-code UI list, which drops
 *  two money codes (legacy lane, A1 + A22). */
export function widenForm(form: NotificationsForm): NotificationsForm {
  switch (form.mode) {
    case "unfiltered":
      return { mode: "declared_csv", groupIndex: form.groupIndex };
    case "declared_csv":
      return { mode: "type_groups", groupIndex: form.groupIndex };
    case "type_groups":
      return { mode: "type_groups", groupIndex: (form.groupIndex + 1) % FANSLY_NOTIFICATION_TYPE_GROUPS.length };
  }
}

/** The narrower of two forms (the provider refuses the wider one); between
 *  two group forms, `own` keeps its rotation. */
export function narrowerForm(own: NotificationsForm, other: NotificationsForm): NotificationsForm {
  return FORM_RANK[other.mode] > FORM_RANK[own.mode] ? other : own;
}

/** A walk boundary rotates a group form to the next group (every group gets
 *  asked, 32007/45012 among them). */
function rotateAtWalkBoundary(form: NotificationsForm): NotificationsForm {
  return form.mode === "type_groups"
    ? { mode: "type_groups", groupIndex: (form.groupIndex + 1) % FANSLY_NOTIFICATION_TYPE_GROUPS.length }
    : form;
}

/** A 4xx that is a statement about the `type` form — never a dead session
 *  (401/403), the provider's pace (429) or a timeout (408). */
export function isTypeFormRefusal(status: number | null): boolean {
  return status !== null && status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 408 && status !== 429;
}

function parseForm(value: unknown): NotificationsForm {
  const record = recordOf(value);
  const mode = record.mode === "declared_csv" || record.mode === "type_groups" ? record.mode : "unfiltered";
  const index = count(record.groupIndex) ?? 0;
  return { mode, groupIndex: index % FANSLY_NOTIFICATION_TYPE_GROUPS.length };
}

// ── small parsers ───────────────────────────────────────────────────────────

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseShadow(value: unknown): ShadowWalkProgress | null {
  const record = recordOf(value);
  const steps = count(record.steps);
  const done = count(record.done);
  return steps === null || done === null ? null : { steps, done };
}

/** The request parameters of a `notifications.page` step. */
function pageParams(request: { params: unknown }): { before: string; types: readonly number[] | null } {
  const params = recordOf(request.params);
  const types = Array.isArray(params.types) ? params.types.filter((code): code is number => typeof code === "number") : null;
  return { before: text(params.before) ?? HEAD, types };
}

function notificationsRequest(before: string, form: NotificationsForm): RequestPlan<"notifications.page"> {
  const types = formTypes(form);
  return { spec: "notifications.page", params: { before, types: types === null ? null : [...types] } };
}

// ── cursors ─────────────────────────────────────────────────────────────────

interface ForwardWalk {
  /** `before` of the next page; null = the head. */
  beforeRef: string | null;
  /** The newest id of this poll's first page, committed on completion only. */
  pendingHeadRef: string | null;
  /** The `before` of the last served page (repeat guard). */
  lastRequestedBefore: string | null;
  pages: number;
  /** An empty unfiltered page waits for its declared-CSV probe at this cursor. */
  probeBefore: string | null;
}

export interface NotificationsForwardCursor {
  /** The overlap stop. */
  newestSeenNotificationId: string | null;
  lastForwardPollAt: string | null;
  /** The form of the last served request. */
  form: NotificationsForm;
  unfilteredProbeSpent: boolean;
  postLikesCoverageWritten: boolean;
  walk: ForwardWalk | null;
  last: Record<string, unknown> | null;
  shadow: ShadowWalkProgress | null;
}

export function parseForwardCursor(value: unknown): NotificationsForwardCursor {
  const record = recordOf(value);
  const walkRecord = recordOf(record.walk);
  const walk: ForwardWalk | null = record.walk === null || record.walk === undefined || typeof record.walk !== "object"
    ? null
    : {
      beforeRef: text(walkRecord.beforeRef),
      pendingHeadRef: text(walkRecord.pendingHeadRef),
      lastRequestedBefore: text(walkRecord.lastRequestedBefore),
      pages: count(walkRecord.pages) ?? 0,
      probeBefore: text(walkRecord.probeBefore),
    };
  return {
    newestSeenNotificationId: text(record.newestSeenNotificationId),
    lastForwardPollAt: text(record.lastForwardPollAt),
    form: parseForm(record.form),
    unfilteredProbeSpent: record.unfilteredProbeSpent === true,
    postLikesCoverageWritten: record.postLikesCoverageWritten === true,
    walk,
    last: typeof record.last === "object" && record.last !== null ? record.last as Record<string, unknown> : null,
    shadow: parseShadow(record.shadow),
  };
}

export interface NotificationsBackfillCursor {
  /** `before` of the next page ("0" = the head). */
  nextBeforeRef: string;
  lastRequestedBefore: string | null;
  /** ISO: the oldest notification the provider served (`notificationFloorAt`). */
  floorAt: string | null;
  /** The observation of the walk's last page (the floor's proof). */
  lastObservationId: number | null;
  form: NotificationsForm;
  shadow: ShadowWalkProgress | null;
}

export function parseBackfillCursor(value: unknown): NotificationsBackfillCursor {
  const record = recordOf(value);
  return {
    nextBeforeRef: text(record.nextBeforeRef) ?? HEAD,
    lastRequestedBefore: text(record.lastRequestedBefore),
    floorAt: text(record.floorAt),
    lastObservationId: count(record.lastObservationId),
    form: parseForm(record.form),
    shadow: parseShadow(record.shadow),
  };
}

function emptyForwardWalk(): ForwardWalk {
  return { beforeRef: null, pendingHeadRef: null, lastRequestedBefore: null, pages: 0, probeBefore: null };
}

// ── the form a step asks in ─────────────────────────────────────────────────

/** The newest row of the other notifications walk of the page (its form is
 *  the provider's answer too). */
async function siblingForm(db: Database, input: { pageId: number; shadow: boolean; resource: string }): Promise<NotificationsForm | null> {
  const result = await db.execute<{ cursor: unknown }>(sql`
    select w.cursor from sync_work w
     where w.page_id = ${input.pageId} and w.shadow = ${input.shadow} and w.resource = ${input.resource}
     order by w.id desc
     limit 1
  `);
  const row = result.rows[0];
  return row === undefined ? null : parseForm(recordOf(row.cursor).form);
}

async function lastAttemptOf(db: Database, work: SyncWorkRow): Promise<SyncAttemptRow | null> {
  return work.lastAttemptId === null ? null : getSyncAttempt(db, work.lastAttemptId);
}

/**
 * The form the next request goes in: the narrower of this walk's and the
 * other walk's served form, or — right after this walk's last request was
 * refused (the engine reopened it after the subject breaker) — the form after
 * the refused one.
 */
async function nextForm(
  db: Database,
  input: { work: SyncWorkRow; own: NotificationsForm; pageId: number; shadow: boolean; sibling: string; last: SyncAttemptRow | null },
): Promise<NotificationsForm> {
  const shared = narrowerForm(input.own, (await siblingForm(db, { pageId: input.pageId, shadow: input.shadow, resource: input.sibling })) ?? input.own);
  const last = input.last;
  if (last === null || last.shadow || !isTypeFormRefusal(last.httpStatus)) return shared;
  const refused = formOfTypes(pageParams({ params: recordOf(last.request).params }).types);
  return refused === null ? shared : widenForm(refused);
}

// ── coverage ────────────────────────────────────────────────────────────────

async function writeCoverage(
  tx: Database,
  input: {
    pageId: number;
    plane: string;
    status: CaptureCoverageStatus;
    proof: CaptureCoverageProof;
    now: Date;
    acquisitionMode?: "forward_only" | "retroactive";
    reasonCode: string | null;
    cursor: Record<string, unknown>;
    oldestCapturedAt?: Date | null;
    proofObservationId?: number | null;
    newestCapturedAt?: Date | null;
  },
): Promise<void> {
  await writeFanslyLaneCoverage({
    db: tx,
    pageId: input.pageId,
    plane: input.plane,
    scopeRef: "",
    status: input.status,
    acquisitionMode: input.acquisitionMode ?? "retroactive",
    proof: input.proof,
    reasonCode: input.reasonCode,
    cursor: input.cursor,
    ...(input.newestCapturedAt === null ? {} : { newestCapturedAt: input.newestCapturedAt ?? input.now }),
    ...(input.oldestCapturedAt === undefined ? {} : { oldestCapturedAt: input.oldestCapturedAt }),
    ...(input.proofObservationId === undefined ? {} : { proofObservationId: input.proofObservationId }),
  });
}

/** Through a narrowed form a claim is never stronger than a partial surface. */
function archiveStatus(form: NotificationsForm, fresh: CaptureCoverageStatus): CaptureCoverageStatus {
  return form.mode === "unfiltered" ? fresh : "partial_provider_surface";
}

/** The standing negative claim on the liker plane, written once (E4: no
 *  Fansly like code is live-confirmed). */
async function writePostLikesCoverage(tx: Database, pageId: number, now: Date): Promise<void> {
  await writeCoverage(tx, {
    pageId,
    plane: CAPTURE_COVERAGE_PLANES.postLikes,
    status: "not_started",
    proof: "none",
    now,
    acquisitionMode: "forward_only",
    reasonCode: "no_like_code_confirmed",
    cursor: { note: "E4: no Fansly like code is live-confirmed; post_likes stays empty" },
    newestCapturedAt: null,
  });
}

// ── forward ─────────────────────────────────────────────────────────────────

export type ForwardStopReason = "overlap" | "first_poll" | "no_cursor" | "empty_page" | "cursor_repeat" | "probe_failed";

/** The walk is over: commit the head, rotate a group form, reset the walk. */
export function completeForward(
  cursor: NotificationsForwardCursor,
  walk: ForwardWalk,
  input: { now: Date; reason: ForwardStopReason; form: NotificationsForm },
): NotificationsForwardCursor {
  const committedHead = walk.pendingHeadRef ?? cursor.newestSeenNotificationId;
  return {
    ...cursor,
    newestSeenNotificationId: committedHead,
    lastForwardPollAt: input.now.toISOString(),
    form: rotateAtWalkBoundary(input.form),
    walk: null,
    last: { completedAt: input.now.toISOString(), stopReason: input.reason, pages: walk.pages, newestSeenNotificationId: committedHead },
    shadow: null,
  };
}

const forwardModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    const cursor = parseForwardCursor(work.cursor);
    const walk = cursor.walk;
    const last = ctx.shadow ? null : await lastAttemptOf(ctx.db, work);
    if (walk !== null && walk.probeBefore !== null) {
      const lastParams = last === null ? null : pageParams({ params: recordOf(last.request).params });
      if (last !== null && lastParams !== null && lastParams.before === walk.probeBefore && formOfTypes(lastParams.types)?.mode === "declared_csv") {
        // The probe was sent and not answered: it is spent (the legacy lane
        // never asks it twice). The walk ends on its empty page.
        const done = completeForward(cursor, walk, { now: ctx.now, reason: "probe_failed", form: cursor.form });
        return { kind: "done", cursor: done, proof: done.last, reason: "probe_failed" };
      }
      return { kind: "request", request: notificationsRequest(walk.probeBefore, DECLARED_FORM) };
    }
    const form = await nextForm(ctx.db, { work, own: cursor.form, pageId: ctx.pageId, shadow: ctx.shadow, sibling: BACKFILL_KEY, last });
    return { kind: "request", request: notificationsRequest(walk?.beforeRef ?? HEAD, form) };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const now = input.now;
    const cursor = parseForwardCursor(input.work.cursor);
    const params = pageParams(input.request);
    const servedForm = formOfTypes(params.types) ?? cursor.form;
    const response = input.parsed;
    if (classifyNotificationResponse(response) === "invalid") {
      throw new ApplyQuarantine("notifications_page_unreadable", { before: params.before });
    }
    const rows = notificationRows(response);
    const bounds = pageRefBounds(rows);
    let next: NotificationsForwardCursor = { ...cursor, shadow: null };
    const counters: Record<string, number> = {};
    if (!next.postLikesCoverageWritten) {
      await writePostLikesCoverage(tx, input.pageId, now);
      next = { ...next, postLikesCoverageWritten: true };
    }
    let walk = cursor.walk ?? emptyForwardWalk();

    const complete = async (reason: ForwardStopReason, form: NotificationsForm): Promise<ApplyResult> => {
      const done = completeForward(next, walk, { now, reason, form });
      await writeCoverage(tx, {
        pageId: input.pageId,
        plane: CAPTURE_COVERAGE_PLANES.notifications,
        // A cursor the provider would not move committed the head WITHOUT
        // reaching overlap: whatever sat below it is a gap we can name.
        status: reason === "cursor_repeat" ? "partial_provider_surface" : archiveStatus(form, "window_captured"),
        proof: "none",
        now,
        reasonCode: form.mode === "unfiltered" ? reason : "type_filter_narrowed",
        cursor: { newestSeenNotificationId: done.newestSeenNotificationId, filterMode: form.mode },
      });
      return {
        work: { satisfiesRevision: true, close: "done", closeReason: `forward_${reason}`, cursor: done, proof: done.last },
        followups: [],
        counters,
      };
    };

    // The probe's answer: rows where the unfiltered form served none mean the
    // unfiltered call is being filtered — the declared CSV from now on.
    if (walk.probeBefore !== null && params.before === walk.probeBefore && servedForm.mode === "declared_csv") {
      walk = { ...walk, probeBefore: null };
      if (rows.length === 0) return complete("empty_page", cursor.form);
      counters.unfiltered_form_filtered = 1;
      await writeCoverage(tx, {
        pageId: input.pageId,
        plane: CAPTURE_COVERAGE_PLANES.notifications,
        status: "partial_provider_surface",
        proof: "none",
        now,
        reasonCode: "unfiltered_form_filtered",
        cursor: { filterMode: "declared_csv", before: params.before },
      });
      return complete("empty_page", DECLARED_FORM);
    }

    const expected = walk.beforeRef ?? HEAD;
    if (params.before !== expected) {
      throw new ApplyQuarantine("notifications_cursor_mismatch", { requested: params.before, walk: expected });
    }
    if (walk.lastRequestedBefore === params.before) {
      counters.cursor_repeat = 1;
      return complete("cursor_repeat", servedForm);
    }
    next = { ...next, form: servedForm };
    walk = {
      ...walk,
      lastRequestedBefore: params.before,
      pages: walk.pages + 1,
      pendingHeadRef: walk.pendingHeadRef ?? bounds.newest,
      probeBefore: null,
    };
    const goOn = (nextWalk: ForwardWalk): ApplyResult => ({
      work: { satisfiesRevision: false, nextDueAt: now, cursor: { ...next, walk: nextWalk } },
      followups: [],
      counters,
    });

    if (rows.length === 0) {
      if (servedForm.mode === "unfiltered" && !next.unfilteredProbeSpent) {
        // Nothing new — or a filter. One declared-CSV call at this cursor tells
        // the two apart, once per page.
        next = { ...next, unfilteredProbeSpent: true };
        return goOn({ ...walk, probeBefore: params.before });
      }
      return complete("empty_page", servedForm);
    }
    // THE CURSOR MUST MOVE DOWN: a `before` page holds only rows older than
    // `before`; one that does not is a provider ignoring the cursor.
    if (params.before !== HEAD && bounds.oldest !== null && compareNotificationRefs(bounds.oldest, params.before) >= 0) {
      counters.cursor_repeat = 1;
      return complete("cursor_repeat", servedForm);
    }
    const newestSeen = cursor.newestSeenNotificationId;
    if (newestSeen !== null && pageReachesOverlap(rows, newestSeen)) return complete("overlap", servedForm);
    // The first ever poll: one page is the whole forward obligation.
    if (newestSeen === null) return complete("first_poll", servedForm);
    if (bounds.oldest === null) return complete("no_cursor", servedForm);
    return goOn({ ...walk, beforeRef: bounds.oldest });
  },

  async shadow(work, _request, ctx): Promise<ShadowResult> {
    // Steady state: ~15 notifications a day against ≈ 50 rows a page — one
    // page reaches the overlap.
    const cursor = parseForwardCursor(work.cursor);
    const step = advanceShadowWalk(cursor.shadow, () => 1);
    return step.finished
      ? { work: { satisfiesRevision: true, close: "done", closeReason: "shadow", cursor: { ...cursor, shadow: null } }, followups: [] }
      : { work: { satisfiesRevision: false, nextDueAt: ctx.now, cursor: { ...cursor, shadow: step.progress } }, followups: [] };
  },

  replay: replayByCanonicalDrafts,
};

// ── backfill ────────────────────────────────────────────────────────────────

const backfillModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    const cursor = parseBackfillCursor(work.cursor);
    const last = ctx.shadow ? null : await lastAttemptOf(ctx.db, work);
    const form = await nextForm(ctx.db, { work, own: cursor.form, pageId: ctx.pageId, shadow: ctx.shadow, sibling: FORWARD_KEY, last });
    return { kind: "request", request: notificationsRequest(cursor.nextBeforeRef, form) };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const now = input.now;
    const cursor = parseBackfillCursor(input.work.cursor);
    const params = pageParams(input.request);
    const form = formOfTypes(params.types) ?? cursor.form;
    if (params.before !== cursor.nextBeforeRef) {
      throw new ApplyQuarantine("notifications_cursor_mismatch", { requested: params.before, walk: cursor.nextBeforeRef });
    }
    const coverageCursor = (nextBeforeRef: string, floorAt: string | null) => ({ notificationFloorAt: floorAt, nextBeforeRef });
    if (cursor.lastRequestedBefore === params.before) {
      // A walk that re-asks for the same page walks nowhere: bounded by the
      // provider, not by us and not by exhaustion.
      await writeCoverage(tx, {
        pageId: input.pageId,
        plane: CAPTURE_COVERAGE_PLANES.notifications,
        status: "partial_provider_surface",
        proof: cursor.lastObservationId === null ? "none" : "terminal_response",
        now,
        reasonCode: "repeat_request",
        cursor: coverageCursor(params.before, cursor.floorAt),
        oldestCapturedAt: cursor.floorAt === null ? null : new Date(cursor.floorAt),
        proofObservationId: cursor.lastObservationId,
      });
      return {
        work: { satisfiesRevision: true, close: "done", closeReason: "backfill_cursor_repeat", cursor: { ...cursor, form } },
        followups: [],
        counters: { cursor_repeat: 1 },
      };
    }
    const response = input.parsed;
    if (classifyNotificationResponse(response) === "invalid") {
      throw new ApplyQuarantine("notifications_page_unreadable", { before: params.before });
    }
    const rows = notificationRows(response);
    const bounds = pageRefBounds(rows);
    const oldestIso = oldestCreatedAtIso(rows);
    const floorAt = oldestIso !== null && (cursor.floorAt === null || oldestIso < cursor.floorAt) ? oldestIso : cursor.floorAt;
    const next: NotificationsBackfillCursor = {
      ...cursor,
      lastRequestedBefore: params.before,
      lastObservationId: input.observation.id,
      floorAt,
      form,
      shadow: null,
    };
    if (bounds.oldest === null) {
      // THE FLOOR: an empty page. Unfiltered it is the archive's end; through
      // a narrowed form only the end of a filter.
      await writeCoverage(tx, {
        pageId: input.pageId,
        plane: CAPTURE_COVERAGE_PLANES.notifications,
        status: archiveStatus(form, "provider_exhausted"),
        proof: "empty_window",
        now,
        reasonCode: form.mode === "unfiltered" ? "empty_window" : "type_filter_narrowed",
        cursor: coverageCursor(params.before, floorAt),
        oldestCapturedAt: floorAt === null ? null : new Date(floorAt),
        proofObservationId: input.observation.id,
      });
      const receipt = { completedAt: now.toISOString(), notificationFloorAt: floorAt, proofObservationId: input.observation.id };
      return {
        work: { satisfiesRevision: true, close: "done", closeReason: "backfill_floor", cursor: next, proof: receipt },
        followups: [],
      };
    }
    const moved: NotificationsBackfillCursor = { ...next, nextBeforeRef: bounds.oldest };
    await writeCoverage(tx, {
      pageId: input.pageId,
      plane: CAPTURE_COVERAGE_PLANES.notifications,
      status: archiveStatus(form, "in_progress"),
      proof: "none",
      now,
      reasonCode: form.mode === "unfiltered" ? "backfill_walking" : "type_filter_narrowed",
      cursor: coverageCursor(bounds.oldest, floorAt),
      oldestCapturedAt: floorAt === null ? null : new Date(floorAt),
    });
    return { work: { satisfiesRevision: false, nextDueAt: now, cursor: moved }, followups: [] };
  },

  async shadow(work, _request, ctx): Promise<ShadowResult> {
    // The depth is unknown until the floor is read: one page per step, the
    // walk simulated as one page (the shadow report lists the backfill apart).
    const cursor = parseBackfillCursor(work.cursor);
    const step = advanceShadowWalk(cursor.shadow, () => 1);
    return step.finished
      ? { work: { satisfiesRevision: true, close: "done", closeReason: "shadow", cursor: { ...cursor, shadow: null } }, followups: [] }
      : { work: { satisfiesRevision: false, nextDueAt: ctx.now, cursor: { ...cursor, shadow: step.progress } }, followups: [] };
  },

  replay: replayByCanonicalDrafts,
};

export function notificationsModule(variant: NotificationsVariant): ResourceModule {
  return variant === "forward" ? forwardModule : backfillModule;
}
