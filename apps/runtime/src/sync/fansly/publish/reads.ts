import {
  fanslyScheduleReadWanted,
  getPublication,
  recordPublicationQueueFailure,
  savePublicationQueueSnapshot,
  type Database,
  type PublicationQueueEntryFacts,
  type SyncWorkRow,
} from "@agency_hub_core/db";
import {
  FANSLY_HEAD_CURSOR,
  FANSLY_PUBLISH_FACTS_VERIFIED,
  FANSLY_SCHEDULED_STATUS,
  type FanslyPublishFacts,
} from "@agency_hub_core/fansly";

import type { ApplyInput, ApplyResult, LocalApplyInput, PlanContext, ResourceModule, StepPlan } from "../../engine/resource.ts";
import { readFanslyPageFacts } from "../lib/page-facts.ts";

// Hub's reads of its own Fansly posts (wall posts PR 9, spec §3.6, §8.2, §9):
//
// - `publish.schedule` (poll, hourly, and at once when the Publications job
//   asks — the owner's "Обновить", a check, a withdrawal): `GET
//   /post/scheduled`, the page's whole schedule as Fansly lists it, by Hub or
//   by hand. Its latest read is the page's row of `publication_queue_snapshots`
//   (the screen's "поставлено вручную", its "неполно" and "несвежее").
// - `publish.verify` (a goal per publication, its subject the publication's
//   id, asked for by the Publications job): the fresh reads a check needs —
//   the post by its id (`GET /post?ids=`), the schedule, the head of the
//   timeline when the id does not show it; for a story, the account's stories
//   (`GET /mediastoriesnew?accountId=`, the contract §7). It concludes
//   nothing: it gathers the reads into its result, and the job decides
//   (services/publications-fansly-checks.ts). Mode `deleted` (0305): after
//   the owner had Hub delete the post, the post by its id alone — Fansly
//   lists nothing for a deleted one (the contract §5); the deletion's job
//   decides (services/publications-fansly-delete.ts).
//
// Every answer is journaled before this reads it, as every read of the engine.
// What these reads may prove is the stand's to confirm
// (`FANSLY_PUBLISH_FACTS_VERIFIED`): until then the snapshot is "неполно" and
// no absence proves anything.

export const FANSLY_SCHEDULE_KEY = "publish.schedule";
export const FANSLY_VERIFY_KEY = "publish.verify";

const MINUTE_MS = 60_000;
/** A verify work that has not finished its reads this long after it was asked
 *  for gives up (its reads keep failing, or the page is held): the job counts
 *  it as a failed read and asks again later. */
export const FANSLY_VERIFY_GIVE_UP_MS = 2 * 60 * MINUTE_MS;
/** The text kept of a post or a schedule entry: enough to know it again. */
const TEXT_HEAD = 500;
const CAPTION_HEAD = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idOf(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

/** Fansly's instants: seconds on a post (`createdAt`), milliseconds on the
 *  schedule and the publishing bodies (FBuddy's map) — read either way. */
export function fanslyInstantMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  // Seconds have no fraction worth keeping: a time, not money.
  return value < 1e12 ? value * 1000 : value;
}

function attachmentIdsOf(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.map((item) => (isRecord(item) ? idOf(item.contentId) : null));
  return ids.every((id) => id !== null) ? ids as string[] : null;
}

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------

export interface FanslyScheduleEntry {
  postId: string;
  scheduledForMs: number | null;
  status: number | null;
  /** The post's text, from its template (head). */
  text: string;
  /** The template's attachments' content ids (account media, bundles); null: unreadable. */
  attachmentIds: string[] | null;
}

export type FanslyScheduleRead =
  | {
    ok: true;
    /** The entries still scheduled (`status` 1; 3 is taken off, the contract §5). */
    active: FanslyScheduleEntry[];
    /** Every entry's status, counted (`"1": 4, "2": 1`). */
    statuses: Record<string, number>;
    /** The list read whole, and the stand confirmed it is the whole schedule. */
    complete: boolean;
    incompleteReasons: string[];
  }
  | { ok: false; reason: string };

