import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalizeFanslyCommentsObservation,
  canParseFanslyCommentsObservation,
  FANSLY_COMMENTS_CANONICALIZED_KINDS,
  FANSLY_COMMENTS_EVENT_TYPES,
  REPLIES_FULL_PAGE_THRESHOLD,
} from "../apps/runtime/src/services/canonicalize/fansly-comments.ts";
import { CANONICALIZER_FAMILIES } from "../apps/runtime/src/services/canonicalize/index.ts";
import { WRITTEN_OBSERVATION_KINDS } from "../apps/runtime/src/services/observation-kinds.ts";
import type {
  CanonicalEventDraft,
  CanonicalizableObservation,
} from "../apps/runtime/src/services/canonicalize/types.ts";

// WP-F5 — the `fansly-comments` family, fixture by fixture.
//
// The five ways this family can be wrong in a way `pnpm check` would otherwise
// call fine:
//
// 1. THE EMPTY BODY. `posts: []` is an ANSWER — "this post has no comments any
//    more" — and it is the answer `missing_since` is computed from. Refusing it
//    would make deletion unrepresentable; accepting a DRIFTED body as it would
//    delete an archive.
// 2. THE EMPTY REPLY. `content: ""` is a real live value, and a parser that
//    treats empty as absent silently drops a fan's reply.
// 3. THE MISSING SIDECAR. `accounts[]` was EMPTY in 2 of 5 live responses, so
//    the display fields must be optional and the author ref must survive alone.
// 4. THE DATE. Receipt-time (§3.2b): the provider instant is a field in `data`,
//    never `occurredAt` — `domain_events` is monthly-partitioned and a 2023
//    comment dated at provider time fails ExecFindPartition (23514) forever.
// 5. THE TRUNCATION CLAIM. A page that could not be proven complete must say
//    so, or the projector will mark live comments deleted.

const FIXTURES = path.resolve("tests/fixtures/fansly-comments");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")) as unknown;
}

const RECEIVED_AT = new Date("2026-08-22T09:00:00.000Z");

function observation(payload: unknown, id = 1): CanonicalizableObservation {
  return {
    id,
    source: "pull",
    producer: "sync",
    platform: "fansly",
    accountId: 7,
    kind: "post_replies",
    payload,
    observedAt: null,
    receivedAt: RECEIVED_AT,
  };
}

function drafts(payload: unknown, id = 1): CanonicalEventDraft[] {
  return canonicalizeFanslyCommentsObservation(observation(payload, id));
}

function comments(payload: unknown, id = 1): CanonicalEventDraft[] {
  return drafts(payload, id).filter((draft) => draft.type === "post.comment_observed");
}

function roster(payload: unknown, id = 1): CanonicalEventDraft {
  const found = drafts(payload, id).find((draft) => draft.type === "post.comment_list_observed");
  if (found === undefined) {
    throw new Error("expected a roster draft");
  }
  return found;
}

/** A synthetic reply page with `count` identical-shaped replies — the only way
 *  to reach the full-page threshold, since no live response ever carried more
 *  than four. */
function syntheticPage(count: number, options: { before?: string | null } = {}) {
  return {
    walk: { postId: "000910000000000001", before: options.before ?? null },
    response: {
      posts: Array.from({ length: count }, (_unused, index) => ({
        id: `00091000000000${String(1000 + index)}`,
        accountId: "000910000000000201",
        content: `reply ${index}`,
        inReplyTo: "000910000000000001",
        inReplyToRoot: "000910000000000001",
        createdAt: 1786709378 - index,
        attachments: [],
        likeCount: 0,
        mediaLikeCount: 0,
        totalTipAmount: 0,
        attachmentTipAmount: 0,
      })),
      accounts: [],
    },
  };
}

