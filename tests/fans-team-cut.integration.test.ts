import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import argon2 from "argon2";
import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";

import { createFanslyPage, createModel, insertPersonLogin, insertPersonRow, type Database } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { assignPageToUser, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { FAN_READ_OPERATIONS } from "../apps/runtime/src/services/fan-reads.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

// «Фаны» in Workboard (products package M): a chatter of team A reads the fans of team A's pages — a page of the team
// their login was never granted too — and gets no fan of team B's pages from ANY fans read: a page read of B is
// refused, a list or a fan's other pages leave B out, a fan of B alone is not found.

const PASSWORD = "fans-secret-1";
const FAN_A = "300000000000000001"; // on alfa-2 only (a page of team A the login was not granted)
const FAN_B = "300000000000000002"; // on bravo-1 only
const FAN_AB = "300000000000000003"; // on alfa-2 and bravo-1

let testDb: StartedTestDatabase | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let cookie = "";

async function fan(db: Database, ref: string, pages: Array<{ id: number; label: string; mills: number }>, chatterId: number) {
  const [row] = (await db.execute<{ id: string }>(sql`insert into fans (platform, platform_user_id, username, display_name)
    values ('fansly', ${ref}, ${`fan_${ref.slice(-1)}`}, ${`Fan ${ref.slice(-1)}`}) returning id`)).rows;
  for (const [index, page] of pages.entries()) {
    await db.execute(sql`insert into page_fans (fan_id, platform_account_id, is_subscriber) values (${row!.id}, ${page.id}, true)`);
    await db.execute(sql`insert into fan_spend_lifetime (platform_account_id, fan_id, gross_amount_mills, creator_net_amount_mills, last_transaction_at)
      values (${page.id}, ${row!.id}, ${page.mills}, ${page.mills}, now() - interval '1 day')`);
    await db.execute(sql`insert into transactions (platform_account_id, fan_id, transaction_id, raw_type, canonical_type, transaction_state,
      raw_status, gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, source, is_active)
      values (${page.id}, ${row!.id}, ${`t-${ref}-${page.label}`}, 'tip', 'tip'::transaction_type, 'posted', 'posted', ${page.mills},
        ${page.mills}, ${page.mills}, now() - interval '1 day', 'fansly:rest', true)`);
    await db.execute(sql`insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, conversation_ref, user_id,
      source, priced, with_media, observed_at) values ('fansly', ${page.id}, ${String(700_000 + Number(ref.slice(-1)) * 10 + index)}, ${ref},
      ${ref}, ${chatterId}, 'fansly-extension', true, false, now() - interval '2 hours')`);
  }
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  const app = createTestAppContext(testDb);
  const db = app.db as Database;
  await createUserAccount(app, { username: "olga", role: "owner", password: PASSWORD }, { source: "cli" });
  const alfa = await createModel(db, { slug: "alfa", name: "Alfa" });
  const bravo = await createModel(db, { slug: "bravo", name: "Bravo" });
  const alfa1 = await createFanslyPage(db, { modelId: alfa.id, label: "alfa-1" });
  const alfa2 = await createFanslyPage(db, { modelId: alfa.id, label: "alfa-2" });
  const bravo1 = await createFanslyPage(db, { modelId: bravo.id, label: "bravo-1" });
  const anna = await createUserAccount(app, { username: "anna", role: "chatter" }, { source: "cli" });
  const boris = await createUserAccount(app, { username: "boris", role: "chatter" }, { source: "cli" });
  await db.execute(sql`update users set password_hash = ${await argon2.hash(PASSWORD)} where id = ${anna.id}`);
  // Anna's login is granted alfa-1 alone; she is in team Alfa by her working page.
  await assignPageToUser(app, { userId: anna.id, pageLabel: "alfa-1" }, { source: "cli" });
  await assignPageToUser(app, { userId: boris.id, pageLabel: "bravo-1" }, { source: "cli" });
  for (const [code, user, page] of [["anna-a", anna.id, alfa1.id], ["boris-b", boris.id, bravo1.id]] as const) {
    const person = await insertPersonRow(db, {
      code, displayName: code, kind: "human", role: "chatter", state: "working", leftOn: null, telegramUserId: null,
      telegramHandle: null, reportTag: null, onboarding: [], note: null, importNotes: [], origin: "owner", createdByUserId: null,
    });
    await insertPersonLogin(db, { personId: person.id, userId: user, linkedByUserId: null });
    await db.execute(sql`insert into person_working_pages (person_id, page_id, position) values (${person.id}, ${page}, 0)`);
  }
  await fan(db, FAN_A, [{ id: alfa2.id, label: "alfa-2", mills: 40_000 }], anna.id);
  await fan(db, FAN_B, [{ id: bravo1.id, label: "bravo-1", mills: 900_000 }], boris.id);
  await fan(db, FAN_AB, [{ id: alfa2.id, label: "alfa-2", mills: 70_000 }, { id: bravo1.id, label: "bravo-1", mills: 800_000 }], boris.id);
  server = await buildApiServer(createTestAppContext(testDb));
  const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "anna", password: PASSWORD } });
  expect(login.statusCode, login.body).toBe(200);
  const header = login.headers["set-cookie"];
  cookie = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
}, 300_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

