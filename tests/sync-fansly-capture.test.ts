import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";

// The Fansly Sync Engine's journal body (design §3.11, S2-05). The engine
// journals observations only, and its observation must be byte-for-byte the
// observation the legacy lane journals for the same served response — the
// canonicalizers, replay, the agent scrub and the AI describer read it by
// kind. So every kind below is captured twice: through the legacy path (the
// lane's own trim + `persistRawPayload`, with the journal writes mocked) and
// through `prepareJournalBody`, and the two must agree on payload, payload
// hash and the raw row's capture-shape version.
//
// The URLs and ids are SYNTHETIC.

const captured = vi.hoisted(() => ({
  raws: [] as Array<{ endpoint: string; responsePayload: unknown; mapperVersion: string }>,
  observations: [] as Array<{ kind: string; payload: unknown; payloadHash: Buffer }>,
}));

vi.mock("@agency_hub_core/db", async (importOriginal) => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    insertRawPayload: vi.fn(async (
      _db: unknown,
      input: { endpoint: string; responsePayload: unknown; mapperVersion: string },
    ) => {
      captured.raws.push(input);
      return { id: 1, capturedAt: new Date(0), payloadRefVanished: false };
    }),
    insertObservation: vi.fn(async (
      _db: unknown,
      input: { kind: string; payload: unknown; payloadHash: Buffer },
    ) => {
      captured.observations.push(input);
      return { inserted: true, observationId: 1, payloadRefVanished: false };
    }),
    recordSyncHttpAttemptResponseBodyBytes: vi.fn(async () => true),
  };
});

const { FANSLY_MAPPER_VERSION } = await import("@agency_hub_core/fansly");
const shared = await import("../apps/runtime/src/services/sync/shared.ts");
const trims = await import("../apps/runtime/src/sync/fansly/lib/capture-trims.ts");
const { FANSLY_STATS_MAPPER_VERSION } = await import("../apps/runtime/src/sync/fansly/lib/stats-rules.ts");
const { prepareJournalBody } = await import("../apps/runtime/src/sync/fansly/capture.ts");

const SIGNED = "https://cdn3.fansly.com/700000000000000001/800000000000000001.jpeg"
  + "?ngsw-bypass=true&Policy=eyJTdGF0ZW1lbnQiOltdfQ__&Key-Pair-Id=KTESTPAIR01&Signature=abc~DEF_ghi-1";
const STRIPPED = "https://cdn3.fansly.com/700000000000000001/800000000000000001.jpeg?ngsw-bypass=true";
const LONE_SURROGATE = "broken \uD83D text";

/** A full account record, as `/notifications`, `/post` and the follower and
 *  conversation lists embed it: the [A20] allowlist keeps a subset. */
const FULL_ACCOUNT = {
  id: "500000000000000001",
  username: "fan-one",
  displayName: "Fan One",
  lastSeenAt: 1_790_000_000_000,
  followCount: 3,
  subscriberCount: 0,
  avatar: { locations: [{ locationId: "1", location: SIGNED }] },
};

function media() {
  return [{ id: "800000000000000001", locations: [{ locationId: "1", location: SIGNED }] }];
}

