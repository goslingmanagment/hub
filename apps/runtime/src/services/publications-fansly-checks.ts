import type { PublicationQueueSnapshotWire } from "@agency_hub_core/contracts";
import {
  getLatestFanslyVerifyWork,
  getPublication,
  getPublicationDispatch,
  getSyncPage,
  insertPublicationCheck,
  listClaimedPlatformPostRefs,
  listCollectedPostsBetween,
  listFanslyCheckCandidates,
  listFanslyQueuePages,
  listFanslyWriteCommandsOfDispatch,
  listPublicationQueueSnapshots,
  listPublicationsByPlatformPostRef,
  transitionPublication,
  upsertDemand,
  type FanslyCheckCandidate,
  type FanslyVerifyWorkFacts,
  type FanslyWriteCommandRecord,
  type PublicationCheckKind,
  type PublicationCheckOutcome,
  type PublicationRecord,
} from "@agency_hub_core/db";
import { FANSLY_PUBLISH_FACTS_VERIFIED, type FanslyPublishFacts } from "@agency_hub_core/fansly";
import { PUBLICATION_WITHDRAW_MIN_LEAD_MINUTES, type PublicationStatus } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { demandToUpsert } from "../sync/engine/resource.ts";
import {
  FANSLY_SCHEDULE_KEY,
  FANSLY_VERIFY_KEY,
  parsePublicationReads,
  type FanslyPublicationReads,
  type FanslyReadPost,
  type FanslyReadsMode,
  type FanslyScheduleEntry,
} from "../sync/fansly/publish/reads.ts";
import { fanslyResourceSpec } from "../sync/fansly/registry.ts";
import { notifyPublicationNotPublishedIncident } from "./notification-incidents.ts";
import { couldBePublication, findPublicationMatch, onlyfansCheckPlan, type PublicationMatchTarget } from "./publications-onlyfans-checks.ts";
import type { OnlyfansPlatformItem } from "./publications-onlyfans-reads.ts";

// Did the Fansly post go out (docs/plans/2026-10-23-wall-posts, spec §3.6, §4,
// §8.2; plan PR 9). Every minute, for the Fansly publications whose fate Hub
// does not know yet — on the same plan as OnlyFans (`onlyfansCheckPlan`: 10
// minutes after the time, retries every 10 minutes, twelve failures → unknown;
// an unknown one in rounds at +10 min, +1 h, +6 h, +24 h, then the collected
// posts daily for a week):
//
// - the reads are the page engine's (`publish.verify`, sync/fansly/publish/
//   reads.ts): this job asks for them and, once they are taken, concludes from
//   them — every read through the page's one sender, at its pace, journaled
//   first. A check whose work is consumed records its id (`evidence.workId`).
// - a post: by its id, the schedule (still in it → it did not go out yet),
//   the head of the timeline by its content (a scheduled post that took a new
//   id when it went out is found there; the id Hub held is kept in evidence).
//   Found → "published"; still scheduled after its time → "unknown";
//   "not published" only when the reads PROVE it — absent by id, absent from a
//   complete schedule, absent from a timeline that reaches back past its time
//   — and only once the stand confirmed what such absences mean
//   (`FANSLY_PUBLISH_FACTS_VERIFIED`); until then "unknown", a person decides.
// - a story: the account's stories (`GET /mediastoriesnew`, the contract §7):
//   found by the id its create answered, it is out; not found proves nothing,
//   so a story not found ends "unknown" — never "not published" from it.
// - "unknown" is looked for by reading only and settled when found (spec §8.2).
// Also here: the owner's "Обновить" of a Fansly page's schedule asks its poll.
//
// Reads only: nothing here writes to Fansly, and it runs whatever the
// switches say (spec §8.4).

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** Publications checked per minute. */
const CHECKS_PER_TICK = 20;
/** A post's time window starts this long before the earlier of its time and its send. */
const WINDOW_LEAD_MS = 5 * MINUTE_MS;
/** The unknown search looks this long after the later of its time and its send. */
const SEARCH_WINDOW_TAIL_MS = HOUR_MS;
/** A verify work still open this long after it was asked for counts as a failed read (the page held, its reads failing). */
export const FANSLY_VERIFY_STALL_MS = 3 * HOUR_MS;

// ---------------------------------------------------------------------------
// Conclusions (pure)
// ---------------------------------------------------------------------------

