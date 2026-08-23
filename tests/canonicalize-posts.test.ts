import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { isProjectionOnlyDomainEventType } from "@agency_hub_core/db";

import {
  clampDraftOccurredAt,
  OCCURRED_AT_CLAMP_MIN,
} from "../apps/runtime/src/services/canonicalize-driver.ts";
import { familyForObservation } from "../apps/runtime/src/services/canonicalize/index.ts";
import {
  buildPostObservedDraft,
  buildPostTipObservedDraft,
  canParsePostsObservation,
  canonicalizePostsObservation,
  deriveHashtags,
  HASHTAG_PARSER_VERSION,
} from "../apps/runtime/src/services/canonicalize/posts.ts";
import type { CanonicalizableObservation } from "../apps/runtime/src/services/canonicalize/types.ts";

const RECEIVED_AT = new Date("2026-08-02T12:00:00Z");

function observation(
  payload: unknown,
  overrides: Partial<CanonicalizableObservation> = {},
): CanonicalizableObservation {
  return {
    id: 71,
    source: "pull",
    producer: "sync:fansly:posts",
    platform: "fansly",
    accountId: 9,
    kind: "posts",
    payload,
    observedAt: null,
    receivedAt: RECEIVED_AT,
    ...overrides,
  };
}

describe("creator-post canonicalizer", () => {
  it("registers posts as its own projection-only pull family", () => {
    const family = familyForObservation(observation({ posts: [] }));
    expect(family).toMatchObject({
      source: "pull",
      version: 6,
      projectionOnly: true,
    });
    expect(family?.kinds).toEqual(["posts", "post_tips"]);
    expect(isProjectionOnlyDomainEventType("post.observed")).toBe(true);
    expect(isProjectionOnlyDomainEventType("post.tip_observed")).toBe(true);
    expect(isProjectionOnlyDomainEventType("post.tip_parse_rejected")).toBe(true);
  });

  it("keeps provider text verbatim, converts Fansly epoch seconds and counts attachments", () => {
    const events = canonicalizePostsObservation(observation({
      posts: [{
        id: "post-42",
        content: "<p>Hello &amp; welcome</p><p>Second line</p>",
        createdAt: 1_754_136_000,
        attachments: [{ id: "a" }, { id: "b" }],
      }],
    }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "post.observed",
      postRef: "post-42",
      occurredAt: new Date("2025-08-02T12:00:00.000Z"),
      schemaVersion: 3,
      data: {
        platform: "fansly",
        textPlain: "<p>Hello &amp; welcome</p><p>Second line</p>",
        publishedAt: "2025-08-02T12:00:00.000Z",
        observedAt: RECEIVED_AT.toISOString(),
        attachmentCount: 2,
        tipAmountMills: null,
        attachmentTipAmountMills: null,
        postTipTotalMills: null,
        tipGoalLinked: null,
        tipGoalRef: null,
      },
    });
    expect(events[0]!.dedupKey).toMatch(/^post:v3:fansly:post-42:[0-9a-f]{64}:obs:71$/);
    expect(events[0]!.data.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps the $520 post counter distinct from its $500/$1000 linked goal", () => {
    const events = canonicalizePostsObservation(observation({
      posts: [{
        id: "birthday-post",
        content: "spoil the birthday girl",
        createdAt: 1_754_136_000,
        tipAmount: 510_000,
        attachmentTipAmount: 10_000,
        // This is the tipped-post/reply banner field and is deliberately not
        // part of Fansly's bottom counter.
        totalTipAmount: 999_000,
        attachments: [{ contentType: 7100, contentId: "goal-500" }],
      }],
      tipGoals: [{
        id: "goal-500",
        label: "spoil the birthday girl",
        goalAmount: 1_000_000,
        currentAmount: 500_000,
        currentPercentage: 50,
        hideAmounts: 0,
      }],
    }));

    expect(events[0]!.data).toMatchObject({
      tipAmountMills: 510_000,
      attachmentTipAmountMills: 10_000,
      postTipTotalMills: 520_000,
      tipGoalLinked: true,
      tipGoalRef: "goal-500",
      tipGoalLabel: "spoil the birthday girl",
      tipGoalTargetMills: 1_000_000,
      tipGoalCurrentMills: 500_000,
      tipGoalAmountsHidden: false,
    });
    expect(events[0]!.data.postTipTotalMills).not.toBe(events[0]!.data.tipGoalCurrentMills);
  });

  it("distinguishes omitted Fansly money from an explicit zero and rejects ambiguous goals", () => {
    const events = canonicalizePostsObservation(observation({
      posts: [
        { id: "missing", createdAt: 1_754_136_000, attachments: [] },
        {
          id: "zero",
          createdAt: 1_754_136_000,
          tipAmount: 0,
          attachmentTipAmount: 0,
          attachments: [],
        },
      ],
    }));
    expect(events[0]!.data).toMatchObject({
      postTipTotalMills: null,
      tipGoalLinked: false,
    });
    expect(events[1]!.data).toMatchObject({
      tipAmountMills: 0,
      attachmentTipAmountMills: 0,
      postTipTotalMills: 0,
      tipGoalLinked: false,
    });
    expect(canParsePostsObservation(observation({
      posts: [{
        id: "ambiguous",
        createdAt: 1_754_136_000,
        attachments: [
          { contentType: 7100, contentId: "goal-a" },
          { contentType: 7100, contentId: "goal-b" },
        ],
      }],
      tipGoals: [],
    }))).toBe(false);
  });

  it("does not invent no-goal when Fansly omits the attachments field", () => {
    const [event] = canonicalizePostsObservation(observation({
      posts: [{ id: "attachments-unknown", createdAt: 1_754_136_000 }],
    }));
    expect(event!.data).toMatchObject({
      attachmentCount: 0,
      tipGoalLinked: null,
      tipGoalRef: null,
    });
  });

  it("claims no linked goal only when every supplied attachment type is readable", () => {
    const [knownTypes, unknownType] = canonicalizePostsObservation(observation({
      posts: [
        {
          id: "known-non-goal",
          createdAt: 1_754_136_000,
          attachments: [
            { contentType: 1_000, contentId: "media-1" },
            { contentType: 2_000, contentId: "media-2" },
          ],
        },
        {
          id: "unknown-attachment-type",
          createdAt: 1_754_136_000,
          attachments: [{ id: "media-without-discriminator" }],
        },
      ],
    }));
    expect(knownTypes!.data.tipGoalLinked).toBe(false);
    expect(unknownType!.data.tipGoalLinked).toBeNull();
  });

  it("refuses malformed money so the raw page stays replayable", () => {
    for (const tipAmount of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "520000"]) {
      expect(canParsePostsObservation(observation({
        posts: [{ id: "bad-money", createdAt: 1_754_136_000, tipAmount }],
      }))).toBe(false);
    }
  });

  it("canonicalizes individual Fansly tips into exact fan-to-post attributions", () => {
    const tipObservation = observation([{
      id: "tip-1",
      senderId: "fan-22",
      receiverId: "creator-1",
      amount: 250_000,
      message: "happy birthday",
      senderTransactionId: "sender-tx-1",
      receiverTransactionId: "receiver-tx-1",
      tipGoalId: "goal-500",
      targets: [
        { id: "birthday-post", type: 1000 },
        { id: "goal-500", type: 7100 },
      ],
      createdAt: 1_754_136_123,
    }], { kind: "post_tips" });

    expect(canParsePostsObservation(tipObservation)).toBe(true);
    const [event] = canonicalizePostsObservation(tipObservation);
    expect(event).toMatchObject({
      type: "post.tip_observed",
      postRef: "birthday-post",
      fanIdentityRef: "fan-22",
      transactionRef: "receiver-tx-1",
      schemaVersion: 3,
      data: {
        platform: "fansly",
        tipId: "tip-1",
        senderPlatformUserId: "fan-22",
        amountMills: 250_000,
        receiverTransactionRef: "receiver-tx-1",
        senderTransactionRef: "sender-tx-1",
        tipGoalRef: "goal-500",
        tipGoalAttribution: "goal",
        tipMessageText: "happy birthday",
      },
    });
    expect(event!.dedupKey).toMatch(
      /^post-tip:v3:fansly:tip-1:birthday-post:[0-9a-f]{64}:obs:71$/,
    );
  });

  it("canonicalizes the observed flat Fansly fixture with unknown goal attribution", () => {
    const liveFlatTips = JSON.parse(readFileSync(
      "tests/fixtures/fansly-post-tips-flat.json",
      "utf8",
    )) as unknown;
    const [event] = canonicalizePostsObservation(
      observation(liveFlatTips, { kind: "post_tips" }),
      { nativeAccountRefByAccountId: new Map([[9, "creator-live"]]) },
    );

    expect(event).toMatchObject({
      type: "post.tip_observed",
      postRef: "post-live-1",
      fanIdentityRef: "fan-live-22",
      transactionRef: null,
      schemaVersion: 3,
      data: {
        receiverTransactionRef: null,
        senderTransactionRef: null,
        tipGoalRef: null,
        tipGoalAttribution: "unknown",
        tipMessageText: "For your level up",
      },
    });
  });

  it("refuses a tip whose receiver does not match the scoped Fansly page", () => {
    const scoped = observation([{
      id: "tip-wrong-receiver",
      senderId: "fan-22",
      receiverId: "another-creator",
      amount: 20_000,
      createdAt: 1_754_136_123,
      targets: [{ id: "party-post", type: 1000 }],
    }], { kind: "post_tips" });
    const [diagnostic] = canonicalizePostsObservation(scoped, {
      nativeAccountRefByAccountId: new Map([[9, "creator-1"]]),
    });
    expect(diagnostic).toMatchObject({
      type: "post.tip_parse_rejected",
      data: {
        rejectedItems: [{ index: 0, reason: "receiver_mismatch" }],
      },
    });
  });

  it("requires exactly one post target and at most one goal target", () => {
    const malformed = [observation([{
      id: "tip-without-target",
      senderId: "fan-22",
      amount: 10_000,
      createdAt: 1_754_136_123,
      targets: [],
    }], { kind: "post_tips" }), observation([{
      id: "tip-with-ambiguous-targets",
      senderId: "fan-22",
      amount: 10_000,
      createdAt: 1_754_136_123,
      targets: [
        { id: "post-a", type: 1000 },
        { id: "post-b", type: 1000 },
      ],
    }], { kind: "post_tips" }), observation([{
      // Duplicate target objects are still ambiguous even if their ids match.
      id: "tip-with-duplicate-post-target",
      senderId: "fan-22",
      amount: 10_000,
      createdAt: 1_754_136_123,
      targets: [
        { id: "post-a", type: 1000 },
        { id: "post-a", type: 1000 },
      ],
    }], { kind: "post_tips" }), observation([{
      id: "tip-with-two-goals",
      senderId: "fan-22",
      amount: 10_000,
      createdAt: 1_754_136_123,
      targets: [
        { id: "post-a", type: 1000 },
        { id: "goal-a", type: 7100 },
        { id: "goal-b", type: 7100 },
      ],
    }], { kind: "post_tips" })];

    for (const item of malformed) {
      expect(canParsePostsObservation(item)).toBe(true);
      expect(canonicalizePostsObservation(item)).toEqual([
        expect.objectContaining({
          type: "post.tip_parse_rejected",
          schemaVersion: 1,
          data: expect.objectContaining({
            parserVersion: 6,
            rejectedItemCount: 1,
          }),
        }),
      ]);
    }
  });

  it("derives goal attribution from type-7100 targets and fail-closes conflicts", () => {
    const targetOnly = observation([{
      id: "tip-target-only",
      senderId: "fan-22",
      amount: 500_000,
      message: "For your level up",
      createdAt: 1_754_136_123,
      targets: [
        { id: "party-post", type: 1000 },
        { id: "birthday-goal", type: 7100 },
      ],
    }], { kind: "post_tips" });
    expect(canParsePostsObservation(targetOnly)).toBe(true);
    expect(canonicalizePostsObservation(targetOnly)[0]!.data).toMatchObject({
      tipGoalRef: "birthday-goal",
      tipGoalAttribution: "goal",
      tipMessageText: "For your level up",
    });

    for (const tipGoalId of ["other-goal", "birthday-goal-without-target"]) {
      const conflicted = observation([{
        id: `tip-conflict-${tipGoalId}`,
        senderId: "fan-22",
        amount: 10_000,
        tipGoalId,
        createdAt: 1_754_136_123,
        targets: tipGoalId === "other-goal"
          ? [
            { id: "post-a", type: 1000 },
            { id: "birthday-goal", type: 7100 },
          ]
          : [{ id: "post-a", type: 1000 }],
      }], { kind: "post_tips" });
      expect(canParsePostsObservation(conflicted)).toBe(true);
      expect(canonicalizePostsObservation(conflicted)[0]).toMatchObject({
        type: "post.tip_parse_rejected",
        data: { rejectedItems: [{ index: 0, reason: "goal_reference_mismatch" }] },
      });
    }

    const direct = observation([{
      id: "tip-direct",
      senderId: "fan-22",
      amount: 20_000,
      message: "",
      createdAt: 1_754_136_123,
      targets: [{ id: "party-post", type: 1000 }],
    }], { kind: "post_tips" });
    expect(canonicalizePostsObservation(direct)[0]!.data).toMatchObject({
      tipGoalRef: null,
      tipGoalAttribution: "direct",
      tipMessageText: "",
    });
    const badMessage = observation([{
      id: "tip-bad-message",
      senderId: "fan-22",
      amount: 20_000,
      message: 42,
      createdAt: 1_754_136_123,
      targets: [{ id: "party-post", type: 1000 }],
    }], { kind: "post_tips" });
    expect(canParsePostsObservation(badMessage)).toBe(true);
    expect(canonicalizePostsObservation(badMessage)[0]).toMatchObject({
      type: "post.tip_parse_rejected",
      data: { rejectedItems: [{ index: 0, reason: "invalid_core_fields" }] },
    });
  });

  it("isolates one malformed tip without dropping valid siblings", () => {
    const mixed = observation([
      {
        id: "tip-valid",
        senderId: "fan-22",
        amount: 20_000,
        createdAt: 1_754_136_123,
        targets: [{ id: "party-post", type: 1000 }],
      },
      {
        id: "tip-ambiguous",
        senderId: "fan-23",
        amount: 10_000,
        createdAt: 1_754_136_124,
        targets: [
          { id: "post-a", type: 1000 },
          { id: "post-b", type: 1000 },
        ],
      },
    ], { kind: "post_tips" });

    expect(canonicalizePostsObservation(mixed)).toEqual([
      expect.objectContaining({
        type: "post.tip_observed",
        data: expect.objectContaining({ tipId: "tip-valid" }),
      }),
      expect.objectContaining({
        type: "post.tip_parse_rejected",
        data: expect.objectContaining({
          rejectedItemCount: 1,
          rejectedItems: [{ index: 1, reason: "post_target_count" }],
        }),
      }),
    ]);
  });

  it("accepts empty/media-only posts but refuses invalid timestamps and wrong text types", () => {
    expect(canParsePostsObservation(observation({ posts: [] }))).toBe(true);
    expect(canParsePostsObservation(observation({
      posts: [{ id: "media-only", createdAt: 1_754_136_000, attachments: [{}] }],
    }))).toBe(true);
    expect(canonicalizePostsObservation(observation({
      posts: [{ id: "media-only", content: null, createdAt: 1_754_136_000 }],
    }))[0]!.data.textPlain).toBe("");
    expect(canParsePostsObservation(observation({
      posts: [{ id: "bad-time", content: "x", createdAt: "not-a-date" }],
    }))).toBe(false);
    expect(canParsePostsObservation(observation({
      posts: [{ id: "bad-text", content: 123, createdAt: 1_754_136_000 }],
    }))).toBe(false);
  });

  it("dedupes one capture retry but keeps later unchanged sightings distinct", () => {
    const material = {
      platform: "fansly" as const,
      postId: "same-post",
      textPlain: "same text",
      publishedAt: new Date("2026-07-01T00:00:00Z"),
      observedAt: RECEIVED_AT,
      attachmentCount: 0,
    };
    const first = buildPostObservedDraft({ ...material, observationId: 10 });
    const retry = buildPostObservedDraft({ ...material, observationId: 10 });
    const later = buildPostObservedDraft({
      ...material,
      observationId: 11,
      observedAt: new Date("2026-08-03T12:00:00Z"),
    });

    expect(retry.dedupKey).toBe(first.dedupKey);
    expect(later.dedupKey).not.toBe(first.dedupKey);
    expect(later.data.contentHash).toBe(first.data.contentHash);
  });

  it("changes the post material hash when only monetization changes", () => {
    const base = {
      platform: "fansly" as const,
      observationId: 10,
      postId: "money-change",
      textPlain: "same text",
      publishedAt: new Date("2026-07-01T00:00:00Z"),
      observedAt: RECEIVED_AT,
      attachmentCount: 0,
      attachmentTipAmountMills: 0,
      postTipTotalMills: 500_000,
      tipGoalLinked: false,
    };
    const before = buildPostObservedDraft({ ...base, tipAmountMills: 500_000 });
    const after = buildPostObservedDraft({
      ...base,
      observationId: 11,
      tipAmountMills: 520_000,
      postTipTotalMills: 520_000,
    });
    expect(after.data.contentHash).not.toBe(before.data.contentHash);

    const directTip = buildPostTipObservedDraft({
      observationId: 12,
      tipId: "tip-direct",
      postId: "money-change",
      senderPlatformUserId: "fan-1",
      amountMills: 20_000,
      occurredAt: RECEIVED_AT,
      observedAt: RECEIVED_AT,
      receiverTransactionRef: null,
      senderTransactionRef: null,
      tipGoalRef: null,
      tipGoalAttribution: "direct",
      tipMessageText: null,
    });
    expect(directTip.data.amountMills).toBe(20_000);

    const withMessage = buildPostTipObservedDraft({
      observationId: 12,
      tipId: "tip-direct",
      postId: "money-change",
      senderPlatformUserId: "fan-1",
      amountMills: 20_000,
      occurredAt: RECEIVED_AT,
      observedAt: RECEIVED_AT,
      receiverTransactionRef: null,
      senderTransactionRef: null,
      tipGoalRef: null,
      tipGoalAttribution: "direct",
      tipMessageText: "For your level up",
    });
    expect(withMessage.data.contentHash).not.toBe(directTip.data.contentHash);
    expect(withMessage.dedupKey).not.toBe(directTip.dedupKey);

    const unknownGoal = buildPostTipObservedDraft({
      observationId: 12,
      tipId: "tip-direct",
      postId: "money-change",
      senderPlatformUserId: "fan-1",
      amountMills: 20_000,
      occurredAt: RECEIVED_AT,
      observedAt: RECEIVED_AT,
      receiverTransactionRef: null,
      senderTransactionRef: null,
      tipGoalRef: null,
      tipGoalAttribution: "unknown",
      tipMessageText: null,
    });
    expect(unknownGoal.data.contentHash).not.toBe(directTip.data.contentHash);
    expect(unknownGoal.dedupKey).not.toBe(directTip.dedupKey);
    expect(() => buildPostTipObservedDraft({
      observationId: 13,
      tipId: "tip-incoherent",
      postId: "money-change",
      senderPlatformUserId: "fan-1",
      amountMills: 20_000,
      occurredAt: RECEIVED_AT,
      observedAt: RECEIVED_AT,
      receiverTransactionRef: null,
      senderTransactionRef: null,
      tipGoalRef: "goal-without-evidence",
      tipGoalAttribution: "unknown",
      tipMessageText: null,
    })).toThrow("post tip goal attribution is incoherent");
  });
});