/** One served body per kind, each carrying what its transforms act on. */
function servedBodies(): Record<string, unknown> {
  return {
    dm_messages: {
      messages: [{ id: "310000000000000001", content: LONE_SURROGATE, attachments: [{ location: SIGNED }] }],
      accountMedia: [{ id: "m", media: { locations: [{ locationId: "1", location: SIGNED }] } }],
    },
    purchase_history: { data: [{ id: "1", media: { locations: [{ locationId: "1", location: SIGNED }] } }] },
    earnings_transactions: {
      total: 1,
      data: [{ id: "900000000000000001", amount: 5000 }],
      aggregationData: { accountMedia: [{ id: "800000000000000001", media: { locations: media()[0]!.locations } }] },
    },
    followers: {
      followers: [{ id: "f-1", followerId: "500000000000000001", lastSeenAt: 1 }],
      aggregationData: { accounts: [FULL_ACCOUNT] },
    },
    dm_conversations: {
      data: [{ groupId: "group-1", partnerAccountId: "500000000000000001", unreadCount: 1, extra: "dropped" }],
      aggregationData: {
        total: 1,
        accounts: [FULL_ACCOUNT],
        groups: [{ id: "group-1", type: 1, users: [], lastMessage: { id: "m-1", content: "redacted" } }],
      },
    },
    notifications: { notifications: [{ id: "n-1", type: 3003 }], accounts: [FULL_ACCOUNT], accountMedia: media() },
    vault_media: { media: media(), aggregationData: { accounts: [FULL_ACCOUNT] } },
    post_replies: { posts: [{ id: "r-1", content: LONE_SURROGATE }], accounts: [FULL_ACCOUNT], accountMedia: media() },
    payout_requests: { total: 1, data: [{ id: "p-1", amount: 131_000 }] },
    account_stats: { dataset: { period: 86_400_000 }, accountMedia: [{ id: "a", media: media()[0] }] },
    group_detail: { id: "group-1", users: [{ userId: "500000000000000001" }] },
  };
}

const WALK = { postId: "post-42", before: "990000000000000001" };

/** The legacy capture of one served body: the lane's trim and capture-shape
 *  version (the lane files named beside each), then `persistRawPayload`. */
async function legacyCapture(kind: string, response: unknown, contractAccepted?: boolean) {
  captured.raws.length = 0;
  captured.observations.length = 0;
  let responsePayload = response;
  let mapperVersion = FANSLY_MAPPER_VERSION;
  let observationPayload: { observationPayload: unknown } | Record<string, never> = {};
  switch (kind) {
    case "followers": // executor-handlers.ts
      responsePayload = trims.captureFanslyFollowerPayload(response, contractAccepted);
      mapperVersion = trims.FANSLY_FOLLOWERS_CAPTURE_MAPPER_VERSION;
      break;
    case "dm_conversations": // fansly-dm-conversations.ts
      responsePayload = trims.captureFanslyMessagingGroupsPayload(response, contractAccepted);
      mapperVersion = trims.FANSLY_GROUPS_CAPTURE_MAPPER_VERSION;
      break;
    case "notifications": // fansly-notifications.ts
      responsePayload = trims.trimFanslyNotificationsPayload(response);
      mapperVersion = trims.FANSLY_NOTIFICATIONS_CAPTURE_MAPPER_VERSION;
      break;
    case "vault_media": // fansly-catalog.ts
      responsePayload = trims.trimFanslyCatalogPayload(response);
      mapperVersion = trims.FANSLY_CATALOG_CAPTURE_MAPPER_VERSION;
      break;
    case "post_replies": // fansly-post-replies.ts
      responsePayload = trims.trimFanslyPostRepliesPayload(response);
      mapperVersion = trims.FANSLY_POST_REPLIES_CAPTURE_MAPPER_VERSION;
      observationPayload = { observationPayload: { walk: WALK, response: responsePayload } };
      break;
    case "payout_requests": // fansly-payouts.ts
      mapperVersion = trims.FANSLY_PAYOUTS_CAPTURE_MAPPER_VERSION;
      break;
    case "account_stats": // fansly-stats.ts
      mapperVersion = FANSLY_STATS_MAPPER_VERSION;
      break;
  }
  await shared.persistRawPayload({} as never, {
    platformAccountId: 7,
    endpoint: kind,
    requestParams: {},
    responsePayload,
    mapperVersion,
    payloadKind: "mapping_critical",
    retainUntil: shared.retentionDate(),
  }, { platform: "fansly", ...observationPayload });
  return { raw: captured.raws[0]!, observation: captured.observations[0]! };
}

