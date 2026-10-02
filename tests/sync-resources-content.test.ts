import { describe, expect, it } from "vitest";

import { fanslyWireSpec } from "@agency_hub_core/fansly";
import { FANSLY_NOTIFICATION_DECLARED_TYPE_CODES, FANSLY_NOTIFICATION_TYPE_GROUPS } from "@agency_hub_core/shared";

import { inspectFanslyPostTipsScope } from "../apps/runtime/src/services/sync/posts.ts";
import { ApplyQuarantine, defaultCaptureCodec } from "../apps/runtime/src/sync/engine/commit.ts";
import { createEngineRegistry, pollsFor, type RequestPlan, type ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import {
  FANSLY_POST_TIPS_SCOPE_QUARANTINE,
  fanslyCaptureCodec,
  prepareJournalBody,
  servedFromJournalBody,
} from "../apps/runtime/src/sync/fansly/capture.ts";
import {
  advanceShadowPass,
  currentShadowPass,
  EMPTY_SHADOW_PASS,
  parseShadowPass,
  QUEUE_SUBJECT_BREAKER,
  shadowPassWaitUntil,
} from "../apps/runtime/src/sync/fansly/lib/subject-queue.ts";
import { FANSLY_RESOURCE_SPECS } from "../apps/runtime/src/sync/fansly/registry.ts";
import {
  completeForward,
  formOfTypes,
  formTypes,
  isTypeFormRefusal,
  narrowerForm,
  parseBackfillCursor,
  parseForwardCursor,
  UNFILTERED_FORM,
  widenForm,
} from "../apps/runtime/src/sync/fansly/resources/notifications.ts";
import { discoverPagination, parsePostRepliesCursor } from "../apps/runtime/src/sync/fansly/resources/post-replies.ts";
import {
  parsePostsWalkCursor,
  refreshCutoffAt,
  wholePageOlderThan,
} from "../apps/runtime/src/sync/fansly/resources/posts.ts";

// The pure parts of the content resources (design §5.14–§5.16, §4.3): the
// notification type-form fork, the walk boundaries, the reply pagination
// discovery, the shadow pass of a subject-queue walk, the journal envelopes
// and the standing rows of a page.

const NOW = new Date("2026-10-02T12:00:00Z");
const HOUR = 3_600_000;

describe("the notifications type form", () => {
  it("names the form of a request by its type parameter", () => {
    expect(formOfTypes(null)).toEqual(UNFILTERED_FORM);
    expect(formOfTypes([])).toEqual(UNFILTERED_FORM);
    expect(formOfTypes([...FANSLY_NOTIFICATION_DECLARED_TYPE_CODES])).toEqual({ mode: "declared_csv", groupIndex: 0 });
    expect(formOfTypes([...FANSLY_NOTIFICATION_TYPE_GROUPS[3]!])).toEqual({ mode: "type_groups", groupIndex: 3 });
    // A code list this module never sends is not a form.
    expect(formOfTypes([1002])).toBeNull();
    for (const form of [UNFILTERED_FORM, { mode: "declared_csv" as const, groupIndex: 0 }, { mode: "type_groups" as const, groupIndex: 5 }]) {
      expect(formOfTypes(formTypes(form))).toEqual(form);
    }
  });

  it("widens unfiltered → the declared CSV → one group per call, rotating, never the narrow UI list", () => {
    const declared = widenForm(UNFILTERED_FORM);
    expect(declared.mode).toBe("declared_csv");
    expect(formTypes(declared)).toEqual(FANSLY_NOTIFICATION_DECLARED_TYPE_CODES);
    expect(formTypes(declared)).toEqual(expect.arrayContaining([32007, 45012]));
    const group = widenForm(declared);
    expect(group).toEqual({ mode: "type_groups", groupIndex: 0 });
    const last = { mode: "type_groups" as const, groupIndex: FANSLY_NOTIFICATION_TYPE_GROUPS.length - 1 };
    expect(widenForm(last)).toEqual({ mode: "type_groups", groupIndex: 0 });
  });

  it("the two walks share the narrower form; a group form keeps its own rotation", () => {
    const declared = { mode: "declared_csv" as const, groupIndex: 0 };
    expect(narrowerForm(UNFILTERED_FORM, declared)).toEqual(declared);
    expect(narrowerForm(declared, UNFILTERED_FORM)).toEqual(declared);
    expect(narrowerForm({ mode: "type_groups", groupIndex: 2 }, { mode: "type_groups", groupIndex: 5 })).toEqual({ mode: "type_groups", groupIndex: 2 });
  });

  it("only a 4xx about the form widens it: not a dead session, the provider's pace or a timeout", () => {
    expect(isTypeFormRefusal(400)).toBe(true);
    expect(isTypeFormRefusal(422)).toBe(true);
    for (const status of [401, 403, 408, 429, 500, 200, null]) expect(isTypeFormRefusal(status), String(status)).toBe(false);
  });
});

describe("the notifications walks", () => {
  it("a completed forward walk commits the head it saw first, rotates a group form and resets", () => {
    const cursor = parseForwardCursor({ newestSeenNotificationId: "100", form: { mode: "type_groups", groupIndex: 1 } });
    const done = completeForward(cursor, { beforeRef: "150", pendingHeadRef: "300", lastRequestedBefore: "200", pages: 2, probeBefore: null }, {
      now: NOW,
      reason: "overlap",
      form: cursor.form,
    });
    expect(done).toMatchObject({
      newestSeenNotificationId: "300",
      lastForwardPollAt: NOW.toISOString(),
      form: { mode: "type_groups", groupIndex: 2 },
      walk: null,
      last: { stopReason: "overlap", pages: 2 },
    });
    // A walk that saw nothing keeps the old head.
    expect(completeForward(cursor, { beforeRef: null, pendingHeadRef: null, lastRequestedBefore: "0", pages: 1, probeBefore: null }, {
      now: NOW, reason: "empty_page", form: UNFILTERED_FORM,
    }).newestSeenNotificationId).toBe("100");
  });

  it("cursors survive whatever a row holds", () => {
    expect(parseForwardCursor(null)).toEqual({
      newestSeenNotificationId: null, lastForwardPollAt: null, form: UNFILTERED_FORM, unfilteredProbeSpent: false,
      postLikesCoverageWritten: false, walk: null, last: null, shadow: null,
    });
    expect(parseForwardCursor({ form: { mode: "nonsense", groupIndex: -3 }, walk: "x" }).form).toEqual(UNFILTERED_FORM);
    expect(parseBackfillCursor({})).toMatchObject({ nextBeforeRef: "0", lastRequestedBefore: null, floorAt: null, lastObservationId: null });
  });
});

describe("the posts walk", () => {
  it("freezes its cutoff 14 days before its first admission", () => {
    expect(refreshCutoffAt(NOW)).toBe("2026-09-18T12:00:00.000Z");
  });

  it("ends a bounded walk on a page wholly older than the cutoff, never on a pinned old item", () => {
    const cutoff = refreshCutoffAt(NOW);
    const old = Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000);
    const recent = Math.floor(Date.parse("2026-10-01T00:00:00Z") / 1000);
    expect(wholePageOlderThan([{ createdAt: old }, { createdAt: old }], cutoff)).toBe(true);
    expect(wholePageOlderThan([{ createdAt: old }, { createdAt: recent }], cutoff)).toBe(false);
    expect(wholePageOlderThan([], cutoff)).toBe(false);
    expect(wholePageOlderThan([{ createdAt: old }], null)).toBe(false);
  });

  it("cursors survive whatever a row holds", () => {
    expect(parsePostsWalkCursor(null)).toEqual({ headPostId: null, tipsBackfilledAt: null, walk: null, last: null, shadow: null });
    expect(parsePostsWalkCursor({ walk: { before: "9", pendingTips: ["1", 2], end: "nope" } }).walk).toMatchObject({
      before: "9", pendingTips: ["1"], end: null, pageIndex: 0,
    });
  });
});

