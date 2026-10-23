import { describe, expect, it } from "vitest";

import type { PublicationRecord } from "@agency_hub_core/db";

import {
  onlyfansCommandFor,
  onlyfansDispatchPlan,
  onlyfansOutcome,
  onlyfansStillInWindow,
  publicationActionId,
} from "../apps/runtime/src/services/publications-onlyfans.ts";

// OnlyFans wall posts (plan PR 4b): when a publication goes out and how, what
// its action's outcome means for it, and that nothing goes out late. The
// sending itself, once and only once, is in publications-onlyfans.integration.

const NOW = new Date("2026-10-24T12:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const at = (ms: number) => new Date(NOW.getTime() + ms);

function record(overrides: Partial<PublicationRecord> = {}): PublicationRecord {
  return {
    id: 7, pageId: 3, pageLabel: "lora-of", platform: "onlyfans", kind: "subscriber_post", status: "approved", version: 1,
    text: "hello", publishAt: at(2 * DAY), expiresAt: null, wallRefs: [], tierRefs: [], priceMills: null, repost: false,
    findings: [], authorKind: "human", authorUserId: 1, authorAgentKeyId: null, idempotencyKey: null, approvedRevisionId: 9,
    platformPostRef: null, statusReason: null, previousPublicationId: null, createdAt: NOW, updatedAt: NOW, statusChangedAt: NOW,
    withdrawal: null,
    media: [
      { role: "media", position: 1, source: "vault", platformMediaRef: "222", fileId: null },
      { role: "media", position: 0, source: "vault", platformMediaRef: "111", fileId: null },
    ],
    ...overrides,
  };
}

describe("OnlyFans publications: when and how", () => {
  it("posts go into OnlyFans' schedule up to 7 days ahead, or now when minutes away; stories at their time", () => {
    expect(onlyfansDispatchPlan({ kind: "subscriber_post", publishAt: at(8 * DAY), now: NOW })).toEqual({ action: "wait" });
    expect(onlyfansDispatchPlan({ kind: "subscriber_post", publishAt: at(6 * DAY), now: NOW })).toEqual({ action: "send", mode: "scheduled" });
    expect(onlyfansDispatchPlan({ kind: "subscriber_post", publishAt: at(MIN), now: NOW })).toEqual({ action: "send", mode: "now" });
    expect(onlyfansDispatchPlan({ kind: "story", publishAt: at(MIN), now: NOW })).toEqual({ action: "wait" });
    expect(onlyfansDispatchPlan({ kind: "story", publishAt: at(-10 * MIN), now: NOW })).toEqual({ action: "send", mode: "story" });
  });

  it("nothing goes out more than 30 minutes late", () => {
    expect(onlyfansDispatchPlan({ kind: "story", publishAt: at(-31 * MIN), now: NOW })).toEqual({ action: "missed" });
    expect(onlyfansDispatchPlan({ kind: "subscriber_post", publishAt: at(-31 * MIN), now: NOW })).toEqual({ action: "missed" });
    expect(onlyfansStillInWindow("story", at(-29 * MIN), NOW)).toBe(true);
    expect(onlyfansStillInWindow("story", at(-31 * MIN), NOW)).toBe(false);
    // A scheduled post's date is frozen in its action: once it is not in the future, it cannot be sent.
    expect(onlyfansStillInWindow("scheduled", at(2 * MIN), NOW)).toBe(true);
    expect(onlyfansStillInWindow("scheduled", at(30_000), NOW)).toBe(false);
  });

  it("the command carries the approved content, the frozen date, whole expiry days and the banned-word stop", () => {
    const post = onlyfansCommandFor(record({ expiresAt: at(5 * DAY) }), "scheduled");
    expect(post).toEqual({
      action: "post_create", pageId: 3, text: "hello", mediaFiles: ["111", "222"],
      scheduledDate: at(2 * DAY).toISOString(), expireDays: 3, blockBannedWords: "strict_ban", reuseProviderOperation: false,
    });
    expect(onlyfansCommandFor(record(), "now")).not.toHaveProperty("scheduledDate");
    const story = onlyfansCommandFor(record({ kind: "story", text: "", media: [{ role: "media", position: 0, source: "vault", platformMediaRef: "333", fileId: null }] }), "story");
    expect(story).toEqual({ action: "story_create", pageId: 3, mediaFiles: ["333"], reuseProviderOperation: false });
    expect(() => onlyfansCommandFor(record({ media: [{ role: "media", position: 0, source: "file", platformMediaRef: null, fileId: 4 }] }), "now"))
      .toThrow(/vault media only/);
  });

  it("one action id per publication, approval and kind", () => {
    const id = publicationActionId(7, 9, "create");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(publicationActionId(7, 9, "create")).toBe(id);
    expect(publicationActionId(7, 10, "create")).not.toBe(id);
    expect(publicationActionId(7, 9, "withdraw")).not.toBe(id);
  });
});

describe("OnlyFans publications: what the action's outcome means", () => {
  const intent = (state: string, extra: Partial<{ remoteId: string | null; errorCode: string | null; responseData: unknown }> = {}) =>
    ({ state, remoteId: null, errorCode: null, responseData: null, ...extra });

  it("accepted is scheduled with the platform's id; a story still preparing is processing", () => {
    expect(onlyfansOutcome(intent("confirmed", { remoteId: "700001" }), "scheduled"))
      .toEqual({ kind: "settled", to: "scheduled", platformPostRef: "700001", reason: null, autostop: false });
    expect(onlyfansOutcome(intent("confirmed", { remoteId: "5", responseData: { isReady: false } }), "story"))
      .toMatchObject({ to: "processing", platformPostRef: "5" });
  });

  it("a lost or unexpected answer is unknown, never a retry; an authorization refusal stops the page", () => {
    expect(onlyfansOutcome(intent("prepared"), "now")).toEqual({ kind: "pending" });
    expect(onlyfansOutcome(intent("dispatching"), "now")).toEqual({ kind: "pending" });
    expect(onlyfansOutcome(intent("indeterminate", { errorCode: "vendor_http_502" }), "now")).toMatchObject({ to: "unknown", autostop: false });
    expect(onlyfansOutcome(intent("partial"), "now")).toMatchObject({ to: "unknown" });
    expect(onlyfansOutcome(intent("rejected", { errorCode: "vendor_http_422" }), "now")).toMatchObject({ to: "rejected", autostop: false });
    expect(onlyfansOutcome(intent("rejected", { errorCode: "vendor_http_401" }), "now")).toMatchObject({ to: "rejected", autostop: true });
    expect(onlyfansOutcome(intent("cancelled"), "story")).toMatchObject({ to: "missed" });
  });
});