describe("prepareJournalBody", () => {
  for (const [kind, response] of Object.entries(servedBodies())) {
    it(`${kind}: journals exactly the legacy observation`, async () => {
      const legacy = await legacyCapture(kind, response);
      const before = structuredClone(response);
      const prepared = prepareJournalBody({ kind }, {
        response,
        ...(kind === "post_replies" ? { walk: WALK } : {}),
      });
      expect(prepared.payload).toEqual(legacy.observation.payload);
      expect(prepared.payloadHash.equals(legacy.observation.payloadHash)).toBe(true);
      expect(prepared.payloadHash.equals(
        createHash("sha256").update(JSON.stringify(prepared.payload)).digest(),
      )).toBe(true);
      expect(prepared.mapperVersion).toBe(legacy.raw.mapperVersion);
      // The served object is never mutated: the apply keeps reading it.
      expect(response).toEqual(before);
    });
  }

  it.each(["followers", "dm_conversations"])("%s: a body the contract refused keeps the nested evidence form", async (kind) => {
    const response = servedBodies()[kind];
    const legacy = await legacyCapture(kind, response, false);
    const prepared = prepareJournalBody({ kind }, { response, contractAccepted: false });
    expect(prepared.payload).toEqual(legacy.observation.payload);
    expect(prepared.payload).toMatchObject({ contractAccepted: false });
    expect(prepared.mapperVersion).toBe(legacy.raw.mapperVersion);
  });

  it("strips signing tokens where legacy does and never where the describer reads them", () => {
    const transactions = JSON.stringify(prepareJournalBody({ kind: "earnings_transactions" }, {
      response: servedBodies().earnings_transactions,
    }).payload);
    expect(transactions).toContain(STRIPPED);
    expect(transactions).not.toContain("Signature=");
    for (const kind of ["dm_messages", "purchase_history"]) {
      const prepared = prepareJournalBody({ kind }, { response: servedBodies()[kind] });
      expect(JSON.stringify(prepared.payload)).toContain(SIGNED);
      expect(prepared.mapperVersion.startsWith(FANSLY_MAPPER_VERSION)).toBe(true);
      expect(prepared.mapperVersion).not.toContain("cdn-tokens-stripped");
    }
  });

  it("replaces a lone surrogate and says so in the capture-shape version", () => {
    const prepared = prepareJournalBody({ kind: "dm_messages" }, { response: servedBodies().dm_messages });
    expect(prepared.loneSurrogatesReplaced).toBe(1);
    expect(prepared.mapperVersion).toBe(`${FANSLY_MAPPER_VERSION}+lone-surrogates-replaced-v1`);
    expect(JSON.stringify(prepared.payload)).toContain("broken � text");
    // Nothing to transform: the served object itself, no copy.
    const body = servedBodies().group_detail;
    const clean = prepareJournalBody({ kind: "group_detail" }, { response: body });
    expect(clean).toMatchObject({ loneSurrogatesReplaced: 0, mapperVersion: FANSLY_MAPPER_VERSION });
    expect(clean.payload).toBe(body);
  });

  it("wraps a reply page in its walk envelope, and refuses one without the walk", () => {
    const empty = prepareJournalBody({ kind: "post_replies" }, { response: { __empty: true }, walk: { postId: "p", before: null } });
    expect(empty.payload).toEqual({ walk: { postId: "p", before: null }, response: { __empty: true } });
    expect(() => prepareJournalBody({ kind: "post_replies" }, { response: {} }))
      .toThrow("A post_replies journal body needs the walk");
  });

  it("journals an absent body as JSON null, as legacy does", async () => {
    const legacy = await legacyCapture("group_detail", undefined);
    const prepared = prepareJournalBody({ kind: "group_detail" }, { response: undefined });
    expect(prepared.payload).toBeNull();
    expect(prepared.payload).toEqual(legacy.observation.payload);
    expect(prepared.payloadHash.equals(legacy.observation.payloadHash)).toBe(true);
  });
});
