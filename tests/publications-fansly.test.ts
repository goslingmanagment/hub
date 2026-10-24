import { describe, expect, it } from "vitest";

import type { FanslyWriteCommandRecord, FanslyWriteState, FanslyWriteStep } from "@agency_hub_core/db";

import {
  FANSLY_STEP_MAX_REFUSALS,
  fanslyCommandWindow,
  fanslyCreateChain,
  fanslyCreateNext,
  fanslyDispatchPlan,
} from "../apps/runtime/src/services/publications-fansly.ts";
import type { ApprovedFormMedia } from "../apps/runtime/src/sync/fansly/publish/derive.ts";

// Wall posts on Fansly (plan PR 9): which requests a publication's create is,
// when it goes, and what its commands make of the publication — the post sent
// once, a lost answer of the post itself "unknown", anything before it that
// did not go "missed", Fansly's refusal "rejected".

const MIN = 60_000;
const NOW = new Date("2026-10-24T12:00:00Z");

const vault = (role: "media" | "preview", position: number): ApprovedFormMedia => ({
  role, position, source: "vault", mediaRef: `m${position}`, fileId: null, fileSha256: null,
});

let nextId = 1;
function command(step: FanslyWriteStep, state: FanslyWriteState, extra: Partial<FanslyWriteCommandRecord> = {}): FanslyWriteCommandRecord {
  return {
    id: nextId++, pageId: 1, dispatchId: 1, publicationId: 1, step, item: "", priority: "background",
    notBefore: NOW, notAfter: null, state, stateReason: null, workId: null, attemptId: null, notSentCount: 0,
    request: null, requestFingerprint: null, result: null, httpStatus: null, observationId: null,
    createdAt: NOW, admittedAt: null, settledAt: null, ...extra,
  };
}

const next = (chain: FanslyWriteStep[], commands: FanslyWriteCommandRecord[], notAfter = new Date(NOW.getTime() + 60 * MIN)) =>
  fanslyCreateNext({ chain, commands, now: NOW, notAfter });

describe("the chain of a Fansly create (spec §5)", () => {
  it("one vault file becomes account media (with its preview), several one bundle (the contract §3), then the post or the story", () => {
    expect(fanslyCreateChain({ kind: "fyp_post", media: [] })).toEqual(["post"]);
    expect(fanslyCreateChain({ kind: "subscriber_post", media: [vault("media", 0), vault("media", 1)] })).toEqual(["account_media_bundle", "post"]);
    expect(fanslyCreateChain({ kind: "paid_post", media: [vault("media", 0)] })).toEqual(["account_media", "post"]);
    expect(fanslyCreateChain({ kind: "paid_post", media: [vault("media", 0), vault("media", 1)] })).toEqual(["account_media_bundle", "post"]);
    expect(fanslyCreateChain({ kind: "paid_post", media: [vault("media", 0), vault("preview", 0)] })).toEqual(["account_media", "post"]);
    expect(fanslyCreateChain({ kind: "story", media: [vault("media", 0)] })).toEqual(["account_media", "story"]);
  });

  it("a new file has no chain until the browser uploads (plan PR 8)", () => {
    const file: ApprovedFormMedia = { role: "media", position: 0, source: "file", mediaRef: null, fileId: 3, fileSha256: "a".repeat(64) };
    expect(fanslyCreateChain({ kind: "fyp_post", media: [file] })).toBeNull();
  });
});

describe("when a Fansly publication goes (spec §3.4–3.5)", () => {
  it("a post enters Fansly's schedule within 7 days; one sent now is not captured — a post closer than the lead is missed; a story at its time; late is missed", () => {
    const at = (minutes: number) => new Date(NOW.getTime() + minutes * MIN);
    expect(fanslyDispatchPlan({ kind: "fyp_post", publishAt: at(8 * 24 * 60), now: NOW })).toEqual({ action: "wait" });
    expect(fanslyDispatchPlan({ kind: "fyp_post", publishAt: at(3 * 24 * 60), now: NOW })).toEqual({ action: "send", mode: "scheduled" });
    expect(fanslyDispatchPlan({ kind: "fyp_post", publishAt: at(6), now: NOW })).toEqual({ action: "send", mode: "scheduled" });
    expect(fanslyDispatchPlan({ kind: "fyp_post", publishAt: at(5), now: NOW })).toEqual({ action: "missed", reason: "too_close_to_schedule" });
    expect(fanslyDispatchPlan({ kind: "fyp_post", publishAt: at(1), now: NOW })).toEqual({ action: "missed", reason: "too_close_to_schedule" });
    // Once a post sent now is verified: now when minutes away.
    expect(fanslyDispatchPlan({ kind: "fyp_post", publishAt: at(1), now: NOW, immediatePost: true })).toEqual({ action: "send", mode: "now" });
    expect(fanslyDispatchPlan({ kind: "story", publishAt: at(5), now: NOW })).toEqual({ action: "wait" });
    expect(fanslyDispatchPlan({ kind: "story", publishAt: at(-29), now: NOW })).toEqual({ action: "send", mode: "story" });
    expect(fanslyDispatchPlan({ kind: "story", publishAt: at(-31), now: NOW })).toEqual({ action: "missed", reason: "window_passed" });
    expect(fanslyDispatchPlan({ kind: "fyp_post", publishAt: at(-31), now: NOW })).toEqual({ action: "missed", reason: "window_passed" });
  });

  it("a scheduled post's requests end the schedule's lead (5 minutes) before its time; a story's are urgent until 30 minutes after", () => {
    const publishAt = new Date(NOW.getTime() + 60 * MIN);
    expect(fanslyCommandWindow("scheduled", publishAt)).toEqual({ notAfter: new Date(publishAt.getTime() - 5 * MIN), priority: "background" });
    expect(fanslyCommandWindow("now", publishAt)).toEqual({ notAfter: new Date(publishAt.getTime() + 30 * MIN), priority: "background" });
    expect(fanslyCommandWindow("story", publishAt)).toEqual({ notAfter: new Date(publishAt.getTime() + 30 * MIN), priority: "urgent" });
  });
});

