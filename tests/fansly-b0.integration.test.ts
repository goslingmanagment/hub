import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireFanslyWsOwnership, applyFanslyWsLiveReceipt, beginBrowserWsConnection, beginFanslyWsConnection, captureFanslyWsFrame,
  createFanslyPage, ensureSyncPage, finishBrowserWsConnection, finishFanslyWsConnection, guardFanslyWsConnection,
  isFanslyWsGenerationBlocked, lastFanslyWsConnectionEnd, readOpenVerifiedWsConnection, readSyncPageWsStatus,
  replayFanslyWsDecode, settleFanslyWsDecode, upsertFans, upsertFanPages, verifyBrowserWsConnection, type Database,
} from "@agency_hub_core/db";
import { decodeFanslyWsCapture, fanslyWsCaptureContainsSubject, FANSLY_WS_CAPTURE_KIND } from "@agency_hub_core/shared";
import { readFanslyPageGeneration, readProbeGeneration } from "../apps/runtime/src/services/egress/fansly-probe-context.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import { planErasure, executeErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { resetIntegrationDatabase, seedFanslyPage, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase;
let lakeDir: string;
const owners: NonNullable<Awaited<ReturnType<typeof acquireFanslyWsOwnership>>>[] = [];
beforeAll(async () => { testDb = await startTestDatabase(); lakeDir = await mkdtemp(join(tmpdir(), "b0-erasure-")); }, 120_000);
afterAll(async () => { await testDb?.stop(); if (lakeDir) await rm(lakeDir, { recursive: true }); });
beforeEach(async () => {
  await resetIntegrationDatabase(testDb.pool);
  await rm(lakeDir, { recursive: true }); await mkdir(lakeDir);
});
afterEach(async () => { for (const owner of owners.splice(0)) await owner.close(); });

async function fixture() {
  const app = createTestAppContext(testDb, { databaseUrl: testDb.connectionString });
  app.config.lakeDir = lakeDir;
  const { page } = await seedFanslyPage(app.db, app.config.encryptionKey);
  if (!page) throw new Error("seed failed");
  await saveProxy(app, page.id, { url: "http://proxy.example.test:8080", username: "test", password: "test" });
  const generation = await readProbeGeneration(app.db, page.label);
  const lost = vi.fn();
  const owner = await acquireFanslyWsOwnership(testDb.connectionString, page.id, lost);
  if (!owner) throw new Error("owner unavailable");
  owners.push(owner);
  const id = randomUUID();
  await beginFanslyWsConnection(owner.db, { id, pageId: page.id, generation });
  const validate = async (tx: Database) => {
    if (!owner.alive || await readFanslyPageGeneration(tx, page.label) !== generation) throw new Error("generation_fenced");
  };
  const frame = (fan = "123") => JSON.stringify({ t: 10001, d: JSON.stringify([
    { t: 10000, d: JSON.stringify({ serviceId: 5, event: JSON.stringify({ type: 1, data: { accountId: fan } }) }) },
    { t: 99999, d: JSON.stringify({ accountId: fan, future: true }) },
  ]) });
  const capture = (ordinal = 1, raw = frame(), receivedAt = new Date()) => captureFanslyWsFrame(owner.db, {
    connectionId: id, pageId: page.id, generation, accountRef: "999", ordinal, frame: raw, receivedAt, validate,
  });
  return { app, page, generation, owner, lost, id, frame, capture };
}

