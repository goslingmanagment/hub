import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createFanslyPage, createModel, insertAgentKey, listLoginsByPersonCode } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { planImport } from "../apps/runtime/src/services/sale-claims-import.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Which login a person code names (the bug happened: a decision «со слов» for a person whose older login was switched
// off was recorded on that switched-off login). A code names the person's live login, the lower id of two live ones;
// a person with no live login left is still known, by the lowest of their logins, so a word about someone who left is
// recorded and not refused as `person_unknown`. The same for the agent's door (decide, applied, ask) and for the
// carry-over from the ledger. Synthetic people and pages.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const AUDIT = { source: "cli" } as const;
const KEY = `${AGENT_KEY_TOKEN_PREFIX}person-login-key`;
const SAID = { telegramUserId: 700_000_701, sourceRef: "https://t.me/c/1/71" };

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const users: Record<string, number> = {};

const asAgent = (url: string, payload: Record<string, unknown>) =>
  server!.inject({ method: "POST", url, headers: { authorization: `Bearer ${KEY}` }, payload });

describe("a person code names the person's live login", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, AUDIT);
    // In this order: each first login is the older one (the lower id).
    for (const name of ["vera-old", "vera-new", "gleb-one", "gleb-two"]) {
      await createUserAccount(app, { username: name, role: "chatter" }, AUDIT);
    }
    for (const name of ["boss", "vera-old", "vera-new", "gleb-one", "gleb-two"]) users[name] = await fixtureUserId(app, name);
    const person = async (code: string, name: string, state: string, logins: number[]) => {
      const id = (await testDb!.pool.query<{ id: string }>(
        "insert into people (code, display_name, role, state) values ($1, $2, 'chatter', $3) returning id", [code, name, state],
      )).rows[0]!.id;
      for (const login of logins) await testDb!.pool.query("insert into person_logins (user_id, person_id) values ($1, $2)", [login, id]);
    };
    // vera's older login was switched off, she works on the newer one; gleb left: both his logins are off.
    await person("vera", "Вера", "working", [users["vera-old"]!, users["vera-new"]!]);
    await person("gleb", "Глеб", "left", [users["gleb-one"]!, users["gleb-two"]!]);
    await testDb.pool.query("update users set disabled_at = now() where id = any($1::bigint[])", [[users["vera-old"], users["gleb-one"], users["gleb-two"]]]);

    const model = await createModel(app.db, { slug: "mia", name: "Mia" });
    const page = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-1" }))!.id;
    await insertAgentKey(testDb.db, {
      name: "person-login", keyPrefix: KEY.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6), keyDigest: sha256Hex(KEY),
      capabilities: ["write:shift_reports"] as never, pageIds: [page],
      expiresAt: new Date(Date.now() + 30 * 86_400_000), createdBy: users.boss!,
    });
    server = await buildApiServer(app);
    await server.ready();
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("lists the live login first, and every login of a person who has none live", async (context) => {
    if (!testDb) return context.skip();
    const logins = await listLoginsByPersonCode(app.db, ["vera", "gleb", "nobody"]);
    expect(logins.get("vera")).toEqual([users["vera-new"], users["vera-old"]]);
    expect(logins.get("gleb")).toEqual([users["gleb-one"], users["gleb-two"]]);
    expect(logins.has("nobody")).toBe(false);
  });

  it("records a decision, its «учтено» and a question on the live login through the agent's door", async (context) => {
    if (!testDb) return context.skip();
    const decide = async (person: string, fanRef: string) => {
      const said = await asAgent("/api/v1/agent/sale-decisions", {
        pageLabel: "mia-1", fanRef, occurredAt: "2026-11-20T12:00:00.000Z", netMills: 9_000,
        kind: "owner", shares: [{ person, percent: 100 }], saidBy: "владелец", saidAt: "2026-11-20", ...SAID,
      });
      expect(said.statusCode, said.body).toBe(200);
      const decision = said.json().decision as { id: number; shares: Array<{ person: string | null; percent: number }> };
      expect(decision.shares).toMatchObject([{ person, percent: 100 }]);
      return decision;
    };
    // The login a decision's share is recorded on: the door's answer names the person, the row keeps the login.
    const sharedLogins = async (id: number) => {
      const row = await testDb!.pool.query<{ shares: Array<{ userId: number | string }> }>("select shares from sale_owner_decisions where id = $1", [id]);
      return row.rows[0]!.shares.map((share) => Number(share.userId));
    };

    const vera = await decide("vera", "7700000701");
    expect(await sharedLogins(vera.id)).toEqual([users["vera-new"]]);
    // No live login left: still known, by the lowest of the logins.
    const gleb = await decide("gleb", "7700000702");
    expect(await sharedLogins(gleb.id)).toEqual([users["gleb-one"]]);

    const applied = await asAgent("/api/v1/agent/sale-decisions/applied", { decisionId: vera.id, person: "vera", reportDate: "2026-11-20" });
    expect(applied.statusCode, applied.body).toBe(200);
    const taken = await testDb.pool.query("select applied_user_id from sale_owner_decisions where id = $1", [vera.id]);
    expect(Number(taken.rows[0].applied_user_id)).toBe(users["vera-new"]);

    const asked = await asAgent("/api/v1/agent/sale-questions", {
      pageLabel: "mia-1", fanRef: "7700000703", askedOf: "chatters", people: ["vera", "gleb"], question: "Чья продажа?", askedAt: "2026-11-20", ...SAID,
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const question = await testDb.pool.query("select claimant_user_id, side_user_id from sale_claims where id = $1", [asked.json().question.id]);
    expect([Number(question.rows[0].claimant_user_id), Number(question.rows[0].side_user_id)]).toEqual([users["vera-new"], users["gleb-one"]]);
  });

  it("carries the ledger's records over to the live login", async (context) => {
    if (!testDb) return context.skip();
    const plan = await planImport(app.db, {
      decisions: {
        columns: ["id", "status", "kind", "shares", "page_label", "fan_ref", "said_at", "said_by", "applied_person", "applied_report_date"],
        rows: [[9_001, "applied", "owner", JSON.stringify([{ person: "vera", percent: 100 }]), "mia-1", "7700000704", "2026-11-20", "владелец", "vera", "2026-11-20"]],
      },
      questions: {
        columns: ["id", "status", "question", "asked_of", "who", "page_label", "asked_at"],
        rows: [[9_101, "open", "Чья продажа?", "chatters", "vera и gleb", "mia-1", "2026-11-20"]],
      },
    });
    expect(plan.decisions[0]!.shares).toEqual([{ userId: users["vera-new"], percent: 100, person: "vera" }]);
    expect(plan.decisions[0]!.applied).toMatchObject({ person: "vera", userId: users["vera-new"], reportDate: "2026-11-20" });
    expect(plan.questions[0]!.people).toEqual([{ userId: users["vera-new"], name: "Вера" }, { userId: users["gleb-one"], name: "Глеб" }]);
  });
});