// ── WP-F6 — the widened post head ────────────────────────────────────────────
//
// Every fixture here is SYNTHETIC. The field NAMES and the presence/absence
// pattern come from the 2026-08-19 capture (`GET /post?ids=` and
// `/timelinenew`); the values do not.

/** A post shaped like the one live `GET /post?ids=` response: every WP-F6 field
 *  present, `wallIds` served as an empty array, one attachment. */
function widePost(overrides: Record<string, unknown> = {}) {
  return {
    id: "935652730221907968",
    accountId: "737077689877278720",
    content: "@LoraVie\n#viral #brunette #fit",
    fypFlags: 0,
    inReplyTo: null,
    inReplyToRoot: null,
    replyPermissionFlags: null,
    createdAt: 1_754_136_000,
    expiresAt: null,
    attachments: [{ postId: "935652730221907968", pos: 0, contentType: 1, contentId: "media-1" }],
    likeCount: 30,
    replyCount: 1,
    wallIds: [],
    mediaLikeCount: 159,
    totalTipAmount: 0,
    attachmentTipAmount: 0,
    accountMentions: [{ start: 0, end: 7, handle: "loravie", accountId: "737077689877278720" }],
    ...overrides,
  };
}

describe("WP-F6 the engagement/thread/placement material", () => {
  it("carries every widened field into the event, typed", () => {
    const [event] = canonicalizePostsObservation(observation({ posts: [widePost()] }));
    expect(event!.schemaVersion).toBe(3);
    expect(event!.data).toMatchObject({
      likeCount: 30,
      mediaLikeCount: 159,
      replyCount: 1,
      fypFlags: 0,
      expiresAt: null,
      inReplyToRef: null,
      inReplyToRootRef: null,
      // Served and EMPTY — a different fact from absent, and the arrays keep
      // them apart.
      wallRefs: [],
      accountMentionRefs: ["737077689877278720"],
    });
    // The attachment id-relations, and only those three keys. `postId` is
    // dropped as redundant with the row's own key.
    expect(event!.data.attachmentRefs).toEqual([
      { pos: 0, contentType: 1, contentId: "media-1" },
    ]);
  });

  it("distinguishes an ABSENT field from a served empty one — absent is null, never 0", () => {
    // The timeline shape: no `replyCount` on 6 of the 15 live posts, and no
    // `wallIds` key on any of them.
    const timelinePost = widePost();
    delete (timelinePost as Record<string, unknown>).replyCount;
    delete (timelinePost as Record<string, unknown>).wallIds;
    delete (timelinePost as Record<string, unknown>).accountMentions;
    delete (timelinePost as Record<string, unknown>).attachments;
    const [event] = canonicalizePostsObservation(observation({ posts: [timelinePost] }));
    expect(event!.data).toMatchObject({
      likeCount: 30,
      // "The provider did not say", NOT "nobody replied".
      replyCount: null,
      wallRefs: null,
      accountMentionRefs: null,
      // An absent `attachments` cannot prove the post has none — the same
      // distinction `tipGoalLinked` already makes.
      attachmentRefs: null,
    });
    // An explicit zero survives as a zero.
    const [zeroed] = canonicalizePostsObservation(observation({
      posts: [widePost({ likeCount: 0, replyCount: 0, mediaLikeCount: 0 })],
    }));
    expect(zeroed!.data).toMatchObject({ likeCount: 0, replyCount: 0, mediaLikeCount: 0 });
  });

  it("stores inReplyTo and inReplyToRoot separately", () => {
    const [event] = canonicalizePostsObservation(observation({
      posts: [widePost({ inReplyTo: "parent-1", inReplyToRoot: "root-1" })],
    }));
    // Equal in every observed reply; kept apart because the day a NESTED reply
    // arrives the difference is what reconstructs the thread, and no re-walk
    // recovers it retroactively.
    expect(event!.data).toMatchObject({
      inReplyToRef: "parent-1",
      inReplyToRootRef: "root-1",
    });
  });

  it("decodes expiresAt with the same clock as createdAt", () => {
    const [event] = canonicalizePostsObservation(observation({
      posts: [widePost({ expiresAt: 1_754_222_400 })],
    }));
    expect(event!.data.expiresAt).toBe("2025-08-03T12:00:00.000Z");
  });

  it("refuses the WHOLE page on a widened field it cannot read", () => {
    for (
      const drift of [
        { likeCount: "30" },
        { replyCount: -1 },
        { fypFlags: 1.5 },
        { wallIds: [{ id: "wall-1" }] },
        { accountMentions: [{ handle: "loravie" }] },
        { inReplyTo: "" },
        { expiresAt: "not-a-date" },
      ]
    ) {
      const payload = { posts: [widePost(drift)] };
      // Journaled upstream, refused here: a drifted response stays UNSTAMPED
      // and replayable rather than half-parsed into a serving table.
      expect(canParsePostsObservation(observation(payload)), JSON.stringify(drift)).toBe(false);
      expect(canonicalizePostsObservation(observation(payload))).toEqual([]);
    }
  });

  it("puts no delivery URL anywhere near the event, whatever the attachment carries", () => {
    const [event] = canonicalizePostsObservation(observation({
      posts: [widePost({
        attachments: [{
          postId: "935652730221907968",
          pos: 0,
          contentType: 1,
          contentId: "media-1",
          // Not a shape observed on `attachments[]` today — the point is that a
          // key nobody copies cannot reach a serving column tomorrow either.
          location: "https://cdn.example/signed/blob.mp4",
          variants: [{ location: "https://cdn.example/signed/720.mp4" }],
        }],
      })],
    }));
    expect(JSON.stringify(event!.data)).not.toContain("cdn.example");
    expect(JSON.stringify(event!.data)).not.toContain("http");
    expect(event!.data.attachmentRefs).toEqual([
      { pos: 0, contentType: 1, contentId: "media-1" },
    ]);
  });

  it("makes a moved counter a NEW material revision, not an in-place edit", () => {
    const [first] = canonicalizePostsObservation(observation({ posts: [widePost()] }));
    const [later] = canonicalizePostsObservation(
      observation({ posts: [widePost({ likeCount: 31 })] }, { id: 72 }),
    );
    expect(first!.data.contentHash).not.toBe(later!.data.contentHash);
    expect(first!.dedupKey).not.toBe(later!.dedupKey);
    // A re-read that saw the SAME numbers hashes identically; only the
    // observation lineage differs, which is what makes a re-sighting advance
    // `last_observed_at` without minting a spurious revision.
    const [unchanged] = canonicalizePostsObservation(
      observation({ posts: [widePost()] }, { id: 73 }),
    );
    expect(unchanged!.data.contentHash).toBe(first!.data.contentHash);
    expect(unchanged!.dedupKey).not.toBe(first!.dedupKey);
  });

  it("keeps every event payload far under the 64 KiB sanity ceiling", () => {
    for (const draft of canonicalizePostsObservation(observation({ posts: [widePost()] }))) {
      expect(Buffer.byteLength(JSON.stringify(draft.data))).toBeLessThan(64 * 1024);
    }
  });
});