/** What a check knows of the publication it looks for. */
export interface FanslyCheckTarget extends PublicationMatchTarget {
  kind: string;
  /** The post or story id Fansly answered the create with. */
  ref: string | null;
  publishAt: Date;
  /** When the post's or story's request was admitted (null: not known). */
  sentAt: Date | null;
  /** Fansly answered Hub's cancel of it (plan PR 9): a later complete read without it, its time ahead, is "withdrawn". */
  withdrawAnswered?: boolean;
}

export interface FanslyConclusion {
  outcome: PublicationCheckOutcome;
  /** The status the publication moves to; null leaves it. */
  status: PublicationStatus | null;
  reason: string | null;
  platformPostRef?: string | null;
  evidence: Record<string, unknown>;
}

const failed = (reason: string, evidence: Record<string, unknown> = {}): FanslyConclusion => ({ outcome: "read_failed", status: null, reason, evidence });
const notFound = (reason: string | null, evidence: Record<string, unknown> = {}): FanslyConclusion => ({ outcome: "not_found", status: null, reason, evidence });
const conclude = (status: PublicationStatus & PublicationCheckOutcome, reason: string, evidence: Record<string, unknown> = {}, platformPostRef?: string | null): FanslyConclusion =>
  ({ outcome: status, status, reason, evidence, ...(platformPostRef === undefined ? {} : { platformPostRef }) });

function itemOfPost(post: FanslyReadPost): OnlyfansPlatformItem {
  return {
    id: post.id, entityId: null, at: post.atMs === null ? null : new Date(post.atMs), text: post.text,
    mediaIds: post.attachmentIds, mediaCount: post.attachmentIds?.length ?? null,
  };
}

function itemOfEntry(entry: FanslyScheduleEntry): OnlyfansPlatformItem {
  return {
    id: entry.postId, entityId: null, at: entry.scheduledForMs === null ? null : new Date(entry.scheduledForMs), text: entry.text,
    mediaIds: entry.attachmentIds, mediaCount: entry.attachmentIds?.length ?? null,
  };
}

/** Which facts an absence still lacks before it proves "not published". */
function unprovenBy(input: {
  facts: FanslyPublishFacts;
  scheduleComplete: boolean;
  timelineReachesBack: boolean;
}): string[] {
  const missing: string[] = [];
  if (!input.facts.scheduledPostKeepsId) missing.push("post_id_kept_unverified");
  if (!input.facts.scheduleListWhole) missing.push("schedule_whole_unverified");
  else if (!input.scheduleComplete) missing.push("schedule_incomplete");
  if (!input.timelineReachesBack) missing.push("timeline_short");
  return missing;
}

