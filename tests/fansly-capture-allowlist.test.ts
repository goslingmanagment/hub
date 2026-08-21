// WP-F0(a) — what the Fansly follower and conversation lanes may put in the
// JOURNAL, pinned as an invariant rather than described in a comment.
//
// Two independent claims live here, and they are independent because [A18]
// found the plan (and every review pass) had them fused and wrong:
//
//   F0(a-1) — the CONVERSATION ROWS lose nothing. `trimFanslyMessagingGroupsPayload`
//   is an IDENTITY REWRITE over `response.data[]`: Fansly serves exactly nine
//   fields per row and the trim keeps all nine. There is no `lastMessage`
//   object on a conversation row, so no preview text, attachment or tip was
//   ever there to lose. Anyone "fixing" this trim expecting recovered DM
//   previews is mis-scoped, and the byte-identity pin below is what stops the
//   belief being re-invented.
//
//   F0(a-2) — the LOSS was `aggregationData.accounts[]`: 4 of ~25 served
//   fields kept. [A20] repairs it as a NAMED ALLOWLIST of 18 fields — not a
//   removal — because the eight rejected fields (last-seen minute, audience
//   and like counters, live flag, version) change on nearly every response and
//   would destroy the ~11:1 content-address dedup collapse measured on
//   production. That collapse is the entire reason the byte-ceiling mechanism
//   could be deleted, which is why the negative pins at the bottom of this
//   file sit beside the positive ones.
//
// The fixture is SYNTHETIC and verbatim-SHAPED: re-keyed ids, invented
// usernames, no PII, no tokens. Its shape was taken from a live capture; the
// capture itself is never committed.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CONFIG_DESCRIPTORS } from "@agency_hub_core/shared";

import {
  FANSLY_FAN_ACCOUNT_CAPTURE_ALLOWLIST,
  FANSLY_FAN_ACCOUNT_NEVER_CAPTURED,
  FANSLY_FOLLOWERS_CAPTURE_MAPPER_VERSION,
  FANSLY_GROUPS_CAPTURE_MAPPER_VERSION,
  trimFanslyFollowerPayload,
  trimFanslyMessagingGroupsPayload,
} from "../apps/runtime/src/services/sync/shared.ts";

const VERBATIM = JSON.parse(readFileSync(
  path.resolve("tests/fixtures/fansly/messaging_groups_verbatim.json"),
  "utf8",
)) as { data: { response: Record<string, unknown> } };

/** The envelope's inner `response` object — exactly what `page.raw` is
 *  (packages/fansly/src/adapter.ts) and therefore exactly what the three call
 *  sites hand the trim. */
function verbatimRaw(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(VERBATIM.data.response)) as Record<string, unknown>;
}

const LIVE_CONVERSATION_ROW_FIELDS = [
  "account_id",
  "groupId",
  "partnerAccountId",
  "partnerUsername",
  "flags",
  "unreadCount",
  "subscriptionTierId",
  "lastMessageId",
  "lastUnreadMessageId",
];

/** The 14 [A20] added on top of the four the trim already kept. */
const NEWLY_KEPT_ACCOUNT_FIELDS = [
  "followsYou",
  "following",
  "subscriber",
  "subscriberSubscription",
  "subscriberAutoRenew",
  "notes",
  "containingLists",
  "profileAccess",
  "profileAccessFlags",
  "profileFlags",
  "permissions",
  "statusId",
  "flags",
  "userFlags",
];

function accountsOf(trimmed: { aggregationData: { accounts: unknown } }) {
  return trimmed.aggregationData.accounts as Record<string, unknown>[];
}

/** The verbatim conversation payload, re-dressed as a `/followers` response so
 *  BOTH lanes are asserted against the SAME fan-account objects. The follower
 *  lane's own aggregationData.accounts[] has the identical 4-of-N shape. */
function followerRaw(): Record<string, unknown> {
  const raw = verbatimRaw();
  const accounts = (raw.aggregationData as Record<string, unknown>).accounts as
    Record<string, unknown>[];
  return {
    followers: accounts.map((account, index) => ({
      id: `863308077229670400`,
      followerId: account.id,
      lastSeenAt: 1767323105 + index,
    })),
    aggregationData: { accounts },
  };
}

