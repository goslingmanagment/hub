import { randomUUID } from "node:crypto";

import type { OfapiAction } from "@agency_hub_core/contracts";

import type { AppContext } from "../bootstrap.ts";
import { ofapiAccountNotFound } from "./ofapi.ts";
import { cancelOfapiAction, dispatchOfapiAction, loadOfapiActionResponse, prepareOfapiAction } from "./ofapi-actions.ts";

// Reads of an OnlyFans page's own posts, stories and schedule for wall posts
// (docs/plans/2026-10-23-wall-posts, plan PR 5). Each read is one owner action
// (ofapi-actions.ts) marked `publication_read`: the response is journaled in
// observations before it is parsed, credits are reserved and settled, the
// page's binding is checked. A read may be repeated (it is a read): a new
// read is a new action. Writes are never repeated; nothing here writes.
//
// Every parser below says what it could not see. "Not there" is concluded
// only from a read that is complete, and only by the caller.

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export interface OnlyfansReadContext {
  app: AppContext;
  pageId: number;
  /** The person on whose behalf Hub reads (the approver, or the owner who pressed). */
  actorUserId: number;
}

/** One post, story or schedule entry as the matching sees it; null = the read did not say. */
export interface OnlyfansPlatformItem {
  id: string;
  /** For a schedule entry: the post id inside it, when it names one. */
  entityId: string | null;
  at: Date | null;
  text: string | null;
  mediaIds: string[] | null;
  mediaCount: number | null;
}

export type OnlyfansReadFailure = { ok: false; reason: string; intentIds: string[] };

type ActionRead =
  | { kind: "confirmed"; data: unknown; intentId: string }
  | { kind: "absent"; intentId: string }
  | { kind: "failed"; reason: string; intentId: string };

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

function idOf(value: unknown): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === "string" && /^[1-9]\d{0,19}$/.test(value) ? value : null;
}