describe("B0 PostgreSQL ownership and journal", () => {
  it("one owner per page, death notifies, the next owner abandons the dead row and leaves a gap", async () => {
    const f = await fixture();
    const other = await createFanslyPage(f.app.db, { modelId: f.page.modelId, label: "b0-bystander" });
    if (!other) throw new Error("seed failed");
    const bystander = randomUUID();
    await testDb.pool.query("insert into fansly_ws_connections(id,page_id,generation) values ($1,$2,$3)",
      [bystander, other.id, f.generation]);
    expect(await acquireFanslyWsOwnership(testDb.connectionString, f.page.id, vi.fn())).toBeNull();
    await f.capture();
    const pid = (await testDb.pool.query("select pid from pg_stat_activity where application_name='fansly-b0' and datname=current_database()" )).rows[0].pid;
    await testDb.pool.query("select pg_terminate_backend($1)", [pid]);
    await vi.waitFor(() => expect(f.lost).toHaveBeenCalledOnce());
    await expect(f.capture(2)).rejects.toThrow();
    const next = await acquireFanslyWsOwnership(testDb.connectionString, f.page.id, vi.fn());
    expect(next).not.toBeNull(); owners.push(next!);
    await beginFanslyWsConnection(next!.db, { id: randomUUID(), pageId: f.page.id, generation: f.generation });
    const rows = (await testDb.pool.query(`select closed_at,stop_reason,last_guard_at,gap_state,gap_since,started_at,
      closed_at=greatest(last_guard_at,last_capture_at) as closed_at_last_proof
      from fansly_ws_connections where page_id=$1 order by started_at`, [f.page.id])).rows;
    expect(rows).toHaveLength(2);
    // The dead owner's row closes at its last proof of liveness, not now; the
    // new attempt's gap still starts at that row's last guard.
    expect(rows[0]).toMatchObject({ stop_reason: "abandoned", closed_at_last_proof: true });
    expect(rows[1]).toMatchObject({ closed_at: null, stop_reason: null, gap_state: "unknown" });
    expect(rows[1].gap_since).toEqual(rows[0].last_guard_at);
    expect(rows[1].gap_since.getTime()).toBeLessThan(rows[1].started_at.getTime());
    expect((await testDb.pool.query("select closed_at,stop_reason from fansly_ws_connections where id=$1", [bystander])).rows)
      .toEqual([{ closed_at: null, stop_reason: null }]);
  });

  it("raw + pending receipt commit atomically, replay recovers unknown child debt, connection ordinal deduplicates", async () => {
    const f = await fixture();
    const id = await f.capture(); expect(await f.capture()).toBe(id);
    const raw = (await testDb.pool.query("select payload from observations where id=$1", [id])).rows[0].payload;
    expect(raw.frame).toBe(f.frame());
    expect((await testDb.pool.query("select state,live_state from fansly_ws_decode_receipts")).rows)
      .toEqual([{ state: "pending", live_state: "pending" }]);
    // The legacy metadata replay leaves overlay-era receipts to the live apply,
    // which settles the metadata receipt in its own transaction.
    expect(await replayFanslyWsDecode(f.owner.db, f.page.id)).toBe(0);
    expect(await applyFanslyWsLiveReceipt(testDb.db, { observationId: id })).toMatchObject({ status: "debt" });
    const receipt = (await testDb.pool.query("select state,nodes,live_state from fansly_ws_decode_receipts")).rows[0];
    // The nodes decide the state and are not stored: the journaled frame
    // rebuilds them (storage audit 2026-10-16).
    expect(receipt.state).toBe("debt"); expect(receipt.nodes).toBeNull();
    expect(decodeFanslyWsCapture(raw.frame)[2]).toMatchObject({ path: [1], state: "unknown" });
    // A service-5 type-1 event without a message is not a message: debt, and
    // no business event, overlay row or HTTP.
    expect(receipt.live_state).toBe("debt");
    expect((await testDb.pool.query("select count(*)::int as n from domain_events")).rows[0].n).toBe(0);
    expect((await testDb.pool.query("select count(*)::int as n from dm_live_messages")).rows[0].n).toBe(0);
  });

  it("a receipt insert failure rolls back both raw and its dedup key", async () => {
    const f = await fixture();
    await testDb.pool.query(`create function b0_fail_receipt() returns trigger language plpgsql as $$
      begin raise exception 'injected'; end $$;
      create trigger b0_fail_receipt before insert on fansly_ws_decode_receipts for each row execute function b0_fail_receipt()`);
    try {
      await expect(f.capture()).rejects.toThrow();
      expect((await testDb.pool.query("select count(*)::int n from observations")).rows[0].n).toBe(0);
      expect((await testDb.pool.query("select count(*)::int n from observation_keys")).rows[0].n).toBe(0);
    } finally { await testDb.pool.query("drop trigger b0_fail_receipt on fansly_ws_decode_receipts; drop function b0_fail_receipt()"); }
    await f.capture();
  });

  it.each(["credential", "proxy", "page"])("fences capture after %s generation changes", async (kind) => {
    const f = await fixture(); await f.capture();
    if (kind === "credential") await testDb.pool.query("update page_credentials set encrypted_session='changed' where platform_account_id=$1", [f.page.id]);
    if (kind === "proxy") await testDb.pool.query("update egress_endpoints set url='http://new.example.test:8080' where platform_account_id=$1", [f.page.id]);
    if (kind === "page") await testDb.pool.query("update pages set external_page_id='changed' where id=$1", [f.page.id]);
    await expect(f.capture(2)).rejects.toThrow("generation_fenced");
    expect((await testDb.pool.query("select count(*)::int n from observations")).rows[0].n).toBe(1);
  });

  it("persists auth refusal across restarts without blocking a new generation", async () => {
    const f = await fixture();
    await finishFanslyWsConnection(f.owner.db, f.id, "auth_refused");
    await f.owner.close();
    expect(await isFanslyWsGenerationBlocked(testDb.db, f.page.id, f.generation)).toBe(true);
    expect(await isFanslyWsGenerationBlocked(testDb.db, f.page.id, "a".repeat(64))).toBe(false);
  });

  it("reports fan-scoped raw as shared residual, preserves bystanders, and fences old queued frames", async () => {
    const f = await fixture();
    const fans = await upsertFans(testDb.db, ["123", "456"].map((platformUserId) => ({ platform: "fansly" as const, platformUserId })));
    await upsertFanPages(testDb.db, fans.map((fan) => ({ fanId: fan.id, platformAccountId: f.page.id })));
    const before = new Date();
    const id = await f.capture(1, f.frame("123"), before);
    await f.capture(2, f.frame("456"));
    await settleFanslyWsDecode(f.owner.db, id, decodeFanslyWsCapture(f.frame()));
    const ownerId = Number((await testDb.pool.query("insert into users(username,role) values ('b0-owner','owner') returning id")).rows[0].id);
    const scope = { scopeType: "fan", platform: "fansly", fanRef: "123" } as const;
    const plan = await planErasure(f.app, scope);
    expect(plan.targets.find((t) => t.target === "fansly_ws_decode_receipts")?.rows).toBe(0);
    expect(plan.sharedObservations).toBe(1);
    await executeErasure(f.app, scope, { initiatedBy: ownerId });
    expect((await testDb.pool.query("select payload from observations where source='fansly_ws'")).rows.map((r) => r.payload.frame)).toEqual([f.frame("123"), f.frame("456")]);
    expect((await testDb.pool.query("select count(*)::int n from fansly_ws_decode_receipts")).rows[0].n).toBe(2);
    await expect(f.capture(3, f.frame(), before)).rejects.toThrow("fansly_ws_material_erased");
    await f.capture(4, f.frame(), new Date());
  });

  it("SQL and lake codec agree for nested Unicode JSON strings", async () => {
    const frame = '{"t":9999,"d":"{\\"accountId\\":\\"\\\\u0031\\\\u0032\\\\u0033\\"}"}';
    for (const subject of ["123", "456"]) {
      const sqlMatch = (await testDb.pool.query("select fansly_ws_json_contains(to_jsonb($1::text),$2) as matched", [frame, subject])).rows[0].matched;
      expect(sqlMatch).toBe(fanslyWsCaptureContainsSubject({ codec: FANSLY_WS_CAPTURE_KIND, frame }, subject));
    }
  });

  it("recognizes group-only debt, preserves a mixed-fan batch, and page erasure reaches all B0 stores", async () => {
    const f = await fixture();
    const [fan] = await upsertFans(testDb.db, [{ platform: "fansly", platformUserId: "123" }]);
    await upsertFanPages(testDb.db, [{ fanId: fan!.id, platformAccountId: f.page.id }]);
    await testDb.pool.query(`insert into page_dm_threads(platform_account_id,fan_id,platform_conversation_id)
      values($1,$2,'group-a')`, [f.page.id, fan!.id]);
    const group = JSON.stringify({ t: 99999, d: JSON.stringify({ groupId: "group-a" }) });
    const before = new Date();
    await f.capture(1, group, before);
    const mixed = JSON.stringify({ t: 10001, d: [JSON.parse(f.frame("123")), JSON.parse(f.frame("456"))] });
    await f.capture(2, mixed);
    const scope = { scopeType: "fan", platform: "fansly", fanRef: "123" } as const;
    const plan = await planErasure(f.app, scope);
    expect(plan.resolvedFanGroupIds).toContain("group-a"); expect(plan.sharedObservations).toBe(2);
    const ownerId = Number((await testDb.pool.query("insert into users(username,role) values ('b0-owner','owner') returning id")).rows[0].id);
    await executeErasure(f.app, scope, { initiatedBy: ownerId });
    await expect(f.capture(3, group, before)).rejects.toThrow("fansly_ws_material_erased");
    const retained = (await testDb.pool.query("select payload->>'frame' as frame from observations where source='fansly_ws'")).rows;
    expect(retained.map((r) => r.frame)).toEqual([group, mixed]);
    await executeErasure(f.app, { scopeType: "page", pageLabel: f.page.label }, { initiatedBy: ownerId });
    for (const table of ["fansly_ws_connections", "fansly_ws_decode_receipts"]) {
      expect((await testDb.pool.query(`select count(*)::int n from ${table}`)).rows[0].n).toBe(0);
    }
    expect((await testDb.pool.query("select count(*)::int n from observations where source='fansly_ws'")).rows[0].n).toBe(0);
  });
});