describe("WP-F5 fansly-comments family registration", () => {
  it("claims the `post_replies` kind, projection-only, and nothing else", () => {
    expect([...FANSLY_COMMENTS_CANONICALIZED_KINDS]).toEqual(["post_replies"]);
    const family = CANONICALIZER_FAMILIES.find((entry) => entry.lane === "comments");
    expect(family?.source).toBe("pull");
    expect(family?.projectionOnly).toBe(true);
    expect(family?.kinds).toEqual(["post_replies"]);
    // Registered as a written kind — the §9.2 ratchet fails otherwise.
    const registered = WRITTEN_OBSERVATION_KINDS.find((entry) => entry.kind === "post_replies");
    expect(registered?.source).toBe("pull");
    expect(registered?.writer).toBe("services/sync/fansly-post-replies.ts");
  });

  it("emits exactly two event types", () => {
    expect([...FANSLY_COMMENTS_EVENT_TYPES]).toEqual([
      "post.comment_observed",
      "post.comment_list_observed",
    ]);
  });
});

describe("WP-F5 the 4-reply parity fixture", () => {
  it("reads every body, both parent fields and both tip bases", () => {
    const payload = fixture("replies-four-with-accounts");
    const rows = comments(payload);
    expect(rows).toHaveLength(4);

    const byRef = new Map(rows.map((row) => [String(row.data.commentRef), row.data]));

    const first = byRef.get("000910000000000101")!;
    expect(first.textPlain).toBe("first one");
    expect(first.parentPostRef).toBe("000910000000000001");
    expect(first.rootRef).toBe("000910000000000001");
    expect(first.authorRef).toBe("000910000000000201");
    // The sidecar was populated on this fixture, so the display fields ride
    // along.
    expect(first.authorUsername).toBe("fixture_fan");
    expect(first.authorDisplayName).toBe("Fixture Fan");

    // THE EMPTY-CONTENT REPLY IS KEPT. One of the four live replies has
    // `content: ""`; dropping it would make the reply count disagree with the
    // archive with no way to tell which is wrong.
    const empty = byRef.get("000910000000000102")!;
    expect(empty.textPlain).toBe("");
    expect(empty.authorRef).toBe("000910000000000202");

    // MONEY IS MILLS, as decimal STRINGS, and the two bases stay apart: a tip on
    // the comment and a tip on its attachment have different bases (§2.3) and
    // are never summed into one number.
    const tipped = byRef.get("000910000000000103")!;
    expect(tipped.tipTotalMills).toBe("5000");
    expect(tipped.attachmentTipMills).toBe("1500");
    expect(tipped.likeCount).toBe(1);
    expect(tipped.mediaLikeCount).toBe(2);
    expect(tipped.attachmentCount).toBe(1);

    // THREADING. `inReplyTo` differs from `inReplyToRoot` on the nested reply,
    // and both are journaled — the difference is the only thing that ever
    // reconstructs a thread, and no re-walk recovers it retroactively.
    const nested = byRef.get("000910000000000104")!;
    expect(nested.parentPostRef).toBe("000910000000000101");
    expect(nested.rootRef).toBe("000910000000000001");
  });

  it("is RECEIPT-TIME with the provider instant typed in data", () => {
    const rows = comments(fixture("replies-four-with-accounts"));
    for (const row of rows) {
      expect(row.occurredAt).toEqual(RECEIVED_AT);
      // §3.2b: the provider instant is a FIELD, and `createdAt` is SECONDS on
      // this route.
      expect(typeof row.data.publishedAtSeconds).toBe("number");
      expect(String(row.data.publishedAt)).toMatch(/^20\d\d-/u);
      // A receipt-time draft is by construction inside the clamp window, so an
      // event from this family can never carry a clamp marker.
      expect(row.data.occurredAtClamped).toBeUndefined();
      expect(row.data.occurredAtRaw).toBeUndefined();
    }
    const seconds = Number(rows[0]!.data.publishedAtSeconds);
    expect(new Date(String(rows[0]!.data.publishedAt)).getTime()).toBe(seconds * 1000);
  });

  it("keys an edit as a REVISION and an unchanged re-read as a no-op", () => {
    const payload = fixture("replies-four-with-accounts") as {
      response: { posts: { content: string }[] };
    };
    const before = comments(payload).map((row) => row.dedupKey);
    // The SAME observation replayed produces the same keys — a re-read of
    // unchanged bytes appends nothing.
    expect(comments(payload).map((row) => row.dedupKey)).toEqual(before);

    const edited = JSON.parse(JSON.stringify(payload)) as typeof payload;
    edited.response.posts[0]!.content = "first one, edited";
    const after = comments(edited).map((row) => row.dedupKey);
    // Exactly one key moved: the edited comment's. An edit is a new event and a
    // head update, not a silent overwrite.
    expect(after.filter((key, index) => key !== before[index])).toHaveLength(1);
    expect(after[0]).not.toBe(before[0]);
    expect(after[0]).toMatch(/^comment:v1:7:000910000000000101:[0-9a-f]{64}$/u);
  });

  it("emits ONE roster naming every reply, keyed per LOOK", () => {
    const payload = fixture("replies-four-with-accounts");
    const first = roster(payload, 41);
    expect(first.data.parentPostRef).toBe("000910000000000001");
    expect(first.data.count).toBe(4);
    expect(first.data.refs).toEqual([
      "000910000000000101",
      "000910000000000102",
      "000910000000000103",
      "000910000000000104",
    ]);
    expect(first.data.possiblyTruncated).toBe(false);
    expect(first.occurredAt).toEqual(RECEIVED_AT);
    expect(first.dedupKey).toContain(":41:");

    // PER LOOK, not per ref-set (WP-F3's correction). A comment deleted and
    // restored UNCHANGED produces the roster it had before it vanished; a
    // set-hash key would dedupe that event and leave the row marked forever.
    const second = roster(payload, 42);
    expect(second.dedupKey).not.toBe(first.dedupKey);
    expect(second.dedupKey).toContain(":42:");
  });

  it("puts the roster LAST, so every comment it names is already upserted", () => {
    const all = drafts(fixture("replies-four-with-accounts"));
    expect(all[all.length - 1]?.type).toBe("post.comment_list_observed");
    expect(all.slice(0, -1).every((draft) => draft.type === "post.comment_observed")).toBe(true);
  });

  it("keeps every event payload far under the 64 KiB sanity ceiling", () => {
    for (const draft of drafts(fixture("replies-four-with-accounts"))) {
      expect(Buffer.byteLength(JSON.stringify(draft.data))).toBeLessThan(64 * 1024);
    }
  });
});

