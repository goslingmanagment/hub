import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { clientFanBadgesResponseSchema } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, createOnlyFansPage, insertAgentKey } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, assignPageToUser, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { issueDeviceTokenForUserId } from "./helpers/device-credentials.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { armNoOutboundTrap } from "./helpers/no-outbound.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Fan badges (`clientFanBadges`): FBuddy's tier and Fansly's «Recent Spender»
// mark of a page's fans, as a chatter's browser read them. A change is
// journaled once and kept with its moment; the same report again writes
// nothing; agents read the badges in `fan_memberships`.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const AGENT_KEY_TOKEN = `${AGENT_KEY_TOKEN_PREFIX}fanbadges000000000000`;
const GOLD = "438766025723355001";
const NO_TIER = "438766025723355002";
const QUIET = "438766025723355003";
const UNLINKED = "438766025723355004";

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let token = "";
let fanslyPage = 0;

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);

async function fan(ref: string, linked = true) {
  const id = Number((await q("insert into fans (platform, platform_user_id, username) values ('fansly', $1, $2) returning id", [ref, `fan${ref}`])).rows[0].id);
  if (linked) await q("insert into page_fans (fan_id, platform_account_id, is_follower) values ($1, $2, true)", [id, fanslyPage]);
  return id;
}

const report = (fans: unknown[], pageLabel = "lora-1") => server!.inject({
  method: "POST",
  url: `/api/v1/client/pages/${pageLabel}/fan-badges`,
  headers: { authorization: `Bearer ${token}`, "x-client-version": "chat-extension/3.3.0" },
  payload: { fans },
});

async function ok(fans: unknown[]) {
  const response = await report(fans);
  expect(response.statusCode, response.body).toBe(200);
  const { serverNow: _, ...counts } = clientFanBadgesResponseSchema.parse(response.json());
  return counts;
}

const journal = async () => (await q("select payload from observations where kind = 'client.fan_badges.v1' order by id")).rows.map((row) => row.payload);
const stored = async () => (await q(`
  select f.platform_user_id as ref, b.xmin::text as version, b.fbuddy_tier, b.fbuddy_tier_since, b.fbuddy_tier_checked_at,
         b.recent_spender, b.recent_spender_since, b.recent_spender_checked_at
  from fan_badges b join fans f on f.id = b.fan_id order by f.platform_user_id`)).rows;

