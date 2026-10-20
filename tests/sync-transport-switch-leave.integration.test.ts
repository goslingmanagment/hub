// The page transport switch (see tests/sync-transport-switch.integration.test.ts): leaving the browser is confirmed before Node takes the page, part 1.
// Split out so the CI shards can spread these slow, real-time tests.

import { describe, expect, it } from "vitest";

import { until } from "./helpers/sync-engine.ts";
import {
  attemptOf,
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
});