describe("WP-F5 the shapes that decide `missing_since`", () => {
  it("reads an EMPTY reply list as an answer, not as a failure", () => {
    const payload = fixture("replies-empty");
    expect(canParseFanslyCommentsObservation(observation(payload))).toBe(true);
    const all = drafts(payload);
    // No row events at all — which is exactly why the roster has to exist.
    expect(all).toHaveLength(1);
    expect(all[0]?.type).toBe("post.comment_list_observed");
    expect(all[0]?.data.count).toBe(0);
    expect(all[0]?.data.refs).toEqual([]);
    // The post id comes from the WALK envelope. The body names no post, so a
    // parser reading it alone could never say which post lost its comments.
    expect(all[0]?.data.parentPostRef).toBe("000910000000000001");
    // Complete, therefore reconcilable: the projector may mark the complement.
    expect(all[0]?.data.possiblyTruncated).toBe(false);
  });

  it("reads the SYNTHETIC 204 marker as no rows, but never as proof of deletion", () => {
    // Named `synthetic_get_204` because no GET anywhere in the capture returned
    // 204 (all 197 are OPTIONS preflights), and production's "no replies" is a
    // 200 with `posts: []`. This is the handling of a case never observed, not
    // an observed contract.
    const payload = fixture("synthetic_get_204");
    expect(canParseFanslyCommentsObservation(observation(payload))).toBe(true);
    const all = drafts(payload);
    expect(all).toHaveLength(1);
    expect(all[0]?.data.count).toBe(0);
    expect(all[0]?.data.parentPostRef).toBe("000910000000000003");
    // Stamped, and its roster clears — but it may never mark the complement: a
    // proxy that swallowed a body would read as every comment deleted.
    expect(all[0]?.data.possiblyTruncated).toBe(true);
  });

  it("treats an EMPTY 2xx body the same as the 204 marker", () => {
    const payload = {
      walk: { postId: "000910000000000003", before: null },
      response: { __empty: true, httpStatus: 200 },
    };
    expect(canParseFanslyCommentsObservation(observation(payload))).toBe(true);
    const all = drafts(payload);
    expect(all).toHaveLength(1);
    expect(all[0]?.data.refs).toEqual([]);
    expect(all[0]?.data.possiblyTruncated).toBe(true);
  });

  it("REFUSES a body it cannot recognize, leaving the observation unstamped", () => {
    // The load-bearing negative. A drifted payload that parsed as "no comments"
    // would mark a whole post's archive deleted, so an unreadable shape is left
    // for a future parser instead of consumed with zero events.
    for (const response of [null, "nope", 7, { data: [] }, { posts: "not-an-array" }]) {
      const payload = { walk: { postId: "000910000000000001", before: null }, response };
      expect(canParseFanslyCommentsObservation(observation(payload))).toBe(false);
      expect(drafts(payload)).toEqual([]);
    }
  });

  it("REFUSES a body with no walk envelope", () => {
    const payload = { posts: [] };
    expect(canParseFanslyCommentsObservation(observation(payload))).toBe(false);
    expect(drafts(payload)).toEqual([]);
  });
});