/** The schedule as one `GET /post/scheduled` answer (`response`) gives it. */
export function readFanslySchedule(response: unknown, facts: FanslyPublishFacts = FANSLY_PUBLISH_FACTS_VERIFIED): FanslyScheduleRead {
  if (!isRecord(response) || !Array.isArray(response.scheduledPosts)) return { ok: false, reason: "answer_without_scheduled_posts" };
  const active: FanslyScheduleEntry[] = [];
  const statuses: Record<string, number> = {};
  let unreadable = 0;
  for (const raw of response.scheduledPosts) {
    const postId = isRecord(raw) ? idOf(raw.postId) : null;
    if (!isRecord(raw) || postId === null) {
      unreadable += 1;
      continue;
    }
    const status = typeof raw.status === "number" && Number.isSafeInteger(raw.status) ? raw.status : null;
    statuses[String(status)] = (statuses[String(status)] ?? 0) + 1;
    if (status !== FANSLY_SCHEDULED_STATUS.waiting) continue;
    let template: Record<string, unknown> = {};
    if (typeof raw.postTemplate === "string") {
      try {
        const parsed: unknown = JSON.parse(raw.postTemplate);
        if (isRecord(parsed)) template = parsed;
      } catch {
        // An unreadable template: the entry is kept by its id and time alone.
      }
    } else if (isRecord(raw.postTemplate)) {
      template = raw.postTemplate;
    }
    active.push({
      postId,
      scheduledForMs: fanslyInstantMs(raw.scheduledFor),
      status,
      text: typeof template.content === "string" ? template.content.slice(0, TEXT_HEAD) : "",
      attachmentIds: attachmentIdsOf(template.attachments),
    });
  }
  const incompleteReasons: string[] = [];
  if (!facts.scheduleListWhole) incompleteReasons.push("list_whole_unverified");
  if (unreadable > 0) incompleteReasons.push(`entries_unreadable:${unreadable}`);
  return { ok: true, active, statuses, complete: incompleteReasons.length === 0, incompleteReasons };
}

/** The screen's words of a caption: whitespace folded. */
function captionHead(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, CAPTION_HEAD);
}

/** The page's snapshot of one read (0302's columns): the entries by their post, the posts per UTC day. */
export function fanslyScheduleSnapshot(read: Extract<FanslyScheduleRead, { ok: true }>): {
  entries: PublicationQueueEntryFacts[];
  postsPerDay: Record<string, number>;
} {
  const postsPerDay: Record<string, number> = {};
  const entries = [...read.active]
    .sort((a, b) => (a.scheduledForMs ?? 0) - (b.scheduledForMs ?? 0))
    .map((entry) => {
      const at = entry.scheduledForMs === null ? null : new Date(entry.scheduledForMs);
      if (at !== null) {
        const day = at.toISOString().slice(0, 10);
        postsPerDay[day] = (postsPerDay[day] ?? 0) + 1;
      }
      return {
        queueId: entry.postId,
        postRef: entry.postId,
        publishAt: at?.toISOString() ?? null,
        text: captionHead(entry.text),
        mediaCount: entry.attachmentIds?.length ?? null,
      };
    });
  return { entries, postsPerDay };
}

/** Keep one read as the page's latest (a failure beside the last good one);
 *  the owner's "Обновить" pressed before the request left is answered. */
async function keepScheduleRead(tx: Database, input: ApplyInput, read: FanslyScheduleRead): Promise<void> {
  const answeredRequestAt = input.attempt.admittedAt ?? null;
  if (!read.ok) {
    await recordPublicationQueueFailure(tx, { pageId: input.pageId, answeredRequestAt, failedAt: input.now, reason: read.reason });
    return;
  }
  const snapshot = fanslyScheduleSnapshot(read);
  await savePublicationQueueSnapshot(tx, {
    pageId: input.pageId,
    answeredRequestAt,
    // When its request was admitted: a withdrawal asked for after it is not
    // answered by it (publish/module.ts waits for a later one).
    readAt: input.attempt.admittedAt ?? input.now,
    // Fansly's list is not windowed: the whole schedule, no days.
    windowFrom: null,
    windowTo: null,
    complete: read.complete,
    incompleteReasons: read.incompleteReasons,
    postsPerDay: snapshot.postsPerDay,
    entries: snapshot.entries,
    evidence: { attemptId: input.attempt.id, observationId: input.observation.id, statuses: read.statuses },
  });
}

/**
 * `publish.schedule`: one read a step, kept as the page's latest. Only on a
 * page whose publishing is on or where Hub has a post in flight: until then
 * the page sends Fansly no new kind of request.
 */
export const fanslySchedulePollModule: ResourceModule = {
  async plan(_work: SyncWorkRow, ctx: PlanContext): Promise<StepPlan> {
    if (!await fanslyScheduleReadWanted(ctx.db, ctx.pageId)) return { kind: "done", reason: "publishing_off" };
    return { kind: "request", request: { spec: "posts.scheduled", params: {} } };
  },
  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const read = readFanslySchedule(input.response);
    await keepScheduleRead(tx, input, read);
    return {
      work: { satisfiesRevision: true, result: read.ok ? { entries: read.active.length, complete: read.complete } : { failed: read.reason } },
      followups: [],
      counters: { [read.ok ? "schedule_read" : "schedule_unreadable"]: 1 },
    };
  },
};

