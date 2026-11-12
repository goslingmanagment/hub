import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { agentPeopleResponseSchema, adminPersonResponseSchema } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, insertAgentKey } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// The people registry's pay terms are money (ecosystem plan 2026-11-12,
// package A): only the owner's session reads and writes them. A team lead's
// and a chatter's session never get them — not on the owner's card, not in
// the team's list — and an agent key reads them only with read:pay_terms.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const KEYS = {
  team: `${AGENT_KEY_TOKEN_PREFIX}people-team-only`,
  terms: `${AGENT_KEY_TOKEN_PREFIX}people-team-terms`,
  none: `${AGENT_KEY_TOKEN_PREFIX}people-no-team`,
} as const;
const SHARE = 2345;
const FIX = 7_000;
const MONEY_WORDS = [`"payTerms"`, "shareBasisPoints", "fixPerShiftMills", String(SHARE)];

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};

const asSession = (who: string, method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });
const asKey = (key: keyof typeof KEYS, method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { authorization: `Bearer ${KEYS[key]}` }, ...(payload ? { payload } : {}) });

describe("people registry: pay terms reach the owner only", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
    await createUserAccount(app, { username: "lead", role: "team_lead", password: "lead-password-for-tests" }, { source: "cli" });
    await createUserAccount(app, { username: "chat", role: "chatter" }, { source: "cli" });
    await setUserPassword(app, { userId: await fixtureUserId(app, "chat"), password: "chat-password-for-tests" }, { source: "cli" });
    const model = await createModel(app.db, { slug: "mia", name: "Mia" });
    const page = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-1" }))!.id;
    const owner = await fixtureUserId(app, "boss");
    const grants: Record<keyof typeof KEYS, string[]> = { team: ["read:team"], terms: ["read:team", "read:pay_terms"], none: ["read:content"] };
    for (const [name, token] of Object.entries(KEYS) as [keyof typeof KEYS, string][]) {
      await insertAgentKey(testDb.db, {
        name: `people-${name}`,
        keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
        keyDigest: sha256Hex(token),
        capabilities: grants[name] as never,
        pageIds: [page],
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        createdBy: owner,
      });
    }
    server = await buildApiServer(app);
    await server.ready();
    for (const user of ["boss", "lead", "chat"]) {
      const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: user, password: `${user}-password-for-tests` } });
      expect(login.statusCode, login.body).toBe(200);
      const header = login.headers["set-cookie"];
      cookies[user] = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
    }
    const created = await asSession("boss", "POST", "/api/v1/admin/people", {
      code: "chat", displayName: "Чаттер", role: "chatter", state: "working", workingPageLabels: ["mia-1"],
      logins: { add: [await fixtureUserId(app, "chat")] },
    });
    expect(created.statusCode, created.body).toBe(200);
    const set = await asSession("boss", "PUT", "/api/v1/admin/people/chat/pay-terms", {
      modelSlug: "mia", validFrom: "2026-11-01", shareBasisPoints: SHARE, fixPerShiftMills: FIX,
    });
    expect(set.statusCode, set.body).toBe(200);
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("gives the owner's card the terms", async (context) => {
    if (!testDb) return context.skip();
    const response = await asSession("boss", "GET", "/api/v1/admin/people/chat");
    expect(response.statusCode, response.body).toBe(200);
    const card = adminPersonResponseSchema.parse(response.json());
    expect(card.payTerms).toEqual([expect.objectContaining({ modelSlug: "mia", validFrom: "2026-11-01", validTo: null, shareBasisPoints: SHARE, fixPerShiftMills: FIX })]);
  });

  it("never gives a team lead's or a chatter's session anyone's terms, nor lets them write one", async (context) => {
    if (!testDb) return context.skip();
    for (const who of ["lead", "chat"]) {
      expect((await asSession(who, "GET", "/api/v1/admin/people/chat")).statusCode).toBe(403);
      expect((await asSession(who, "PUT", "/api/v1/admin/people/chat/pay-terms", {
        modelSlug: "mia", validFrom: "2026-11-02", shareBasisPoints: 9_000, fixPerShiftMills: 0,
      })).statusCode).toBe(403);
      expect((await asSession(who, "GET", "/api/v1/admin/people-proposals")).statusCode).toBe(403);
    }
    // The team's list is the team lead's, and it has no money in it at all.
    const list = await asSession("lead", "GET", "/api/v1/team/people");
    expect(list.statusCode, list.body).toBe(200);
    for (const word of MONEY_WORDS) expect(list.body).not.toContain(word);
    expect(list.json().people.map((person: { code: string }) => person.code)).toEqual(["chat"]);
    expect((await asSession("chat", "GET", "/api/v1/team/people")).statusCode).toBe(403);
    // Nothing changed the owner's term.
    const card = adminPersonResponseSchema.parse((await asSession("boss", "GET", "/api/v1/admin/people/chat")).json());
    expect(card.payTerms.map((term) => term.shareBasisPoints)).toEqual([SHARE]);
  });

  it("gives an agent key the terms only with read:pay_terms, and the feed only with read:team", async (context) => {
    if (!testDb) return context.skip();
    const plain = await asKey("team", "GET", "/api/v1/agent/people");
    expect(plain.statusCode, plain.body).toBe(200);
    expect(agentPeopleResponseSchema.parse(plain.json()).payTermsIncluded).toBe(false);
    for (const word of MONEY_WORDS) expect(plain.body).not.toContain(word);

    const withTerms = agentPeopleResponseSchema.parse((await asKey("terms", "GET", "/api/v1/agent/people")).json());
    expect(withTerms.payTermsIncluded).toBe(true);
    expect(withTerms.people[0]!.payTerms).toEqual([expect.objectContaining({ shareBasisPoints: SHARE, fixPerShiftMills: FIX })]);

    expect((await asKey("none", "GET", "/api/v1/agent/people")).statusCode).toBe(403);
    // Neither key reaches the owner's card, nor proposes without propose:people.
    expect((await asKey("terms", "GET", "/api/v1/admin/people/chat")).statusCode).toBe(403);
    expect((await asKey("terms", "POST", "/api/v1/agent/people/proposals", {
      kind: "update", personCode: "chat", change: { note: "x" }, reason: "x",
    })).statusCode).toBe(403);
  });
});