const get = (url: string) => server!.inject({ method: "GET", url, headers: { cookie } });
const post = (url: string, payload: unknown) => server!.inject({ method: "POST", url, payload: payload as Record<string, unknown>, headers: { cookie } });

/** Every fans read, named on a page and a fan. */
function reads(page: string, ref: string): Record<string, string> {
  return {
    pageSpenderAutoLists: `/api/v1/pages/${page}/spender-autolists`,
    pageSpenderAutoListDetail: `/api/v1/pages/${page}/spender-autolists/0-25`,
    pageSubscribers: `/api/v1/pages/${page}/subscribers`,
    pageFollowers: `/api/v1/pages/${page}/followers`,
    pageDeletedFans: `/api/v1/pages/${page}/deleted-fans`,
    pageFanCard: `/api/v1/pages/${page}/fans/${ref}/card`,
    pageFanDetail: `/api/v1/pages/${page}/fans/${ref}`,
    pageFanProfile: `/api/v1/pages/${page}/fans/${ref}/profile`,
    pageFanProfileVersions: `/api/v1/pages/${page}/fans/${ref}/profile/versions`,
    pageFanProfileVersion: `/api/v1/pages/${page}/fans/${ref}/profile/versions/1`,
    pageFanTransactions: `/api/v1/pages/${page}/fans/${ref}/transactions`,
    pageFanWorkedWith: `/api/v1/pages/${page}/fans/${ref}/worked-with`,
    pageConversationPreview: `/api/v1/pages/${page}/conversations/${ref}/preview`,
    spenderDetail: `/api/v2/spenders/fansly/${ref}?scope=page&pageLabel=${page}&period=lifetime`,
    spenderSeries: `/api/v2/spenders/fansly/${ref}/series?scope=page&pageLabel=${page}&period=30d`,
  };
}

describe("fans: a chatter reads the fans of their teams' pages only (package M)", () => {
  it("refuses every page read of team B, and opens team A's page the login was never granted", async (context) => {
    if (!server) return context.skip();
    for (const [key, url] of Object.entries(reads("bravo-1", FAN_B))) {
      const response = await get(url);
      expect(response.statusCode, `${key} ${url}: ${response.body}`).toBe(403);
    }
    for (const key of ["pageSubscribers", "pageFanCard", "pageFanDetail", "pageFanTransactions", "pageFanWorkedWith"]) {
      const response = await get(reads("alfa-2", FAN_A)[key]!);
      expect(response.statusCode, `${key}: ${response.body}`).toBe(200);
    }
    const fanPages = JSON.parse((await get("/api/v1/fans/pages")).body) as Array<{ label: string }>;
    expect(fanPages.map((page) => page.label).sort()).toEqual(["alfa-1", "alfa-2"]);
    const workedWith = JSON.parse((await get(reads("alfa-2", FAN_A).pageFanWorkedWith!)).body) as { authors: Array<{ username: string }> };
    expect(workedWith.authors.map((author) => author.username)).toEqual(["anna"]);
  });

  it("leaves team B out of every list and every fan's other pages", async (context) => {
    if (!server) return context.skip();
    const answers = [
      await get("/api/v2/spenders?scope=agency&platform=fansly&period=lifetime"),
      await get("/api/v2/spenders?scope=model&modelSlug=alfa&platform=fansly&period=lifetime"),
      await get(`/api/v1/fans/fansly/${FAN_AB}`),
      await get(`/api/v1/fans/fansly/${FAN_AB}/transactions`),
      await get(reads("alfa-2", FAN_AB).pageFanCard!),
      await get(reads("alfa-2", FAN_AB).pageFanDetail!),
      await get(reads("alfa-2", FAN_AB).spenderDetail!),
      await get("/api/v2/fans/search?scope=agency&platform=fansly&q=Fan"),
      await get("/api/v1/fans/pages"),
      await post("/api/v2/spenders:batch", { scope: "agency", platform: "fansly", period: "lifetime", fans: [{ platform: "fansly", platformUserId: FAN_AB }] }),
    ];
    for (const response of answers) {
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body, response.body).not.toContain("bravo");
      expect(response.body, response.body).not.toContain(FAN_B);
      expect(response.body, response.body).not.toContain("800000");
    }
    // A fan of team B alone: not found, not a page of B.
    const batch = await post("/api/v2/spenders:batch", { scope: "agency", platform: "fansly", period: "lifetime", fans: [{ platform: "fansly", platformUserId: FAN_B }] });
    expect((JSON.parse(batch.body) as { items: Array<{ found: boolean }> }).items.map((item) => item.found)).toEqual([false]);
    expect((await get(`/api/v1/fans/fansly/${FAN_B}`)).statusCode).toBe(404);
    expect((await get(`/api/v1/fans/fansly/${FAN_B}/transactions`)).statusCode).toBe(404);
  });

  it("walks every fans read the server declares", async (context) => {
    if (!server) return context.skip();
    const declared = new Set(server.routePolicyTable.map((row) => row.routeKey));
    for (const key of FAN_READ_OPERATIONS) expect(declared.has(key), key).toBe(true);
    const walked = new Set([...Object.keys(reads("x", "1")), "spenders", "spenderBatch", "crossPageFanDetail", "crossPageFanTransactions", "fanPages"]);
    expect([...FAN_READ_OPERATIONS].filter((key) => !walked.has(key))).toEqual([]);
  });
});
