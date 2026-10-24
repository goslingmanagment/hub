import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { clientFanCardResponseSchema, type ClientFanCardResponse } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, createOnlyFansPage } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { assignPageToUser, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { armNoOutboundTrap } from "./helpers/no-outbound.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// The fan's card across pages (Chat Memory week 2, week-2.md §1–2): asked on
// ari-1 by a chatter who works only ari-1, it shows the fan's lora-1 alias and
// money; Hub suggests another account the team gave the same alias, and an
// account with the same username on OnlyFans; a chatter's «Да» joins them, a
// «Нет» keeps the suggestion away, and only a suggested account can be decided.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const VERSION = "chat-extension/0.9.0";
let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let token = "";
const pages: Record<string, number> = {};
const fans: Record<string, number> = {};

async function fan(key: string, platform: string, ref: string, username: string) {
  const result = await testDb!.pool.query<{ id: string }>(
    "insert into fans (platform, platform_user_id, username, first_seen_at) values ($1, $2, $3, now() - interval '1 day' * $4) returning id",
    [platform, ref, username, Object.keys(fans).length],
  );
  fans[key] = Number(result.rows[0]!.id);
}

async function onPage(fanKey: string, pageLabel: string, alias: string | null, spentMills: number) {
  await testDb!.pool.query(
    "insert into page_fans (fan_id, platform_account_id, page_alias, is_subscriber) values ($1, $2, $3, true)",
    [fans[fanKey], pages[pageLabel], alias],
  );
  if (spentMills > 0) {
    await testDb!.pool.query(
      `insert into fan_spend_lifetime (platform_account_id, fan_id, gross_amount_mills, creator_net_amount_mills, last_transaction_at, updated_at)
       values ($1, $2, $3, $3, now(), now())`,
      [pages[pageLabel], fans[fanKey], spentMills],
    );
  }
}

const get = async (fanRef: string) => {
  const response = await server!.inject({
    method: "GET",
    url: `/api/v1/client/pages/ari-1/fans/${fanRef}/card`,
    headers: { authorization: `Bearer ${token}`, "x-client-version": VERSION },
  });
  expect(response.statusCode, response.body).toBe(200);
  return clientFanCardResponseSchema.parse(response.json());
};

const decide = (otherPlatform: string, otherFanRef: string, decision: "same" | "different") => server!.inject({
  method: "POST",
  url: "/api/v1/client/pages/ari-1/fans/7000000001/links",
  headers: { authorization: `Bearer ${token}`, "x-client-version": VERSION },
  payload: { otherPlatform, otherFanRef, decision },
});

const suggested = (card: ClientFanCardResponse) => card.suggestions.map((one) => [one.platform, one.fanRef, one.reason]);

describe("the fan's card across pages", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "vanya", role: "chatter" }, { source: "cli" });
    const vanya = await fixtureUserId(app, "vanya");
    await setUserPassword(app, { userId: vanya, password: "vanya-secret" }, { source: "cli" });
    const lora = await createModel(app.db, { slug: "lora", name: "Lora" });
    const ari = await createModel(app.db, { slug: "ari", name: "Ari" });
    for (const [label, model, create] of [
      ["lora-1", lora, createFanslyPage], ["lora-2", lora, createFanslyPage], ["ari-1", ari, createFanslyPage], ["lora-of", lora, createOnlyFansPage],
    ] as const) {
      pages[label] = (await create(app.db, { modelId: model!.id, label }))!.id;
    }
    await assignPageToUser(app, { userId: vanya, pageLabel: "ari-1" }, { source: "cli" });

    await fan("rick", "fansly", "7000000001", "rickyboy");
    await fan("rickNew", "fansly", "7000000002", "rick_again");
    await fan("rickOf", "onlyfans", "7000000003", "RickyBoy");
    await fan("stranger", "fansly", "7000000004", "someone");
    await onPage("rick", "lora-1", "❌Rick/USA/40", 50_000);
    await onPage("rick", "ari-1", null, 0);
    await onPage("rickNew", "lora-2", "Rick/USA/40", 20_000);
    await onPage("rickOf", "lora-of", null, 5_000);
    await onPage("stranger", "lora-2", "User/Country", 1_000);

    server = await buildApiServer(app);
    await server.ready();
    const signIn = await server.inject({
      method: "POST",
      url: "/api/v1/auth/device-tokens/password",
      headers: { "x-client-version": VERSION },
      payload: { username: "vanya", password: "vanya-secret", label: "Firefox", mode: "active", client: "chat-extension" },
    });
    expect(signIn.statusCode, signIn.body).toBe(200);
    token = signIn.json<{ token: string }>().token;
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("shows another page's alias and money, suggests the same person, and takes the chatter's decision", async (context) => {
    if (!testDb || !server) return context.skip();
    const trap = await armNoOutboundTrap(testDb);
    try {
      const card = await get("7000000001");
      expect(card.known).toBe(true);
      // lora-1 is not Vanya's page: its alias with the mark and its money, no text of it.
      expect(card.pages.map((page) => [page.pageLabel, page.granted, page.alias, page.spentMills])).toEqual([
        ["lora-1", false, "❌Rick/USA/40", 50_000],
        ["ari-1", true, null, 0],
      ]);
      expect(suggested(card)).toEqual([
        ["fansly", "7000000002", "same_alias"],
        ["onlyfans", "7000000003", "same_username"],
      ]);
      expect(card.suggestions[0]).toMatchObject({ shared: "Rick/USA/40", sharedOn: "lora-2" });

      // Only a suggested account can be decided.
      const stranger = await decide("fansly", "7000000004", "same");
      expect(stranger.statusCode, stranger.body).toBe(409);

      const linked = await decide("fansly", "7000000002", "same");
      expect(linked.statusCode, linked.body).toBe(200);
      expect(linked.json()).toMatchObject({ decision: "same", recorded: true });
      const joined = await get("7000000001");
      expect(joined.accounts.map((account) => [account.fanRef, account.linkedBy])).toEqual([["7000000001", null], ["7000000002", "vanya"]]);
      expect(joined.pages.map((page) => page.pageLabel)).toEqual(["lora-1", "lora-2", "ari-1"]);
      expect(suggested(joined)).toEqual([["onlyfans", "7000000003", "same_username"]]);

      // «Нет» keeps it away; a repeat reads the first decision back.
      expect((await decide("onlyfans", "7000000003", "different")).json()).toMatchObject({ decision: "different", recorded: true });
      expect((await decide("onlyfans", "7000000003", "same")).json()).toMatchObject({ decision: "different", recorded: false });
      expect(suggested(await get("7000000001"))).toEqual([]);

      // An unknown fan is an empty card, not an error.
      expect(await get("7999999999")).toMatchObject({ known: false, accounts: [], pages: [], suggestions: [] });
      await trap.assertNoOutbound();
    } finally {
      await trap.restore();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
