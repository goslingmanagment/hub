import {
  getPublication,
  getPublicationRevision,
  insertPublicationCheck,
  listClaimedPlatformPostRefs,
  listCollectedPostsBetween,
  listOnlyfansCheckCandidates,
  transitionPublication,
  type OnlyfansCheckCandidate,
  type PublicationCheckKind,
  type PublicationCheckOutcome,
  type PublicationRecord,
} from "@agency_hub_core/db";
import {
  PUBLICATION_CHECK_DELAY_MINUTES,
  PUBLICATION_PROCESSING_RECHECK_HOURS,
  PUBLICATION_SEARCH_DAYS,
  PUBLICATION_SEARCH_READ_ROUNDS_MINUTES,
  PUBLICATION_WITHDRAW_MIN_LEAD_MINUTES,
  type PublicationStatus,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { notifyPublicationNotPublishedIncident } from "./notification-incidents.ts";
import {
  readOnlyfansLiveStories,
  readOnlyfansPostById,
  readOnlyfansPostsSince,
  readOnlyfansQueue,
  readOnlyfansStoryById,
  utcDay,
  type OnlyfansPlatformItem,
  type OnlyfansReadContext,
} from "./publications-onlyfans-reads.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

// Did it go out (docs/plans/2026-10-23-wall-posts, spec §3.6, §4, §8.2; plan
// PR 5a). Every minute Hub reads, fresh, the OnlyFans publications whose fate
// it does not know yet:
//
// - 10 minutes after its time, a post by its id (GET /posts/{id}) and a story
//   by its id (GET /stories/{id}); a story OnlyFans still prepares again at
//   +1 h and +6 h.
// - Found and out → "published". The id reads as absent → the schedule and
//   then the recent posts are read fresh (in that order, so a post moving from
//   one to the other between the reads is seen in one of them): the post
//   found there by its text, media and time is "published" with the id it
//   really has (the id OnlyFans answered the create with may be a schedule
//   id — plan §12, the owner's check); nothing there and both reads complete
//   → "not published", and the owner is paged; anything else → "unknown".
// - "Unknown" is looked for by reading only — the schedule, the recent posts,
//   the posts Hub collected — and settled when found. Hub never concludes "it
//   did not go out" for an unknown one: a person does (spec §8.2).
//
// Reads are retried (they are reads); nothing here writes to OnlyFans.

export const PUBLICATIONS_ONLYFANS_CHECKS_QUEUE = "publications.onlyfans.checks";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** A failed read is tried again this much later... */
export const CHECK_RETRY_MINUTES = 10;
/** ...and after this many in a row a post or story Hub cannot read turns "unknown" (about two hours). */
export const CHECK_MAX_FAILED_READS = 12;
/** The unknown search tries a round's fresh reads this many times before waiting for the next round. */
const SEARCH_MAX_FAILED_READS = 3;
/** Publications checked per minute: each check is one to six reads of up to a minute each. */
const CHECKS_PER_TICK = 10;
/** A post's time window starts this long before the earlier of its time and its send. */
const WINDOW_LEAD_MS = 5 * MINUTE_MS;
/** The unknown search looks this long after the later of its time and its send. */
const SEARCH_WINDOW_TAIL_MS = HOUR_MS;

export async function ensurePublicationsOnlyfansChecksQueue(boss: QueueCreationClient, createdQueues?: Set<string>) {
  await ensureQueueCreated(boss, PUBLICATIONS_ONLYFANS_CHECKS_QUEUE, { policy: "exclusive" }, createdQueues);
}

export async function ensurePublicationsOnlyfansChecksSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) return;
  await boss.schedule(PUBLICATIONS_ONLYFANS_CHECKS_QUEUE, "* * * * *", null, { tz: "UTC" });
}

// ---------------------------------------------------------------------------
// Matching (pure)
// ---------------------------------------------------------------------------

