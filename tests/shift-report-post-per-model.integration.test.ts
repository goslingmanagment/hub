import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { shiftReportResponseSchema } from "@agency_hub_core/contracts";
import { assignUserToPage, createFanslyPage, createModel } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { refreshSaleHomes } from "../apps/runtime/src/services/sale-homes.ts";
import { syncCheckMatters } from "../apps/runtime/src/services/shift-handin-check.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";
import { handInAndConfirm, editingSession } from "./helpers/shift-report-hand-in.ts";

// «Скопировать пост» on a shift of two models (final review of the «Отчёт» board, the third reader's №2): «Отчётность»
// takes one post per model — the ledger's post reader reads the first model of a text and drops the rest — so the board
// copies each model's post by its own button and remembers each copy; «Пост изменился» is said of the model whose pages
// changed. Money: required (a joined text loses the second model's money).
//
// anna works ari-1 and lilly-1 (two models) from 6 to 1 hours ago.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const HOUR_MS = 3_600_000;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};
const pages: Record<string, number> = {};
let anna = 0;
let shift = 0;
let refs = 0;

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
const rawSession = (who: string, method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });
const asSession = editingSession(rawSession);

async function sale(label: string, net: number, minutesAgo: number): Promise<number> {
  refs += 1;
  const inserted = await q(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
       gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency)
     values ($1, $2, 'tip', 'tip', 'posted', 'ok', $3, $3, $4, 1000, now() - make_interval(mins => $5::int), 'fansly:rest', 'USD') returning id`,
    [pages[label], `tx-post-model-${refs}`, net + 1_000, net, minutesAgo],
  );
  const now = new Date();
  await refreshSaleHomes(app.db, { from: new Date(now.getTime() - 48 * HOUR_MS), to: now, now });
  return Number(inserted.rows[0].id);
}

async function read() {
  const got = await rawSession("anna", "GET", `/api/v1/shift-reports/${shift}`);
  expect(got.statusCode, got.body).toBe(200);
  return shiftReportResponseSchema.parse(got.json());
}

describe("«Скопировать пост» on a shift of two models", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
    await createUserAccount(app, { username: "anna", role: "chatter" }, { source: "cli" });
    anna = await fixtureUserId(app, "anna");
    await setUserPassword(app, { userId: anna, password: "anna-password-for-tests" }, { source: "cli" });
    for (const [slug, name, label] of [["ari", "Ари", "ari-1"], ["lilly", "Лилли", "lilly-1"]] as const) {
      const model = await createModel(app.db, { slug, name });
      pages[label] = (await createFanslyPage(app.db, { modelId: model!.id, label }))!.id;
      await assignUserToPage(app.db, anna, pages[label]!);
    }
    server = await buildApiServer(app);
    await server.ready();
    for (const user of ["boss", "anna"]) {
      const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: user, password: `${user}-password-for-tests` } });
      expect(login.statusCode, login.body).toBe(200);
      const header = login.headers["set-cookie"];
      cookies[user] = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
    }
    const created = await asSession("boss", "POST", "/api/v1/admin/people", {
      code: "anna", displayName: "anna", role: "chatter", state: "working", rights: ["submits_shift"], logins: { add: [anna] },
    });
    expect(created.statusCode, created.body).toBe(200);
    await q("update person_rights set granted_at = now() - interval '30 days'");
    // anna's work on both pages: every minute from 6 to 1 hours ago, a message every three minutes on each.
    let base = 9_600_000_000;
    for (const label of ["ari-1", "lilly-1"]) {
      await q(
        `insert into chatter_activity_minutes (user_id, page_id, minute, input)
         select $1, $2, minute, true from generate_series(date_trunc('minute', now() - interval '6 hours'), date_trunc('minute', now() - interval '1 hour'), interval '1 minute') minute`,
        [anna, pages[label]],
      );
      await q(
        `insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at, composed_with)
         select 'fansly', $1, ($3::bigint + n)::text, '7700000088', $2, 'fansly-extension', false, false, now() - interval '6 hours' + interval '3 minutes' * n, 'hand'
         from generate_series(0, 99) n`,
        [pages[label], anna, base],
      );
      base += 1_000;
    }
    const startedAt = new Date(Date.now() - 6.5 * HOUR_MS);
    shift = Number((await q(
      `insert into shifts (user_id, state, started_at, ended_at, worked_minutes, messages, report_date, pages)
       values ($1, 'closed', $2::timestamptz, now() - interval '30 minutes', 300, 200, $3::date, $4::jsonb) returning id`,
      [anna, startedAt.toISOString(), new Date(startedAt.getTime() + 3 * HOUR_MS).toISOString().slice(0, 10), JSON.stringify([
        { pageLabel: "ari-1", activeMinutes: 300, messages: 100, salesFrom: startedAt.toISOString() },
        { pageLabel: "lilly-1", activeMinutes: 300, messages: 100, salesFrom: startedAt.toISOString() },
      ])],
    )).rows[0].id);
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("gives one post per model, copies and marks each by itself, and says «Пост изменился» of that model alone", async (context) => {
    if (!testDb) return context.skip();
    await sale("ari-1", 120_000, 5 * 60);
    await sale("lilly-1", 80_000, 4 * 60);
    await handInAndConfirm(asSession, "anna", shift);
    const counted = await read();
    // Two texts, each of its own model only: never one text with both.
    expect(counted.posts.map((post) => post.modelSlug).sort()).toEqual(["ari", "lilly"]);
    const ari = counted.posts.find((post) => post.modelSlug === "ari")!;
    const lilly = counted.posts.find((post) => post.modelSlug === "lilly")!;
    expect(ari.text).toContain("120");
    expect(ari.text).not.toContain("lilly-1");
    expect(lilly.text).toContain("80");
    expect(lilly.text).not.toContain("ari-1");
    expect(counted.board?.post?.models.map((model) => [model.modelSlug, model.copiedAt])).toEqual(expect.arrayContaining([["ari", null], ["lilly", null]]));

    // «Скопировать пост: Ари»: that model's post is copied, the other's is not.
    const copied = await rawSession("anna", "POST", `/api/v1/shift-reports/${shift}/post-copied?model=ari`);
    expect(copied.statusCode, copied.body).toBe(200);
    const after = shiftReportResponseSchema.parse(copied.json());
    expect(after.board?.post?.models.find((model) => model.modelSlug === "ari")?.copiedAt).not.toBeNull();
    expect(after.board?.post?.models.find((model) => model.modelSlug === "lilly")?.copiedAt).toBeNull();
    expect((await rawSession("anna", "POST", `/api/v1/shift-reports/${shift}/post-copied?model=nobody`)).statusCode).toBe(400);

    // A later version that changes only Лилли's sum: Ари's copy stands, Лилли's post was never copied — no «Пост изменился».
    await sale("lilly-1", 20_000, 3 * 60);
    await handInAndConfirm(asSession, "anna", shift);
    await syncCheckMatters(app, new Date());
    const changed = await read();
    expect(changed.board?.post?.models.find((model) => model.modelSlug === "ari")).toMatchObject({ changedSinceCopy: false });
    expect((await q("select count(*)::int as n from matters where kind = 'shift.report.post_changed' and state = 'open'")).rows[0].n).toBe(0);

    // Лилли copied, then Ари's sum changes: «Пост (Ари) изменился», Лилли's stands.
    expect((await rawSession("anna", "POST", `/api/v1/shift-reports/${shift}/post-copied?model=lilly`)).statusCode).toBe(200);
    await sale("ari-1", 30_000, 2 * 60);
    await handInAndConfirm(asSession, "anna", shift);
    await syncCheckMatters(app, new Date());
    const third = await read();
    expect(third.board?.post?.models.find((model) => model.modelSlug === "ari")).toMatchObject({ changedSinceCopy: true });
    expect(third.board?.post?.models.find((model) => model.modelSlug === "lilly")).toMatchObject({ changedSinceCopy: false });
    expect((await q("select reason_key from matters where kind = 'shift.report.post_changed' and state = 'open'")).rows.map((row) => String(row.reason_key)))
      .toEqual([expect.stringMatching(/:ari$/)]);
  });
});
