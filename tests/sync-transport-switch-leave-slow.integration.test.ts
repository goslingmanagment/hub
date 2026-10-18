// The page transport switch (see tests/sync-transport-switch.integration.test.ts): leaving the browser is confirmed before Node takes the page, part 3 (a mixed buffer, a slow delivery).
// Split out so the CI shards can spread these slow, real-time tests (each file runs whole in one shard).

import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { settleAttemptWithoutCapture, type Database } from "@agency_hub_core/db";

import { until } from "./helpers/sync-engine.ts";
import {
  attemptOf,
  bigAnswers,
  db,
  diedAfterBrowserSent,
  leftBy,
  onBrowser,
  rig,
  startHost,
  testDb,
  useSwitchHarness,
} from "./helpers/sync-transport-switch.ts";

useSwitchHarness();

describe("leaving the browser is confirmed before Node takes the page (Astra PR 14, P1)", () => {
  it("a mixed buffer — a settled attempt's outcome kept with its body unread, beside an unfinished attempt the operator keeps nothing of: everything kept is redelivered on its own backoff, whatever recover names (Astra PR 14 round 3, P1)", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await onBrowser(r);
    const old = await diedAfterBrowserSent(r);
    // #2: an unfinished attempt of the page the operator keeps nothing of
    // (its recover answers `unknown`), so `recover` always names something.
    const second = (await testDb.pool.query<{ id: number }>(
      `insert into sync_attempts
       select (jsonb_populate_record(null::sync_attempts, to_jsonb(a) || jsonb_build_object('id', nextval(pg_get_serial_sequence('sync_attempts', 'id'))))).*
         from sync_attempts a where a.id = $1
       returning id::int`, [old.id],
    )).rows[0]!.id;
    // #1: settled already; the operator keeps its outcome, whose body cannot be read now.
    await db().transaction(async (tx) => settleAttemptWithoutCapture(tx as unknown as Database, { attemptId: old.id, outcome: "unknown", errorClass: "recovery:unknown" }));
    r.operator.bodiesUnreadable = true;

    const host = await startHost(r);
    await until(async () => r.operator.recovers.flat().includes(second), 20_000, "the operator asked about #2");
    const hellos = r.operator.hellos.length;
    const since = Date.now();
    await sleep(5_000);
    expect(host.state(r.page.pageId)).toMatchObject({ kind: "waiting", reason: "browser_leave_unconfirmed" });
    expect(r.server.arrivals).toEqual([]);
    // Asked again both ways, never in a tight loop (2 s, then 4 s, …).
    expect(r.operator.recovers.filter((ids) => ids.includes(second)).length).toBeGreaterThanOrEqual(2);
    const again = r.operator.hellos.length - hellos;
    expect(again).toBeGreaterThanOrEqual(1);
    expect(again).toBeLessThanOrEqual(1 + Math.ceil((Date.now() - since) / 2_000));
    expect(r.operator.held.has(old.id)).toBe(true);

    // The disk reads again: the next redelivery gives #1, taken as a late
    // fact; the leave is confirmed and Node sends. (Node's own work after
    // that is not this test's: #2 is a copy of #1's attempt, of its work.)
    r.operator.bodiesUnreadable = false;
    await until(async () => (await leftBy(r.page.pageId)).by === "operator" && r.server.arrivals.length >= 1, 60_000, "the leave confirmed, Node sending");
    expect(host.state(r.page.pageId)).toMatchObject({ kind: "running" });
    expect(r.operator.acks).toContain(old.id);
    expect(r.operator.held.size).toBe(0);
    expect(await attemptOf(r, old.id)).toMatchObject({ outcome: "unknown" });
    expect(await leftBy(r.page.pageId)).toMatchObject({ by: "operator", pending: null });
  }, 120_000);

  it("a slow but working delivery — 3 MiB over 45 s — is never cut: the leave waits for it, takes the outcome as the attempt's and Node sends (Astra PR 14 round 4, P1)", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await onBrowser(r);
    bigAnswers(r);
    const old = await diedAfterBrowserSent(r);
    // As Astra: the body does not read at first (the recover says unknown),
    // then it reads — slowly: a part every 15 s.
    r.operator.bodiesUnreadable = true;
    const host = await startHost(r);
    await until(async () => r.operator.recovers.flat().includes(old.id), 20_000, "the operator asked about the attempt");
    r.operator.bodyPartDelayMs = 15_000;
    r.operator.bodiesUnreadable = false;
    await until(async () => (await leftBy(r.page.pageId)).by === "operator" && r.server.arrivals.length >= 1, 150_000, "the leave confirmed, Node sending");
    // The engine got it whole — a body is taken only with every part of one
    // connection and its sha256 matching — and it is the attempt's.
    // Its `sent` went to the engine that died: unknown to this one — the
    // result's own instant proves nothing (Astra's review of PR 15, round 6).
    expect(await attemptOf(r, old.id)).toMatchObject({ outcome: "response", sendMark: "completion_fallback" });
    expect(r.operator.acks).toContain(old.id);
    expect(host.state(r.page.pageId)).toMatchObject({ kind: "running" });
  }, 240_000);
});
