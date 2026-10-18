// The page transport switch (see tests/sync-transport-switch.integration.test.ts): leaving the browser is confirmed before Node takes the page, part 2 (unreadable bodies).
// Split out so the CI shards can spread these slow, real-time tests (each file runs whole in one shard).

import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { settleAttemptWithoutCapture, type Database } from "@agency_hub_core/db";

import { until } from "./helpers/sync-engine.ts";
import {
  attemptOf,
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
});