// ---------------------------------------------------------------------------
// A publication's fresh reads
// ---------------------------------------------------------------------------

/** A post as a read gives it. */
export interface FanslyReadPost {
  id: string;
  atMs: number | null;
  text: string;
  attachmentIds: string[] | null;
}

/** The account's stories as `GET /mediastoriesnew` lists them (the contract
 *  §7; the shape of its answer is not captured): the ids found, and whether
 *  a list of stories was there at all. */
export interface FanslyStoryList {
  ids: string[];
  listed: boolean;
}

/** Why a publication's reads are taken: did it go out (`verify`), look for
 *  an unknown one (`search`), is a deleted post gone (`deleted`, 0305). */
export type FanslyReadsMode = "verify" | "search" | "deleted";

/** What a `publish.verify` work read, step by step (its cursor, then its result). */
export interface FanslyPublicationReads {
  v: 1;
  publicationId: number;
  mode: FanslyReadsMode;
  /** The post read by its id: found or not (null: not read). */
  byId?: { ref: string; found: FanslyReadPost | null; answered: number };
  schedule?: FanslyScheduleRead;
  /** The head of the timeline: its posts, and the oldest of them. */
  timeline?: { posts: FanslyReadPost[]; oldestMs: number | null };
  stories?: FanslyStoryList;
  /** The reads did not finish (`FANSLY_VERIFY_GIVE_UP_MS`). */
  gaveUp?: string;
  /** When the reads were taken: the last step's instant. */
  at?: string;
}

export function readPostOf(raw: unknown): FanslyReadPost | null {
  if (!isRecord(raw)) return null;
  const id = idOf(raw.id);
  if (id === null) return null;
  return {
    id,
    atMs: fanslyInstantMs(raw.createdAt),
    text: typeof raw.content === "string" ? raw.content.slice(0, TEXT_HEAD) : "",
    attachmentIds: attachmentIdsOf(raw.attachments),
  };
}

function postsOf(response: unknown): FanslyReadPost[] {
  const posts = isRecord(response) && Array.isArray(response.posts) ? response.posts : [];
  return posts.map(readPostOf).filter((post): post is FanslyReadPost => post !== null);
}

/** The story ids an answer of `GET /mediastoriesnew` names: the list itself,
 *  or one under `mediaStories` or `stories` (its shape is not captured), each
 *  entry by its `id`. */
export function storyListOf(response: unknown): FanslyStoryList {
  const list = Array.isArray(response)
    ? response
    : isRecord(response) && Array.isArray(response.mediaStories)
      ? response.mediaStories
      : isRecord(response) && Array.isArray(response.stories) ? response.stories : null;
  if (list === null) return { ids: [], listed: false };
  return { ids: list.flatMap((entry) => (isRecord(entry) && idOf(entry.id) !== null ? [idOf(entry.id)!] : [])), listed: true };
}

export function parsePublicationReads(value: unknown): FanslyPublicationReads | null {
  if (!isRecord(value) || value.v !== 1 || typeof value.publicationId !== "number") return null;
  if (value.mode !== "verify" && value.mode !== "search" && value.mode !== "deleted") return null;
  return value as unknown as FanslyPublicationReads;
}

/** The params a `publish.verify` work is asked with. */
export interface FanslyVerifyParams {
  v: 1;
  mode: FanslyReadsMode;
}

function verifyParamsOf(work: Pick<SyncWorkRow, "params">): FanslyVerifyParams {
  const params = isRecord(work.params) ? work.params : {};
  return { v: 1, mode: params.mode === "search" || params.mode === "deleted" ? params.mode : "verify" };
}

/** The publication a work's subject names. */
function publicationIdOf(work: Pick<SyncWorkRow, "subject">): number | null {
  return /^[1-9][0-9]{0,17}$/.test(work.subject) ? Number(work.subject) : null;
}

type NextRead = { spec: "posts.by_ids"; ref: string } | { spec: "posts.scheduled" } | { spec: "posts.timeline" } | { spec: "stories.list" } | null;

/**
 * The next read a publication's check needs, or null when it has them all: a
 * story — the account's stories; a post — the post by its id (when Hub
 * knows one), the schedule (a post still in it did not go out), and, when the
 * id does not show it and its time has come, the head of the timeline. A
 * deleted post (mode `deleted`): its id alone.
 */
