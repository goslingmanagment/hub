import { describe, expect, it } from "vitest";

import type { OnlyfansCheckCandidate } from "@agency_hub_core/db";

import {
  findPublicationMatch,
  normalizePostText,
  onlyfansCheckPlan,
  type PublicationMatchTarget,
} from "../apps/runtime/src/services/publications-onlyfans-checks.ts";
import { queueReadDue } from "../apps/runtime/src/services/publications-onlyfans-queue.ts";
import {
  parseOnlyfansQueueEntry,
  planQueueWindows,
  type OnlyfansPlatformItem,
} from "../apps/runtime/src/services/publications-onlyfans-reads.ts";

// Did it go out (plan PR 5a): which post on OnlyFans is the publication, when
// a check is due, and how the schedule is read in windows. Hub must never call
// a post "not there" from a read that cannot rule it out. The reads themselves
// and the outcomes are in publications-onlyfans-checks.integration.

const NOW = new Date("2026-10-24T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (ms: number) => new Date(NOW.getTime() + ms);

const target: PublicationMatchTarget = { text: "New set <3", mediaIds: ["101"], mediaCount: 1, from: at(-15 * MIN), to: NOW };
const item = (overrides: Partial<OnlyfansPlatformItem> = {}): OnlyfansPlatformItem => ({
  id: "9001", entityId: null, at: at(-10 * MIN), text: "<p>New set &lt;3</p>", mediaIds: ["101"], mediaCount: 1, ...overrides,
});

describe("which post is the publication", () => {
  it("reads OnlyFans' HTML caption as the words the person wrote", () => {
    expect(normalizePostText("<p>New  set<br/>today &amp; now</p>")).toBe("New set today & now");
  });

  it("finds the one post with its caption or its vault files inside the time window", () => {
    expect(findPublicationMatch(target, [item()], new Set())).toMatchObject({ kind: "one", ref: "9001" });
    // Both without a caption: the vault files say.
    expect(findPublicationMatch({ ...target, text: "" }, [item({ text: "" })], new Set())).toMatchObject({ kind: "one" });
    expect(findPublicationMatch(target, [item({ at: at(-40 * MIN) })], new Set())).toEqual({ kind: "none" });
  });

  it("a post that could be it but proves nothing keeps the outcome open, never 'not there'", () => {
    // A reworded caption and no media ids: neither proven nor ruled out.
    expect(findPublicationMatch(target, [item({ text: "something else", mediaIds: null })], new Set())).toEqual({ kind: "ambiguous", reason: "could_be_unproven" });
    // The same file under other words: another post (by hand, by another tool), never taken for this one.
    expect(findPublicationMatch(target, [item({ text: "<p>Another caption</p>" })], new Set())).toEqual({ kind: "ambiguous", reason: "could_be_unproven" });
    // No caption where Hub wrote one, or one where Hub wrote none: another post too.
    expect(findPublicationMatch(target, [item({ text: "" })], new Set())).toEqual({ kind: "ambiguous", reason: "could_be_unproven" });
    expect(findPublicationMatch({ ...target, text: "" }, [item({ text: "<p>hand-made</p>" })], new Set())).toEqual({ kind: "ambiguous", reason: "could_be_unproven" });
    // A read without the caption leaves the files to say.
    expect(findPublicationMatch(target, [item({ text: null })], new Set())).toMatchObject({ kind: "one" });
    // No time in the read: it cannot be ruled out either.
    expect(findPublicationMatch(target, [item({ at: null, text: null, mediaIds: null, mediaCount: null })], new Set()).kind).toBe("ambiguous");
  });

  it("two posts that both match, or a post another publication claims, are not taken", () => {
    expect(findPublicationMatch(target, [item(), item({ id: "9002" })], new Set())).toEqual({ kind: "ambiguous", reason: "several_match" });
    expect(findPublicationMatch(target, [item()], new Set(["9001"]))).toEqual({ kind: "ambiguous", reason: "claimed_by_another" });
  });

  it("other files rule a post out; a schedule entry is claimed by the post inside it", () => {
    expect(findPublicationMatch(target, [item({ mediaIds: ["101", "102"], mediaCount: 2 })], new Set())).toEqual({ kind: "none" });
    expect(findPublicationMatch(target, [item({ id: "55", entityId: "9001" })], new Set())).toMatchObject({ kind: "one", ref: "9001" });
  });

  it("reads a schedule entry: its id, the post inside, its publish time", () => {
    expect(parseOnlyfansQueueEntry({
      id: 55, type: "post", publishDateTime: "2026-10-24T11:50:00+00:00",
      entity: { responseType: "post", id: 9001, rawText: "New set", postedAt: "2026-10-24T11:50:00+00:00", media: [{ id: 101 }] },
    })).toEqual({ id: "55", entityId: "9001", at: at(-10 * MIN), text: "New set", mediaIds: ["101"], mediaCount: 1 });
    expect(parseOnlyfansQueueEntry({ id: 56, type: "chat", entity: {} })).toBeNull();
  });
});

describe("the schedule in windows of at most 100 posts", () => {
  it("joins days up to 100 posts, skips empty days and leaves out a day it cannot read whole", () => {
    const postsPerDay = new Map([["2026-10-24", 60], ["2026-10-25", 30], ["2026-10-26", 20], ["2026-10-28", 150], ["2026-10-29", 5]]);
    expect(planQueueWindows({ from: "2026-10-24", to: "2026-10-30", postsPerDay })).toEqual({
      windows: [
        { start: "2026-10-24", end: "2026-10-25", expected: 90 },
        { start: "2026-10-26", end: "2026-10-27", expected: 20 },
        { start: "2026-10-29", end: "2026-10-30", expected: 5 },
      ],
      unreadableDays: ["2026-10-28"],
    });
  });
});

describe("when a publication is read", () => {
  const candidate = (overrides: Partial<OnlyfansCheckCandidate> = {}): OnlyfansCheckCandidate => ({
    id: 1, pageId: 2, kind: "subscriber_post", status: "scheduled", publishAt: at(-20 * MIN), statusChangedAt: at(-2 * HOUR),
    platformPostRef: "9001", approvedRevisionId: 3, dispatchedAt: at(-2 * HOUR), withdrawState: null, checks: [], ...overrides,
  });

  it("a scheduled post 10 minutes after its time, once", () => {
    expect(onlyfansCheckPlan(candidate({ publishAt: at(-5 * MIN) }), NOW)).toEqual({ action: "wait" });
    expect(onlyfansCheckPlan(candidate(), NOW)).toEqual({ action: "verify", final: false });
  });

  it("a failed read is tried again 10 minutes later, and after twelve in a row it is unknown", () => {
    const failure = (minutesAgo: number) => ({ kind: "verify" as const, outcome: "read_failed" as const, at: at(-minutesAgo * MIN) });
    expect(onlyfansCheckPlan(candidate({ checks: [failure(3)] }), NOW)).toEqual({ action: "wait" });
    expect(onlyfansCheckPlan(candidate({ checks: [failure(11)] }), NOW)).toEqual({ action: "verify", final: false });
    const many = Array.from({ length: 12 }, (_, index) => failure(120 - index * 10));
    expect(onlyfansCheckPlan(candidate({ checks: many }), NOW)).toEqual({ action: "give_up" });
  });

  it("a story still preparing is read at +1 h and +6 h; the last read is final", () => {
    const story = candidate({ kind: "story", status: "processing", publishAt: at(-30 * MIN), statusChangedAt: at(-20 * MIN) });
    expect(onlyfansCheckPlan(story, NOW)).toEqual({ action: "wait" });
    expect(onlyfansCheckPlan(story, at(31 * MIN))).toEqual({ action: "verify", final: false });
    const readAtHour = { kind: "verify" as const, outcome: "processing" as const, at: at(32 * MIN) };
    expect(onlyfansCheckPlan({ ...story, checks: [readAtHour] }, at(2 * HOUR))).toEqual({ action: "wait" });
    expect(onlyfansCheckPlan({ ...story, checks: [readAtHour] }, at(6 * HOUR))).toEqual({ action: "verify", final: true });
  });

  it("an unknown one is searched in rounds: fresh reads for a day, then the collected posts for a week, then a person", () => {
    const unknown = candidate({ status: "unknown", statusChangedAt: NOW });
    expect(onlyfansCheckPlan(unknown, at(5 * MIN))).toEqual({ action: "wait" });
    expect(onlyfansCheckPlan(unknown, at(11 * MIN))).toEqual({ action: "search", fresh: true });
    const searched = { kind: "search" as const, outcome: "not_found" as const, at: at(11 * MIN) };
    expect(onlyfansCheckPlan({ ...unknown, checks: [searched] }, at(30 * MIN))).toEqual({ action: "wait" });
    expect(onlyfansCheckPlan({ ...unknown, checks: [searched] }, at(61 * MIN))).toEqual({ action: "search", fresh: true });
    expect(onlyfansCheckPlan(unknown, at(50 * HOUR))).toEqual({ action: "search", fresh: false });
    const lastRound = { kind: "search" as const, outcome: "not_found" as const, at: at(7 * 24 * HOUR + MIN) };
    expect(onlyfansCheckPlan({ ...unknown, checks: [lastRound] }, at(30 * 24 * HOUR))).toEqual({ action: "wait" });
  });
});

describe("when an OnlyFans page's schedule is read", () => {
  const due = (overrides: Partial<Parameters<typeof queueReadDue>[0]>) => queueReadDue({
    inFlight: false, publishingEnabled: false, lastAttemptAt: null, refreshRequestedAt: null, now: NOW, ...overrides,
  });

  it("hourly while Hub posts are in it, daily with publishing on, otherwise only on the owner's press", () => {
    expect(due({ inFlight: true, lastAttemptAt: at(-30 * MIN) })).toBe(false);
    expect(due({ inFlight: true, lastAttemptAt: at(-61 * MIN) })).toBe(true);
    expect(due({ publishingEnabled: true, lastAttemptAt: at(-3 * HOUR) })).toBe(false);
    expect(due({ publishingEnabled: true, lastAttemptAt: at(-25 * HOUR) })).toBe(true);
    expect(due({ lastAttemptAt: null })).toBe(false);
    expect(due({ lastAttemptAt: at(-MIN), refreshRequestedAt: at(-MIN) })).toBe(true);
  });
});
