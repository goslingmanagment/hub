import { describe, expect, it } from "vitest";

import type { FanslyPublishFacts } from "@agency_hub_core/fansly";

import {
  concludeFanslySearch,
  concludeFanslyVerify,
  type FanslyCheckTarget,
} from "../apps/runtime/src/services/publications-fansly-checks.ts";
import {
  fanslyScheduleSnapshot,
  nextPublicationRead,
  readFanslySchedule,
  type FanslyPublicationReads,
  type FanslyReadPost,
  storyListOf,
} from "../apps/runtime/src/sync/fansly/publish/reads.ts";

// Did the Fansly post go out (plan PR 9): what the fresh reads prove, and what
// they do not. Until the stand confirms Fansly's answers, an absence proves
// nothing — "unknown", never "not published" — and a story is never "out" by
// a read.

const MIN = 60_000;
const NOW = new Date("2026-10-24T12:10:00Z");
const PUBLISH_AT = new Date("2026-10-24T12:00:00Z");
const UNVERIFIED: FanslyPublishFacts = { scheduleListWhole: false, scheduledPostKeepsId: false, storyListRead: false, immediatePost: false };
const VERIFIED: FanslyPublishFacts = { scheduleListWhole: true, scheduledPostKeepsId: true, storyListRead: true, immediatePost: false };

const target = (overrides: Partial<FanslyCheckTarget> = {}): FanslyCheckTarget => ({
  kind: "fyp_post", ref: "p1", publishAt: PUBLISH_AT, sentAt: new Date(PUBLISH_AT.getTime() - 2 * 24 * 60 * MIN),
  text: "new set", mediaIds: ["am1"], mediaCount: 1, from: new Date(PUBLISH_AT.getTime() - 5 * MIN), to: NOW, ...overrides,
});

const post = (id: string, at: Date, overrides: Partial<FanslyReadPost> = {}): FanslyReadPost => ({
  id, atMs: at.getTime(), text: "new set", attachmentIds: ["am1"], ...overrides,
});

const schedule = (entries: Array<{ postId: string; at?: Date; text?: string; attachmentIds?: string[] }>, facts: FanslyPublishFacts = UNVERIFIED) =>
  readFanslySchedule({
    scheduledPosts: entries.map((entry) => ({
      accountId: "a1", postId: entry.postId, scheduledFor: (entry.at ?? PUBLISH_AT).getTime(), status: 1,
      postTemplate: JSON.stringify({ content: entry.text ?? "new set", attachments: (entry.attachmentIds ?? ["am1"]).map((contentId) => ({ contentId, contentType: 1 })) }),
    })),
  }, facts);

const reads = (overrides: Partial<FanslyPublicationReads>): FanslyPublicationReads => ({ v: 1, publicationId: 9, mode: "verify", ...overrides });
const verify = (r: FanslyPublicationReads, facts = UNVERIFIED, t = target()) => concludeFanslyVerify({ target: t, reads: r, claimed: new Set(), now: NOW, facts });

