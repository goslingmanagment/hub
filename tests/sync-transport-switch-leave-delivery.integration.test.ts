// The page transport switch (see tests/sync-transport-switch.integration.test.ts): leaving the browser is confirmed before Node takes the page, part 2 (unreadable bodies, slow and stalled deliveries).
// Split out so the CI shards can spread these slow, real-time tests.

import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { settleAttemptWithoutCapture, type Database } from "@agency_hub_core/db";

import { until } from "./helpers/sync-engine.ts";
import {
  attemptOf,
  bigAnswers,
  currentLinkOf,
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
  it("a body that does not read for a while: the operator answers unknown and keeps the outcome; the leave asks again, at a bounded rate, and takes it as the attempt's once it reads (Astra PR 14 round 2, P1)", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await onBrowser(r);
    const old = await diedAfterBrowserSent(r);
    // A failing disk: the outcome's body cannot be read (EIO) — the recover
    // answers `unknown`, the outcome stays kept.
    r.operator.bodiesUnreadable = true;

    const host = await startHost(r);
    await until(async () => r.operator.recovers.flat().includes(old.id), 20_000, "the operator asked about the attempt");
    const firstAsked = Date.now();
    await sleep(5_000);
    expect(host.state(r.page.pageId)).toMatchObject({ kind: "waiting", reason: "browser_leave_unconfirmed" });
    expect(await attemptOf(r, old.id)).toMatchObject({ outcome: "admitted" });
    expect(r.server.arrivals).toEqual([]);
    // Asked again, never in a tight loop: first after 2 s, then 4 s, …
    const asked = r.operator.recovers.filter((ids) => ids.includes(old.id)).length;
    expect(asked).toBeGreaterThanOrEqual(2);
    expect(asked).toBeLessThanOrEqual(2 + Math.ceil((Date.now() - firstAsked) / 2_000));

    // The disk reads again: the next ask resends it, and it is the attempt's.
    r.operator.bodiesUnreadable = false;
    await until(async () => r.server.arrivalsAt("/api/v1/polls").length >= 1, 40_000, "the page running on Node");
    // Its `sent` went to the engine that died: unknown to this one — the
    // result's own instant proves nothing (Astra's review of PR 15, round 6).
    expect(await attemptOf(r, old.id)).toMatchObject({ outcome: "response", sendMark: "completion_fallback" });
    expect(r.operator.acks).toContain(old.id);
    expect(r.operator.held.size).toBe(0);
    expect(r.operator.physical.filter((request) => request.attemptId === old.id)).toHaveLength(1);
    expect(await leftBy(r.page.pageId)).toMatchObject({ by: "operator", pending: null });
  }, 120_000);

  it("an outcome of an attempt settled already, its body unreadable when the leave connected: with nothing unfinished to ask, the leave connects again, at a bounded rate, until the operator delivers it (Astra PR 14 round 2, P1)", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await onBrowser(r);
    const old = await diedAfterBrowserSent(r);
    // Its owner's recovery closed it `unknown`; the operator still keeps its
    // outcome, whose body cannot be read now.
    await db().transaction(async (tx) => settleAttemptWithoutCapture(tx as unknown as Database, { attemptId: old.id, outcome: "unknown", errorClass: "recovery:unknown" }));
    r.operator.bodiesUnreadable = true;

    const host = await startHost(r);
    await until(async () => r.operator.commands.length >= 1, 20_000, "the browser stopped by the leave");
    const hellos = r.operator.hellos.length;
    await sleep(5_000);
    expect(host.state(r.page.pageId)).toMatchObject({ kind: "waiting", reason: "browser_leave_unconfirmed" });
    expect(r.server.arrivals).toEqual([]);
    // Connected again, never in a tight loop.
    const again = r.operator.hellos.length - hellos;
    expect(again).toBeGreaterThanOrEqual(1);
    expect(again).toBeLessThanOrEqual(3);

    r.operator.bodiesUnreadable = false;
    await until(async () => r.server.arrivalsAt("/api/v1/polls").length >= 1, 60_000, "the page running on Node");
    // A late answer of a settled attempt: kept as a fact, acknowledged, never applied in its place.
    expect(r.operator.acks).toContain(old.id);
    expect(r.operator.held.size).toBe(0);
    expect(await attemptOf(r, old.id)).toMatchObject({ outcome: "unknown" });
    expect(await leftBy(r.page.pageId)).toMatchObject({ by: "operator", pending: null });
  }, 120_000);

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

  it("a delivery that stalls is cut after its silence, never sooner; the next connection's delivers it (Astra PR 14 round 4)", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await onBrowser(r);
    bigAnswers(r);
    const old = await diedAfterBrowserSent(r);
    r.operator.bodiesUnreadable = true;
    await startHost(r);
    await until(async () => r.operator.recovers.flat().includes(old.id), 20_000, "the operator asked about the attempt");
    // It reads now, but stalls after the first part.
    r.operator.stallAfterParts = 1;
    r.operator.bodiesUnreadable = false;
    const sentBefore = r.operator.partsSent.length;
    await until(async () => r.operator.partsSent.length > sentBefore, 40_000, "the delivery under way");
    const stalledOn = r.operator.partsSent[sentBefore]!.link;
    const stalledAt = Date.now();
    // A new connection only after the stall's silence (30 s), within one more step (≤ 30 s) and its ask.
    await until(async () => currentLinkOf(r) > stalledOn, 90_000, "the stalled connection cut");
    const after = Date.now() - stalledAt;
    expect(after).toBeGreaterThanOrEqual(25_000);
    expect(after).toBeLessThanOrEqual(80_000);
    // No longer stalled: the next delivery is whole (the engine took the
    // body, which it does only whole), and the leave ends.
    r.operator.stallAfterParts = null;
    await until(async () => (await leftBy(r.page.pageId)).by === "operator", 120_000, "the leave confirmed");
    // Its `sent` went to the engine that died: unknown to this one — the
    // result's own instant proves nothing (Astra's review of PR 15, round 6).
    expect(await attemptOf(r, old.id)).toMatchObject({ outcome: "response", sendMark: "completion_fallback" });
  }, 300_000);

  it("a delivery that stalls while the leave first asks (before the drain) is cut after its silence too, and asked again on the next connection", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await onBrowser(r);
    bigAnswers(r);
    const old = await diedAfterBrowserSent(r);
    r.operator.stallAfterParts = 1;
    const sentBefore = r.operator.partsSent.length;
    await startHost(r);
    await until(async () => r.operator.partsSent.length > sentBefore, 40_000, "the delivery under way");
    const stalledOn = r.operator.partsSent[sentBefore]!.link;
    const stalledAt = Date.now();
    await until(async () => currentLinkOf(r) > stalledOn, 90_000, "the stalled connection cut");
    expect(Date.now() - stalledAt).toBeGreaterThanOrEqual(25_000);
    r.operator.stallAfterParts = null;
    await until(async () => (await leftBy(r.page.pageId)).by === "operator", 120_000, "the leave confirmed");
    expect(await attemptOf(r, old.id)).toMatchObject({ outcome: "response" });
  }, 300_000);
});