describe("F0(a-1): the conversation-list trim is an identity rewrite on data[]", () => {
  it("serves exactly the nine live fields per row, in order", () => {
    const rows = verbatimRaw().data as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(Object.keys(row)).toEqual(LIVE_CONVERSATION_ROW_FIELDS);
    }
  });

  it("[A18] byte-identity pin: the trim changes data[] by ZERO bytes", () => {
    const raw = verbatimRaw();
    const trimmed = trimFanslyMessagingGroupsPayload(raw);
    // Not "deep equal" — byte identity, key order included. A trim that
    // reordered keys would still change the journaled body and break the
    // content-address dedup collapse without changing a single fact.
    expect(JSON.stringify(trimmed.data)).toBe(JSON.stringify(raw.data));
  });

  it("keeps every row and every one of its nine fields", () => {
    const raw = verbatimRaw();
    const trimmed = trimFanslyMessagingGroupsPayload(raw);
    expect(trimmed.data).toHaveLength((raw.data as unknown[]).length);
    for (const row of trimmed.data) {
      expect(Object.keys(row)).toEqual(LIVE_CONVERSATION_ROW_FIELDS);
    }
  });

  it("there is no lastMessage object on a conversation row — nothing to recover", () => {
    for (const row of verbatimRaw().data as Record<string, unknown>[]) {
      expect(row).not.toHaveProperty("lastMessage");
      expect(row).not.toHaveProperty("attachments");
      expect(row).not.toHaveProperty("content");
    }
  });
});

describe("F0(a-2): [A20] the fan-account allowlist, on BOTH lanes", () => {
  it("is exactly the 18 named fields", () => {
    expect([...FANSLY_FAN_ACCOUNT_CAPTURE_ALLOWLIST]).toEqual([
      "id",
      "username",
      "displayName",
      "createdAt",
      ...NEWLY_KEPT_ACCOUNT_FIELDS,
    ]);
    expect(FANSLY_FAN_ACCOUNT_CAPTURE_ALLOWLIST).toHaveLength(18);
    // Widening it is a deliberate edit with a written reason, exactly like the
    // platform-branch budget — this length pin is the tripwire.
  });

  it("names the eight rejected fields, and they never intersect the allowlist", () => {
    expect([...FANSLY_FAN_ACCOUNT_NEVER_CAPTURED]).toEqual([
      "lastSeenAt",
      "followCount",
      "subscriberCount",
      "postLikes",
      "accountMediaLikes",
      "timelineStats",
      "streaming",
      "version",
    ]);
    for (const field of FANSLY_FAN_ACCOUNT_NEVER_CAPTURED) {
      expect(FANSLY_FAN_ACCOUNT_CAPTURE_ALLOWLIST).not.toContain(field);
    }
  });

  for (
    const lane of [
      { name: "dm_conversations", trim: () => trimFanslyMessagingGroupsPayload(verbatimRaw()) },
      { name: "followers", trim: () => trimFanslyFollowerPayload(followerRaw()) },
    ]
  ) {
    describe(lane.name, () => {
      it("recovers the 14 newly kept fields on the fan account", () => {
        const account = accountsOf(lane.trim())[0]!;
        for (const field of NEWLY_KEPT_ACCOUNT_FIELDS) {
          expect(Object.hasOwn(account, field), `${lane.name}: ${field}`).toBe(true);
        }
        // Kept VERBATIM — objects and arrays keep their served shape, so a
        // consumer reads what Fansly said and not a re-summary of it.
        expect(account.subscriberSubscription).toMatchObject({
          id: "subscription_alpha",
          subscriptionTierId: "tier_fixture",
          price: 1234,
          renewPrice: 1456,
        });
        expect(account.notes).toEqual([expect.objectContaining({ note: "prefers evenings" })]);
        expect(account.containingLists).toEqual(["list_vip"]);
        expect(account.permissions).toEqual({ accountPermissionFlags: { flags: 0 } });
      });

      it("keeps the original four as well", () => {
        const account = accountsOf(lane.trim())[0]!;
        expect(account).toMatchObject({
          id: "acct_fan_alpha",
          username: "fixture_fan",
          displayName: "Fixture Fan",
          createdAt: 1767323045,
        });
      });

      it("lets NO field outside the allowlist reach the journal shape", () => {
        for (const account of accountsOf(lane.trim())) {
          for (const key of Object.keys(account)) {
            expect(FANSLY_FAN_ACCOUNT_CAPTURE_ALLOWLIST, `${lane.name}: leaked ${key}`)
              .toContain(key);
          }
        }
      });

      it("drops all eight rejected fields — lastSeenAt included", () => {
        for (const account of accountsOf(lane.trim())) {
          for (const field of FANSLY_FAN_ACCOUNT_NEVER_CAPTURED) {
            expect(Object.hasOwn(account, field), `${lane.name}: ${field}`).toBe(false);
          }
        }
      });

      it("drops an unknown field the platform starts serving tomorrow", () => {
        // The allowlist is the mechanism, not the current key census: a field
        // nobody has seen yet must not arrive in the journal by default.
        const raw = lane.name === "followers" ? followerRaw() : verbatimRaw();
        const accounts = (raw.aggregationData as Record<string, unknown>).accounts as
          Record<string, unknown>[];
        for (const account of accounts) {
          account.newVolatileCounter = 999;
          account.lastSeenAtV2 = 1767323199;
        }
        const trimmed = lane.name === "followers"
          ? trimFanslyFollowerPayload(raw)
          : trimFanslyMessagingGroupsPayload(raw);
        for (const account of accountsOf(trimmed)) {
          expect(account).not.toHaveProperty("newVolatileCounter");
          expect(account).not.toHaveProperty("lastSeenAtV2");
        }
      });

      it("orders kept keys by the allowlist so a reordered response still hashes the same", () => {
        const accounts = accountsOf(lane.trim());
        for (const account of accounts) {
          const keys = Object.keys(account);
          const expected = FANSLY_FAN_ACCOUNT_CAPTURE_ALLOWLIST.filter((field) =>
            keys.includes(field)
          );
          expect(keys).toEqual(expected);
        }
      });
    });
  }

  it("drops lastSeenAt from the follower RELATION row too", () => {
    const raw = followerRaw();
    expect((raw.followers as Record<string, unknown>[])[0]).toHaveProperty("lastSeenAt");
    for (const row of trimFanslyFollowerPayload(raw).followers) {
      expect(Object.keys(row)).toEqual(["id", "followerId"]);
    }
  });
});