describe("WP-F6 the hashtag grammar (A8)", () => {
  it("derives tags from the CAPTION and nowhere else", () => {
    const [event] = canonicalizePostsObservation(observation({ posts: [widePost()] }));
    expect(event!.data.hashtags).toEqual(["viral", "brunette", "fit"]);
    expect(event!.data.hashtagsNormalized).toEqual(["viral", "brunette", "fit"]);
    expect(event!.data.hashtagParserVersion).toBe(HASHTAG_PARSER_VERSION);
    // There is no structured tag field on any post object in the capture, so a
    // caption with no `#` yields an EMPTY list rather than null.
    const [untagged] = canonicalizePostsObservation(observation({
      posts: [widePost({ content: "no tags here" })],
    }));
    expect(untagged!.data.hashtags).toEqual([]);
    expect(untagged!.data.hashtagsNormalized).toEqual([]);
  });

  it("accepts Unicode letters, numbers, marks and underscore — not just \\w", () => {
    expect(deriveHashtags("#кисуля #日本語 #tag_2026 #café").raw)
      .toEqual(["кисуля", "日本語", "tag_2026", "café"]);
    // Combining marks belong to the token: the decomposed spelling of `café`
    // is the same tag typed a different way, and dropping the mark would cut
    // the token in half.
    expect(deriveHashtags("#cafe\u0301").raw).toEqual(["cafe\u0301"]);
  });

  it("tolerates ONE trailing + — defensively, and claims nothing about it", () => {
    // SYNTHETIC. No tag with a trailing `+` appears anywhere in the HAR; the
    // grammar tolerates the character so a caption that types it does not lose
    // it, and this assertion must never be read as an observation (A8).
    expect(deriveHashtags("#synthetic+").raw).toEqual(["synthetic+"]);
    // One, not many, and not in the middle.
    expect(deriveHashtags("#synthetic++").raw).toEqual(["synthetic+"]);
    expect(deriveHashtags("#syn+thetic").raw).toEqual(["syn+"]);
  });

  it("NFKC-folds before lowercasing, and de-duplicates by the folded form", () => {
    // Full-width and ASCII are one tag; folding after lowercasing would leave
    // them apart.
    expect(deriveHashtags("#\uFF26\uFF29\uFF34").normalized).toEqual(["fit"]);
    const repeated = deriveHashtags("#Viral #viral #VIRAL");
    // One tag named three times is one tag — and the two arrays stay the same
    // length, which is the pairing the table's CHECK constraint enforces.
    expect(repeated.raw).toEqual(["Viral"]);
    expect(repeated.normalized).toEqual(["viral"]);
    expect(repeated.raw.length).toBe(repeated.normalized.length);
  });

  it("stops the token at the first character outside the grammar", () => {
    expect(deriveHashtags("#one,#two. #three! #f-our").raw)
      .toEqual(["one", "two", "three", "f"]);
    expect(deriveHashtags("no#lead").raw).toEqual(["lead"]);
    expect(deriveHashtags("# ").raw).toEqual([]);
  });

  it("makes a grammar change a NEW revision rather than a silent rewrite", () => {
    const material = {
      platform: "fansly" as const,
      observationId: 71,
      postId: "post-42",
      textPlain: "#viral",
      publishedAt: new Date("2026-07-20T10:00:00Z"),
      observedAt: RECEIVED_AT,
      attachmentCount: 0,
    };
    // The parser version participates in the content hash, so re-deriving the
    // tokens under a new grammar mints a new head instead of overwriting the
    // lineage that produced the old ones.
    const draft = buildPostObservedDraft(material);
    expect(draft.data.hashtagParserVersion).toBe(HASHTAG_PARSER_VERSION);
    const withoutTag = buildPostObservedDraft({ ...material, textPlain: "viral" });
    expect(withoutTag.data.contentHash).not.toBe(draft.data.contentHash);
  });
});