describe("the schedule read (GET /post/scheduled)", () => {
  it("keeps the entries still scheduled, by their post, with their template's text and attachments", () => {
    const read = readFanslySchedule({
      scheduledPosts: [
        { postId: "p1", scheduledFor: PUBLISH_AT.getTime(), status: 1, postTemplate: JSON.stringify({ content: "hi", attachments: [{ contentId: "am1" }] }) },
        { postId: "p2", scheduledFor: PUBLISH_AT.getTime(), status: 2, postTemplate: "{}" },
        { nothing: true },
      ],
    }, UNVERIFIED);
    expect(read).toMatchObject({ ok: true, statuses: { 1: 1, 2: 1 }, complete: false, incompleteReasons: ["list_whole_unverified", "entries_unreadable:1"] });
    if (!read.ok) throw new Error("unreachable");
    expect(read.active).toEqual([{ postId: "p1", scheduledForMs: PUBLISH_AT.getTime(), status: 1, text: "hi", attachmentIds: ["am1"], mediaRefs: [] }]);
    expect(fanslyScheduleSnapshot(read)).toEqual({
      entries: [{ queueId: "p1", postRef: "p1", publishAt: PUBLISH_AT.toISOString(), text: "hi", mediaCount: 1, mediaRefs: [], attachmentRefs: ["am1"] }],
      postsPerDay: { "2026-10-24": 1 },
    });
  });

  it("names each entry's files by their media ids, as the answer's aggregationData gives them (account media, bundles)", () => {
    const read = readFanslySchedule({
      scheduledPosts: [
        { postId: "p1", scheduledFor: PUBLISH_AT.getTime(), status: 1, postTemplate: JSON.stringify({ content: "set", attachments: [{ contentId: "am1", contentType: 1 }, { contentId: "b1", contentType: 2 }] }) },
      ],
      aggregationData: {
        accountMedia: [
          { id: "am1", mediaId: "m1" },
          { id: "am2", media: { id: "m2" } },
          { id: "am3", mediaId: "m3" },
        ],
        // Its fourth member is not in the answer: the list stays a lower bound.
        accountMediaBundles: [{ id: "b1", accountMediaIds: ["am2", "am3", "am9"] }],
      },
    }, UNVERIFIED);
    if (!read.ok) throw new Error("unreachable");
    expect(read.active[0]).toMatchObject({ attachmentIds: ["am1", "b1"], mediaRefs: ["m1", "m2", "m3"] });
    expect(fanslyScheduleSnapshot(read).entries[0]).toMatchObject({ mediaRefs: ["m1", "m2", "m3"], attachmentRefs: ["am1", "b1"] });
  });

  it("is whole only once the stand confirmed the list is the whole schedule", () => {
    expect(schedule([], UNVERIFIED)).toMatchObject({ complete: false });
    expect(schedule([], VERIFIED)).toMatchObject({ complete: true, incompleteReasons: [] });
    expect(readFanslySchedule({ posts: [] })).toEqual({ ok: false, reason: "answer_without_scheduled_posts" });
  });
});

describe("the reads a check takes", () => {
  it("a post: by its id, the schedule, then the timeline when the id does not show it; a story: the account", () => {
    const at = { kind: "fyp_post", platformPostRef: "p1", publishAt: PUBLISH_AT, now: NOW };
    expect(nextPublicationRead({ ...at, reads: reads({}) })).toEqual({ spec: "posts.by_ids", ref: "p1" });
    expect(nextPublicationRead({ ...at, reads: reads({ byId: { ref: "p1", found: null, answered: 0 } }) })).toEqual({ spec: "posts.scheduled" });
    const absent = reads({ byId: { ref: "p1", found: null, answered: 0 }, schedule: schedule([]) });
    expect(nextPublicationRead({ ...at, reads: absent })).toEqual({ spec: "posts.timeline" });
    const shown = reads({ byId: { ref: "p1", found: post("p1", PUBLISH_AT), answered: 1 }, schedule: schedule([]) });
    expect(nextPublicationRead({ ...at, reads: shown })).toBeNull();
    expect(nextPublicationRead({ kind: "story", platformPostRef: "s1", publishAt: PUBLISH_AT, now: NOW, reads: reads({}) })).toEqual({ spec: "stories.list" });
  });
});