describe("F0(a): the groups[].lastMessage redaction is KEPT, deliberately", () => {
  it("still drops content and empties the four arrays", () => {
    const raw = verbatimRaw();
    const live = ((raw.aggregationData as Record<string, unknown>).groups as
      Record<string, unknown>[])[0]!.lastMessage as Record<string, unknown>;
    expect(live.interactions).toHaveLength(1);
    expect(live.likes).toHaveLength(1);

    const trimmed = trimFanslyMessagingGroupsPayload(raw);
    const lastMessage = trimmed.aggregationData.groups[0]!.lastMessage!;
    // It is 3.7 % of the payload delta and a DUPLICATE of material the
    // verbatim `dm_messages` journal already holds, so it stays redacted — and
    // that is what keeps the agent-read scrub's justification for admitting
    // `dm_conversations` ("already trimmed of content before it reaches the
    // journal", modules/agent-read/observation-scrub.ts) true after [A20].
    expect(lastMessage).not.toHaveProperty("content");
    expect(lastMessage.attachments).toEqual([]);
    expect(lastMessage.embeds).toEqual([]);
    expect(lastMessage.interactions).toEqual([]);
    expect(lastMessage.likes).toEqual([]);
  });
});

describe("capture-shape mapper versions", () => {
  it("suffix the shared constant instead of bumping it", () => {
    // Bumping FANSLY_MAPPER_VERSION itself was rejected explicitly: every
    // Fansly writer reads it, so the bump would re-label unrelated captures.
    expect(FANSLY_FOLLOWERS_CAPTURE_MAPPER_VERSION).toBe("fansly-phase1-v5+followers-capture-v2");
    expect(FANSLY_GROUPS_CAPTURE_MAPPER_VERSION).toBe("fansly-phase1-v5+groups-capture-v2");
    expect(FANSLY_FOLLOWERS_CAPTURE_MAPPER_VERSION)
      .not.toBe(FANSLY_GROUPS_CAPTURE_MAPPER_VERSION);
  });
});

describe("[A20] negative pins: no byte ceiling exists, anywhere", () => {
  it("no fanslyUntrimmedCaptureByteCeilingPerDay key is in the config registry", () => {
    // The mechanism it belonged to — a daily byte budget whose breach DEFERRED
    // the `dm_conversations` lane to the next UTC day — was deleted with its
    // premise. `dm_conversations` feeds live chatter work; a storage guard that
    // can stop revenue work is the [A19] failure mode re-shipped.
    for (const descriptor of CONFIG_DESCRIPTORS) {
      expect(descriptor.key).not.toMatch(/ByteCeiling/i);
      expect(descriptor.envName).not.toMatch(/BYTE_CEILING/i);
    }
    expect(CONFIG_DESCRIPTORS.some((descriptor) =>
      descriptor.key === "fanslyUntrimmedCaptureByteCeilingPerDay"
    )).toBe(false);
  });

  it("nothing in the capture path can defer a lane on a byte budget", () => {
    const captureSources = [
      "apps/runtime/src/services/sync/shared.ts",
      "apps/runtime/src/services/sync/executor-handlers.ts",
      "packages/db/src/repositories/sync.ts",
    ];
    for (const relative of captureSources) {
      const source = readFileSync(path.resolve(relative), "utf8");
      expect(source, relative).not.toMatch(/byteCeiling|BYTE_CEILING|byteBudget/i);
      // `response_body_bytes` survives as pure instrumentation — a disk-trend
      // input. It may be WRITTEN and MEASURED; it may never gate anything.
      // (The one comparison the measurement path is allowed is the `< 0`
      // sanity guard on its own input, which decides whether to record a
      // sample — never whether to make a request.)
      for (const line of source.split("\n")) {
        if (!/responseBodyBytes|response_body_bytes/.test(line)) {
          continue;
        }
        expect(line, `${relative}: ${line.trim()}`)
          .not.toMatch(/defer|throttle|ceiling|budget|\bcap\b|\blimit\b|config\./i);
      }
    }
  });
});
