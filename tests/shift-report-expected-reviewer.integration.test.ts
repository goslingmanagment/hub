import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  agentShiftReportChecksResponseSchema,
  shiftReportResponseSchema,
  teamShiftReportsResponseSchema,
} from "@agency_hub_core/contracts";
import {
  assignUserToPage,
  createFanslyPage,
  createModel,
  deletePersonAgentKey,
  insertAgentKey,
  revokeAgentKey,
} from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { replaceAgentKey } from "../apps/runtime/src/services/agent-keys.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { checkReportNow, moveWhenDue } from "../apps/runtime/src/services/shift-handin-check.ts";
import { readShiftReport, type HandinPersonActor } from "../apps/runtime/src/services/shift-handins.ts";
import { handInShiftReport } from "../apps/runtime/src/services/shift-report-board.ts";
import { pageCatalog } from "../apps/runtime/src/services/shift-report-draft.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { insertReviewerAgentKey } from "./helpers/shift-report-hand-in.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Expected reviewer snapshot at hand-in (OA-002 / 0440):
// - Issuing, rotating, or revoking a reviewer key never changes the phase or gengar state of an already handed-in shift.
// - A partial page grant never qualifies as expected reviewer for a multi-page shift (teamShiftReports included).
// - Multiple active reviewers covering all pages -> first alphabetically by people.code with a warning.
// - Queue filters by reviewer identity BEFORE limit.
// - Posting a check answer verifies calling key's linked person against stored expected_reviewer_person_id inside the tx.
// - Hub remake inherits expected_reviewer_person_id; DB trigger keeps it immutable.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};
const users: Record<string, number> = {};
let miaModelId = 0;
let pageMia = 0;
let pageNova = 0;
let txSeq = 0;

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
const asSession = (who: string, method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });
const asBearer = (token: string, method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
const annaActor = (): HandinPersonActor => ({
  kind: "person", userId: users.anna!, role: "chatter", pageIds: [pageMia, pageNova], door: "workboard",
});

async function insertShift(pages: string[], hoursAgoStart: number, hoursAgoEnd: number): Promise<number> {
  const startedAt = new Date(Date.now() - hoursAgoStart * HOUR_MS);
  const endedAt = new Date(Date.now() - hoursAgoEnd * HOUR_MS);
  const reportDate = new Date(startedAt.getTime() + 3 * HOUR_MS).toISOString().slice(0, 10);
  const result = await q(
    `insert into shifts (user_id, state, started_at, ended_at, worked_minutes, messages, report_date, pages)
     values ($1, 'closed', $2::timestamptz, $3::timestamptz, 120, 60, $4::date, $5::jsonb) returning id`,
    [
      users.anna,
      startedAt.toISOString(),
      endedAt.toISOString(),
      reportDate,
      JSON.stringify(pages.map((pageLabel) => ({ pageLabel, activeMinutes: 120, messages: 60, salesFrom: startedAt.toISOString() }))),
    ],
  );
  return Number(result.rows[0].id);
}

async function insertSaleForShift(_shiftId: number, pageId: number, occurredAt: Date, netMills = 10_000): Promise<number> {
  txSeq += 1;
  const fan = (await q(
    `insert into fans (platform, platform_user_id, username, display_name)
     values ('fansly', $1, $2, $2) on conflict (platform, platform_user_id) do update set username = excluded.username returning id`,
    ["7700000440", "test_fan_440"],
  )).rows[0] as { id: string };
  const inserted = await q(
    `insert into transactions (platform_account_id, fan_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
       gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency)
     values ($1, $2, $3, 'tip', 'tip', 'posted', 'ok', $4, $4, $5, 2000, $6::timestamptz, 'fansly:rest', 'USD') returning id`,
    [pageId, Number(fan.id), `tx-er-${txSeq}`, netMills + 2_000, netMills, occurredAt.toISOString()],
  );
  return Number(inserted.rows[0].id);
}

async function revokeAllReviewerKeys() {
  await q("update agent_keys set revoked_at = now() where revoked_at is null and 'review:shift_reports' = any(capabilities)");
}

async function candidateRow(candidateId: number) {
  const row = (await q(
    `select id, number, expected_reviewer_person_id, gengar_answered_at, gengar_clean, superseded_at, superseded_by
     from shift_handin_candidates where id = $1`,
    [candidateId],
  )).rows[0] as {
    id: string;
    number: number;
    expected_reviewer_person_id: string | null;
    gengar_answered_at: Date | null;
    gengar_clean: boolean | null;
    superseded_at: Date | null;
    superseded_by: string | null;
  };
  return {
    id: Number(row.id),
    number: row.number,
    expectedReviewerPersonId: row.expected_reviewer_person_id === null ? null : Number(row.expected_reviewer_person_id),
    gengarAnsweredAt: row.gengar_answered_at,
    gengarClean: row.gengar_clean,
    supersededAt: row.superseded_at,
    supersededBy: row.superseded_by === null ? null : Number(row.superseded_by),
  };
}

async function teamReportFor(who: string, shiftId: number) {
  const response = await asSession(who, "GET", "/api/v1/team/shift-reports?days=14");
  expect(response.statusCode, response.body).toBe(200);
  const parsed = teamShiftReportsResponseSchema.parse(response.json());
  return parsed.reports.find((one) => one.shiftId === shiftId);
}

describe("expected reviewer snapshot at hand-in (OA-002)", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
    await createUserAccount(app, { username: "lead", role: "team_lead", password: "lead-password-for-tests" }, { source: "cli" });
    await createUserAccount(app, { username: "anna", role: "chatter" }, { source: "cli" });
    users.boss = await fixtureUserId(app, "boss");
    users.lead = await fixtureUserId(app, "lead");
    users.anna = await fixtureUserId(app, "anna");
    await setUserPassword(app, { userId: users.anna, password: "anna-password-for-tests" }, { source: "cli" });

    const mia = await createModel(app.db, { slug: "mia", name: "Mia" });
    const nova = await createModel(app.db, { slug: "nova", name: "Nova" });
    miaModelId = mia!.id;
    pageMia = (await createFanslyPage(app.db, { modelId: mia!.id, label: "mia-1" }))!.id;
    pageNova = (await createFanslyPage(app.db, { modelId: nova!.id, label: "nova-1" }))!.id;

    await assignUserToPage(app.db, users.anna, pageMia);
    await assignUserToPage(app.db, users.anna, pageNova);
    await assignUserToPage(app.db, users.lead, pageMia);

    server = await buildApiServer(app);
    await server.ready();
    for (const user of ["boss", "lead", "anna"]) {
      const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: user, password: `${user}-password-for-tests` } });
      expect(login.statusCode, login.body).toBe(200);
      const header = login.headers["set-cookie"];
      cookies[user] = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
    }
    const createdAnna = await asSession("boss", "POST", "/api/v1/admin/people", {
      code: "anna", displayName: "Anna", role: "chatter", state: "working", rights: ["submits_shift"], logins: { add: [users.anna] },
    });
    expect(createdAnna.statusCode, createdAnna.body).toBe(200);
    const createdLead = await asSession("boss", "POST", "/api/v1/admin/people", {
      code: "lead", displayName: "Lead", role: "team_lead", state: "working", rights: [], logins: { add: [users.lead] },
    });
    expect(createdLead.statusCode, createdLead.body).toBe(200);
    await q("update person_rights set granted_at = now() - interval '30 days'");
    await q("insert into person_working_pages (person_id, page_id, position) select p.id, $1, 0 from people p where p.code = 'anna'", [pageMia]);
    await q("insert into person_working_pages (person_id, page_id, position) select p.id, $1, 1 from people p where p.code = 'anna'", [pageNova]);
    // Lead leads Mia only (mia-1), never Nova (nova-1).
    await q("insert into team_roles (person_id, model_id, kind) select p.id, $1, 'lead' from people p where p.code = 'lead'", [miaModelId]);
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("only serves granted lines when an owner delivers a sale from another page into a candidate", async (context) => {
    if (!testDb) return context.skip();
    await revokeAllReviewerKeys();
    const token = `${AGENT_KEY_TOKEN_PREFIX}fixture-line-scope`;
    await insertReviewerAgentKey(testDb.db, {
      token, name: "fixture-line-scope", pageIds: [pageMia], createdBy: users.boss!, agentCode: "fixture-reviewer",
    });
    const pages = (await q("select label from pages where id = $1", [pageMia])).rows;
    const shift = await insertShift([pages[0].label as string], 4, 1);
    const time = new Date(Date.now() - 3 * HOUR_MS);
    const external = await insertSaleForShift(shift, pageNova, time, 1234);
    await q(`insert into sale_homes (transaction_id, page_id, occurred_at, net_mills, home, reason, shares, rule_version, computed_at)
      values ($1, $2, $3, 1234, 'nobody', 'no_holder', '[]', 'fixture', now())`, [external, pageNova, time]);
    const given = await asSession("boss", "POST", "/api/v1/sale-nobody/give", { transactionId: external, userId: users.anna });
    expect(given.statusCode, given.body).toBe(200);
    const sent = await handInShiftReport(app, annaActor(), { shiftId: shift });
    const id = sent.board!.candidate!.id;
    const stored = await q("select lines from shift_handin_candidates where id = $1", [id]);
    expect(stored.rows[0].lines).toContainEqual(expect.objectContaining({ transactionId: external, amountMills: 1234 }));
    const result = await asBearer(token, "GET", "/api/v1/agent/shift-reports/checks");
    const visible = agentShiftReportChecksResponseSchema.parse(result.json()).checks.find((one) => one.candidateId === id);
    expect(visible).toBeDefined();
    expect(visible!.lines.map((one) => one.transactionId)).not.toContain(external);
    const answer = await asBearer(token, "POST", `/api/v1/agent/shift-reports/checks/${id}`, {
      proposals: [{ transactionId: external, kind: "note", note: "Fixture note", why: "Fixture review" }],
    });
    expect(answer.statusCode, answer.body).toBe(404);
    expect((await candidateRow(id)).gengarAnsweredAt).toBeNull();
    expect((await q("select id from shift_handin_proposals where candidate_id = $1", [id])).rows).toEqual([]);
  });

  it("issuing, revoking, or rotating a reviewer key does not change the phase of an already handed-in shift", async (context) => {
    if (!testDb) return context.skip();
    await revokeAllReviewerKeys();

    // (A) Hand in with NO reviewer -> expected_reviewer_person_id = null, phase = confirm, gengar = idle.
    const shiftNoRev = await insertShift(["mia-1"], 30, 28);
    const handedNoRev = shiftReportResponseSchema.parse((await asSession("anna", "POST", `/api/v1/shift-reports/${shiftNoRev}/submit`)).json());
    const candNoRev = handedNoRev.board!.candidate!.id;
    expect(handedNoRev.board?.phase).toBe("confirm");
    expect(handedNoRev.board?.candidate?.gengar.state).toBe("idle");
    expect((await candidateRow(candNoRev)).expectedReviewerPersonId).toBeNull();

    // Issue a reviewer key AFTER hand-in: phase, board view, and teamShiftReports stay unchanged, and the new reviewer cannot answer it.
    const tokAlpha1 = `${AGENT_KEY_TOKEN_PREFIX}er-alpha-1`;
    const alpha = await insertReviewerAgentKey(testDb.db, {
      name: "er-alpha-1", token: tokAlpha1, pageIds: [pageMia], createdBy: users.boss!, agentCode: "alpha-rev",
    });
    const boardAfterIssue = shiftReportResponseSchema.parse((await asSession("anna", "GET", `/api/v1/shift-reports/${shiftNoRev}`)).json()).board!;
    expect(boardAfterIssue.phase).toBe("confirm");
    expect(boardAfterIssue.candidate?.gengar.state).toBe("idle");
    expect((await teamReportFor("boss", shiftNoRev))?.check?.gengar).toBe("idle");
    const checksAfterIssue = agentShiftReportChecksResponseSchema.parse((await asBearer(tokAlpha1, "GET", "/api/v1/agent/shift-reports/checks")).json());
    expect(checksAfterIssue.checks.map((one) => one.candidateId)).not.toContain(candNoRev);
    const refusedAnswer = await asBearer(tokAlpha1, "POST", `/api/v1/agent/shift-reports/checks/${candNoRev}`, { proposals: [] });
    expect(refusedAnswer.statusCode, refusedAnswer.body).toBe(403);
    expect((await candidateRow(candNoRev)).gengarAnsweredAt).toBeNull();

    // (B) Hand in WITH alpha active -> expected_reviewer_person_id = alpha.personId, phase = checking, gengar = reading.
    const shiftRevoked = await insertShift(["mia-1"], 26, 24);
    const handedAt = new Date();
    const handedWithRev = await handInShiftReport(app, annaActor(), { shiftId: shiftRevoked }, handedAt);
    const candRevoked = handedWithRev.board!.candidate!.id;
    expect(handedWithRev.board?.phase).toBe("checking");
    expect(handedWithRev.board?.candidate?.gengar.state).toBe("reading");
    expect((await candidateRow(candRevoked)).expectedReviewerPersonId).toBe(alpha.personId);

    // Revoke alpha's key right after hand-in: phase MUST stay `checking` (never prematurely flip to `confirm`/`idle`).
    await revokeAgentKey(testDb.db, { id: alpha.agentKeyId });
    const twoMinLater = new Date(handedAt.getTime() + 2 * 60_000);
    expect(await moveWhenDue(app.db, { shiftId: shiftRevoked }, twoMinLater)).toBe(false);
    const boardWhileChecking = (await readShiftReport(app, annaActor(), shiftRevoked, twoMinLater)).board!;
    expect(boardWhileChecking.phase).toBe("checking");
    expect(boardWhileChecking.candidate?.gengar.state).toBe("reading");
    expect((await teamReportFor("boss", shiftRevoked))?.check?.gengar).toBe("reading");

    // Once the 10-minute timeout elapses, it moves to `confirm` with `gengar: "silent"` (still never `"idle"`).
    const elevenMinLater = new Date(handedAt.getTime() + 11 * 60_000);
    const boardTimedOut = (await readShiftReport(app, annaActor(), shiftRevoked, elevenMinLater)).board!;
    expect(boardTimedOut.phase).toBe("confirm");
    expect(boardTimedOut.candidate?.gengar.state).toBe("silent");

    // (C) Key rotation (`replaceAgentKey`): does not change phase, does not warn during grace, and the replacement key answers the candidate.
    const tokAlpha2 = `${AGENT_KEY_TOKEN_PREFIX}er-alpha-2`;
    const alpha2 = await insertReviewerAgentKey(testDb.db, {
      name: "er-alpha-2", token: tokAlpha2, pageIds: [pageMia], createdBy: users.boss!, agentCode: "alpha-rev",
    });
    const shiftRotated = await insertShift(["mia-1"], 22, 20);
    const handedRot = shiftReportResponseSchema.parse((await asSession("anna", "POST", `/api/v1/shift-reports/${shiftRotated}/submit`)).json());
    const candRot = handedRot.board!.candidate!.id;
    expect(handedRot.board?.phase).toBe("checking");
    expect((await candidateRow(candRot)).expectedReviewerPersonId).toBe(alpha2.personId);

    const replaced = await replaceAgentKey(app, { id: alpha2.agentKeyId, name: "er-alpha-3", expiresInDays: 30 }, { source: "cli", actorUserId: users.boss! });

    // Handing in another shift during the 24h replacement grace does not emit a multiple-reviewers warning.
    const warnSpy = vi.spyOn(app.logger, "warn");
    const shiftDuringGrace = await insertShift(["mia-1"], 20, 19);
    const handedGrace = shiftReportResponseSchema.parse((await asSession("anna", "POST", `/api/v1/shift-reports/${shiftDuringGrace}/submit`)).json());
    expect((await candidateRow(handedGrace.board!.candidate!.id)).expectedReviewerPersonId).toBe(alpha2.personId);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();

    // Revoking the old key leaves the phase in `checking`; the new rotated key sees and answers the candidate seamlessly.
    await revokeAgentKey(testDb.db, { id: alpha2.agentKeyId });
    expect((await readShiftReport(app, annaActor(), shiftRotated)).board?.phase).toBe("checking");
    const rotChecks = agentShiftReportChecksResponseSchema.parse((await asBearer(replaced.token, "GET", "/api/v1/agent/shift-reports/checks")).json());
    expect(rotChecks.checks.map((one) => one.candidateId)).toContain(candRot);
    const rotAnswer = await asBearer(replaced.token, "POST", `/api/v1/agent/shift-reports/checks/${candRot}`, { proposals: [] });
    expect(rotAnswer.statusCode, rotAnswer.body).toBe(200);
    expect((await readShiftReport(app, annaActor(), shiftRotated)).board?.phase).toBe("confirm");
  });

  it("does not qualify a partial page grant as expected reviewer for a multi-page shift (including cut teamShiftReports)", async (context) => {
    if (!testDb) return context.skip();
    await revokeAllReviewerKeys();

    // Reviewer covers ONLY mia-1, NOT nova-1.
    const tokPartial = `${AGENT_KEY_TOKEN_PREFIX}er-partial-key`;
    await insertReviewerAgentKey(testDb.db, {
      name: "er-partial", token: tokPartial, pageIds: [pageMia], createdBy: users.boss!, agentCode: "partial-rev",
    });

    const multiShift = await insertShift(["mia-1", "nova-1"], 18, 16);
    const handed = shiftReportResponseSchema.parse((await asSession("anna", "POST", `/api/v1/shift-reports/${multiShift}/submit`)).json());
    const candId = handed.board!.candidate!.id;

    expect(handed.board?.phase).toBe("confirm");
    expect(handed.board?.candidate?.gengar.state).toBe("idle");
    expect((await candidateRow(candId)).expectedReviewerPersonId).toBeNull();

    // Both owner (whole shift) and lead (cut to mia-1 alone) see `gengar: "idle"` because ALL shift pages are checked.
    expect((await teamReportFor("boss", multiShift))?.check?.gengar).toBe("idle");
    expect((await teamReportFor("lead", multiShift))?.check?.gengar).toBe("idle");

    // Partial reviewer does not see it in checks.
    const checks = agentShiftReportChecksResponseSchema.parse((await asBearer(tokPartial, "GET", "/api/v1/agent/shift-reports/checks")).json());
    expect(checks.checks.map((one) => one.candidateId)).not.toContain(candId);
  });

  it("does not assign an agent with review:shift_reports capability unless it explicitly holds reviews_shift_reports right (OA-002)", async (context) => {
    if (!testDb) return context.skip();
    await revokeAllReviewerKeys();

    const tokUnassigned = `${AGENT_KEY_TOKEN_PREFIX}er-unassigned-key`;
    const unassigned = await insertReviewerAgentKey(testDb.db, {
      name: "er-unassigned", token: tokUnassigned, pageIds: [pageMia], createdBy: users.boss!, agentCode: "unassigned-rev", assignedReviewer: false,
    });
    const shift1 = await insertShift(["mia-1"], 15, 14);
    const handed1 = shiftReportResponseSchema.parse((await asSession("anna", "POST", `/api/v1/shift-reports/${shift1}/submit`)).json());
    expect(handed1.board?.phase).toBe("confirm");
    expect(handed1.board?.candidate?.gengar.state).toBe("idle");
    expect((await candidateRow(handed1.board!.candidate!.id)).expectedReviewerPersonId).toBeNull();

    // Granting `reviews_shift_reports` explicitly assigns this agent as expected reviewer for subsequent hand-ins.
    await q("insert into person_rights (person_id, \"right\") values ($1, 'reviews_shift_reports') on conflict do nothing", [unassigned.personId]);
    const shift2 = await insertShift(["mia-1"], 13, 12);
    const handed2 = shiftReportResponseSchema.parse((await asSession("anna", "POST", `/api/v1/shift-reports/${shift2}/submit`)).json());
    expect(handed2.board?.phase).toBe("checking");
    expect((await candidateRow(handed2.board!.candidate!.id)).expectedReviewerPersonId).toBe(unassigned.personId);
  });

  it("picks alphabetically first reviewer by people.code with a warning when multiple cover all pages, and refuses others in the tx", async (context) => {
    if (!testDb) return context.skip();
    await revokeAllReviewerKeys();

    // Insert zeta-rev FIRST (smaller person_id), then beta-rev (larger person_id), both covering [mia-1, nova-1].
    const tokZeta = `${AGENT_KEY_TOKEN_PREFIX}er-zeta-key`;
    const tokBeta = `${AGENT_KEY_TOKEN_PREFIX}er-beta-key`;
    const zeta = await insertReviewerAgentKey(testDb.db, {
      name: "er-zeta", token: tokZeta, pageIds: [pageMia, pageNova], createdBy: users.boss!, agentCode: "zeta-rev",
    });
    const beta = await insertReviewerAgentKey(testDb.db, {
      name: "er-beta", token: tokBeta, pageIds: [pageMia, pageNova], createdBy: users.boss!, agentCode: "beta-rev",
    });
    expect(zeta.personId).toBeLessThan(beta.personId);

    // Also add an unlinked review key with full page grant: must not match and must be refused on POST.
    const tokUnlinked = `${AGENT_KEY_TOKEN_PREFIX}er-unlinked-key`;
    await insertAgentKey(testDb.db, {
      name: "er-unlinked",
      keyPrefix: tokUnlinked.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(tokUnlinked),
      capabilities: ["review:shift_reports"] as never,
      pageIds: [pageMia, pageNova],
      expiresAt: new Date(Date.now() + 30 * DAY_MS),
      createdBy: users.boss!,
    });

    const warnSpy = vi.spyOn(app.logger, "warn");
    const shift = await insertShift(["mia-1", "nova-1"], 15, 13);
    const handed = shiftReportResponseSchema.parse((await asSession("anna", "POST", `/api/v1/shift-reports/${shift}/submit`)).json());
    const candId = handed.board!.candidate!.id;

    // Picked beta-rev (alphabetically before zeta-rev despite larger person_id) and logged a warning.
    expect((await candidateRow(candId)).expectedReviewerPersonId).toBe(beta.personId);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ shiftId: shift, picked: "beta-rev", reviewers: ["beta-rev", "zeta-rev"] }),
      expect.stringContaining("multiple active reviewers"),
    );
    warnSpy.mockRestore();

    // Queue: beta-rev sees it; zeta-rev and unlinked key do NOT.
    expect(agentShiftReportChecksResponseSchema.parse((await asBearer(tokBeta, "GET", "/api/v1/agent/shift-reports/checks")).json()).checks.map((one) => one.candidateId)).toContain(candId);
    expect(agentShiftReportChecksResponseSchema.parse((await asBearer(tokZeta, "GET", "/api/v1/agent/shift-reports/checks")).json()).checks.map((one) => one.candidateId)).not.toContain(candId);
    expect(agentShiftReportChecksResponseSchema.parse((await asBearer(tokUnlinked, "GET", "/api/v1/agent/shift-reports/checks")).json()).checks).toEqual([]);

    // POST answer by wrong reviewer (zeta-rev) and by unlinked key: refused 403 inside tx, zero DB writes.
    for (const wrong of [tokZeta, tokUnlinked]) {
      const refused = await asBearer(wrong, "POST", `/api/v1/agent/shift-reports/checks/${candId}`, { proposals: [] });
      expect(refused.statusCode, refused.body).toBe(403);
      expect((await candidateRow(candId)).gengarAnsweredAt).toBeNull();
    }

    // If beta-rev's key is unlinked before posting, POST is also refused 403 inside the tx.
    await deletePersonAgentKey(testDb.db, { personId: beta.personId, agentKeyId: beta.agentKeyId });
    const unlinkedNow = await asBearer(tokBeta, "POST", `/api/v1/agent/shift-reports/checks/${candId}`, { proposals: [] });
    expect(unlinkedNow.statusCode, unlinkedNow.body).toBe(403);
    expect((await candidateRow(candId)).gengarAnsweredAt).toBeNull();
  });

  it("filters the check queue by reviewer identity BEFORE applying limit", async (context) => {
    if (!testDb) return context.skip();
    await revokeAllReviewerKeys();

    // Two disjoint reviewers: mia-rev owns mia-1, nova-rev owns nova-1.
    const tokMia = `${AGENT_KEY_TOKEN_PREFIX}er-queue-mia`;
    const tokNova = `${AGENT_KEY_TOKEN_PREFIX}er-queue-nova`;
    const miaRev = await insertReviewerAgentKey(testDb.db, {
      name: "er-queue-mia", token: tokMia, pageIds: [pageMia], createdBy: users.boss!, agentCode: "mia-rev",
    });
    const novaRev = await insertReviewerAgentKey(testDb.db, {
      name: "er-queue-nova", token: tokNova, pageIds: [pageNova], createdBy: users.boss!, agentCode: "nova-rev",
    });

    const base = Date.now() - 10 * 60_000;
    // 3 OLDER candidates for mia-rev.
    const miaCands: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const shift = await insertShift(["mia-1"], 12 - i * 0.5, 11.6 - i * 0.5);
      const handed = await handInShiftReport(app, annaActor(), { shiftId: shift }, new Date(base + i * 1_000));
      const cid = handed.board!.candidate!.id;
      expect((await candidateRow(cid)).expectedReviewerPersonId).toBe(miaRev.personId);
      miaCands.push(cid);
    }
    // 2 NEWER candidates for nova-rev.
    const novaCands: number[] = [];
    for (let i = 0; i < 2; i += 1) {
      const shift = await insertShift(["nova-1"], 9 - i * 0.5, 8.6 - i * 0.5);
      const handed = await handInShiftReport(app, annaActor(), { shiftId: shift }, new Date(base + (10 + i) * 1_000));
      const cid = handed.board!.candidate!.id;
      expect((await candidateRow(cid)).expectedReviewerPersonId).toBe(novaRev.personId);
      novaCands.push(cid);
    }

    // With limit=1, nova-rev MUST get its own oldest candidate (not starved by mia-rev's 3 older ones!).
    const one = agentShiftReportChecksResponseSchema.parse((await asBearer(tokNova, "GET", "/api/v1/agent/shift-reports/checks?limit=1")).json());
    expect(one.checks.map((check) => check.candidateId)).toEqual([novaCands[0]]);

    // With limit=2, nova-rev gets both of its candidates in oldest-first order.
    const two = agentShiftReportChecksResponseSchema.parse((await asBearer(tokNova, "GET", "/api/v1/agent/shift-reports/checks?limit=2")).json());
    expect(two.checks.map((check) => check.candidateId)).toEqual(novaCands);
  });

  it("inherits expected_reviewer_person_id in remakeAt and keeps it immutable via trigger", async (context) => {
    if (!testDb) return context.skip();
    await revokeAllReviewerKeys();

    const tokRemake = `${AGENT_KEY_TOKEN_PREFIX}er-remake-key`;
    const rev = await insertReviewerAgentKey(testDb.db, {
      name: "er-remake", token: tokRemake, pageIds: [pageMia], createdBy: users.boss!, agentCode: "remake-rev",
    });

    // Make mia-1 askable by Hub's check (`transactions.rescan` sync_work row) and record anna's activity/messages on mia-1.
    const shift = await insertShift(["mia-1"], 5, 3);
    await q(
      `insert into chatter_activity_minutes (user_id, page_id, minute, input)
       select $1, $2, minute, true
       from generate_series(date_trunc('minute', now() - interval '5 hours'), date_trunc('minute', now() - interval '3 hours'), interval '1 minute') minute
       on conflict do nothing`,
      [users.anna, pageMia],
    );
    await q(
      `insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at, composed_with)
       select 'fansly', $1, (9900000440 + n)::text, '7700000440', $2, 'fansly-extension', false, false, now() - interval '5 hours' + interval '3 minutes' * n, 'hand'
       from generate_series(0, 39) n
       on conflict do nothing`,
      [pageMia, users.anna],
    );
    const handedAt = new Date();
    await q(
      `insert into sync_work (page_id, resource, kind, class, state, proof)
       values ($1, 'transactions.rescan', 'poll', 'planned', 'open', '{}'::jsonb)`,
      [pageMia],
    );
    const handed = await handInShiftReport(app, annaActor(), { shiftId: shift }, handedAt);
    const firstCandId = handed.board!.candidate!.id;
    expect((await candidateRow(firstCandId)).expectedReviewerPersonId).toBe(rev.personId);

    // Immutability trigger refuses changing expected_reviewer_person_id.
    await expect(
      q("update shift_handin_candidates set expected_reviewer_person_id = null where id = $1", [firstCandId]),
    ).rejects.toThrow(/immutable/);

    // Revoke the reviewer's key BEFORE Hub's re-check triggers remakeAt.
    await revokeAgentKey(testDb.db, { id: rev.agentKeyId });

    // A sale arrives inside the shift's window and the wallet rescan proves coverage after cutoffAt -> triggers remakeAt!
    const saleTime = new Date(Date.now() - 4 * HOUR_MS);
    await insertSaleForShift(shift, pageMia, saleTime, 15_000);
    const walkStartedAt = new Date(handedAt.getTime() + 10_000).toISOString();
    await q(
      `update sync_work set proof = $2::jsonb where page_id = $1 and resource = 'transactions.rescan'`,
      [pageMia, JSON.stringify({ walkStartedAt })],
    );

    const handinId = Number((await q("select id from shift_handins where shift_id = $1", [shift])).rows[0].id);
    const catalog = await pageCatalog(app.db);
    expect(await checkReportNow(app, { handinId, shiftId: shift, catalog }, new Date(handedAt.getTime() + 20_000))).toBe(true);

    const firstAfter = await candidateRow(firstCandId);
    expect(firstAfter.supersededBy).not.toBeNull();
    const remade = await candidateRow(firstAfter.supersededBy!);
    // Remade candidate inherited the snapshot from Candidate #1 even though the key was revoked in between!
    expect(remade.expectedReviewerPersonId).toBe(rev.personId);
  });
});
