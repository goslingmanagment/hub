// The page transport switch (see tests/sync-transport-switch.integration.test.ts): leaving the browser is confirmed before Node takes the page, part 1.
// Split out so the CI shards can spread these slow, real-time tests.

import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { findPageBrowserByPage, readSyncLivePathFacts } from "@agency_hub_core/db";

import type { StallSubject, StallTracking } from "../apps/runtime/src/sync/engine/watchdog.ts";
import { SyncOwnerLeverError } from "../apps/runtime/src/sync/inspect.ts";
import { changeSyncPageTransport } from "../apps/runtime/src/sync/page-transport.ts";
import { until } from "./helpers/sync-engine.ts";
import {
  attemptOf,
  audits,
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
  it("the operator out of reach: Node waits, visibly; the owner's word that the container is stopped lets it go, the buffer marked not drained", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await onBrowser(r);
    const host = await startHost(r);
    await until(async () => r.operator.physical.length >= 1, 20_000, "the page running on its browser");
    // The link to the operator goes (its socket may live on in the browser).
    await r.operator.close();
    const switched = await changeSyncPageTransport(db(), { pageLabel: r.page.pageLabel, to: "node", prepare: false, actor: "test" });
    expect(switched.pendingLeave).not.toBeNull();
    await sleep(3_000);
    // Nothing through Node while the browser's stop is not confirmed.
    expect(r.server.arrivals).toEqual([]);
    expect(host.state(r.page.pageId)).toMatchObject({ kind: "waiting", reason: "browser_leave_unconfirmed" });
    expect((await leftBy(r.page.pageId)).pending).toBe(switched.pendingLeave!.toString());
    // What the alert evaluator reads: the pending leave, since the switch
    // (alert 2 `browser_leave_unconfirmed` after its bound).
    const liveFacts = () => readSyncLivePathFacts(db(), { pageId: r.page.pageId, decodeWindowMs: 60_000, unconfirmedAfterMs: 60_000 });
    expect((await liveFacts()).browserLeaveSince).toBeInstanceOf(Date);

    // The owner says the container is stopped (scripts/deploy-page-browser.sh to-node).
    const asserted = await changeSyncPageTransport(db(), { pageLabel: r.page.pageLabel, to: "node", prepare: false, browserStopped: true, actor: "test" });
    expect(asserted).toMatchObject({ changed: false, pendingLeave: null, browserStopped: { leftGeneration: switched.pendingLeave, bufferUndrained: true } });
    await until(async () => r.server.arrivalsAt("/api/v1/polls").length >= 1, 30_000, "the page running on Node");
    expect(await leftBy(r.page.pageId)).toMatchObject({ by: "owner", pending: null });
    expect((await findPageBrowserByPage(db(), r.page.pageId))!.bufferUndrainedSince).toBeInstanceOf(Date);
    const facts = await liveFacts();
    expect(facts.bufferUndrainedSince).toBeInstanceOf(Date);
    expect(facts.browserLeaveSince).toBeNull();
    expect(await audits(r.page.pageId)).toEqual([
      expect.objectContaining({ to: "node", browserStopped: false }),
      expect.objectContaining({ to: "node", browserStopped: true, leftGeneration: switched.pendingLeave!.toString() }),
    ]);
    // Nothing more to confirm: refused.
    await expect(changeSyncPageTransport(db(), { pageLabel: r.page.pageLabel, to: "node", prepare: false, browserStopped: true, actor: "test" }))
      .rejects.toBeInstanceOf(SyncOwnerLeverError);
  }, 90_000);

  it("a state said right after the stop does not confirm the leave: what the operator commits after it is taken first", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await onBrowser(r);
    await startHost(r);
    await until(async () => r.operator.physical.length >= 1, 20_000, "the page running on its browser");
    // The stopping browser's last event reaches the operator's buffer after
    // the state that says the page stopped (its commit batch, stretched).
    let late: { seq: number } | null = null;
    r.operator.lateAfterStop = { afterMs: 600, run: () => void (late = r.operator.gap("operator_start", null)) };
    await changeSyncPageTransport(db(), { pageLabel: r.page.pageLabel, to: "node", prepare: false, actor: "test" });
    await until(async () => (await leftBy(r.page.pageId)).by === "operator", 30_000, "the leave confirmed");
    expect(late).not.toBeNull();
    expect(r.operator.buffer.acknowledged).toBe(late!.seq);
    expect(r.operator.buffer.kept).toEqual([]);
  }, 90_000);

  it("an operator out of reach for long: the leave keeps telling the watchdog it goes on — the process is not taken for stalled", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await onBrowser(r);
    // What the host tells the process's stall watchdog.
    const tracked: Array<{ subject: StallSubject; phases: string[] }> = [];
    const watchdog: StallTracking = {
      track(subject, phase) {
        const entry = { subject, phases: [phase] };
        tracked.push(entry);
        return { progress: (next) => void entry.phases.push(next), done: () => undefined };
      },
    };
    const host = await startHost(r, { watchdog });
    await until(async () => r.operator.physical.length >= 1, 20_000, "the page running on its browser");
    await r.operator.close();
    const switched = await changeSyncPageTransport(db(), { pageLabel: r.page.pageLabel, to: "node", prepare: false, actor: "test" });
    // The leave runs under the generation after the one the page left at.
    const leave = () => tracked.find((entry) => entry.subject.component === "actor" && entry.subject.generation === switched.pendingLeave! + 1n);
    await until(async () => leave() !== undefined, 20_000, "the leave running");
    const looks = leave()!.phases.length;
    await sleep(2_000);
    // Waiting for the operator is no stall: every look is told to the
    // watchdog (it stops the process after 120 s without one).
    expect(leave()!.phases.length - looks).toBeGreaterThanOrEqual(4);
    expect(leave()!.phases.at(-1)).toBe("gate");
    expect(host.state(r.page.pageId)).toMatchObject({ kind: "waiting", reason: "browser_leave_unconfirmed" });
    expect(r.server.arrivals).toEqual([]);
  }, 90_000);

  it("the engine died after the browser sent; the page goes to Node meanwhile: a host that starts again stops the browser and takes its kept outcome before Node sends (Astra PR 14, P1 ×2)", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await onBrowser(r);
    const old = await diedAfterBrowserSent(r);

    await startHost(r);
    await until(async () => r.server.arrivalsAt("/api/v1/polls").length >= 1, 30_000, "the page running on Node");
    // The outcome the operator kept is the attempt's: captured, applied,
    // acknowledged — never closed unknown, never sent again. (As delivered
    // to the leave's connection, or resent on its recover: either way.)
    // Its `sent` went to the engine that died: unknown to this one — the
    // result's own instant proves nothing (Astra's review of PR 15, round 6).
    expect(await attemptOf(r, old.id)).toMatchObject({ outcome: "response", sendMark: "completion_fallback" });
    expect(r.operator.acks).toContain(old.id);
    expect(r.operator.physical.filter((request) => request.attemptId === old.id)).toHaveLength(1);
    // Stopped, taken and confirmed before Node sent anything.
    expect(r.operator.commands.map((command) => command.command.kind)).toEqual(["stopPage"]);
    expect(await leftBy(r.page.pageId)).toMatchObject({ by: "operator", pending: null });
    // On the database's clock: Node's first admission after the confirmation.
    const order = (await testDb.pool.query<{ ok: boolean }>(
      `select min(a.admitted_at) > sp.browser_left_at as ok
         from sync_pages sp join sync_attempts a on a.page_id = sp.page_id and a.owner_generation > sp.browser_left_generation
        where sp.page_id = $1 group by sp.browser_left_at`, [r.page.pageId],
    )).rows[0]!;
    expect(order.ok).toBe(true);
  }, 120_000);

  it("a buffer the operator cannot open is not a drained one: its 0 bytes confirm nothing, the leave waits with the kept outcome unread; once it opens, the outcome is the attempt's and Node takes the page (Astra PR 14 round 2, P1)", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await onBrowser(r);
    const old = await diedAfterBrowserSent(r);
    // The operator's buffer cannot be opened: it counts 0 bytes, answers a
    // recover with `unknown`, refuses the subscription — and its stopPage
    // replaces whatever stop reason said so.
    r.operator.setBufferUnavailable("locked");

    const host = await startHost(r);
    await until(async () => r.operator.commands.length >= 1, 20_000, "the browser stopped by the leave");
    await until(async () => r.operator.recovers.flat().includes(old.id), 20_000, "the operator asked about the attempt");
    await sleep(3_000);
    expect(r.operator.state).toMatchObject({ stopReason: "owner_stop", exitOpen: false });
    // Not confirmed: Node has not taken the page, the attempt is not closed
    // unknown, nothing is acknowledged.
    expect(await leftBy(r.page.pageId)).toMatchObject({ by: null });
    expect((await leftBy(r.page.pageId)).pending).not.toBeNull();
    expect(host.state(r.page.pageId)).toMatchObject({ kind: "waiting", reason: "browser_leave_unconfirmed" });
    expect(r.server.arrivals).toEqual([]);
    expect(await attemptOf(r, old.id)).toMatchObject({ outcome: "admitted" });
    expect(r.operator.held.has(old.id)).toBe(true);

    // The buffer opens: what it kept goes to the engine, and is the attempt's.
    r.operator.setBufferUnavailable(null);
    await until(async () => r.server.arrivalsAt("/api/v1/polls").length >= 1, 30_000, "the page running on Node");
    // Its `sent` went to the engine that died: unknown to this one — the
    // result's own instant proves nothing (Astra's review of PR 15, round 6).
    expect(await attemptOf(r, old.id)).toMatchObject({ outcome: "response", sendMark: "completion_fallback" });
    expect(r.operator.acks).toContain(old.id);
    expect(r.operator.held.size).toBe(0);
    expect(await leftBy(r.page.pageId)).toMatchObject({ by: "operator", pending: null });
  }, 120_000);
});
