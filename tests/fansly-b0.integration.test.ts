import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireFanslyWsOwnership, beginFanslyWsConnection, captureFanslyWsFrame,
  finishFanslyWsConnection, isFanslyWsGenerationBlocked, replayFanslyWsDecode,
  settleFanslyWsDecode, upsertFans, upsertFanPages, type Database,
} from "@agency_hub_core/db";
import { decodeFanslyWsCapture, fanslyWsCaptureContainsSubject, FANSLY_WS_CAPTURE_KIND } from "@agency_hub_core/shared";
import { readFanslyPageGeneration, readProbeGeneration } from "../apps/runtime/src/services/egress/fansly-probe-context.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import { planErasure, executeErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { resetIntegrationDatabase, seedFanslyPage, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { TIERED_TABLES, ndjsonToParquet, readParquetIds } from "../apps/runtime/src/services/tiering/index.ts";
import * as socketTransport from "../apps/runtime/src/services/egress/fansly-receiver-socket.ts";
import { startFanslyWsWorker } from "../apps/runtime/src/services/fansly-ws/worker.ts";

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
  it("reconnects after a missing pong, preserves the gap and captures with the same generation", async () => {
    const f = await fixture();
    await finishFanslyWsConnection(f.owner.db, f.id, "disabled");
    await f.owner.close();
    await testDb.pool.query("update pages set external_page_id='999' where id=$1", [f.page.id]);
    const generation = await readProbeGeneration(f.app.db, f.page.label);
    const stops: ReturnType<typeof vi.fn>[] = [];
    const open = vi.spyOn(socketTransport, "openFanslyReceiverSocket").mockImplementation(() => {
      const first = stops.length === 0;
      const stop = vi.fn(); stops.push(stop);
      const socket = Object.assign(new EventTarget(), { send: vi.fn((data: string) => {
        // The failed connection still delivers business traffic, as observed
        // in W0. Only its heartbeat response is absent. The next one answers.
        if (data === "p") socket.dispatchEvent(new MessageEvent("message", {
          data: first ? f.frame("456") : '{"t":2,"d":"{}"}',
        }));
      }) });
      queueMicrotask(() => {
        socket.dispatchEvent(new Event("open"));
        socket.dispatchEvent(new MessageEvent("message", { data: '{"t":1,"d":"{}"}' }));
        socket.dispatchEvent(new MessageEvent("message", { data: f.frame(first ? "123" : "789") }));
      });
      return { socket, stop } as unknown as ReturnType<typeof socketTransport.openFanslyReceiverSocket>;
    });
    f.app.config.fanslyWsCaptureEnabled = true;
    f.app.config.fanslyWsCapturePageAllowlist = f.page.label;
    const worker = startFanslyWsWorker(f.app);
    try {
      await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2), { timeout: 45_000 });
      await vi.waitFor(async () => expect((await testDb.pool.query(
        "select count(*)::int n from observations where source='fansly_ws'",
      )).rows[0].n).toBe(3));
      const rows = (await testDb.pool.query(`select id,generation,closed_at,stop_reason,gap_state,gap_since,started_at
        from fansly_ws_connections where id<>$1::uuid order by started_at`, [f.id])).rows;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ generation, stop_reason: "pong_timeout", gap_state: "unknown" });
      expect(rows[0].closed_at).toBeInstanceOf(Date);
      expect(rows[1]).toMatchObject({ generation, closed_at: null, stop_reason: null, gap_state: "unknown" });
      expect(rows[1].gap_since).toEqual(rows[0].closed_at);
      expect(rows[1].started_at.getTime()).toBeGreaterThan(rows[0].closed_at.getTime());
      expect(stops[0]).toHaveBeenCalledOnce();
      expect(stops[1]).not.toHaveBeenCalled();
      expect(await acquireFanslyWsOwnership(testDb.connectionString, f.page.id, vi.fn())).toBeNull();
      expect(await isFanslyWsGenerationBlocked(f.app.db, f.page.id, generation)).toBe(false);
      const raw = (await testDb.pool.query("select payload from observations where source='fansly_ws' order by id")).rows;
      expect(raw.map(row => row.payload.frame)).toEqual([f.frame("123"), f.frame("456"), f.frame("789")]);
    } finally { await worker.stop(); open.mockRestore(); }
    expect(stops[1]).toHaveBeenCalledOnce();
    expect((await testDb.pool.query(`select stop_reason from fansly_ws_connections
      where id<>$1::uuid order by started_at`, [f.id])).rows)
      .toEqual([{ stop_reason: "pong_timeout" }, { stop_reason: "disabled" }]);
  }, 60_000);

  it("the actual worker retains capture through replay failure and observes live off within 60 seconds", async () => {
    const f = await fixture(); await f.owner.close();
    await testDb.pool.query("update pages set external_page_id='999' where id=$1", [f.page.id]);
    await testDb.pool.query(`create function b0_fail_settle() returns trigger language plpgsql as $$
      begin raise exception 'injected'; end $$;
      create trigger b0_fail_settle before update on fansly_ws_decode_receipts for each row execute function b0_fail_settle()`);
    const stop = vi.fn();
    let activeSocket: EventTarget;
    const open = vi.spyOn(socketTransport, "openFanslyReceiverSocket").mockImplementation(() => {
      const socket = Object.assign(new EventTarget(), { send: vi.fn() });
      activeSocket = socket;
      queueMicrotask(() => {
        socket.dispatchEvent(new Event("open"));
        socket.dispatchEvent(new MessageEvent("message", { data: '{"t":1,"d":"{}"}' }));
        socket.dispatchEvent(new MessageEvent("message", { data: f.frame() }));
      });
      return { socket, stop } as unknown as ReturnType<typeof socketTransport.openFanslyReceiverSocket>;
    });
    f.app.config.fanslyWsCaptureEnabled = true;
    f.app.config.fanslyWsCapturePageAllowlist = f.page.label;
    const worker = startFanslyWsWorker(f.app);
    try {
      await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
      await vi.waitFor(async () => expect((await testDb.pool.query("select count(*)::int n from observations where source='fansly_ws'")).rows[0].n).toBe(1));
      await vi.waitFor(async () => expect((await testDb.pool.query("select count(*)::int n from fansly_ws_connections where verified_at is not null")).rows[0].n).toBe(1), { timeout: 8000 });
      activeSocket!.dispatchEvent(new MessageEvent("message", { data: f.frame("456") }));
      await vi.waitFor(async () => expect((await testDb.pool.query("select count(*)::int n from observations where source='fansly_ws'")).rows[0].n).toBe(2));
      expect(stop).not.toHaveBeenCalled();
      expect((await testDb.pool.query("select distinct state from fansly_ws_decode_receipts")).rows).toEqual([{ state: "pending" }]);
      const changedAt = Date.now(); f.app.config.fanslyWsCaptureEnabled = false;
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce(), { timeout: 15_000 });
      expect(Date.now() - changedAt).toBeLessThan(60_000);
    } finally {
      await worker.stop(); open.mockRestore();
      await testDb.pool.query("drop trigger b0_fail_settle on fansly_ws_decode_receipts; drop function b0_fail_settle()");
    }
    expect((await testDb.pool.query("select stop_reason from fansly_ws_connections where id<>$1::uuid", [f.id])).rows)
      .toEqual([{ stop_reason: "disabled" }]);
  }, 30_000);
  it("one owner per page, death notifies, restart owns a new connection and leaves a gap", async () => {
    const f = await fixture();
    expect(await acquireFanslyWsOwnership(testDb.connectionString, f.page.id, vi.fn())).toBeNull();
    await f.capture();
    const pid = (await testDb.pool.query("select pid from pg_stat_activity where application_name='fansly-b0' and datname=current_database()" )).rows[0].pid;
    await testDb.pool.query("select pg_terminate_backend($1)", [pid]);
    await vi.waitFor(() => expect(f.lost).toHaveBeenCalledOnce());
    await expect(f.capture(2)).rejects.toThrow();
    const next = await acquireFanslyWsOwnership(testDb.connectionString, f.page.id, vi.fn());
    expect(next).not.toBeNull(); owners.push(next!);
    await beginFanslyWsConnection(next!.db, { id: randomUUID(), pageId: f.page.id, generation: f.generation });
    const rows = (await testDb.pool.query("select closed_at,gap_state,gap_since,started_at from fansly_ws_connections order by started_at")).rows;
    expect(rows).toHaveLength(2); expect(rows[0].closed_at).toBeNull();
    expect(rows[1].gap_state).toBe("unknown"); expect(rows[1].gap_since.getTime()).toBeLessThan(rows[1].started_at.getTime());
  });

  it("raw + pending receipt commit atomically, replay recovers unknown child debt, connection ordinal deduplicates", async () => {
    const f = await fixture();
    const id = await f.capture(); expect(await f.capture()).toBe(id);
    const raw = (await testDb.pool.query("select payload from observations where id=$1", [id])).rows[0].payload;
    expect(raw.frame).toBe(f.frame());
    expect((await testDb.pool.query("select state from fansly_ws_decode_receipts")).rows).toEqual([{ state: "pending" }]);
    expect(await replayFanslyWsDecode(f.owner.db, f.page.id)).toBe(1);
    const receipt = (await testDb.pool.query("select state,nodes from fansly_ws_decode_receipts")).rows[0];
    expect(receipt.state).toBe("debt"); expect(receipt.nodes[2]).toMatchObject({ path: [1], state: "unknown" });
    expect((await testDb.pool.query("select count(*)::int as n from domain_events")).rows[0].n).toBe(0);
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

  it("reports tiered WS material as residual without invoking the OFAPI receipt decoder", async () => {
    const f = await fixture();
    const [fan] = await upsertFans(testDb.db, [{ platform: "fansly", platformUserId: "123" }]);
    await upsertFanPages(testDb.db, [{ fanId: fan!.id, platformAccountId: f.page.id }]);
    const dir = join(lakeDir, "capture/observations/2024"); await mkdir(dir, { recursive: true });
    const parquet = join(dir, "01.parquet"); const scratch = join(lakeDir, "seed.ndjson");
    const base = { id: 9001, source: "fansly_ws", producer: "fansly:b0", platform: "fansly", account_id: f.page.id,
      native_account_ref: "999", kind: FANSLY_WS_CAPTURE_KIND, payload: { codec: FANSLY_WS_CAPTURE_KIND,
        frame: JSON.stringify({ t: 99999, d: { accountId: 123, bystanderId: 456 } }) },
      payload_hash: "00", idempotency_key: "lake-b0", observed_at: null,
      received_at: "2024-01-10T00:00:00Z", actor_principal_id: null, parse_version: 0 };
    await writeFile(scratch, JSON.stringify(base) + "\n" + JSON.stringify({ ...base, id: 9002,
      source: "pull", kind: "fixture", payload: { accountId: "456" } }) + "\n");
    await ndjsonToParquet(scratch, parquet, TIERED_TABLES.find((t) => t.table === "observations")!.columns);
    await writeFile(join(dir, "01.manifest.json"), JSON.stringify({ table: "observations", partition: "observations_2024_01",
      rowCount: 2, restrictedRowCount: 0, minId: 9001, maxId: 9002, sha256: "fixture",
      restrictedSha256: null, exportedAt: "2024-02-01T00:00:00Z" }));
    const plan = await planErasure(f.app, { scopeType: "fan", platform: "fansly", fanRef: "123" });
    expect(plan.sharedObservations).toBe(1);
    expect(plan.targets.filter((t) => t.plane === "lake" && t.rows > 0)).toEqual([]);
    const ownerId = Number((await testDb.pool.query("insert into users(username,role) values ('b0-owner','owner') returning id")).rows[0].id);
    await executeErasure(f.app, { scopeType: "fan", platform: "fansly", fanRef: "123" }, { initiatedBy: ownerId });
    expect(await readParquetIds(parquet)).toEqual([9001, 9002]);
  });
});
