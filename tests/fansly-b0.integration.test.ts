import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireFanslyWsOwnership, applyFanslyWsLiveReceipt, beginFanslyWsConnection, captureFanslyWsFrame, createFanslyPage,
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
import * as liveConfig from "../apps/runtime/src/services/effective-config.ts";
import { startFanslyWsWorker, type FanslyWsWorkerTiming } from "../apps/runtime/src/services/fansly-ws/worker.ts";

// The worker-level tests below run the real worker on production timing scaled
// down 10x, not further: on a loaded runner a guard or config round trip must
// stay well inside the staleness margins. tests/fansly-b0-connection.test.ts
// pins the production defaults, including the 60 s live-off bound.
const scaled: FanslyWsWorkerTiming = {
  configPollMs: 1_000, configStaleMs: 2_000, pagePauseMs: 1_000, backoffBaseMs: 150,
  authTimeoutMs: 1_000, checkMs: 500, guardStaleMs: 1_500, pingMs: 2_000, pongTimeoutMs: 3_000,
  drainMs: 2_000, applyDrainMs: 1_500,
};

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
  it.each(["rejected", "stalled"])("records an unavailable guard when live configuration is %s", async (failure) => {
    const f = await fixture();
    await finishFanslyWsConnection(f.owner.db, f.id, "disabled");
    await f.owner.close();
    await testDb.pool.query("update pages set external_page_id='999' where id=$1", [f.page.id]);
    const stop = vi.fn();
    const open = vi.spyOn(socketTransport, "openFanslyReceiverSocket").mockImplementation(() => {
      const socket = Object.assign(new EventTarget(), { send: vi.fn((data: string) => {
        if (data === "p") socket.dispatchEvent(new MessageEvent("message", { data: '{"t":2,"d":"{}"}' }));
      }) });
      queueMicrotask(() => {
        socket.dispatchEvent(new Event("open"));
        socket.dispatchEvent(new MessageEvent("message", { data: '{"t":1,"d":"{}"}' }));
        socket.dispatchEvent(new MessageEvent("message", { data: f.frame() }));
      });
      return { socket, stop } as unknown as ReturnType<typeof socketTransport.openFanslyReceiverSocket>;
    });
    const load = vi.spyOn(liveConfig, "loadEffectiveConfig");
    f.app.config.fanslyWsCaptureEnabled = true;
    f.app.config.fanslyWsCapturePageAllowlist = f.page.label;
    const worker = startFanslyWsWorker(f.app, { timing: scaled });
    try {
      await vi.waitFor(async () => expect((await testDb.pool.query(
        "select count(*)::int n from observations where source='fansly_ws'",
      )).rows[0].n).toBe(1));
      if (failure === "rejected") load.mockRejectedValue(new Error("config_read_failed"));
      else load.mockImplementation(() => new Promise(() => {}));
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce(), { timeout: 10_000 });
      await vi.waitFor(async () => expect((await testDb.pool.query(`select stop_reason from fansly_ws_connections
        where id<>$1::uuid`, [f.id])).rows).toEqual([{ stop_reason: "guard_unavailable" }]));
      expect(open).toHaveBeenCalledOnce();
      expect((await testDb.pool.query("select payload from observations where source='fansly_ws'")).rows)
        .toEqual([{ payload: expect.objectContaining({ frame: f.frame() }) }]);
    } finally { await worker.stop(); load.mockRestore(); open.mockRestore(); }
    const replacement = await acquireFanslyWsOwnership(testDb.connectionString, f.page.id, vi.fn());
    expect(replacement).not.toBeNull();
    if (replacement) { owners.push(replacement); await replacement.close(); }
  });

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
    const worker = startFanslyWsWorker(f.app, { timing: scaled });
    try {
      await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2), { timeout: 15_000 });
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
    // Plan §2.5: each connection attempt was one capture of the page's send
    // guard (source ws_connect), completed by the end of its attempt, and the
    // page is free again.
    expect((await testDb.pool.query(`select source, operation, completed_at is not null as done
      from fansly_send_log where page_id = $1 order by id`, [f.page.id])).rows).toEqual([
      { source: "ws_connect", operation: "ws_connect", done: true },
      { source: "ws_connect", operation: "ws_connect", done: true },
    ]);
    expect((await testDb.pool.query("select holder_token from fansly_page_send_guards where page_id = $1",
      [f.page.id])).rows).toEqual([{ holder_token: null }]);
  });

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
    const worker = startFanslyWsWorker(f.app, { timing: scaled });
    try {
      await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
      await vi.waitFor(async () => expect((await testDb.pool.query("select count(*)::int n from observations where source='fansly_ws'")).rows[0].n).toBe(1));
      await vi.waitFor(async () => expect((await testDb.pool.query("select count(*)::int n from fansly_ws_connections where verified_at is not null")).rows[0].n).toBe(1), { timeout: 5_000 });
      activeSocket!.dispatchEvent(new MessageEvent("message", { data: f.frame("456") }));
      await vi.waitFor(async () => expect((await testDb.pool.query("select count(*)::int n from observations where source='fansly_ws'")).rows[0].n).toBe(2));
      expect(stop).not.toHaveBeenCalled();
      expect((await testDb.pool.query("select distinct state from fansly_ws_decode_receipts")).rows).toEqual([{ state: "pending" }]);
      const changedAt = Date.now(); f.app.config.fanslyWsCaptureEnabled = false;
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce(), { timeout: 10_000 });
      // The same bound the unit test pins at production scale (<= 60 s).
      expect(Date.now() - changedAt).toBeLessThan(scaled.configPollMs + scaled.configStaleMs + scaled.checkMs);
    } finally {
      await worker.stop(); open.mockRestore();
      await testDb.pool.query("drop trigger b0_fail_settle on fansly_ws_decode_receipts; drop function b0_fail_settle()");
    }
    expect((await testDb.pool.query("select stop_reason from fansly_ws_connections where id<>$1::uuid", [f.id])).rows)
      .toEqual([{ stop_reason: "disabled" }]);
  });
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

  describe("a close the owner cannot record", () => {
    const failClose = `create function b0_fail_close() returns trigger language plpgsql as $$
        begin raise exception 'injected close failure'; end $$;
      create trigger b0_fail_close before update on fansly_ws_connections for each row
        when (new.closed_at is not null and new.stop_reason <> 'abandoned') execute function b0_fail_close()`;
    const allowClose = "drop trigger if exists b0_fail_close on fansly_ws_connections; drop function if exists b0_fail_close()";
    async function workerFixture(firstFrame: (f: Awaited<ReturnType<typeof fixture>>) => string) {
      const f = await fixture();
      await finishFanslyWsConnection(f.owner.db, f.id, "disabled");
      await f.owner.close();
      await testDb.pool.query("update pages set external_page_id='999' where id=$1", [f.page.id]);
      const generation = await readProbeGeneration(f.app.db, f.page.label);
      await testDb.pool.query(failClose);
      const open = vi.spyOn(socketTransport, "openFanslyReceiverSocket").mockImplementation(() => {
        const socket = Object.assign(new EventTarget(), { send: vi.fn() });
        queueMicrotask(() => {
          socket.dispatchEvent(new Event("open"));
          socket.dispatchEvent(new MessageEvent("message", { data: firstFrame(f) }));
          socket.dispatchEvent(new MessageEvent("message", { data: f.frame() }));
        });
        return { socket, stop: vi.fn() } as unknown as ReturnType<typeof socketTransport.openFanslyReceiverSocket>;
      });
      f.app.config.fanslyWsCaptureEnabled = true;
      f.app.config.fanslyWsCapturePageAllowlist = f.page.label;
      const rows = async () => (await testDb.pool.query(`select id,stop_reason,closed_at,last_guard_at,gap_since,
        closed_at=greatest(last_guard_at,last_capture_at) as closed_at_last_proof
        from fansly_ws_connections where id<>$1::uuid order by started_at`, [f.id])).rows;
      return { ...f, generation, open, rows };
    }
    afterEach(async () => { vi.restoreAllMocks(); await testDb.pool.query(allowClose); });

    it("is logged by fixed class only and abandoned by the next owner", async () => {
      const f = await workerFixture(() => '{"t":1,"d":"{}"}');
      const warn = vi.spyOn(f.app.logger, "warn");
      let worker = startFanslyWsWorker(f.app);
      try {
        await vi.waitFor(async () => expect((await testDb.pool.query(
          "select count(*)::int n from observations where source='fansly_ws'",
        )).rows[0].n).toBe(1), { timeout: 10_000 });
      } finally { await worker.stop(); }
      const [lost] = await f.rows();
      expect(lost).toMatchObject({ closed_at: null, stop_reason: null });
      expect(warn).toHaveBeenCalledWith(
        { pageLabel: f.page.label, connectionId: lost.id, stopReason: "disabled", closeError: "P0001" },
        "Fansly B0 connection close not confirmed; if it did not commit, the next owner marks it abandoned",
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("injected");
      await testDb.pool.query(allowClose);
      worker = startFanslyWsWorker(f.app);
      try { await vi.waitFor(() => expect(f.open).toHaveBeenCalledTimes(2), { timeout: 15_000 }); }
      finally { await worker.stop(); }
      const [abandoned, next] = await f.rows();
      expect(abandoned).toMatchObject({ id: lost.id, stop_reason: "abandoned", closed_at_last_proof: true });
      expect(next).toMatchObject({ stop_reason: "disabled" });
      expect(next.gap_since).toEqual(abandoned.last_guard_at);
    }, 30_000);

    it("keeps an auth refusal in the page loop, logs it as an error, and the next page start retries the generation once", async () => {
      const f = await workerFixture(() => '{"t":0,"d":"{\\"code\\":401}"}');
      const error = vi.spyOn(f.app.logger, "error");
      let worker = startFanslyWsWorker(f.app);
      try {
        await vi.waitFor(() => expect(error).toHaveBeenCalledWith(
          { pageLabel: f.page.label, connectionId: expect.any(String), stopReason: "auth_refused", closeError: "P0001" },
          "Fansly B0 auth refusal not confirmed; if it did not commit, the next page start retries this generation once",
        ), { timeout: 10_000 });
        expect(await isFanslyWsGenerationBlocked(testDb.db, f.page.id, f.generation)).toBe(false);
        expect(f.open).toHaveBeenCalledOnce();
      } finally { await worker.stop(); }
      await testDb.pool.query(allowClose);
      worker = startFanslyWsWorker(f.app);
      try {
        await vi.waitFor(async () => expect(await isFanslyWsGenerationBlocked(testDb.db, f.page.id, f.generation))
          .toBe(true), { timeout: 15_000 });
      } finally { await worker.stop(); }
      // The stated residual: one more refused auth attempt on the next page start.
      expect(f.open).toHaveBeenCalledTimes(2);
      expect((await f.rows()).map((row) => row.stop_reason)).toEqual(["abandoned", "auth_refused"]);
    }, 30_000);
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
    expect(receipt.state).toBe("debt"); expect(receipt.nodes[2]).toMatchObject({ path: [1], state: "unknown" });
    // A service-5 type-1 event without a message is not a message: debt, and
    // no business event, overlay row or HTTP.
    expect(receipt.live_state).toBe("debt");
    expect((await testDb.pool.query("select count(*)::int as n from domain_events")).rows[0].n).toBe(0);
    expect((await testDb.pool.query("select count(*)::int as n from dm_live_messages")).rows[0].n).toBe(0);
  });

  it("the legacy metadata replay still settles receipts captured before the overlay", async () => {
    const f = await fixture();
    const id = await f.capture();
    await testDb.pool.query("update fansly_ws_decode_receipts set live_state='legacy' where observation_id=$1", [id]);
    expect(await replayFanslyWsDecode(f.owner.db, f.page.id)).toBe(1);
    expect((await testDb.pool.query("select state,live_state from fansly_ws_decode_receipts")).rows)
      .toEqual([{ state: "debt", live_state: "legacy" }]);
    expect(await applyFanslyWsLiveReceipt(testDb.db, { observationId: id })).toEqual({ status: "not_pending" });
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