describe("did the Fansly post go out (spec §3.6, §4)", () => {
  it("shown by its id and gone from the schedule: published", () => {
    expect(verify(reads({ byId: { ref: "p1", found: post("p1", PUBLISH_AT), answered: 1 }, schedule: schedule([]) })))
      .toMatchObject({ outcome: "published", status: "published", reason: "read_by_id", platformPostRef: "p1" });
  });

  it("still in the schedule after its time: unknown, even when the id reads", () => {
    expect(verify(reads({ byId: { ref: "p1", found: post("p1", PUBLISH_AT), answered: 1 }, schedule: schedule([{ postId: "p1" }]) })))
      .toMatchObject({ status: "unknown", reason: "still_in_schedule" });
  });

  it("absent by its id but on the wall under a new id: published with that id", () => {
    const r = reads({ byId: { ref: "p1", found: null, answered: 0 }, schedule: schedule([]), timeline: { posts: [post("p77", new Date(PUBLISH_AT.getTime() + MIN))], oldestMs: PUBLISH_AT.getTime() - 60 * MIN } });
    expect(verify(r)).toMatchObject({ status: "published", reason: "matched_by_content", platformPostRef: "p77" });
  });

  it("absent everywhere: unknown until the stand confirms what absences mean; then not published", () => {
    const r = reads({ byId: { ref: "p1", found: null, answered: 0 }, schedule: schedule([], VERIFIED), timeline: { posts: [], oldestMs: PUBLISH_AT.getTime() - 60 * MIN } });
    expect(verify(r, UNVERIFIED)).toMatchObject({ status: "unknown", reason: expect.stringMatching(/^absent_unproven:post_id_kept_unverified/) });
    expect(verify(r, VERIFIED)).toMatchObject({ outcome: "not_published", status: "not_published" });
    // A timeline that does not reach back past the post's time proves nothing either.
    const short = reads({ ...r, timeline: { posts: [], oldestMs: NOW.getTime() } });
    expect(verify(short, VERIFIED)).toMatchObject({ status: "unknown", reason: "absent_unproven:timeline_short" });
  });

  it("a read that did not come back is a failed read, never a conclusion", () => {
    expect(verify(reads({ byId: { ref: "p1", found: null, answered: 0 } }))).toMatchObject({ outcome: "read_failed", status: null });
    expect(verify(reads({ gaveUp: "reads_timed_out" }))).toMatchObject({ outcome: "read_failed", status: null });
    expect(verify(reads({ byId: { ref: "p1", found: null, answered: 0 }, schedule: { ok: false, reason: "answer_without_scheduled_posts" } })))
      .toMatchObject({ outcome: "read_failed" });
  });

  it("a story: out when the account's stories list it by its id (the contract §7); not listed proves nothing", () => {
    const story = target({ kind: "story", ref: "s1", text: "", mediaIds: null, sentAt: new Date(NOW.getTime() - 9 * MIN) });
    const seen = reads({ stories: storyListOf({ mediaStories: [{ id: "s0" }, { id: "s1" }] }) });
    expect(verify(seen, UNVERIFIED, story)).toMatchObject({ status: "unknown", reason: "story_read_unverified" });
    expect(verify(seen, VERIFIED, story)).toMatchObject({ status: "published", platformPostRef: "s1" });
    const none = reads({ stories: storyListOf({ mediaStories: [{ id: "s0" }] }) });
    expect(verify(none, VERIFIED, story)).toMatchObject({ status: "unknown", reason: "story_not_listed" });
    expect(verify(reads({}), VERIFIED, story)).toMatchObject({ outcome: "read_failed" });
    // The list's shape is not captured: the list itself, or under a key.
    expect(storyListOf([{ id: 7 }])).toEqual({ ids: ["7"], listed: true });
    expect(storyListOf({ stories: [{ id: "a" }] })).toEqual({ ids: ["a"], listed: true });
    expect(storyListOf({ account: {} })).toEqual({ ids: [], listed: false });
  });
});

describe("the search for an unknown Fansly post (spec §8.2)", () => {
  const search = (r: FanslyPublicationReads, now = NOW, t = target()) =>
    concludeFanslySearch({ target: t, reads: r, claimed: new Set(), now, facts: UNVERIFIED });

  it("found in the schedule while its time is ahead: scheduled", () => {
    const early = new Date(PUBLISH_AT.getTime() - 60 * MIN);
    expect(search(reads({ mode: "search", schedule: schedule([{ postId: "p1" }]) }), early)).toMatchObject({ status: "scheduled", platformPostRef: "p1" });
    expect(search(reads({ mode: "search", schedule: schedule([{ postId: "p5" }]) }), early, target({ ref: null }))).toMatchObject({ status: "scheduled", platformPostRef: "p5" });
  });

  it("on the wall: published; nowhere: not found — never not published", () => {
    const wall = reads({ mode: "search", byId: { ref: "p1", found: null, answered: 0 }, schedule: schedule([]), timeline: { posts: [post("p8", PUBLISH_AT)], oldestMs: 0 } });
    expect(search(wall)).toMatchObject({ status: "published", platformPostRef: "p8" });
    const nowhere = reads({ mode: "search", byId: { ref: "p1", found: null, answered: 0 }, schedule: schedule([]), timeline: { posts: [], oldestMs: 0 } });
    expect(search(nowhere)).toMatchObject({ outcome: "not_found", status: null });
  });
});