describe("WP-F6 §3.2b — post.observed is PROVIDER-dated, and the clamp proves it", () => {
  it("clamps a pre-2024 publication to receipt time and preserves the raw instant", () => {
    const publishedAt = new Date("2022-05-04T08:30:00.000Z");
    expect(publishedAt.getTime()).toBeLessThan(OCCURRED_AT_CLAMP_MIN.getTime());
    const [draft] = canonicalizePostsObservation(observation({
      posts: [widePost({ createdAt: Math.floor(publishedAt.getTime() / 1000) })],
    }));
    // The DRAFT is provider-dated — this family is §3.2b's exception, and that
    // is exactly why the driver's clamp can fire on it at all. A receipt-time
    // family is inside the window by construction and can never produce a clamp
    // marker; its presence here is the proof this lane is the other kind.
    expect(draft!.occurredAt.toISOString()).toBe(publishedAt.toISOString());

    const clamped = clampDraftOccurredAt(draft!, RECEIVED_AT, new Date("2026-08-02T12:00:00Z"));
    expect(clamped.occurredAt.toISOString()).toBe(RECEIVED_AT.toISOString());
    expect(clamped.data.occurredAtClamped).toBe(true);
    expect(clamped.data.occurredAtRaw).toBe(publishedAt.toISOString());
    // …and the TRUE publication date survives in `data`, which is what the
    // projector dates the row from. The clamp moves where the event LANDS in
    // the partitioned ledger; it never rewrites what the platform said.
    expect(clamped.data.publishedAt).toBe(publishedAt.toISOString());
    // The dedup key is built BEFORE the clamp, so a replay stays key-stable.
    expect(clamped.dedupKey).toBe(draft!.dedupKey);
  });

  it("leaves a 2026 publication untouched", () => {
    const [draft] = canonicalizePostsObservation(observation({ posts: [widePost()] }));
    const passed = clampDraftOccurredAt(draft!, RECEIVED_AT, new Date("2026-08-02T12:00:00Z"));
    expect(passed).toBe(draft);
    expect(passed.data.occurredAtClamped).toBeUndefined();
    expect(passed.data.occurredAtRaw).toBeUndefined();
  });
});
