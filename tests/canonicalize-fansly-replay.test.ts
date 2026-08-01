import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { isProjectionOnlyDomainEventType } from "@agency_hub_core/db";

import {
  asDomainInstant,
  canonicalizeFanslyReplayObservation,
  canParseFanslyReplayObservation,
  FANSLY_REPLAY_CANONICALIZED_KINDS,
  FANSLY_REPLAY_EVENT_TYPES,
  FANSLY_REPLAY_FAMILY,
} from "../apps/runtime/src/services/canonicalize/fansly-replay.ts";
import { CANONICALIZER_FAMILIES } from "../apps/runtime/src/services/canonicalize/index.ts";
import type { CanonicalizableObservation } from "../apps/runtime/src/services/canonicalize/types.ts";
import {
  trimFanslyFollowerPayload,
  trimFanslyMessagingGroupsPayload,
} from "../apps/runtime/src/services/sync/shared.ts";

const OBSERVED_AT = new Date("2026-03-15T08:00:00Z");
const RECEIVED_AT = new Date("2026-03-15T08:00:05Z");

/** The production response envelope: `_meta` + `data.response`; the adapter
 *  journals exactly `data.response` as the observation payload. */
async function loadResponse<T>(name: string): Promise<T> {
  const raw = await readFile(path.resolve("reference/responses", name), "utf8");
  const parsed = JSON.parse(raw) as { data: { response: T } };
  return parsed.data.response;
}

function observation(
  kind: string,
  payload: unknown,
  overrides: Partial<CanonicalizableObservation> = {},
): CanonicalizableObservation {
  return {
    id: 1,
    source: "pull",
    producer: "sync:fansly:followers",
    platform: "fansly",
    accountId: 7,
    kind,
    payload,
    observedAt: OBSERVED_AT,
    receivedAt: RECEIVED_AT,
    ...overrides,
  };
}

function context(ownRef: string | null) {
  return { nativeAccountRefByAccountId: new Map([[7, ownRef]]) };
}

function byType(events: ReturnType<typeof canonicalizeFanslyReplayObservation>, type: string) {
  return events.filter((event) => event.type === type);
}