describe("the reply walk", () => {
  it("learns what `before` does from the page that came back", () => {
    expect(discoverPagination(["3", "2"], ["3", "2"])).toBe("single_page");
    expect(discoverPagination(["3", "2"], ["1"])).toBe("before");
    // An empty page after a cursor: honoured, nothing older.
    expect(discoverPagination(["3", "2"], [])).toBe("before");
  });

  it("keeps at most 1 000 author refs and 200 page samples", () => {
    const refs = Array.from({ length: 1_200 }, (_, index) => `a${index}`);
    const samples = Array.from({ length: 300 }, (_, index) => index);
    const cursor = parsePostRepliesCursor({ hydratedAuthorRefs: refs, postsLengthSamples: samples, paginationMode: "before" });
    expect(cursor.hydratedAuthorRefs).toHaveLength(1_000);
    expect(cursor.hydratedAuthorRefs.at(-1)).toBe("a1199");
    expect(cursor.postsLengthSamples).toHaveLength(200);
    expect(cursor.paginationMode).toBe("before");
    expect(parsePostRepliesCursor({ walk: { before: "x" } }).walk).toBeNull();
  });
});

describe("the shadow pass of a subject-queue walk", () => {
  const recheckMs = 6 * HOUR;

  it("steps through the due subjects by keyset and rests at the end of the pass", () => {
    const first = advanceShadowPass({ pass: EMPTY_SHADOW_PASS, now: NOW, recheckMs, taken: [{ keyset: "k1" }, { keyset: "k2" }], limit: 2 });
    expect(first).toEqual({ pass: { after: "k2", startedAt: NOW.toISOString(), ended: false }, nextDueAt: NOW });
    const later = new Date(NOW.getTime() + 60_000);
    const last = advanceShadowPass({ pass: first.pass, now: later, recheckMs, taken: [{ keyset: "k3" }], limit: 2 });
    expect(last.pass).toEqual({ after: null, startedAt: NOW.toISOString(), ended: true });
    // The next pass starts one re-check period after this one started.
    expect(last.nextDueAt).toEqual(new Date(NOW.getTime() + recheckMs));
    expect(currentShadowPass(last.pass, later, recheckMs).ended).toBe(true);
    expect(currentShadowPass(last.pass, new Date(NOW.getTime() + recheckMs), recheckMs)).toEqual(EMPTY_SHADOW_PASS);
  });

  it("waits a whole period when no pass is running, and never waits into the past", () => {
    expect(shadowPassWaitUntil(EMPTY_SHADOW_PASS, NOW, recheckMs)).toEqual(new Date(NOW.getTime() + recheckMs));
    const stale = { after: null, startedAt: new Date(NOW.getTime() - 2 * recheckMs).toISOString(), ended: true };
    expect(shadowPassWaitUntil(stale, NOW, recheckMs).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("parses a pass without a start as no pass", () => {
    expect(parseShadowPass({ after: "k" })).toEqual(EMPTY_SHADOW_PASS);
    expect(parseShadowPass({ after: "k", startedAt: NOW.toISOString(), ended: false })).toEqual({ after: "k", startedAt: NOW.toISOString(), ended: false });
  });

  it("the queue breaker climbs the engine's subject ladder", () => {
    expect(QUEUE_SUBJECT_BREAKER).toEqual({
      stepsMs: [60_000, 600_000, 3_600_000, 21_600_000, 86_400_000],
      blockAfter: 5,
      blockedProbeEveryMs: 86_400_000,
    });
  });
});

describe("the engine's journal of the content routes", () => {
  const module = {} as ResourceModule;
  const OWN = "300000000000000001";

  it("journals a post-tips answer outside its scope in the legacy quarantine envelope", () => {
    const request = { spec: "posts.tips" as const, params: { targetIds: ["p1", "p2"] } };
    const inScope = [{ id: "t1", receiverId: OWN, targetId: "p1" }];
    expect(fanslyCaptureCodec.prepare({ spec: "posts.tips", kind: "post_tips", response: inScope, contractAccepted: true, request, ownRef: OWN, module }))
      .toEqual(inScope);
    const escaped = [{ id: "t2", receiverId: "399999999999999999", targetId: "p9" }];
    expect(inspectFanslyPostTipsScope(escaped, { requestedTargetIds: ["p1", "p2"], receiverId: OWN }).accepted).toBe(false);
    expect(fanslyCaptureCodec.prepare({ spec: "posts.tips", kind: "post_tips", response: escaped, contractAccepted: true, request, ownRef: OWN, module }))
      .toEqual({ quarantine: FANSLY_POST_TIPS_SCOPE_QUARANTINE, requestedTargetIds: ["p1", "p2"], response: escaped });
    // Without the page's own id there is no receiver to check against.
    expect(fanslyCaptureCodec.prepare({ spec: "posts.tips", kind: "post_tips", response: escaped, contractAccepted: true, request, module }))
      .toEqual(escaped);
    // A non-array answer has no scope to check: journaled raw, as legacy
    // journals it (the posts walk counts it and moves on).
    expect(fanslyCaptureCodec.prepare({ spec: "posts.tips", kind: "post_tips", response: { x: 1 }, contractAccepted: true, request, ownRef: OWN, module }))
      .toEqual({ x: 1 });
    expect(prepareJournalBody({ kind: "post_tips" }, { response: { x: 1 }, contractAccepted: false, tipsScope: { requestedTargetIds: ["p1"], receiverId: OWN } }).payload)
      .toEqual({ x: 1 });
  });

  it("the tips companion read is journal-first: the wire refuses no body, the walk judges it", () => {
    const spec = fanslyWireSpec("posts.tips");
    const params = { targetIds: ["p1"] };
    expect(spec.parse([{ id: "t1" }], params)).toEqual({ ok: true, value: [{ id: "t1" }] });
    expect(spec.parse({ tips: [] }, params)).toEqual({ ok: true, value: { tips: [] } });
  });

  it("an apply from the journal gets back the very answer the capture served, out of each envelope", () => {
    const replies = (postId: string, before: string | null): RequestPlan => ({ spec: "post.replies", params: { postId, before } });
    const page = { posts: Array.from({ length: 20 }, (_, index) => ({ id: String(900 - index), accountId: "77", content: "x" })) };
    const tipsRequest: RequestPlan = { spec: "posts.tips", params: { targetIds: ["p1", "p2"] } };
    const escaped = [{ id: "t2", receiverId: "399999999999999999", targetId: "p9" }];
    const roundTrip = (spec: RequestPlan["spec"], kind: string, request: RequestPlan, response: unknown) => fanslyCaptureCodec.served({
      spec,
      kind,
      request,
      payload: JSON.parse(JSON.stringify(fanslyCaptureCodec.prepare({ spec, kind, response, contractAccepted: true, request, ownRef: OWN, module }))),
    });

    for (const before of [null, "881"]) {
      expect(roundTrip("post.replies", "post_replies", replies("555", before), page)).toEqual(page);
    }
    // A 204's empty marker and an absent answer come back as they went in.
    expect(roundTrip("post.replies", "post_replies", replies("555", null), { __empty: true, httpStatus: 204 })).toEqual({ __empty: true, httpStatus: 204 });
    expect(roundTrip("posts.tips", "post_tips", tipsRequest, escaped)).toEqual(escaped);
    expect(roundTrip("posts.tips", "post_tips", tipsRequest, [{ id: "t1", receiverId: OWN, targetId: "p1" }])).toEqual([{ id: "t1", receiverId: OWN, targetId: "p1" }]);
    expect(roundTrip("posts.tips", "post_tips", tipsRequest, { drifted: true })).toEqual({ drifted: true });
    const timeline: RequestPlan = { spec: "posts.timeline", params: { accountId: OWN, before: "0" } };
    expect(roundTrip("posts.timeline", "posts", timeline, { posts: [] })).toEqual({ posts: [] });

    // A body of another walk is not this request's answer.
    const journaled = fanslyCaptureCodec.prepare({ spec: "post.replies", kind: "post_replies", response: page, contractAccepted: true, request: replies("555", null), module });
    expect(() => fanslyCaptureCodec.served({ spec: "post.replies", kind: "post_replies", request: replies("556", null), payload: journaled }))
      .toThrow(ApplyQuarantine);
    expect(() => fanslyCaptureCodec.served({ spec: "post.replies", kind: "post_replies", request: replies("555", "881"), payload: journaled }))
      .toThrow(ApplyQuarantine);
    expect(servedFromJournalBody("post_replies", page)).toBeNull();
    // The default codec adds no envelope and takes none off.
    expect(defaultCaptureCodec.served({ spec: "post.replies", kind: "post_replies", request: replies("555", null), payload: journaled })).toBe(journaled);
  });

  it("journals notifications and timeline pages as the legacy lanes do", () => {
    const notifications = { spec: "notifications.page" as const, params: { before: "0", types: null } };
    const served = { notifications: [{ id: "1", type: 1002 }], accounts: [{ id: "9", username: "fan", lastSeenAt: 1 }] };
    const body = fanslyCaptureCodec.prepare({ spec: "notifications.page", kind: "notifications", response: served, contractAccepted: true, request: notifications, module });
    expect(JSON.stringify(body)).not.toContain("lastSeenAt");
    expect(body).toMatchObject({ notifications: [{ id: "1", type: 1002 }] });
  });
});

describe("standing rows", () => {
  it("a page keeps one open row per poll and per standing walk", () => {
    const registry = createEngineRegistry(FANSLY_RESOURCE_SPECS);
    const rows = pollsFor(registry, { registryOverrides: {} }, true);
    expect(rows.filter((row) => row.kind === "goal").map((row) => row.resource).sort()).toEqual(["post-replies.walk", "posts.engagement"]);
    expect(rows.find((row) => row.resource === "posts.engagement")).toEqual({ resource: "posts.engagement", class: "planned", everyMs: 6 * HOUR, kind: "goal" });
    // A poll row stays exactly what it was.
    expect(rows.find((row) => row.resource === "notifications.forward")).toEqual({ resource: "notifications.forward", class: "planned", everyMs: 30 * 60_000 });
    // The owner switches a walk off like any key.
    expect(pollsFor(registry, { registryOverrides: { "post-replies.walk": { enabled: false } } }, true).map((row) => row.resource)).not.toContain("post-replies.walk");
  });

  it("a standing walk must be a goal with a re-check period", () => {
    expect(() => createEngineRegistry([{ key: "x.walk", kind: "poll", class: "planned", period: { everyMs: 1 }, standing: { recheckMs: 1 }, http: true, evidence: false, fence: "none" }]))
      .toThrow(/standing walk/);
    expect(() => createEngineRegistry([{ key: "x.walk", kind: "goal", class: "planned", standing: { recheckMs: 0 }, http: true, evidence: false, fence: "none" }]))
      .toThrow(/standing walk/);
  });
});