function dateOf(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function mediaOf(value: unknown): { ids: string[] | null; count: number | null } {
  if (!Array.isArray(value)) return { ids: null, count: null };
  const ids = value.map((item) => idOf(object(item)?.id));
  return { ids: ids.every((id): id is string => id !== null) ? ids : null, count: value.length };
}

/** A post of the account (GET /posts/{id}, a /posts list item, a schedule entry's entity). */
export function parseOnlyfansPost(raw: unknown): (OnlyfansPlatformItem & { pinned: boolean }) | null {
  const post = object(raw);
  const id = idOf(post?.id);
  if (!post || !id) return null;
  const media = mediaOf(post.media);
  const declaredCount = typeof post.mediaCount === "number" && Number.isSafeInteger(post.mediaCount) ? post.mediaCount : null;
  return {
    id,
    entityId: null,
    at: dateOf(post.postedAt),
    text: typeof post.rawText === "string" ? post.rawText : typeof post.text === "string" ? post.text : null,
    mediaIds: media.ids,
    mediaCount: media.count ?? declaredCount,
    pinned: post.isPinned === true,
  };
}

/** A story of the account (GET /stories/{id}, an item of GET /stories). */
export function parseOnlyfansStory(raw: unknown): (OnlyfansPlatformItem & { isReady: boolean | null }) | null {
  const story = object(raw);
  const id = idOf(story?.id);
  if (!story || !id) return null;
  const media = mediaOf(story.media);
  return {
    id,
    entityId: null,
    at: dateOf(story.createdAt),
    text: null,
    mediaIds: media.ids,
    mediaCount: media.count,
    isReady: typeof story.isReady === "boolean" ? story.isReady : null,
  };
}

/** A post waiting in the account's schedule (GET /queue): the entry's id and the post inside it. */
export function parseOnlyfansQueueEntry(raw: unknown): OnlyfansPlatformItem | null {
  const entry = object(raw);
  const id = idOf(entry?.id);
  if (!entry || !id || entry.type !== "post") return null;
  const post = parseOnlyfansPost(entry.entity);
  return {
    id,
    entityId: post?.id ?? null,
    at: dateOf(entry.publishDateTime) ?? post?.at ?? null,
    text: post?.text ?? null,
    mediaIds: post?.mediaIds ?? null,
    mediaCount: post?.mediaCount ?? null,
  };
}

/** One owner-action read: confirmed (the documented answer), absent (a plain 404 for the thing itself), or failed. */
async function readAction(ctx: OnlyfansReadContext, command: OfapiAction): Promise<ActionRead> {
  const intentId = randomUUID();
  try {
    await prepareOfapiAction(ctx.app, { id: intentId, command, origin: "publication_read" }, ctx.actorUserId);
  } catch (error) {
    return { kind: "failed", reason: `not_prepared: ${message(error)}`, intentId };
  }
  let intent;
  try {
    intent = await dispatchOfapiAction(ctx.app, intentId, ctx.actorUserId);
  } catch (error) {
    // Never left (the action lock was busy, the transport down): drop it so it does not linger.
    await cancelOfapiAction(ctx.app, intentId, ctx.actorUserId).catch(() => undefined);
    return { kind: "failed", reason: `not_sent: ${message(error)}`, intentId };
  }
  if (intent.state === "confirmed") return { kind: "confirmed", data: intent.responseData, intentId };
  if (intent.state === "rejected" && intent.errorCode === "vendor_http_404") {
    // A 404 that names the account, or OnlyFans' own "route not found", is not
    // the post's absence (ASSUMPTION — the body of a missing post's 404 is
    // what the owner's check of plan PR 5 should confirm).
    const response = await loadOfapiActionResponse(ctx.app, intent.responseObservationId).catch(() => null);
    if (response && !ofapiAccountNotFound(response.status, response.text) && !/route not found/i.test(response.text)) {
      return { kind: "absent", intentId };
    }
  }
  return { kind: "failed", reason: intent.errorCode ?? intent.state, intentId };
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

export type OnlyfansByIdRead<T> =
  | { ok: true; found: T | null; intentIds: string[] }
  | OnlyfansReadFailure;

/** GET /posts/{id}: the post, null when OnlyFans says there is no such post, or a failure. */
export async function readOnlyfansPostById(ctx: OnlyfansReadContext, postId: string): Promise<OnlyfansByIdRead<OnlyfansPlatformItem & { pinned: boolean }>> {
  const read = await readAction(ctx, { action: "post_get", pageId: ctx.pageId, postId } as OfapiAction);
  if (read.kind === "failed") return { ok: false, reason: read.reason, intentIds: [read.intentId] };
  if (read.kind === "absent") return { ok: true, found: null, intentIds: [read.intentId] };
  const post = parseOnlyfansPost(read.data);
  return post ? { ok: true, found: post, intentIds: [read.intentId] } : { ok: false, reason: "post_unreadable", intentIds: [read.intentId] };
}

/** GET /stories/{id}. */
export async function readOnlyfansStoryById(ctx: OnlyfansReadContext, storyId: string): Promise<OnlyfansByIdRead<OnlyfansPlatformItem & { isReady: boolean | null }>> {
  const read = await readAction(ctx, { action: "story_get", pageId: ctx.pageId, storyId } as OfapiAction);
  if (read.kind === "failed") return { ok: false, reason: read.reason, intentIds: [read.intentId] };
  if (read.kind === "absent") return { ok: true, found: null, intentIds: [read.intentId] };
  const story = parseOnlyfansStory(read.data);
  return story ? { ok: true, found: story, intentIds: [read.intentId] } : { ok: false, reason: "story_unreadable", intentIds: [read.intentId] };
}

export type OnlyfansListRead = { ok: true; items: OnlyfansPlatformItem[]; complete: boolean; intentIds: string[] } | OnlyfansReadFailure;

const POSTS_PAGE = 50;

/**
 * The account's posts from now back to `since`, newest first (GET /posts,
 * order=publish_date desc), up to `maxPages` reads of 50. Complete when the
 * list ended or reached a post older than `since` — the minimum date it asks
 * for is a day earlier, so OnlyFans' own time zone cannot cut the window.
 */
export async function readOnlyfansPostsSince(ctx: OnlyfansReadContext, since: Date, maxPages = 3): Promise<OnlyfansListRead> {
  const items: OnlyfansPlatformItem[] = [];
  const intentIds: string[] = [];
  const minimumPublishDate = new Date(since.getTime() - DAY_MS).toISOString().slice(0, 10);
  for (let page = 0; page < maxPages; page += 1) {
    const read = await readAction(ctx, {
      action: "posts_list", pageId: ctx.pageId, limit: POSTS_PAGE, offset: page * POSTS_PAGE, minimumPublishDate,
    } as OfapiAction);
    intentIds.push(read.intentId);
    if (read.kind !== "confirmed") return { ok: false, reason: read.kind === "failed" ? read.reason : "posts_absent", intentIds };
    const data = object(read.data);
    const list = Array.isArray(data?.list) ? data.list : [];
    const posts = list.map(parseOnlyfansPost);
    if (posts.some((post) => post === null)) return { ok: false, reason: "post_unreadable", intentIds };
    const parsed = posts as Array<OnlyfansPlatformItem & { pinned: boolean }>;
    items.push(...parsed);
    if (data?.hasMore !== true) return { ok: true, items, complete: true, intentIds };
    // A pinned post can sit on top out of date order; the page's tail tells how far back it reached.
    const tail = [...parsed].reverse().find((post) => !post.pinned);
    if (tail?.at && tail.at.getTime() < since.getTime()) return { ok: true, items, complete: true, intentIds };
  }
  return { ok: true, items, complete: false, intentIds };
}

/** GET /stories: the account's live stories (one read, no pages). */
export async function readOnlyfansLiveStories(ctx: OnlyfansReadContext): Promise<OnlyfansListRead> {
  const read = await readAction(ctx, { action: "stories_list", pageId: ctx.pageId } as OfapiAction);
  if (read.kind !== "confirmed") return { ok: false, reason: read.kind === "failed" ? read.reason : "stories_absent", intentIds: [read.intentId] };
  const list = Array.isArray(read.data) ? read.data : object(read.data)?.list;
  const stories = (Array.isArray(list) ? list : []).map(parseOnlyfansStory);
  if (stories.some((story) => story === null)) return { ok: false, reason: "story_unreadable", intentIds: [read.intentId] };
  return { ok: true, items: stories as OnlyfansPlatformItem[], complete: true, intentIds: [read.intentId] };
}

// ---------------------------------------------------------------------------
// The schedule (spec §6): at most 100 entries per window, no cursor, and a
// `syncInProcess` flag. The full list is read in windows of days whose
// counts (GET /queue/counts) add up to 100 or less, and each window's list
// must hold exactly its count. Anything else is "incomplete" and proves
// nothing about a post being absent.
// ---------------------------------------------------------------------------

export const ONLYFANS_QUEUE_WINDOW_MAX = 100;
const QUEUE_TIMEZONE = "UTC";

export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function addUtcDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export interface QueueWindow { start: string; end: string; expected: number }

/**
 * Windows of consecutive days, each with at most 100 scheduled posts, from the
 * per-day counts; a day with more than 100 cannot be read whole and is left
 * out (`unreadableDays`); days with no posts need no read.
 */
export function planQueueWindows(input: { from: string; to: string; postsPerDay: ReadonlyMap<string, number> }): { windows: QueueWindow[]; unreadableDays: string[] } {
  const windows: QueueWindow[] = [];
  const unreadableDays: string[] = [];
  let current: QueueWindow | null = null;
  for (let day = input.from; day <= input.to; day = addUtcDays(day, 1)) {
    const count = input.postsPerDay.get(day) ?? 0;
    if (count > ONLYFANS_QUEUE_WINDOW_MAX) {
      if (current) windows.push(current);
      current = null;
      unreadableDays.push(day);
      continue;
    }
    if (count === 0) {
      if (current) current.end = day;
      continue;
    }
    if (current && current.expected + count <= ONLYFANS_QUEUE_WINDOW_MAX) {
      current.end = day;
      current.expected += count;
      continue;
    }
    if (current) windows.push(current);
    current = { start: day, end: day, expected: count };
  }
  if (current) windows.push(current);
  return { windows: windows.filter((window) => window.expected > 0), unreadableDays };
}

export interface OnlyfansQueueRead {
  ok: true;
  /** UTC days the read covers, inclusive. */
  from: string;
  to: string;
  entries: OnlyfansPlatformItem[];
  /** Posts scheduled per UTC day, from the counts. */
  postsPerDay: Record<string, number>;
  complete: boolean;
  /** Why it is incomplete: sync_in_process, count_mismatch, day_over_100, read_budget, past_days. */
  incompleteReasons: string[];
  readAt: Date;
  intentIds: string[];
}

/**
 * The page's scheduled posts for UTC days [from, to], fresh. Days before today
 * cannot be read (OnlyFans takes today or later) and make the read
 * incomplete; so do a count still syncing, a window whose list does not hold
 * its count, a day over 100 posts, and windows past `maxListReads`.
 */
export async function readOnlyfansQueue(ctx: OnlyfansReadContext, input: { from: string; to: string; maxListReads: number; now?: Date }): Promise<OnlyfansQueueRead | OnlyfansReadFailure> {
  const now = input.now ?? new Date();
  // OnlyFans refuses a window that starts before its today: the wall clock, not `now`.
  const today = utcDay(new Date());
  const incompleteReasons = new Set<string>();
  const from = input.from < today ? today : input.from;
  if (input.from < today) incompleteReasons.add("past_days");
  const intentIds: string[] = [];
  const base = { ok: true as const, from, to: input.to, readAt: now };
  if (input.to < from) {
    return { ...base, entries: [], postsPerDay: {}, complete: false, incompleteReasons: [...incompleteReasons], intentIds };
  }
  const counts = await readAction(ctx, { action: "queue_counts", pageId: ctx.pageId, publishDateStart: from, publishDateEnd: input.to, timezone: QUEUE_TIMEZONE } as OfapiAction);
  intentIds.push(counts.intentId);
  if (counts.kind !== "confirmed") return { ok: false, reason: counts.kind === "failed" ? counts.reason : "queue_absent", intentIds };
  const countsData = object(counts.data);
  if (countsData?.syncInProcess !== false) incompleteReasons.add("sync_in_process");
  const postsPerDay = new Map<string, number>();
  for (const [day, value] of Object.entries(object(countsData?.list) ?? {})) {
    const posts = object(value)?.post;
    if (typeof posts === "number" && posts > 0) postsPerDay.set(day, posts);
  }
  const plan = planQueueWindows({ from, to: input.to, postsPerDay });
  if (plan.unreadableDays.length > 0) incompleteReasons.add("day_over_100");
  const entries: OnlyfansPlatformItem[] = [];
  for (const [index, window] of plan.windows.entries()) {
    if (index >= input.maxListReads) {
      incompleteReasons.add("read_budget");
      break;
    }
    const list = await readAction(ctx, {
      action: "queue_list", pageId: ctx.pageId, publishDateStart: window.start, publishDateEnd: window.end,
      timezone: QUEUE_TIMEZONE, limit: ONLYFANS_QUEUE_WINDOW_MAX, types: ["post"],
    } as OfapiAction);
    intentIds.push(list.intentId);
    if (list.kind !== "confirmed") return { ok: false, reason: list.kind === "failed" ? list.reason : "queue_absent", intentIds };
    const data = object(list.data);
    if (data?.syncInProcess !== false) incompleteReasons.add("sync_in_process");
    const parsed = (Array.isArray(data?.list) ? data.list : [])
      .filter((item) => object(item)?.type === "post")
      .map(parseOnlyfansQueueEntry);
    if (parsed.some((entry) => entry === null)) return { ok: false, reason: "queue_entry_unreadable", intentIds };
    // Truncated or stale: the list does not hold the count of its days.
    if (parsed.length !== window.expected) incompleteReasons.add("count_mismatch");
    entries.push(...(parsed as OnlyfansPlatformItem[]));
  }
  return {
    ...base,
    entries,
    postsPerDay: Object.fromEntries(postsPerDay),
    complete: incompleteReasons.size === 0,
    incompleteReasons: [...incompleteReasons].sort(),
    intentIds,
  };
}