describe("Fansly replay canonicalizers (slice D)", () => {
  it("stays OUT of the minutely sweep registry — the flag is the only driver", () => {
    // Registering the family would put it on the unconditional per-minute
    // sweep, and fanslyReplayMode would gate nothing.
    for (const family of CANONICALIZER_FAMILIES) {
      expect(family.canonicalize).not.toBe(FANSLY_REPLAY_FAMILY.canonicalize);
    }
    expect([...FANSLY_REPLAY_CANONICALIZED_KINDS].sort()).toEqual([
      "account_me",
      "dm_conversations",
      "followers",
      "subscribers",
    ]);
  });

  it("declares every emitted type projection-only, so no client is handed the backfill", () => {
    // Review round 1: these events describe year-old facts but take FRESH
    // account_seq values, so a reconnecting SSE client would replay the whole
    // backfill as news. The family flag and the type registry are one
    // decision — the driver's checkpoint protocol depends on both.
    expect(FANSLY_REPLAY_FAMILY.projectionOnly).toBe(true);
    for (const type of FANSLY_REPLAY_EVENT_TYPES) {
      expect(isProjectionOnlyDomainEventType(type)).toBe(true);
    }
  });

  it("emits nothing for a non-Fansly observation of a shared kind", () => {
    // dm_conversations is journaled by the OFAPI DM sync too, under the same
    // kind and a completely different shape.
    const events = canonicalizeFanslyReplayObservation(
      observation("dm_conversations", { data: [{ groupId: "g1" }] }, { platform: "onlyfans" }),
    );
    expect(events).toEqual([]);
  });

  describe("followers (journaled TRIMMED)", () => {
    it("mints one follow per relation and one identity per aggregated account", async () => {
      const response = await loadResponse("followers.json");
      const trimmed = trimFanslyFollowerPayload(response);
      const events = canonicalizeFanslyReplayObservation(observation("followers", trimmed));

      const follows = byType(events, "follow.observed");
      const identities = byType(events, "fan.identity_observed");
      expect(follows).toHaveLength(trimmed.followers.length);
      expect(identities).toHaveLength(trimmed.aggregationData.accounts.length);

      const first = follows[0]!;
      expect(first.dedupKey).toBe("follow:885754550978359296");
      expect(first.fanIdentityRef).toBe("870585695649939456");
      // The follow relation id IS the follow moment (snowflake).
      expect(first.data.followedAt).toBe("2026-03-05T01:38:21.377Z");
      // Snapshot semantics: occurredAt is when we OBSERVED, never the domain
      // timestamp — so the driver's 2024-01-01 clamp can never rewrite it.
      expect(first.occurredAt).toEqual(OBSERVED_AT);

      const identity = identities[0]!;
      expect(identity.dedupKey.startsWith("fan_identity:")).toBe(true);
      expect(identity.data.username).toBe(trimmed.aggregationData.accounts[0]!.username);
    });

    it("survives a payload the trimmer left without aggregation data", () => {
      const trimmed = trimFanslyFollowerPayload({ followers: [{ id: "1", followerId: "2" }] });
      const events = canonicalizeFanslyReplayObservation(observation("followers", trimmed));
      expect(byType(events, "fan.identity_observed")).toHaveLength(0);
      expect(byType(events, "follow.observed")).toHaveLength(1);
    });

    it("drops rows the trimmer could not complete instead of inventing ids", () => {
      const events = canonicalizeFanslyReplayObservation(observation("followers", {
        followers: [{ id: "1" }, { followerId: "2" }, null, "garbage"],
        aggregationData: { accounts: [{ displayName: "no id" }] },
      }));
      expect(events).toEqual([]);
    });
  });

  describe("vendor timestamps: interpret, then refuse the uninterpretable", () => {
    // Review round 1 (P1-4). Fansly mixes epoch seconds and milliseconds in
    // the same payload family — that is why this repo has asFanslyTimestamp
    // at all, and why migration 0077 exists. These values become floors that
    // fold monotonically EARLIER, so a 1970 written here can never be lifted
    // by a later, correct run. Refuse instead of defaulting.
    it("reads a seconds-valued timestamp as seconds, not as 1970", () => {
      // 1745781549 seconds and 1745781549000 ms are the SAME instant; read as
      // milliseconds the seconds value would be 1970-01-21.
      expect(asDomainInstant(1_745_781_549)?.toISOString()).toBe("2025-04-27T19:19:09.000Z");
      expect(asDomainInstant(1_745_781_549_000)?.toISOString()).toBe("2025-04-27T19:19:09.000Z");
    });

    it("refuses zero, negative, non-numeric and pre-platform values", () => {
      // `lastSeenAt: 0` is live payload content, not a hypothetical.
      for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, "", "123"]) {
        expect(asDomainInstant(value)).toBeNull();
      }
      // 1 second and 1 millisecond after the epoch: both land before Fansly
      // existed, so neither can be a real Fansly moment.
      expect(asDomainInstant(1)).toBeNull();
      expect(asDomainInstant(1_000_000_000_001)).toBeNull();
    });

    it("carries null into the event rather than a guessed default", () => {
      const events = canonicalizeFanslyReplayObservation(observation("subscribers", {
        subscriptions: [
          { id: "s-zero", subscriberId: "fan-1", status: 3, createdAt: 0 },
          { id: "s-seconds", subscriberId: "fan-2", status: 3, createdAt: 1_772_157_317 },
        ],
      }));
      expect(events[0]!.data.subscribedAt).toBeNull();
      expect(events[1]!.data.subscribedAt).toBe("2026-02-27T01:55:17.000Z");
    });

    it("withholds a follow whose id does not decode to a real moment", () => {
      const events = canonicalizeFanslyReplayObservation(observation("followers", {
        followers: [
          { id: "1", followerId: "fan-1" },
          { id: "885754550978359296", followerId: "fan-2" },
        ],
      }));
      const follows = byType(events, "follow.observed");
      expect(follows).toHaveLength(2);
      // Follow id "1" decodes to the raw Fansly epoch — implausible, so the
      // date is refused and the projection will skip the dated row entirely.
      expect(follows[0]!.data.followedAt).toBeNull();
      expect(follows[1]!.data.followedAt).toBe("2026-03-05T01:38:21.377Z");
    });

    it("refuses a zero createdAt in an aggregated profile", () => {
      const events = canonicalizeFanslyReplayObservation(observation("followers", {
        followers: [],
        aggregationData: { accounts: [{ id: "fan-1", username: "u", createdAt: 0 }] },
      }));
      expect(events[0]!.data.createdAtExternal).toBeNull();
    });
  });

  describe("subscribers (journaled RAW)", () => {
    it("mints one subscription event per row with the canonical status", async () => {
      const response = await loadResponse<{ subscriptions: Array<Record<string, unknown>> }>(
        "subscribers.json",
      );
      const events = canonicalizeFanslyReplayObservation(observation("subscribers", response));
      const subscriptions = byType(events, "subscription.observed");
      expect(subscriptions).toHaveLength(response.subscriptions.length);

      const first = subscriptions[0]!;
      expect(first.fanIdentityRef).toBe("586780754529234944");
      expect(first.dedupKey.startsWith("subscription:883584485138907136:")).toBe(true);
      expect(first.data.canonicalStatus).toBe("active");
      expect(first.data.autoRenew).toBe(true);
      // Fansly subscription prices are MILLS; carried through untouched.
      expect(first.data.priceMills).toBe(20000);
      expect(first.data.subscribedAt).toBe("2026-02-27T01:55:17.000Z");
      expect(first.data.endsAt).toBe("2026-03-27T01:55:17.000Z");
    });

    it("ignores a payload without a subscriptions array", () => {
      expect(canonicalizeFanslyReplayObservation(observation("subscribers", { stats: {} })))
        .toEqual([]);
    });
  });

  describe("dm_conversations (journaled TRIMMED — content redacted away)", () => {
    it("mints one conversation per row plus identities, without message content", async () => {
      const response = await loadResponse("messaging_groups.json");
      const trimmed = trimFanslyMessagingGroupsPayload(response);
      const events = canonicalizeFanslyReplayObservation(
        observation("dm_conversations", trimmed),
        context("772956494390898689"),
      );

      const conversations = byType(events, "conversation.observed");
      expect(conversations).toHaveLength(trimmed.data.length);
      expect(byType(events, "fan.identity_observed"))
        .toHaveLength(trimmed.aggregationData.accounts.length);

      const first = conversations[0]!;
      expect(first.conversationRef).toBe("878739490577862656");
      expect(first.fanIdentityRef).toBe("622205078341689346");
      expect(first.data.partnerUsername).toBe("kev02364");
      expect(first.messageRef).toBe("885512029928960000");
      // redactFanslyMessageLike drops content entirely; nothing here may
      // resurrect it, and this fixture's groups carry no lastMessage at all.
      expect(JSON.stringify(first.data)).not.toContain("content");
      expect(first.data.lastMessageAt).toBeNull();
    });

    it("reads the redacted lastMessage head when the trimmer kept one", () => {
      const trimmed = trimFanslyMessagingGroupsPayload({
        data: [{ groupId: "g1", account_id: "own", partnerAccountId: "fan-1" }],
        aggregationData: {
          groups: [{
            id: "g1",
            lastMessage: {
              id: "m1",
              senderId: "fan-1",
              groupId: "g1",
              // Fansly DM createdAt is epoch SECONDS.
              createdAt: 1_772_157_317,
              content: "SECRET — the redactor drops this before journaling",
            },
          }],
        },
      });
      expect(trimmed.aggregationData.groups[0]!.lastMessage).not.toBeNull();
      const events = canonicalizeFanslyReplayObservation(
        observation("dm_conversations", trimmed),
        context("own"),
      );
      const conversation = byType(events, "conversation.observed")[0]!;
      expect(conversation.data.lastMessageAt).toBe("2026-02-27T01:55:17.000Z");
      expect(conversation.data.lastMessageSenderId).toBe("fan-1");
      expect(JSON.stringify(conversation.data)).not.toContain("SECRET");
    });

    it("falls back to the single non-owner group member for the partner", () => {
      const trimmed = trimFanslyMessagingGroupsPayload({
        data: [{ groupId: "g1", account_id: "own" }],
        aggregationData: {
          groups: [{
            id: "g1",
            users: [
              { groupId: "g1", userId: "own", type: 0, permissionFlags: 1 },
              { groupId: "g1", userId: "fan-9", type: 0, permissionFlags: 1 },
            ],
          }],
        },
      });
      const conversation = byType(
        canonicalizeFanslyReplayObservation(observation("dm_conversations", trimmed), context("own")),
        "conversation.observed",
      )[0]!;
      expect(conversation.fanIdentityRef).toBe("fan-9");
    });

    it("names no partner for a genuine multi-member group rather than guessing", () => {
      const trimmed = trimFanslyMessagingGroupsPayload({
        data: [{ groupId: "g1", account_id: "own" }],
        aggregationData: {
          groups: [{
            id: "g1",
            users: [
              { groupId: "g1", userId: "own", type: 0, permissionFlags: 1 },
              { groupId: "g1", userId: "fan-1", type: 0, permissionFlags: 1 },
              { groupId: "g1", userId: "fan-2", type: 0, permissionFlags: 1 },
            ],
          }],
        },
      });
      const conversation = byType(
        canonicalizeFanslyReplayObservation(observation("dm_conversations", trimmed), context("own")),
        "conversation.observed",
      )[0]!;
      expect(conversation.fanIdentityRef).toBeNull();
    });
  });

  describe("account_me (journaled RAW — carries live secrets)", () => {
    it("mints the page identity snapshot and never copies email or checkToken", async () => {
      const response = await loadResponse<{ account: Record<string, unknown> }>("account_me.json");
      expect(response.account.email).toBeDefined();
      const events = canonicalizeFanslyReplayObservation(observation("account_me", response));
      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.type).toBe("page.identity_observed");
      expect(event.fanIdentityRef).toBeNull();
      expect(event.data).toEqual({
        platformAccountRef: "772956494390898689",
        businessDate: "2026-03-15",
        username: "lanavellor",
        displayName: "Lana Vellor",
        followCount: 474,
        subscriberCount: 6,
        createdAtExternal: "2025-04-27T19:19:09.000Z",
      });
      const serialized = JSON.stringify(event.data);
      expect(serialized).not.toContain("checkToken");
      expect(serialized).not.toContain("@");
    });
  });

  describe("dedup-key stability", () => {
    it("is byte-identical across two canonicalizations of the same payload", async () => {
      const trimmed = trimFanslyFollowerPayload(await loadResponse("followers.json"));
      const first = canonicalizeFanslyReplayObservation(observation("followers", trimmed));
      const second = canonicalizeFanslyReplayObservation(
        observation("followers", structuredClone(trimmed), { id: 2, receivedAt: new Date() }),
      );
      expect(second.map((event) => event.dedupKey)).toEqual(first.map((event) => event.dedupKey));
    });

    it("ignores volatile fields so an unchanged profile re-fetch dedupes to nothing", () => {
      const build = (lastSeenAt: number, unreadCount: number) => ({
        followers: [{ id: "1", followerId: "fan-1", lastSeenAt }],
        aggregationData: { accounts: [{ id: "fan-1", username: "u", displayName: "d", createdAt: 1, lastSeenAt }] },
        data: [{ groupId: "g1", partnerAccountId: "fan-1", unreadCount }],
      });
      const early = canonicalizeFanslyReplayObservation(observation("followers", build(1, 1)));
      const late = canonicalizeFanslyReplayObservation(observation("followers", build(999, 9)));
      expect(late.map((event) => event.dedupKey)).toEqual(early.map((event) => event.dedupKey));
    });

    it("changes the key when a DURABLE field changes", () => {
      const build = (username: string) => ({
        followers: [],
        aggregationData: { accounts: [{ id: "fan-1", username, displayName: "d", createdAt: 1 }] },
      });
      const before = canonicalizeFanslyReplayObservation(observation("followers", build("old")));
      const after = canonicalizeFanslyReplayObservation(observation("followers", build("new")));
      expect(after[0]!.dedupKey).not.toBe(before[0]!.dedupKey);
    });

    it("changes the subscription key when the subscription state moves", () => {
      const build = (status: number) => ({
        subscriptions: [{ id: "s1", subscriberId: "fan-1", status, price: 1, createdAt: 1 }],
      });
      const active = canonicalizeFanslyReplayObservation(observation("subscribers", build(3)));
      const expired = canonicalizeFanslyReplayObservation(observation("subscribers", build(5)));
      expect(expired[0]!.dedupKey).not.toBe(active[0]!.dedupKey);
      expect(expired[0]!.data.canonicalStatus).toBe("expired");
    });

    it("keeps one page-identity witness PER UTC DAY even when nothing changed", () => {
      // Review round 1 (P2-b): content-only keys collapsed two identical daily
      // snapshots into one event, and the later day silently lost its
      // follower-total witness although the journal proves the observation
      // happened. The rollups are keyed by day, so the key must be too.
      const payload = { account: { id: "page-1", username: "u", followCount: 100 } };
      const monday = canonicalizeFanslyReplayObservation(
        observation("account_me", payload, { observedAt: new Date("2026-03-15T23:00:00Z") }),
      );
      const tuesday = canonicalizeFanslyReplayObservation(
        observation("account_me", payload, { observedAt: new Date("2026-03-16T01:00:00Z") }),
      );
      const sameDay = canonicalizeFanslyReplayObservation(
        observation("account_me", payload, { observedAt: new Date("2026-03-15T06:00:00Z") }),
      );
      expect(tuesday[0]!.dedupKey).not.toBe(monday[0]!.dedupKey);
      expect(sameDay[0]!.dedupKey).toBe(monday[0]!.dedupKey);
      expect(monday[0]!.data.businessDate).toBe("2026-03-15");
      expect(tuesday[0]!.data.businessDate).toBe("2026-03-16");
    });
  });

  it("emits only the event types the projection knows how to apply", async () => {
    const payloads: Array<[string, unknown]> = [
      ["followers", trimFanslyFollowerPayload(await loadResponse("followers.json"))],
      ["subscribers", await loadResponse("subscribers.json")],
      ["dm_conversations", trimFanslyMessagingGroupsPayload(await loadResponse("messaging_groups.json"))],
      ["account_me", await loadResponse("account_me.json")],
    ];
    for (const [kind, payload] of payloads) {
      const events = canonicalizeFanslyReplayObservation(
        observation(kind, payload),
        context("772956494390898689"),
      );
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(FANSLY_REPLAY_EVENT_TYPES.has(event.type)).toBe(true);
        expect(event.occurredAt).toEqual(OBSERVED_AT);
      }
      // Keys are unique within one payload — a batch append must never hit
      // the same (account, dedup_key) claim twice.
      expect(new Set(events.map((event) => event.dedupKey)).size).toBe(events.length);
    }
  });

  describe("shape gate (review round 2, P2-2)", () => {
    it("accepts a legitimately EMPTY snapshot — that is a real observation", () => {
      const empty: Array<[string, unknown]> = [
        ["followers", { followers: [], aggregationData: { accounts: [] } }],
        ["subscribers", { stats: { total: 0 }, subscriptions: [] }],
        ["dm_conversations", { data: [], aggregationData: { accounts: [], groups: [] } }],
        ["account_me", { account: { id: "page-1" } }],
      ];
      for (const [kind, payload] of empty) {
        expect(canParseFanslyReplayObservation(observation(kind, payload))).toBe(true);
      }
    });

    it("refuses a drifted payload so the row is never stamped consumed", () => {
      const drifted: Array<[string, unknown]> = [
        ["followers", { items: [] }],
        ["subscribers", { stats: { total: 3 }, subscriberList: [] }],
        ["dm_conversations", { conversations: [] }],
        ["account_me", { account: { username: "no id" } }],
        ["account_me", { profile: {} }],
      ];
      for (const [kind, payload] of drifted) {
        expect(canParseFanslyReplayObservation(observation(kind, payload))).toBe(false);
      }
      for (const payload of [null, 42, "text", []]) {
        expect(canParseFanslyReplayObservation(observation("followers", payload))).toBe(false);
      }
    });

    it("is wired onto the family, not merely exported", () => {
      expect(FANSLY_REPLAY_FAMILY.canParse).toBe(canParseFanslyReplayObservation);
    });
  });

  it("counts refused timestamps rather than dropping them silently", () => {
    const counts = new Map<string, number>();
    const context = {
      nativeAccountRefByAccountId: new Map<number, string | null>(),
      diagnostics: {
        record: (code: string) => counts.set(code, (counts.get(code) ?? 0) + 1),
      },
    };
    canonicalizeFanslyReplayObservation(
      observation("subscribers", {
        subscriptions: [{ id: "s1", subscriberId: "fan-1", status: 3, createdAt: 0, endsAt: 5 }],
      }),
      context,
    );
    canonicalizeFanslyReplayObservation(
      observation("followers", { followers: [{ id: "1", followerId: "fan-1" }] }),
      context,
    );
    expect(Object.fromEntries(counts)).toEqual({
      "timestamp_refused:subscriptions.createdAt": 1,
      "timestamp_refused:subscriptions.endsAt": 1,
      "timestamp_refused:followers.followId": 1,
    });
  });

  it("returns zero events for garbage payloads instead of throwing", () => {
    for (const kind of FANSLY_REPLAY_CANONICALIZED_KINDS) {
      for (const payload of [null, undefined, 42, "text", [], {}, { data: null }]) {
        expect(canonicalizeFanslyReplayObservation(observation(kind, payload))).toEqual([]);
      }
    }
  });
});
