import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createFanslyPage, createModel, listPotDistributions } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount, principalOfLogin, setUserPassword, type AuthPrincipal } from "../apps/runtime/src/services/auth.ts";
import { createPerson } from "../apps/runtime/src/services/people/index.ts";
import { readAccountPots } from "../apps/runtime/src/services/pots-mine.ts";
import { createPot, reversePotDistribution, setPotsFromSwitch } from "../apps/runtime/src/services/pots.ts";
import { refreshSaleHomesForDay } from "../apps/runtime/src/services/sale-homes.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// A person's own share of the Workboard pots (`accountPots`, services/pots-mine.ts), on Postgres: only the caller's
// own lines (a colleague's code or base never in the answer), reversed distributions left out, the window's days only,
// the share still to come as the caller's line of the pot's split among THAT sale day's participants, and none of it
// for whoever is not one of them.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let txSeq = 0;
const users = { boss: 0, alex: 0, kate: 0, nobody: 0 };
const pages = { one: 0, two: 0 };

const msk = (at: string) => new Date(`${at.replace(" ", "T")}:00+03:00`);
const WINDOW = { from: "2026-11-20", to: "2026-11-26" };
const NOW = msk("2026-11-27 12:00");

async function insertPostTip(pageId: number, occurredAt: Date, netMills: number): Promise<number> {
  txSeq += 1;
  const ref = `account-pots-tip-${txSeq}`;
  const res = await testDb!.pool.query(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
       gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at,
       source, currency, correlation_id)
     values ($1, $2, 'tip', 'tip'::transaction_type, 'posted', 'ok', $3, $3, $3, 0, $4, 'fansly:rest', 'USD', $5)
     returning id`,
    [pageId, `tx-account-pots-${txSeq}`, netMills, occurredAt, ref],
  );
  await testDb!.pool.query(
    `insert into creator_post_tips (account_id, platform, platform_post_id, platform_tip_id, tip_sender_platform_user_id,
       post_tip_amount_mills, occurred_at, first_observed_at, last_observed_at, content_hash, source_event_id,
       source_observation_id, source_account_seq)
     values ($1, 'fansly', $2, $3, 'fan-synth-1', $4, $5, $5, $5, $6, 1, 1, $7)`,
    [pageId, `post-${txSeq}`, ref, netMills, occurredAt, sha256Hex(ref), txSeq],
  );
  return Number(res.rows[0].id);
}

/** A sale on a Moscow day at noon, its day refreshed (the pots reconciled, unless deferred) at the end of it. */
async function sale(pageId: number, day: string, netMills: number, options: { deferPots?: boolean } = {}) {
  const id = await insertPostTip(pageId, msk(`${day} 12:00`), netMills);
  await refreshSaleHomesForDay(app.db, day, msk(`${day} 20:00`), options);
  return id;
}

async function sessionOf(userId: number): Promise<AuthPrincipal> {
  // A cookie session's principal (requireSessionUser): the login's own, with a session id.
  return { ...(await principalOfLogin(app, userId))!, authSessionId: 1 };
}

const potsOf = async (userId: number, window = WINDOW) => readAccountPots(app, await sessionOf(userId), window, NOW);

describe("a person's own share of the pots (accountPots)", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);

    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
    for (const name of ["alex", "kate", "nobody"] as const) {
      await createUserAccount(app, { username: name, role: "chatter" }, { source: "cli" });
      users[name] = await fixtureUserId(app, name);
      await setUserPassword(app, { userId: users[name], password: `${name}-password-for-tests` }, { source: "cli" });
    }
    users.boss = await fixtureUserId(app, "boss");

    const model = (await createModel(app.db, { slug: "mia", name: "Mia" }))!;
    pages.one = (await createFanslyPage(app.db, { modelId: model.id, label: "mia-1" }))!.id;
    pages.two = (await createFanslyPage(app.db, { modelId: model.id, label: "mia-2" }))!.id;
    // «nobody» has a login and no person in the registry.
    await createPerson(app, { code: "alex", displayName: "Alex", role: "chatter", state: "working", logins: { add: [users.alex] } }, { source: "cli" }, msk("2026-11-01 09:00"));
    await createPerson(app, { code: "kate", displayName: "Kate", role: "chatter", state: "working", logins: { add: [users.kate] } }, { source: "cli" }, msk("2026-11-01 09:00"));

    await setPotsFromSwitch(app.db, { potsFrom: "2026-11-18", setBy: "test", at: msk("2026-11-18 09:00") });
    const owner = (await principalOfLogin(app, users.boss))!;
    const intake = { intakeReasons: ["post_tip", "campaign"] as Array<"post_tip" | "campaign">, opensOn: "2026-11-18", closesOn: null };
    // mia-1: auto-posted, equal; alex all along, kate until 2026-11-23.
    await createPot(app, owner, {
      code: "pot-mia-1", name: "Pot mia-1", modelId: model.id, pageIds: [pages.one], ...intake, participantsMode: "listed",
      participants: [{ personCode: "alex", fromDay: "2026-11-18", toDay: null }, { personCode: "kate", fromDay: "2026-11-18", toDay: "2026-11-23" }],
      formula: { kind: "equal", params: {} }, autoPost: true,
    }, msk("2026-11-18 10:00"));
    // mia-2: distributed by hand (nothing posted yet), kate alone.
    await createPot(app, owner, {
      code: "pot-mia-2", name: "Pot mia-2", modelId: model.id, pageIds: [pages.two], ...intake, participantsMode: "listed",
      participants: [{ personCode: "kate", fromDay: "2026-11-18", toDay: null }],
      formula: { kind: "equal", params: {} }, autoPost: false,
    }, msk("2026-11-18 10:00"));

    await sale(pages.one, "2026-11-19", 9_000); // before the window
    await sale(pages.one, "2026-11-21", 10_001); // alex 5_001, kate 5_000
    await sale(pages.one, "2026-11-22", 3_000); // posted, then reversed by the owner: held, not to come by itself
    await sale(pages.one, "2026-11-23", 3_000, { deferPots: true }); // not reconciled yet: still to come
    await sale(pages.one, "2026-11-24", 7_000); // alex alone (kate's period ended)
    await sale(pages.two, "2026-11-25", 4_000); // the pot without auto-post: the owner's to post, no promise
    await sale(pages.one, "2026-11-27", 2_000); // after the window

    const potOne = (await testDb.pool.query("select id from pots where code = 'pot-mia-1'")).rows[0] as { id: string };
    const reversed = (await listPotDistributions(app.db, Number(potOne.id))).find((one) => one.day === "2026-11-22")!;
    await reversePotDistribution(app, owner, reversed.id, { reason: "owner check" }, msk("2026-11-23 10:00"));

    server = await buildApiServer(app);
    await server.ready();
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("gives the caller their own lines of the window's live distributions and nothing of a colleague's", async (context) => {
    if (!testDb) return context.skip();
    const alex = await potsOf(users.alex);
    expect(alex).toMatchObject({ on: true, potsFrom: "2026-11-18", totalMills: 12_001, pendingMills: 1_500 });
    expect(alex.pots).toEqual([{
      code: "pot-mia-1", name: "Pot mia-1", pageLabels: ["mia-1"],
      // 2026-11-21 and 2026-11-24; the reversed 2026-11-22 and the days outside the window are not in it.
      mineMills: 12_001, distributions: 2, lastSplit: 1, lastFormula: "equal",
      // The unreconciled 2026-11-23 sale's 3_000 split as on its day (alex and kate), not as today (alex alone); the
      // reversed (held) 2026-11-22 sale is not to come.
      pendingMills: 1_500, participantToday: true,
    }]);
    // Nothing of kate: not her code, not her lines, not the manual pot she alone is in.
    expect(JSON.stringify(alex)).not.toContain("kate");
    expect(JSON.stringify(alex)).not.toContain("pot-mia-2");

    const kate = await potsOf(users.kate);
    expect(kate).toMatchObject({ totalMills: 5_000, pendingMills: 1_500 });
    expect(kate.pots).toEqual([
      // Her period ended on 2026-11-23: a share of what she worked, not a participant today.
      { code: "pot-mia-1", name: "Pot mia-1", pageLabels: ["mia-1"], mineMills: 5_000, distributions: 1, lastSplit: 2, lastFormula: "equal", pendingMills: 1_500, participantToday: false },
      // The pot without auto-post: a participant today, nothing promised before the owner posts.
      { code: "pot-mia-2", name: "Pot mia-2", pageLabels: ["mia-2"], mineMills: 0, distributions: 0, lastSplit: null, lastFormula: null, pendingMills: 0, participantToday: true },
    ]);
    expect(JSON.stringify(kate)).not.toContain("alex");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("follows the window's days", async (context) => {
    if (!testDb) return context.skip();
    const wide = await potsOf(users.alex, { from: "2026-11-18", to: "2026-11-27" });
    // 4_500 (2026-11-19) + 5_001 + 7_000 + 2_000 (2026-11-27); the reversed line stays out.
    expect(wide.totalMills).toBe(18_501);
    expect(wide.pots[0]).toMatchObject({ distributions: 4, lastSplit: 1 });
    const day = await potsOf(users.alex, { from: "2026-11-21", to: "2026-11-21" });
    expect(day.pots[0]).toMatchObject({ mineMills: 5_001, distributions: 1, lastSplit: 2 });
    // A window before the pots: off, nothing.
    expect(await potsOf(users.alex, { from: "2026-11-10", to: "2026-11-17" })).toMatchObject({ on: false, totalMills: 0, pendingMills: 0, pots: [] });
    await expect(potsOf(users.alex, { from: "2026-09-01", to: "2026-11-26" })).rejects.toMatchObject({ statusCode: 400 });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("answers a login that is nobody's with no pots, and only a cookie session", async (context) => {
    if (!testDb || !server) return context.skip();
    expect(await potsOf(users.nobody)).toMatchObject({ on: true, totalMills: 0, pendingMills: 0, pots: [] });
    await expect(readAccountPots(app, (await principalOfLogin(app, users.alex))!, WINDOW, NOW)).rejects.toMatchObject({ statusCode: 403 });

    const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "alex", password: "alex-password-for-tests" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const answer = await server.inject({ method: "GET", url: `/api/v1/account/pots?from=${WINDOW.from}&to=${WINDOW.to}`, headers: { cookie } });
    expect(answer.statusCode, answer.body).toBe(200);
    expect(answer.json()).toMatchObject({ totalMills: 12_001, pots: [{ code: "pot-mia-1", mineMills: 12_001 }] });
    expect(answer.body).not.toContain("kate");
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