/** 10 minutes after its time: did the post or story go out (spec §3.6). */
export function concludeFanslyVerify(input: {
  target: FanslyCheckTarget;
  reads: FanslyPublicationReads;
  claimed: ReadonlySet<string>;
  now: Date;
  facts?: FanslyPublishFacts;
}): FanslyConclusion {
  const { target, reads, now } = input;
  const facts = input.facts ?? FANSLY_PUBLISH_FACTS_VERIFIED;
  const evidence: Record<string, unknown> = { createRef: target.ref };
  if (reads.gaveUp !== undefined) return failed(`reads_${reads.gaveUp}`, evidence);
  if (target.kind === "story") {
    // The account's stories (the contract §7): found by its id, it is out;
    // its absence proves nothing (the list's shape is not captured).
    if (reads.stories === undefined) return failed("stories_not_read", evidence);
    evidence.stories = { listed: reads.stories.listed, count: reads.stories.ids.length };
    if (!facts.storyListRead) return conclude("unknown", "story_read_unverified", evidence);
    if (target.ref !== null && reads.stories.ids.includes(target.ref)) return conclude("published", "story_listed", evidence, target.ref);
    return conclude("unknown", "story_not_listed", evidence);
  }
  const schedule = reads.schedule;
  if (schedule === undefined) return failed("schedule_not_read", evidence);
  if (!schedule.ok) return failed(`schedule: ${schedule.reason}`, evidence);
  if (target.ref !== null && reads.byId === undefined) return failed("post_not_read_by_id", evidence);
  evidence.schedule = { complete: schedule.complete, incompleteReasons: schedule.incompleteReasons, statuses: schedule.statuses };
  // Still in Fansly's schedule after its time: it did not go out yet.
  if (target.ref !== null && schedule.active.some((entry) => entry.postId === target.ref)) return conclude("unknown", "still_in_schedule", evidence);
  const found = reads.byId?.found ?? null;
  if (found !== null) {
    evidence.postedAt = found.atMs === null ? null : new Date(found.atMs).toISOString();
    if (found.atMs !== null && found.atMs > now.getTime() + MINUTE_MS) return conclude("unknown", "not_out_yet", evidence);
    // The id names some post; it must also look like this one.
    if (!couldBePublication(target, itemOfPost(found))) return conclude("unknown", "id_reads_another_post", evidence);
    return conclude("published", "read_by_id", evidence, target.ref);
  }
  // Absent by its id. A post with a new id still in the schedule…
  const scheduled = findPublicationMatch(target, schedule.active.map(itemOfEntry), input.claimed);
  if (scheduled.kind !== "none") return conclude("unknown", scheduled.kind === "one" ? "still_in_schedule_by_content" : `schedule_${scheduled.reason}`, evidence);
  // …or on the wall under the id it took when it went out.
  if (reads.timeline === undefined) return failed("timeline_not_read", evidence);
  if (target.ref !== null && reads.timeline.posts.some((post) => post.id === target.ref)) return conclude("unknown", "list_shows_the_id", evidence);
  const match = findPublicationMatch(target, reads.timeline.posts.map(itemOfPost), input.claimed);
  if (match.kind === "one") return conclude("published", "matched_by_content", { ...evidence, postRef: match.ref }, match.ref);
  if (match.kind === "ambiguous") return conclude("unknown", `timeline_${match.reason}`, evidence);
  const missing = unprovenBy({
    facts,
    scheduleComplete: schedule.complete,
    timelineReachesBack: reads.timeline.oldestMs !== null && reads.timeline.oldestMs < target.from.getTime(),
  });
  if (missing.length > 0) return conclude("unknown", `absent_unproven:${missing.join(",")}`, evidence);
  return conclude("not_published", "absent_by_id_schedule_and_timeline", evidence);
}

/** Spec §8.2: an unknown publication, looked for by fresh reads; settled when found, never "not published". */
export function concludeFanslySearch(input: {
  target: FanslyCheckTarget;
  reads: FanslyPublicationReads;
  claimed: ReadonlySet<string>;
  now: Date;
  facts?: FanslyPublishFacts;
}): FanslyConclusion {
  const { target, reads, now } = input;
  const facts = input.facts ?? FANSLY_PUBLISH_FACTS_VERIFIED;
  const evidence: Record<string, unknown> = { createRef: target.ref };
  if (reads.gaveUp !== undefined) return failed(`reads_${reads.gaveUp}`, evidence);
  if (target.kind === "story") {
    if (reads.stories === undefined) return failed("stories_not_read", evidence);
    evidence.stories = { listed: reads.stories.listed, count: reads.stories.ids.length };
    if (facts.storyListRead && target.ref !== null && reads.stories.ids.includes(target.ref)) return conclude("published", "story_listed", evidence, target.ref);
    return notFound(facts.storyListRead ? null : "story_read_unverified", evidence);
  }
  const ahead = target.publishAt.getTime() > now.getTime();
  let failure: string | null = null;
  const schedule = reads.schedule;
  if (schedule === undefined || !schedule.ok) failure = schedule === undefined ? "schedule_not_read" : `schedule: ${schedule.reason}`;
  else {
    const byRef = target.ref === null ? [] : schedule.active.filter((entry) => entry.postId === target.ref);
    if (byRef.length === 1 && ahead) return conclude("scheduled", "found_in_schedule_by_id", evidence, target.ref);
    const match = findPublicationMatch({ ...target, to: new Date(Math.max(target.to.getTime(), target.publishAt.getTime() + MINUTE_MS)) }, schedule.active.map(itemOfEntry), input.claimed);
    if (match.kind === "one" && ahead) return conclude("scheduled", "found_in_schedule", { ...evidence, postRef: match.ref }, match.ref);
    if (byRef.length > 0 || match.kind !== "none") return notFound("still_in_schedule", evidence);
    // A cancel Fansly answered whose read after could not confirm it: gone
    // from a whole schedule while its time is well ahead is withdrawn.
    if (target.withdrawAnswered === true && facts.scheduleListWhole && schedule.complete
      && target.publishAt.getTime() - now.getTime() >= PUBLICATION_WITHDRAW_MIN_LEAD_MINUTES * MINUTE_MS) {
      return conclude("withdrawn", "withdraw_confirmed_by_read", evidence);
    }
  }
  const found = reads.byId?.found ?? null;
  if (found !== null && !ahead && couldBePublication({ ...target, to: new Date(Math.max(target.to.getTime(), now.getTime())) }, itemOfPost(found))) {
    return conclude("published", "read_by_id", evidence, target.ref);
  }
  if (reads.timeline !== undefined) {
    const match = findPublicationMatch(target, reads.timeline.posts.map(itemOfPost), input.claimed);
    if (match.kind === "one") return conclude("published", "found_in_timeline", { ...evidence, postRef: match.ref }, match.ref);
  } else if (!ahead) {
    failure ??= "timeline_not_read";
  }
  return failure === null ? notFound(null, evidence) : failed(failure, evidence);
}

