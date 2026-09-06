import { describe, expect, it } from "vitest";
import {
  canonicalizeOfapiContentObservation,
  ofapiLikedPostRef,
} from "../apps/runtime/src/services/canonicalize/ofapi-content-events.ts";
import type { CanonicalizableObservation } from "../apps/runtime/src/services/canonicalize/types.ts";
const observation = (
  kind: string,
  payload: unknown,
): CanonicalizableObservation => ({
  id: 1,
  source: "webhook",
  producer: "onlyfansapi",
  platform: "onlyfans",
  accountId: 1,
  kind,
  payload: { event: kind, account_id: "acct_test", payload },
  observedAt: null,
  receivedAt: new Date("2026-09-06T12:00:00Z"),
});
const like = {
  id: "99",
  user_id: "999",
  user: { id: "90071992547409931234" },
  createdAt: "2026-09-06T10:00:00Z",
  replacePairs: {
    "{POST_LINK}": "<a href='https://onlyfans.com/123/creator'>post</a>",
  },
};
describe("OFAPI content webhook evidence", () => {
  it("keeps notification, post and actor namespaces separate and large IDs exact", () => {
    const event = canonicalizeOfapiContentObservation(
      observation("posts.liked", like),
    )[0]!;
    expect(event).toMatchObject({
      type: "ofapi.post_like_observed",
      postRef: "123",
      fanIdentityRef: "90071992547409931234",
      data: { notificationRef: "99", sourceAt: "2026-09-06T10:00:00.000Z" },
    });
    expect(
      canonicalizeOfapiContentObservation(
        observation("posts.liked", { ...like, user: undefined }),
      ),
    ).toEqual([]);
    expect(
      canonicalizeOfapiContentObservation(
        observation("posts.liked", {
          ...like,
          user: { id: Number.MAX_SAFE_INTEGER + 1 },
        }),
      ),
    ).toEqual([]);
  });
  it("keeps unattributed evidence and never trusts an arbitrary or ambiguous URL", () => {
    for (const value of [
      undefined,
      "<a href='https://evil.test/123/creator'>post</a>",
      "<a href='https://onlyfans.com@evil.test/123/creator'>post</a>",
      "<a href='https://onlyfans.com/123/creator'>x</a><a href='https://onlyfans.com/456/creator'>y</a>",
    ]) {
      const payload = { ...like, replacePairs: { "{POST_LINK}": value } };
      expect(ofapiLikedPostRef(payload)).toBeNull();
      expect(
        canonicalizeOfapiContentObservation(
          observation("posts.liked", payload),
        )[0],
      ).toMatchObject({ postRef: null, data: { attribution: "unattributed" } });
    }
  });
  it("preserves canceled finished flags without creating recipient sends or invented source timestamps", () => {
    const event = canonicalizeOfapiContentObservation(
      observation("chat_queue.finished", {
        id: 12,
        date: "2026-09-01T00:00:00Z",
        isDone: true,
        isCanceled: true,
        pending: 0,
        total: 7,
      }),
    )[0]!;
    expect(event).toMatchObject({
      type: "ofapi.chat_queue_observed",
      data: {
        phase: "finished",
        isCanceled: true,
        isDone: true,
        pending: 0,
        total: 7,
        timeBasis: "receipt",
        queueDate: "2026-09-01T00:00:00.000Z",
      },
    });
    expect(event.fanIdentityRef).toBeUndefined();
    expect(event.messageRef).toBeUndefined();
    const other = observation("chat_queue.finished", {
      id: 12,
      date: "2026-09-01T00:00:00Z",
      isDone: true,
      isCanceled: true,
      pending: 0,
      total: 7,
    });
    other.receivedAt = new Date("2026-09-07");
    expect(canonicalizeOfapiContentObservation(other)[0]?.dedupKey).toBe(
      event.dedupKey,
    );
  });
});