describe("a create follows its commands (spec §4, §8.2)", () => {
  const chain: FanslyWriteStep[] = ["account_media", "post"];

  it("queues the first step, waits while one is in flight, then queues the next", () => {
    expect(next(chain, [])).toEqual({ kind: "enqueue", step: "account_media" });
    expect(next(chain, [command("account_media", "queued")])).toEqual({ kind: "in_flight" });
    expect(next(chain, [command("account_media", "sending")])).toEqual({ kind: "in_flight" });
    expect(next(chain, [command("account_media", "answered", { result: { accountMediaIds: ["a1"] } })])).toEqual({ kind: "enqueue", step: "post" });
  });

  it("the post answered with its id is scheduled; without one, unknown", () => {
    const media = command("account_media", "answered");
    expect(next(chain, [media, command("post", "answered", { result: { postId: "p9" } })]))
      .toEqual({ kind: "settle", to: "scheduled", reason: null, platformPostRef: "p9" });
    expect(next(chain, [media, command("post", "answered", { result: {} })]))
      .toMatchObject({ kind: "settle", to: "unknown", platformPostRef: null });
    expect(next(["account_media", "story"], [media, command("story", "answered", { result: { storyId: "s1" } })]))
      .toEqual({ kind: "settle", to: "scheduled", reason: null, platformPostRef: "s1" });
  });

  it("a lost answer of the post itself is unknown; of a step before it, the post never went: missed", () => {
    const media = command("account_media", "answered");
    expect(next(chain, [media, command("post", "unknown", { stateReason: "no_answer:timeout" })]))
      .toEqual({ kind: "settle", to: "unknown", reason: "post:no_answer:timeout", platformPostRef: null });
    expect(next(chain, [command("account_media", "unknown", { stateReason: "no_answer:timeout" })]))
      .toEqual({ kind: "settle", to: "missed", reason: "not_sent:account_media_unknown:no_answer:timeout", platformPostRef: null });
  });

  it("Fansly's refusal of any step is rejected, with the step and the status", () => {
    expect(next(chain, [command("account_media", "rejected", { stateReason: "fansly_http_400" })]))
      .toEqual({ kind: "settle", to: "rejected", reason: "account_media:fansly_http_400", platformPostRef: null });
    expect(next(chain, [command("account_media", "answered"), command("post", "rejected", { stateReason: "fansly_http_400" })]))
      .toEqual({ kind: "settle", to: "rejected", reason: "post:fansly_http_400", platformPostRef: null });
  });

  it("a step a switch held back is queued again inside its window; its window passed, missed", () => {
    const held = [command("account_media", "refused", { stateReason: "page_publishing_off" })];
    for (let index = 0; index < 5; index += 1) held.push(command("account_media", "refused", { stateReason: "publishing_off" }));
    expect(next(chain, held)).toEqual({ kind: "enqueue", step: "account_media" });
    expect(next(chain, held, new Date(NOW.getTime() - 1))).toEqual({ kind: "settle", to: "missed", reason: "window_passed", platformPostRef: null });
    expect(next(chain, [command("account_media", "refused", { stateReason: "window_passed" })]))
      .toEqual({ kind: "settle", to: "missed", reason: "window_passed", platformPostRef: null });
  });

  it("a step refused for itself is given up after a few tries: never sent, missed", () => {
    const refused = Array.from({ length: FANSLY_STEP_MAX_REFUSALS - 1 }, () => command("post", "refused", { stateReason: "not_sent:not_sent:write_refused" }));
    const media = command("account_media", "answered");
    expect(next(chain, [media, ...refused])).toEqual({ kind: "enqueue", step: "post" });
    const more = [...refused, command("post", "refused", { stateReason: "audience_not_approved" })];
    expect(next(chain, [media, ...more])).toEqual({ kind: "settle", to: "missed", reason: "not_sent:post:audience_not_approved", platformPostRef: null });
  });
});