/** The free half of the search (spec §8.2): the posts Hub collected, by the id or by content. */
export function concludeFanslyCollected(input: {
  target: FanslyCheckTarget;
  posts: ReadonlyArray<{ postRef: string; publishedAt: Date; text: string; attachmentCount: number; attachmentRefs: string[] }>;
  claimed: ReadonlySet<string>;
}): FanslyConclusion {
  const { target } = input;
  const evidence: Record<string, unknown> = { createRef: target.ref };
  if (target.ref !== null && input.posts.some((post) => post.postRef === target.ref)) return conclude("published", "collected_post_by_id", evidence, target.ref);
  const items: OnlyfansPlatformItem[] = input.posts.map((post) => ({
    id: post.postRef, entityId: null, at: post.publishedAt, text: post.text,
    mediaIds: post.attachmentRefs.length === post.attachmentCount ? post.attachmentRefs : null, mediaCount: post.attachmentCount,
  }));
  const match = findPublicationMatch(target, items, input.claimed);
  if (match.kind === "one") return conclude("published", "found_in_collected_posts", { ...evidence, postRef: match.ref }, match.ref);
  return notFound("collected_posts_only", evidence);
}

/** The content ids the post's own request carried (its recorded body): what the wall will show it with. */
export function postAttachmentIds(commands: readonly FanslyWriteCommandRecord[]): string[] | null {
  const post = commands.find((command) => command.step === "post" && command.request !== null && command.state !== "refused");
  if (post?.request === null || post === undefined) return null;
  try {
    const body: unknown = JSON.parse(post.request.body);
    const attachments = (body as { attachments?: unknown }).attachments;
    if (!Array.isArray(attachments)) return null;
    const ids = attachments.map((item) => (typeof (item as { contentId?: unknown }).contentId === "string" ? (item as { contentId: string }).contentId : null));
    return ids.every((id) => id !== null) ? ids as string[] : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export interface FanslyChecksReport {
  checked: number;
  /** Reads asked of the pages' engines. */
  readsAsked: number;
  published: number;
  notPublished: number;
  unknown: number;
  settledUnknown: number;
  readFailures: number;
  /** Fansly pages whose schedule the owner asked to read at once. */
  scheduleRefreshes: number;
}

export interface FanslyChecksOptions {
  now?: Date;
  facts?: FanslyPublishFacts;
}

/** One minute's checks and the owner's schedule refreshes; reads only, whatever the switches say. */
export async function runFanslyChecksTick(app: AppContext, options: FanslyChecksOptions = {}): Promise<FanslyChecksReport> {
  const now = options.now ?? new Date();
  const report: FanslyChecksReport = {
    checked: 0, readsAsked: 0, published: 0, notPublished: 0, unknown: 0, settledUnknown: 0, readFailures: 0, scheduleRefreshes: 0,
  };
  for (const candidate of await listFanslyCheckCandidates(app.db)) {
    if (report.checked >= CHECKS_PER_TICK) break;
    const plan = onlyfansCheckPlan(candidate, now);
    if (plan.action === "wait") continue;
    report.checked += 1;
    try {
      await checkOne(app, candidate, plan, now, options.facts ?? FANSLY_PUBLISH_FACTS_VERIFIED, report);
    } catch (error) {
      app.logger?.warn({ error, publicationId: candidate.id }, "publications: Fansly check failed");
      await insertPublicationCheck(app.db, {
        publicationId: candidate.id, kind: plan.action === "search" ? "search" : "verify", outcome: "read_failed",
        reason: "check_crashed", platformPostRef: null, evidence: {}, at: now,
      }).catch(() => undefined);
    }
  }
  report.scheduleRefreshes = await askRequestedScheduleReads(app, now);
  return report;
}

/** The owner's "Обновить" on a Fansly page: its schedule poll is due now. */
async function askRequestedScheduleReads(app: AppContext, now: Date): Promise<number> {
  const pages = await listFanslyQueuePages(app.db);
  const snapshots = await listPublicationQueueSnapshots(app.db, pages.map((page) => page.pageId));
  let asked = 0;
  for (const snapshot of snapshots) {
    if (snapshot.refreshRequestedAt === null) continue;
    // Pressed after the last read began: ask (again) — the poll row takes the demand, a second ask changes nothing.
    if (await askScheduleRead(app, snapshot.pageId, now, "publication:refresh")) asked += 1;
  }
  return asked;
}

/** Make the page's schedule poll due now (`publish.schedule`, trigger `publication`). */
export async function askScheduleRead(app: AppContext, pageId: number, now: Date, reason: string): Promise<boolean> {
  const spec = fanslyResourceSpec(FANSLY_SCHEDULE_KEY);
  const page = await getSyncPage(app.db, pageId);
  if (spec === null || page === null) return false;
  const upsert = demandToUpsert({ resource: FANSLY_SCHEDULE_KEY, demand: { reason } }, spec, { pageId, now, page });
  if (upsert === null) return false;
  await upsertDemand(app.db, upsert);
  return true;
}

/** Ask the page's engine for a publication's fresh reads (`publish.verify`, trigger `publication`); never beside an open one. */
export async function askVerifyReads(app: AppContext, input: { pageId: number; publicationId: number; mode: FanslyReadsMode; now: Date }): Promise<boolean> {
  const spec = fanslyResourceSpec(FANSLY_VERIFY_KEY);
  const page = await getSyncPage(app.db, input.pageId);
  if (spec === null || page === null) return false;
  const upsert = demandToUpsert({
    resource: FANSLY_VERIFY_KEY, subject: String(input.publicationId), params: { v: 1, mode: input.mode },
    demand: { reason: `publication:${input.publicationId}:${input.mode}` },
  }, spec, { pageId: input.pageId, now: input.now, page });
  if (upsert === null) return false;
  await upsertDemand(app.db, { ...upsert, createOnly: true });
  return true;
}

/** Whether the publication's newest verify work is this check's: asked for since its last status change and not concluded from yet. */
function currentWork(candidate: FanslyCheckCandidate, work: FanslyVerifyWorkFacts | null): FanslyVerifyWorkFacts | null {
  if (work === null || candidate.consumedWorkIds.includes(work.id)) return null;
  return work.createdAt.getTime() >= candidate.statusChangedAt.getTime() ? work : null;
}

async function checkOne(
  app: AppContext,
  c: FanslyCheckCandidate,
  plan: Exclude<ReturnType<typeof onlyfansCheckPlan>, { action: "wait" }>,
  now: Date,
  facts: FanslyPublishFacts,
  report: FanslyChecksReport,
) {
  const record = await getPublication(app.db, c.id);
  if (record === null || record.status !== c.status) return;
  const kind: PublicationCheckKind = plan.action === "search" ? "search" : "verify";
  if (plan.action === "give_up") {
    await settle(app, record, kind, conclude("unknown", "reads_failed"), now, report);
    return;
  }
  const dispatch = await getPublicationDispatch(app.db, record.id, "create");
  const commands = dispatch === null ? [] : await listFanslyWriteCommandsOfDispatch(app.db, dispatch.id);
  const last = commands.find((command) => (command.step === "post" || command.step === "story") && command.state !== "refused");
  const sentAt = last?.admittedAt ?? c.dispatchedAt;
  const searching = plan.action === "search";
  const from = new Date(Math.min(record.publishAt.getTime(), (sentAt ?? record.publishAt).getTime()) - WINDOW_LEAD_MS);
  const to = searching ? new Date(Math.max(record.publishAt.getTime(), (sentAt ?? record.publishAt).getTime()) + SEARCH_WINDOW_TAIL_MS) : now;
  const attachmentIds = postAttachmentIds(commands);
  const target: FanslyCheckTarget = {
    kind: record.kind,
    ref: record.platformPostRef,
    publishAt: record.publishAt,
    sentAt,
    withdrawAnswered: c.withdrawState === "answered",
    text: record.kind === "story" ? "" : record.text,
    mediaIds: attachmentIds,
    // Without the post's own request, its files' count is the best Hub knows.
    mediaCount: attachmentIds?.length ?? record.media.filter((item) => item.role === "media").length,
    from,
    to,
  };
  const claimed = await listClaimedPlatformPostRefs(app.db, record.pageId, record.id);
  if (plan.action === "search" && !plan.fresh) {
    if (record.kind === "story") {
      await settle(app, record, kind, notFound("story_not_collected"), now, report);
      return;
    }
    const posts = await listCollectedPostsBetween(app.db, { pageId: record.pageId, from, to });
    await settle(app, record, kind, concludeFanslyCollected({ target, posts, claimed }), now, report);
    return;
  }
  const work = currentWork(c, await getLatestFanslyVerifyWork(app.db, { pageId: record.pageId, publicationId: record.id }));
  if (work !== null && work.closedAt === null) {
    // Its reads are under way; one stuck for hours counts as a failed read (retried, twelve → unknown).
    if (now.getTime() - work.createdAt.getTime() > FANSLY_VERIFY_STALL_MS) {
      await settle(app, record, kind, failed(`reads_stalled:${work.state}`), now, report);
    }
    return;
  }
  if (work !== null) {
    const reads = parsePublicationReads(work.result);
    const evidence = { workId: work.id };
    const conclusion = reads === null
      ? failed(`reads_missing:${work.closeReason ?? work.state}`)
      : searching
        ? concludeFanslySearch({ target, reads, claimed, now, facts })
        : concludeFanslyVerify({ target, reads, claimed, now, facts });
    await settle(app, record, kind, { ...conclusion, evidence: { ...conclusion.evidence, ...evidence } }, now, report);
    return;
  }
  if (await askVerifyReads(app, { pageId: record.pageId, publicationId: record.id, mode: searching ? "search" : "verify", now })) report.readsAsked += 1;
}

/** Record the check, then move the publication; a post another publication already claims is not taken twice. */
async function settle(app: AppContext, record: PublicationRecord, kind: PublicationCheckKind, conclusion: FanslyConclusion, now: Date, report: FanslyChecksReport) {
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
      pageId: record.pageId, pageLabel: record.pageLabel, platform: "fansly", publicationId: record.id,
      publishAt: record.publishAt, reason: result.reason ?? "not_published", occurredAt: now,
    }).catch((error: unknown) => {
      app.logger?.warn({ error, publicationId: record.id }, "publications: not-published notice failed");
    });
  }
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