export function nextPublicationRead(input: {
  kind: string;
  platformPostRef: string | null;
  publishAt: Date;
  now: Date;
  reads: FanslyPublicationReads;
}): NextRead {
  const { reads } = input;
  if (reads.mode === "deleted") return input.platformPostRef !== null && reads.byId === undefined ? { spec: "posts.by_ids", ref: input.platformPostRef } : null;
  if (input.kind === "story") return reads.stories === undefined ? { spec: "stories.list" } : null;
  if (input.platformPostRef !== null && reads.byId === undefined) return { spec: "posts.by_ids", ref: input.platformPostRef };
  if (reads.schedule === undefined) return { spec: "posts.scheduled" };
  const shownById = reads.byId?.found !== null && reads.byId?.found !== undefined;
  if (!shownById && input.publishAt.getTime() <= input.now.getTime() && reads.timeline === undefined) return { spec: "posts.timeline" };
  return null;
}

/** `publish.verify`: the reads of one publication's check, kept in its cursor, handed over in its result. */
export const fanslyVerifyModule: ResourceModule = {
  async plan(work, ctx: PlanContext): Promise<StepPlan> {
    const id = publicationIdOf(work);
    if (id === null) return { kind: "quarantine", reason: "verify_subject_invalid" };
    const params = verifyParamsOf(work);
    const reads: FanslyPublicationReads = parsePublicationReads(work.cursor) ?? { v: 1, publicationId: id, mode: params.mode };
    const publication = await getPublication(ctx.db, id);
    if (publication === null || publication.pageId !== ctx.pageId) return { kind: "done", reason: "publication_missing", result: { ...reads, gaveUp: "publication_missing" } };
    if (ctx.now.getTime() - work.createdAt.getTime() > FANSLY_VERIFY_GIVE_UP_MS) {
      return { kind: "local", reason: "verify_give_up", detail: { ...reads, gaveUp: "reads_timed_out", at: ctx.now.toISOString() } };
    }
    const next = nextPublicationRead({
      kind: publication.kind, platformPostRef: publication.platformPostRef, publishAt: publication.publishAt, now: ctx.now, reads,
    });
    if (next === null) return { kind: "done", reason: "reads_taken", cursor: reads, result: { ...reads, at: ctx.now.toISOString() } };
    switch (next.spec) {
      case "posts.by_ids":
        return { kind: "request", request: { spec: "posts.by_ids", params: { ids: [next.ref] }, step: { read: "by_id", ref: next.ref } } };
      case "posts.scheduled":
        return { kind: "request", request: { spec: "posts.scheduled", params: {}, step: { read: "schedule" } } };
      case "stories.list":
      case "posts.timeline": {
        const facts = await readFanslyPageFacts(ctx.db, ctx.pageId);
        if (facts === null) return { kind: "quarantine", reason: "page_missing" };
        if (facts.externalId === null) {
          return { kind: "wait", reason: "dependency", until: null, enqueue: [{ resource: "account.poll", demand: { reason: `dependency:${work.resource}` } }] };
        }
        if (next.spec === "stories.list") return { kind: "request", request: { spec: "stories.list", params: { accountId: facts.externalId }, step: { read: "stories" } } };
        return { kind: "request", request: { spec: "posts.timeline", params: { accountId: facts.externalId, before: FANSLY_HEAD_CURSOR }, step: { read: "timeline" } } };
      }
    }
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const id = publicationIdOf(input.work) ?? 0;
    const params = verifyParamsOf(input.work);
    const reads: FanslyPublicationReads = { ...(parsePublicationReads(input.work.cursor) ?? { v: 1, publicationId: id, mode: params.mode }) };
    switch (input.request.spec) {
      case "posts.by_ids": {
        const ref = String((input.request.params as { ids?: readonly string[] }).ids?.[0] ?? "");
        const posts = postsOf(input.response);
        reads.byId = { ref, found: posts.find((post) => post.id === ref) ?? null, answered: posts.length };
        break;
      }
      case "posts.scheduled": {
        reads.schedule = readFanslySchedule(input.response);
        // A fresh read is the page's latest as well.
        await keepScheduleRead(tx, input, reads.schedule);
        break;
      }
      case "posts.timeline": {
        const posts = postsOf(input.response);
        const instants = posts.flatMap((post) => (post.atMs === null ? [] : [post.atMs]));
        reads.timeline = { posts, oldestMs: instants.length === 0 ? null : Math.min(...instants) };
        break;
      }
      case "stories.list":
        reads.stories = storyListOf(input.response);
        break;
      default:
        break;
    }
    // The next plan asks for the next read, or hands the reads over.
    return { work: { satisfiesRevision: false, nextDueAt: input.now, cursor: reads }, followups: [] };
  },

  async applyLocal(_tx, input: LocalApplyInput): Promise<ApplyResult> {
    // Given up: the reads taken so far, and why it stopped.
    return { work: { satisfiesRevision: true, close: "done", closeReason: "verify_gave_up", result: input.plan?.detail ?? null }, followups: [] };
  },
};