// The owner's login of a page still on Node (Project Browser; the 2026-10-22
// audit, P2-4): the login browser's site socket opens its rows beside the
// engine's own socket. Its session is not the page's yet, so it must not end
// the Node socket's capture; the switch to the browser does.
describe("a login browser's socket beside the engine's own", () => {
  /** The browser's credentials generation: not the one Node's socket runs. */
  const BROWSER_GENERATION = "b".repeat(64);
  /** An operator's instant ahead of the database's clock: taken as that
   *  clock's now (a row never opens or closes later than it). */
  const now = () => new Date(Date.now() + 60_000);

  /** A site connection of the page's browser opened now: its row id and the
   *  operator's connection id. */
  async function openBrowser(pageId: number): Promise<{ id: string; browserConnectionId: string }> {
    const opened = { id: randomUUID(), browserConnectionId: randomUUID() };
    expect(await beginBrowserWsConnection(testDb.db, { ...opened, pageId, generation: BROWSER_GENERATION, startedAt: now() })).toBe(true);
    return opened;
  }

  /** Whether `expression` over two rows (`a`, `b`, by id) holds — instants
   *  compared at the database's own precision. */
  async function holds(a: string, b: string, expression: string): Promise<boolean> {
    const result = await testDb.pool.query<{ holds: boolean }>(`select ${expression} as holds
      from fansly_ws_connections a, fansly_ws_connections b where a.id = $1::uuid and b.id = $2::uuid`, [a, b]);
    return result.rows[0]?.holds === true;
  }

  async function connections(pageId: number) {
    return (await testDb.pool.query<{
      id: string; origin: string; browserConnectionId: string | null; startedAt: Date; verifiedAt: Date | null;
      lastGuardAt: Date; closedAt: Date | null; stopReason: string | null; gapSince: Date | null; closedAtLastProof: boolean | null;
    }>(`select id::text as id, origin, browser_connection_id::text as "browserConnectionId", started_at as "startedAt",
        verified_at as "verifiedAt", last_guard_at as "lastGuardAt", closed_at as "closedAt", stop_reason as "stopReason",
        gap_since as "gapSince", closed_at = greatest(last_guard_at, last_capture_at) as "closedAtLastProof"
      from fansly_ws_connections where page_id = $1 order by started_at, id`, [pageId])).rows;
  }

  it("on a page still on Node: the Node socket stays open and capturing, a stale browser row is still abandoned, and the page's socket is the Node one", async () => {
    const f = await fixture();
    await ensureSyncPage(f.app.db, { pageId: f.page.id });
    await guardFanslyWsConnection(f.owner.db, f.id, true);
    const stale = await openBrowser(f.page.id);
    const login = await openBrowser(f.page.id);
    expect(await verifyBrowserWsConnection(testDb.db, { pageId: f.page.id, browserConnectionId: login.browserConnectionId, at: now() })).toBe(true);
    const [node, abandoned, open] = await connections(f.page.id);
    expect(node).toMatchObject({ id: f.id, origin: "node", closedAt: null, stopReason: null });
    expect(abandoned).toMatchObject({ id: stale.id, origin: "browser", stopReason: "abandoned", closedAtLastProof: true });
    expect(open).toMatchObject({ id: login.id, origin: "browser", closedAt: null });
    // Not fenced: the Node socket's frames go on into the journal.
    await f.capture(2);
    expect((await testDb.pool.query("select count(*)::int as n from observations where source='fansly_ws'")).rows[0].n).toBe(1);
    // The status and a history request's anchor read the Node socket, not the
    // newer login browser's beside it.
    expect(await readSyncPageWsStatus(testDb.db, { pageId: f.page.id, decodeWindowMs: 60_000 }))
      .toMatchObject({ connected: true, since: node!.startedAt });
    expect(await readOpenVerifiedWsConnection(testDb.db, f.page.id)).toEqual({ verifiedAt: node!.verifiedAt });
  });

  it("the page's next connection's gap starts where the Node socket ended, though the login's browser row opened after it", async () => {
    const f = await fixture();
    await ensureSyncPage(f.app.db, { pageId: f.page.id });
    const login = await openBrowser(f.page.id);
    expect(await finishBrowserWsConnection(testDb.db, { pageId: f.page.id, browserConnectionId: login.browserConnectionId, closedAt: now(), reason: "site_closed" })).toBe(true);
    await finishFanslyWsConnection(f.owner.db, f.id, "closed");
    // The login's browser row is the newer one, and it ended first.
    expect(await holds(login.id, f.id, "a.started_at > b.started_at and a.closed_at < b.closed_at")).toBe(true);
    const node = (await connections(f.page.id)).find((row) => row.id === f.id)!;
    expect(await lastFanslyWsConnectionEnd(testDb.db, f.page.id)).toEqual(node.closedAt);
    const next = randomUUID();
    await beginFanslyWsConnection(f.owner.db, { id: next, pageId: f.page.id, generation: f.generation });
    expect(await holds(next, f.id, "a.gap_since = b.closed_at and a.closed_at is null")).toBe(true);
  });

  it("once the page is on its browser: a browser row closes the Node row still open at its last proof — its socket is fenced — and its gap starts there", async () => {
    const f = await fixture();
    await ensureSyncPage(f.app.db, { pageId: f.page.id });
    const login = await openBrowser(f.page.id);
    expect(await finishBrowserWsConnection(testDb.db, { pageId: f.page.id, browserConnectionId: login.browserConnectionId, closedAt: now(), reason: "site_closed" })).toBe(true);
    // The Node socket proves itself after the login's browser closed; its
    // slot could not close its row at the switch.
    await guardFanslyWsConnection(f.owner.db, f.id, true);
    await testDb.pool.query("update sync_pages set transport = 'browser' where page_id = $1", [f.page.id]);
    const site = await openBrowser(f.page.id);
    expect((await connections(f.page.id)).find((row) => row.id === f.id))
      .toMatchObject({ stopReason: "abandoned", closedAtLastProof: true });
    expect(await holds(f.id, login.id, "a.closed_at = a.last_guard_at and a.closed_at > b.closed_at")).toBe(true);
    expect(await holds(site.id, f.id, "a.gap_since = b.closed_at and a.closed_at is null")).toBe(true);
    await expect(f.capture(2)).rejects.toThrow("fansly_ws_connection_fenced");
  });
});