/** Fansly's schedule is read hourly: a read older than two hours is not fresh. */
const FANSLY_SCHEDULE_STALE_MS = 2 * HOUR_MS;

/** The screen's view of every Fansly page's schedule: Hub's posts in it and the ones put there by hand. */
export async function listFanslyQueueWire(app: AppContext, now = new Date()): Promise<PublicationQueueSnapshotWire[]> {
  const pages = await listFanslyQueuePages(app.db);
  const snapshots = new Map((await listPublicationQueueSnapshots(app.db, pages.map((page) => page.pageId))).map((row) => [row.pageId, row]));
  const out: PublicationQueueSnapshotWire[] = [];
  for (const page of pages) {
    const snapshot = snapshots.get(page.pageId);
    const claimed = await listPublicationsByPlatformPostRef(app.db, page.pageId);
    const readAt = snapshot?.readAt ?? null;
    out.push({
      pageLabel: page.pageLabel,
      platform: "fansly",
      readAt: readAt?.toISOString() ?? null,
      windowFrom: snapshot?.windowFrom ?? null,
      windowTo: snapshot?.windowTo ?? null,
      complete: snapshot?.complete ?? false,
      incompleteReasons: snapshot?.incompleteReasons ?? [],
      stale: readAt === null || now.getTime() - readAt.getTime() > FANSLY_SCHEDULE_STALE_MS,
      postsPerDay: snapshot?.postsPerDay ?? {},
      refreshRequestedAt: snapshot?.refreshRequestedAt?.toISOString() ?? null,
      lastFailure: snapshot?.lastFailure ?? null,
      lastFailedAt: snapshot?.lastFailedAt?.toISOString() ?? null,
      entries: (snapshot?.entries ?? []).map((entry) => {
        const publication = (entry.postRef ? claimed.get(entry.postRef) : undefined) ?? null;
        return { ...entry, publicationId: publication?.id ?? null };
      }),
    });
  }
  return out;
}