describe("WP-F5 the author-hydration fallback path", () => {
  it("keeps the author ref and NULLs the display fields when `accounts[]` is empty", () => {
    // 2 of 5 live responses. The fallback is mandatory because of this shape,
    // and the shape has to survive parsing with the identity intact.
    const rows = comments(fixture("replies-accounts-empty"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data.authorRef).toBe("000910000000000205");
    expect(rows[0]?.data.authorUsername).toBeNull();
    expect(rows[0]?.data.authorDisplayName).toBeNull();
    expect(rows[0]?.data.textPlain).toBe("no sidecar for me");
  });
});

describe("WP-F5 truncation honesty", () => {
  it("marks nothing truncated on a page below the threshold", () => {
    const page = syntheticPage(REPLIES_FULL_PAGE_THRESHOLD - 1);
    expect(comments(page).every((row) => row.data.possiblyTruncated === false)).toBe(true);
    expect(roster(page).data.possiblyTruncated).toBe(false);
  });

  it("marks a suspiciously FULL page truncated — rows and roster alike", () => {
    const page = syntheticPage(REPLIES_FULL_PAGE_THRESHOLD);
    expect(comments(page).every((row) => row.data.possiblyTruncated === true)).toBe(true);
    // The roster's flag is what forbids the projector from marking a complement
    // missing: a truncated page's complement is unknowable, and guessing it
    // would delete an archive one page at a time.
    expect(roster(page).data.possiblyTruncated).toBe(true);
  });

  it("marks ANY cursor-fetched page truncated, however few rows it carried", () => {
    // Deliberately conservative. One response can prove nothing about a second
    // page on a route whose pagination has never been observed, so a page
    // reached through a cursor carries the same doubt a full one does.
    const page = syntheticPage(2, { before: "000910000000001000" });
    expect(comments(page).every((row) => row.data.possiblyTruncated === true)).toBe(true);
    expect(roster(page).data.possiblyTruncated).toBe(true);
    expect(roster(page).data.cursor).toBe("000910000000001000");
  });
});

describe("WP-F5 the pre-2024 receipt-time pin", () => {
  it("dates a 2023 comment at RECEIPT time and types the provider instant", () => {
    const rows = comments(fixture("replies-pre-2024"));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // The whole point: `domain_events` is monthly-partitioned, and a draft dated
    // 2023 would fail ExecFindPartition (23514) forever. `occurredAt` is the
    // look; the comment's real date is preserved in `data` and the projection
    // keeps it.
    expect(row.occurredAt).toEqual(RECEIVED_AT);
    expect(row.data.publishedAt).toBe(new Date(1688000000 * 1000).toISOString());
    expect(String(row.data.publishedAt).startsWith("2023-")).toBe(true);
    // NO CLAMP MARKER. Its presence would mean this family had gone
    // provider-dated, which is the failure signal §3.2b names.
    expect(row.data.occurredAtClamped).toBeUndefined();
    expect(row.data.occurredAtRaw).toBeUndefined();
  });
});