/** A caption as words: OnlyFans keeps the text as HTML, Hub as the person wrote it. */
export function normalizePostText(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export interface PublicationMatchTarget {
  text: string;
  /** Vault media ids; null when a file was uploaded (OnlyFans gives it an id Hub does not know). */
  mediaIds: readonly string[] | null;
  mediaCount: number;
  from: Date;
  to: Date;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
}

/**
 * Not ruled out: in the time window and with as many files, as far as the
 * read says. Only time and count rule a post out — a caption OnlyFans
 * reformatted, or a media id it renumbered, must never prove "not there".
 */
export function couldBePublication(target: PublicationMatchTarget, item: OnlyfansPlatformItem): boolean {
  if (item.at && (item.at.getTime() < target.from.getTime() || item.at.getTime() > target.to.getTime())) return false;
  const count = item.mediaIds?.length ?? item.mediaCount;
  return count === null || count === target.mediaCount;
}

/** Positively this publication: in the window, and the same caption (when it has one) or the same vault files. */
export function surelyPublication(target: PublicationMatchTarget, item: OnlyfansPlatformItem): boolean {
  if (item.at === null || !couldBePublication(target, item)) return false;
  if (target.mediaIds && target.mediaIds.length > 0 && item.mediaIds && !sameSet(target.mediaIds, item.mediaIds)) return false;
  const text = normalizePostText(target.text);
  if (text !== "" && item.text !== null && normalizePostText(item.text) === text) return true;
  return Boolean(target.mediaIds && target.mediaIds.length > 0 && item.mediaIds && sameSet(target.mediaIds, item.mediaIds));
}

export type PublicationMatch =
  | { kind: "one"; item: OnlyfansPlatformItem; ref: string }
  | { kind: "none" }
  | { kind: "ambiguous"; reason: string };

/**
 * The one post among `items` that is this publication: exactly one sure
 * match, not claimed by another publication of the page. Nothing that could
 * be it → none; anything else → ambiguous. A schedule entry is claimed by
 * the post inside it when it names one.
 */
export function findPublicationMatch(target: PublicationMatchTarget, items: readonly OnlyfansPlatformItem[], claimed: ReadonlySet<string>): PublicationMatch {
  const possible = items.filter((item) => couldBePublication(target, item));
  const sure = possible.filter((item) => surelyPublication(target, item));
  if (sure.length > 1) return { kind: "ambiguous", reason: "several_match" };
  const [one] = sure;
  if (one) {
    const ref = one.entityId ?? one.id;
    if (claimed.has(ref) || claimed.has(one.id)) return { kind: "ambiguous", reason: "claimed_by_another" };
    return { kind: "one", item: one, ref };
  }
  return possible.length === 0 ? { kind: "none" } : { kind: "ambiguous", reason: "could_be_unproven" };
}

// ---------------------------------------------------------------------------
// When (pure)
// ---------------------------------------------------------------------------

export type OnlyfansCheckPlan =
  | { action: "wait" }
  | { action: "verify"; final: boolean }
  | { action: "search"; fresh: boolean }
  | { action: "give_up" };

type CheckFacts = Pick<OnlyfansCheckCandidate, "status" | "publishAt" | "statusChangedAt" | "checks">;

function trailingFailures(checks: CheckFacts["checks"], since: Date) {
  let count = 0;
  let last: Date | null = null;
  for (const check of [...checks].reverse()) {
    if (check.at.getTime() < since.getTime()) break;
    if (check.outcome !== "read_failed") break;
    count += 1;
    last ??= check.at;
  }
  return { count, last };
}

/**
 * What to do with one publication at `now`. The checks are those since its
 * last status change. A scheduled one is read 10 minutes after its time; a
 * processing story at +1 h and +6 h (the last is final); an unknown one in
 * rounds after it became unknown — fresh reads at +10 min, +1 h, +6 h, +24 h,
 * then the collected posts once a day for a week. A failed read is tried
 * again 10 minutes later; a scheduled or processing one Hub cannot read for
 * twelve tries in a row turns unknown.
 */
export function onlyfansCheckPlan(c: CheckFacts, now: Date): OnlyfansCheckPlan {
  const at = now.getTime();
  const retryWait = (since: Date, maxFailed: number): "retry_later" | "give_up" | "go" => {
    const failures = trailingFailures(c.checks, since);
    if (failures.count >= maxFailed) return "give_up";
    if (failures.last && at < failures.last.getTime() + CHECK_RETRY_MINUTES * MINUTE_MS) return "retry_later";
    return "go";
  };
  const doneSince = (since: Date) => c.checks.some((check) => check.outcome !== "read_failed" && check.at.getTime() >= since.getTime());

  if (c.status === "scheduled") {
    if (at < c.publishAt.getTime() + PUBLICATION_CHECK_DELAY_MINUTES * MINUTE_MS) return { action: "wait" };
    if (doneSince(c.statusChangedAt)) return { action: "wait" };
    const retry = retryWait(c.statusChangedAt, CHECK_MAX_FAILED_READS);
    if (retry === "give_up") return { action: "give_up" };
    return retry === "retry_later" ? { action: "wait" } : { action: "verify", final: false };
  }
  if (c.status === "processing") {
    const thresholds = PUBLICATION_PROCESSING_RECHECK_HOURS.map((hours) => new Date(c.publishAt.getTime() + hours * HOUR_MS));
    const passed = thresholds.filter((threshold) => threshold.getTime() <= at);
    const latest = passed.at(-1);
    if (!latest) return { action: "wait" };
    const since = latest.getTime() > c.statusChangedAt.getTime() ? latest : c.statusChangedAt;
    if (doneSince(since)) return { action: "wait" };
    const retry = retryWait(since, CHECK_MAX_FAILED_READS);
    if (retry === "give_up") return { action: "give_up" };
    return retry === "retry_later" ? { action: "wait" } : { action: "verify", final: passed.length === thresholds.length };
  }
  if (c.status === "unknown") {
    const freshRounds = PUBLICATION_SEARCH_READ_ROUNDS_MINUTES.map((minutes) => ({ at: c.statusChangedAt.getTime() + minutes * MINUTE_MS, fresh: true }));
    const collectedRounds = Array.from({ length: PUBLICATION_SEARCH_DAYS - 1 }, (_, index) => ({ at: c.statusChangedAt.getTime() + (index + 2) * DAY_MS, fresh: false }));
    const latest = [...freshRounds, ...collectedRounds].filter((round) => round.at <= at).at(-1);
    if (!latest) return { action: "wait" };
    const since = new Date(latest.at);
    if (doneSince(since)) return { action: "wait" };
    return retryWait(since, SEARCH_MAX_FAILED_READS) === "go" ? { action: "search", fresh: latest.fresh } : { action: "wait" };
  }
  return { action: "wait" };
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/** What one check concluded. `status` moves the publication; null leaves it. */
interface Conclusion {
  outcome: PublicationCheckOutcome;
  status: PublicationStatus | null;
  reason: string | null;
  platformPostRef?: string | null;
  evidence: Record<string, unknown>;
}

const failed = (reason: string, evidence: Record<string, unknown>): Conclusion => ({ outcome: "read_failed", status: null, reason, evidence });
const conclude = (status: PublicationStatus & PublicationCheckOutcome, reason: string | null, evidence: Record<string, unknown>, platformPostRef?: string | null): Conclusion =>
  ({ outcome: status, status, reason, evidence, ...(platformPostRef === undefined ? {} : { platformPostRef }) });

function targetOf(record: PublicationRecord, from: Date, to: Date): PublicationMatchTarget {
  const media = record.media.filter((item) => item.role === "media");
  const vaultOnly = media.every((item) => item.source === "vault" && item.platformMediaRef !== null);
  return {
    text: record.kind === "story" ? "" : record.text,
    mediaIds: vaultOnly ? media.map((item) => item.platformMediaRef as string) : null,
    mediaCount: media.length,
    from,
    to,
  };
}

function collectedItems(rows: Awaited<ReturnType<typeof listCollectedPostsBetween>>): OnlyfansPlatformItem[] {
  return rows.map((row) => ({
    id: row.postRef,
    entityId: null,
    at: row.publishedAt,
    text: row.text,
    mediaIds: row.attachmentRefs.length === row.attachmentCount ? row.attachmentRefs : null,
    mediaCount: row.attachmentCount,
  }));
}

/** 10 minutes after its time: did the post go out (spec §3.6). */
async function verifyPost(ctx: OnlyfansReadContext, c: OnlyfansCheckCandidate, record: PublicationRecord, now: Date): Promise<Conclusion> {
  const ref = c.platformPostRef;
  if (!ref) return conclude("unknown", "no_platform_ref", {});
  const sentAt = c.dispatchedAt ?? c.publishAt;
  const target = targetOf(record, new Date(Math.min(c.publishAt.getTime(), sentAt.getTime()) - WINDOW_LEAD_MS), now);
  const byId = await readOnlyfansPostById(ctx, ref);
  const evidence: Record<string, unknown> = { createRef: ref, intentIds: [...byId.intentIds] };
  if (!byId.ok) return failed(`post_read: ${byId.reason}`, evidence);
  if (byId.found) {
    const post = byId.found;
    // The id names some post; it must also look like this one, or it is not ours.
    if (!couldBePublication(target, post)) return conclude("unknown", "id_reads_another_post", { ...evidence, postedAt: post.at?.toISOString() ?? null });
    if (post.at && post.at.getTime() > now.getTime() + MINUTE_MS) return conclude("unknown", "not_out_yet", { ...evidence, postedAt: post.at.toISOString() });
    return conclude("published", "read_by_id", evidence, ref);
  }
  // The id reads as absent. Schedule first, then the posts: a post moving
  // from one to the other between the two reads is seen in one of them.
  const queue = await readOnlyfansQueue(ctx, { from: utcDay(c.publishAt), to: utcDay(new Date(Math.max(c.publishAt.getTime(), now.getTime()))), maxListReads: 2, now });
  const posts = await readOnlyfansPostsSince(ctx, target.from);
  (evidence.intentIds as string[]).push(...queue.intentIds, ...posts.intentIds);
  const claimed = await listClaimedPlatformPostRefs(ctx.app.db, record.pageId, record.id);
  if (posts.ok) {
    if (posts.items.some((item) => item.id === ref)) return conclude("unknown", "list_shows_the_id", evidence);
    const match = findPublicationMatch(target, posts.items, claimed);
    // The create's id was not the post's (a schedule id): the post is found by its content.
    if (match.kind === "one") return conclude("published", "matched_by_content", { ...evidence, postRef: match.ref }, match.ref);
    if (match.kind === "ambiguous") return conclude("unknown", `posts_${match.reason}`, evidence);
  }
  if (!queue.ok) return failed(`queue_read: ${queue.reason}`, evidence);
  if (!posts.ok) return failed(`posts_read: ${posts.reason}`, evidence);
  const queued = queue.entries.filter((entry) => entry.id === ref || entry.entityId === ref || couldBePublication(target, entry));
  if (queued.length > 0) return conclude("unknown", "still_in_schedule", { ...evidence, queueIds: queued.map((entry) => entry.id) });
  if (!queue.complete) return conclude("unknown", `schedule_incomplete:${queue.incompleteReasons.join(",")}`, evidence);
  if (!posts.complete) return conclude("unknown", "posts_incomplete", evidence);
  return conclude("not_published", "absent_by_id_schedule_and_posts", evidence);
}

/** A story 10 minutes after its time, or OnlyFans still preparing it at +1 h / +6 h. */
async function verifyStory(ctx: OnlyfansReadContext, c: OnlyfansCheckCandidate, record: PublicationRecord, now: Date, final: boolean): Promise<Conclusion> {
  const ref = c.platformPostRef;
  if (!ref) return conclude("unknown", "no_platform_ref", {});
  const sentAt = c.dispatchedAt ?? c.publishAt;
  const target = targetOf(record, new Date(Math.min(c.publishAt.getTime(), sentAt.getTime()) - WINDOW_LEAD_MS), now);
  const byId = await readOnlyfansStoryById(ctx, ref);
  const evidence: Record<string, unknown> = { createRef: ref, intentIds: [...byId.intentIds] };
  if (!byId.ok) return failed(`story_read: ${byId.reason}`, evidence);
  const readiness = (isReady: boolean | null, storyRef: string, reason: string): Conclusion => {
    if (isReady === true) return conclude("published", reason, evidence, storyRef);
    if (isReady === false && !final) return conclude("processing", "still_processing", evidence, storyRef);
    return conclude("unknown", isReady === false ? "still_processing_at_last_check" : "readiness_unknown", evidence);
  };
  if (byId.found) return readiness(byId.found.isReady, ref, "read_by_id");
  const stories = await readOnlyfansLiveStories(ctx);
  (evidence.intentIds as string[]).push(...stories.intentIds);
  if (!stories.ok) return failed(`stories_read: ${stories.reason}`, evidence);
  if (stories.items.some((item) => item.id === ref)) return conclude("unknown", "list_shows_the_id", evidence);
  const claimed = await listClaimedPlatformPostRefs(ctx.app.db, record.pageId, record.id);
  const match = findPublicationMatch(target, stories.items, claimed);
  if (match.kind === "one") {
    const story = match.item as OnlyfansPlatformItem & { isReady?: boolean | null };
    return readiness(story.isReady ?? null, match.ref, "matched_by_content");
  }
  if (match.kind === "ambiguous") return conclude("unknown", `stories_${match.reason}`, evidence);
  return conclude("not_published", "absent_by_id_and_live_stories", evidence);
}

/**
 * Spec §8.2: an unknown publication is looked for by reading only, matched
 * by text, media and time, and settled when found. Not found stays unknown.
 */
async function searchUnknown(ctx: OnlyfansReadContext, c: OnlyfansCheckCandidate, record: PublicationRecord, now: Date, fresh: boolean): Promise<Conclusion> {
  const sentAt = c.dispatchedAt ?? c.publishAt;
  const from = new Date(Math.min(c.publishAt.getTime(), sentAt.getTime()) - WINDOW_LEAD_MS);
  const to = new Date(Math.max(c.publishAt.getTime(), sentAt.getTime()) + SEARCH_WINDOW_TAIL_MS);
  const target = targetOf(record, from, to);
  const claimed = await listClaimedPlatformPostRefs(ctx.app.db, record.pageId, record.id);
  const evidence: Record<string, unknown> = { createRef: c.platformPostRef, intentIds: [] as string[] };
  const intentIds = evidence.intentIds as string[];
  if (record.kind !== "story") {
    const collected = collectedItems(await listCollectedPostsBetween(ctx.app.db, { pageId: record.pageId, from, to }));
    if (c.platformPostRef && collected.some((item) => item.id === c.platformPostRef)) {
      return conclude("published", "collected_post_by_id", evidence, c.platformPostRef);
    }
    const match = findPublicationMatch(target, collected, claimed);
    if (match.kind === "one") return conclude("published", "found_in_collected_posts", { ...evidence, postRef: match.ref }, match.ref);
  }
  if (!fresh) return { outcome: "not_found", status: null, reason: "collected_posts_only", evidence };

  let failure: string | null = null;
  const ref = c.platformPostRef;
  if (record.kind === "story") {
    if (ref) {
      const byId = await readOnlyfansStoryById(ctx, ref);
      intentIds.push(...byId.intentIds);
      if (!byId.ok) failure = `story_read: ${byId.reason}`;
      else if (byId.found?.isReady === true) return conclude("published", "read_by_id", evidence, ref);
      else if (byId.found?.isReady === false) return conclude("processing", "read_by_id", evidence, ref);
    }
    const stories = await readOnlyfansLiveStories(ctx);
    intentIds.push(...stories.intentIds);
    if (!stories.ok) failure ??= `stories_read: ${stories.reason}`;
    else {
      const match = findPublicationMatch(target, stories.items, claimed);
      if (match.kind === "one") {
        const ready = (match.item as OnlyfansPlatformItem & { isReady?: boolean | null }).isReady;
        if (ready === true) return conclude("published", "matched_by_content", evidence, match.ref);
        if (ready === false) return conclude("processing", "matched_by_content", evidence, match.ref);
      }
    }
    return failure ? failed(failure, evidence) : { outcome: "not_found", status: null, reason: null, evidence };
  }

  if (ref) {
    const byId = await readOnlyfansPostById(ctx, ref);
    intentIds.push(...byId.intentIds);
    if (!byId.ok) failure = `post_read: ${byId.reason}`;
    else if (byId.found && couldBePublication({ ...target, to: new Date(Math.max(to.getTime(), now.getTime())) }, byId.found)) {
      const out = !byId.found.at || byId.found.at.getTime() <= now.getTime();
      return conclude(out ? "published" : "scheduled", "read_by_id", evidence, ref);
    }
  }
  // Still ahead (or just past): it may sit in OnlyFans' schedule.
  if (now.getTime() <= to.getTime()) {
    const queue = await readOnlyfansQueue(ctx, { from: utcDay(c.publishAt), to: utcDay(c.publishAt), maxListReads: 2, now });
    intentIds.push(...queue.intentIds);
    if (!queue.ok) failure ??= `queue_read: ${queue.reason}`;
    else {
      const byRef = ref ? queue.entries.filter((entry) => entry.id === ref || entry.entityId === ref) : [];
      if (byRef.length === 1) return conclude("scheduled", "found_in_schedule_by_id", evidence, ref);
      const match = findPublicationMatch(target, queue.entries, claimed);
      if (match.kind === "one") return conclude("scheduled", "found_in_schedule", { ...evidence, queueId: match.item.id }, match.ref);
      // A withdrawal OnlyFans confirmed whose read after could not: gone from a
      // complete schedule while its time is still ahead is withdrawn (plan PR 5b).
      if (c.withdrawState === "confirmed" && queue.complete && byRef.length === 0 && match.kind === "none"
        && c.publishAt.getTime() - now.getTime() >= PUBLICATION_WITHDRAW_MIN_LEAD_MINUTES * MINUTE_MS) {
        return conclude("withdrawn", "withdraw_confirmed_by_read", evidence);
      }
    }
  }
  if (c.publishAt.getTime() <= now.getTime()) {
    const posts = await readOnlyfansPostsSince(ctx, from);
    intentIds.push(...posts.intentIds);
    if (!posts.ok) failure ??= `posts_read: ${posts.reason}`;
    else {
      const match = findPublicationMatch(target, posts.items, claimed);
      if (match.kind === "one") return conclude("published", "found_in_posts", { ...evidence, postRef: match.ref }, match.ref);
    }
  }
  return failure ? failed(failure, evidence) : { outcome: "not_found", status: null, reason: null, evidence };
}

export interface OnlyfansChecksReport {
  checked: number;
  published: number;
  notPublished: number;
  unknown: number;
  settledUnknown: number;
  readFailures: number;
}

/** One minute's checks: reads keep working whatever the publishing switches say (spec §8.4). */
export async function runOnlyfansChecksTick(app: AppContext, now = new Date()): Promise<OnlyfansChecksReport> {
  const report: OnlyfansChecksReport = { checked: 0, published: 0, notPublished: 0, unknown: 0, settledUnknown: 0, readFailures: 0 };
  // No OnlyFansAPI here (a dev stand): nothing can be read, and a failure would count toward "unknown".
  if (!app.ofapi?.dispatchGovernedRaw) return report;
  for (const candidate of await listOnlyfansCheckCandidates(app.db)) {
    if (report.checked >= CHECKS_PER_TICK) break;
    const plan = onlyfansCheckPlan(candidate, now);
    if (plan.action === "wait") continue;
    report.checked += 1;
    try {
      await checkOne(app, candidate, plan, now, report);
    } catch (error) {
      app.logger?.warn({ error, publicationId: candidate.id }, "publications: OnlyFans check failed");
      // Counted as a failed read, so a check that keeps crashing waits its turn instead of reading every minute.
      await insertPublicationCheck(app.db, {
        publicationId: candidate.id, kind: plan.action === "search" ? "search" : "verify", outcome: "read_failed",
        reason: "check_crashed", platformPostRef: null, evidence: {}, at: now,
      }).catch(() => undefined);
    }
  }
  return report;
}

async function checkOne(app: AppContext, c: OnlyfansCheckCandidate, plan: Exclude<OnlyfansCheckPlan, { action: "wait" }>, now: Date, report: OnlyfansChecksReport) {
  const record = await getPublication(app.db, c.id);
  if (!record || record.status !== c.status) return;
  const kind: PublicationCheckKind = plan.action === "search" ? "search" : "verify";
  if (plan.action === "give_up") {
    await settle(app, record, kind, conclude("unknown", "reads_failed", {}), now, report);
    return;
  }
  const revision = await getPublicationRevision(app.db, c.approvedRevisionId);
  if (!revision) return;
  const ctx: OnlyfansReadContext = { app, pageId: record.pageId, actorUserId: revision.approvedByUserId };
  const conclusion = plan.action === "search"
    ? await searchUnknown(ctx, c, record, now, plan.fresh)
    : record.kind === "story"
      ? await verifyStory(ctx, c, record, now, plan.final)
      : await verifyPost(ctx, c, record, now);
  await settle(app, record, kind, conclusion, now, report);
}

/** Record the check, then move the publication; a post another publication already claims is not taken twice. */
async function settle(app: AppContext, record: PublicationRecord, kind: PublicationCheckKind, conclusion: Conclusion, now: Date, report: OnlyfansChecksReport) {
  let result = conclusion;
  if (result.status !== null && result.status !== record.status) {
    const moved = await transitionPublication(app.db, {
      id: record.id, from: record.status, to: result.status, actor: { kind: "hub" }, reason: result.reason,
      ...(result.platformPostRef === undefined || result.platformPostRef === record.platformPostRef ? {} : { platformPostRef: result.platformPostRef }),
    }).catch(async (error: unknown) => {
      // publications_page_platform_post_uidx: the post is another publication's.
      if ((error as { code?: string }).code !== "23505") throw error;
      result = conclude("unknown", "post_claimed_by_another", { ...result.evidence, postRef: result.platformPostRef ?? null });
      if (record.status === "unknown") return false;
      return transitionPublication(app.db, { id: record.id, from: record.status, to: "unknown", actor: { kind: "hub" }, reason: result.reason });
    });
    if (!moved) return;
  }
  await insertPublicationCheck(app.db, {
    publicationId: record.id, kind, outcome: result.outcome, reason: result.reason,
    platformPostRef: result.platformPostRef ?? null, evidence: result.evidence, at: now,
  });
  if (result.outcome === "read_failed") report.readFailures += 1;
  if (result.status === "published") report.published += 1;
  if (result.status === "unknown" && record.status !== "unknown") report.unknown += 1;
  if (record.status === "unknown" && result.status !== null && result.status !== "unknown") report.settledUnknown += 1;
  if (result.status === "not_published") {
    report.notPublished += 1;
    await notifyPublicationNotPublishedIncident(app, {
      pageId: record.pageId, pageLabel: record.pageLabel, platform: "onlyfans", publicationId: record.id,
      publishAt: record.publishAt, reason: result.reason ?? "not_published", occurredAt: now,
    }).catch((error: unknown) => {
      app.logger?.warn({ error, publicationId: record.id }, "publications: not-published notice failed");
    });
  }
}