describe("fan badges from a chatter's browser", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "vanya", role: "chatter" }, { source: "cli" });
    const vanya = await fixtureUserId(app, "vanya");
    const model = await createModel(app.db, { slug: "lora", name: "Lora" });
    fanslyPage = (await createFanslyPage(app.db, { modelId: model!.id, label: "lora-1" }))!.id;
    await createOnlyFansPage(app.db, { modelId: model!.id, label: "lora-of" });
    for (const pageLabel of ["lora-1", "lora-of"]) await assignPageToUser(app, { userId: vanya, pageLabel }, { source: "cli" });
    token = (await issueDeviceTokenForUserId(app, { userId: vanya, label: "vanya client" })).token;
    await insertAgentKey(app.db, {
      name: "fan-badges-probe",
      keyPrefix: AGENT_KEY_TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(AGENT_KEY_TOKEN),
      capabilities: ["read:datasets", "read:money"],
      pageIds: [fanslyPage],
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdBy: null,
    });
    for (const ref of [GOLD, NO_TIER, QUIET]) await fan(ref);
    await fan(UNLINKED, false);
    server = await buildApiServer(app);
    await server.ready();
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("journals and keeps a change once, writes nothing for the same report, and shows the badges to agents", async (context) => {
    if (!testDb || !server) return context.skip();
    const trap = await armNoOutboundTrap(testDb);
    const first = [
      { fanRef: GOLD, fbuddyTier: "bronze" },
      { fanRef: GOLD, fbuddyTier: "gold", recentSpender: true },
      { fanRef: NO_TIER, fbuddyTier: null },
      { fanRef: QUIET },
      { fanRef: UNLINKED, recentSpender: true },
    ];
    try {
      // The last entry of a fan wins; a fan sent with neither badge and one not linked to the page are skipped.
      expect(await ok(first)).toEqual({ changed: 2, unchanged: 0, skipped: 2 });
      expect(await journal()).toEqual([{
        pageLabel: "lora-1",
        fans: [{ fanRef: GOLD, fbuddyTier: "gold", recentSpender: true }, { fanRef: NO_TIER, fbuddyTier: null }],
        reportedAt: expect.any(String),
      }]);
      const kept = await stored();
      expect(kept.map((row) => [row.ref, row.fbuddy_tier, row.recent_spender])).toEqual([[GOLD, "gold", true], [NO_TIER, "none", null]]);
      expect(kept[1]).toMatchObject({ recent_spender_since: null, recent_spender_checked_at: null });

      // The same report again: no journal, no row written.
      expect(await ok(first)).toEqual({ changed: 0, unchanged: 2, skipped: 2 });
      expect(await journal()).toHaveLength(1);
      expect(await stored()).toEqual(kept);

      // Confirmed over a day ago: only the moment of the confirmation moves, still no journal.
      await q("update fan_badges set fbuddy_tier_checked_at = now() - interval '2 days', fbuddy_tier_since = now() - interval '3 days'");
      const old = (await stored())[0]!;
      expect(await ok([{ fanRef: GOLD, fbuddyTier: "gold" }])).toEqual({ changed: 0, unchanged: 1, skipped: 0 });
      const confirmed = (await stored())[0]!;
      expect(confirmed.fbuddy_tier_since).toEqual(old.fbuddy_tier_since);
      expect(confirmed.fbuddy_tier_checked_at.getTime()).toBeGreaterThan(old.fbuddy_tier_checked_at.getTime());
      expect(confirmed.recent_spender_checked_at).toEqual(old.recent_spender_checked_at);
      expect(await journal()).toHaveLength(1);

      // Another tier: journaled alone, with a new moment; the mark keeps its own.
      expect(await ok([{ fanRef: GOLD, fbuddyTier: "silver", recentSpender: true }])).toEqual({ changed: 1, unchanged: 0, skipped: 0 });
      expect((await journal())[1]).toMatchObject({ fans: [{ fanRef: GOLD, fbuddyTier: "silver" }] });
      const changed = (await stored())[0]!;
      expect(changed.fbuddy_tier).toBe("silver");
      expect(changed.fbuddy_tier_since.getTime()).toBeGreaterThan(old.fbuddy_tier_since.getTime());
      expect(changed.recent_spender_since).toEqual(old.recent_spender_since);

      // Another platform takes no report.
      const onlyFans = await report([{ fanRef: "7001", recentSpender: true }], "lora-of");
      expect(onlyFans.statusCode, onlyFans.body).toBe(409);
      expect(onlyFans.json()).toMatchObject({ error: "client_feature_disabled", reason: "platform_unsupported" });
      await trap.assertNoOutbound();
    } finally {
      await trap.restore();
    }

    const memberships = await server.inject({
      method: "POST",
      url: "/api/v1/agent/pages/lora-1/datasets/fan_memberships/query",
      headers: { authorization: `Bearer ${AGENT_KEY_TOKEN}` },
      payload: { from: new Date(Date.now() - 24 * 60 * 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() },
    });
    expect(memberships.statusCode, memberships.body).toBe(200);
    const byFan = new Map(memberships.json().items.map((item: { fanPlatformUserId: string; fields: Record<string, unknown> }) => [item.fanPlatformUserId, item.fields]));
    expect(byFan.get(GOLD)).toMatchObject({
      fbuddyTier: "silver", recentSpender: true, fbuddyTierCheckedAt: expect.any(String), recentSpenderCheckedAt: expect.any(String),
    });
    expect(byFan.get(NO_TIER)).toMatchObject({ fbuddyTier: "none", recentSpender: null, recentSpenderCheckedAt: null });
    expect(byFan.get(QUIET)).toMatchObject({ fbuddyTier: null, fbuddyTierCheckedAt: null, recentSpender: null, recentSpenderCheckedAt: null });
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
