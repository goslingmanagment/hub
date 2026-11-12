import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  findShiftRowAt,
  listSaleHomes,
  listShiftRows,
  readSaleRuleSwitch,
  setSaleRuleSwitch,
  syncShiftRows,
  upsertSaleHomes,
  type SaleHomeRow,
  type ShiftRowFacts,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { planShiftRows, reportDateOfShift } from "../apps/runtime/src/services/shift-rows.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// The shadow tables of the one rule (0379–0381): a shift row keeps its id across syncs and its old address resolves; a
// sale's home is written only when it changed; the screens' switch is off until set.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let chatter = 0;

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
const msk = (at: string) => new Date(`${at.replace(" ", "T")}:00+03:00`);

function facts(from: string, to: string, state: ShiftRowFacts["state"] = "closed"): ShiftRowFacts {
  const startedAt = msk(from);
  const endedAt = msk(to);
  return {
    userId: chatter, state, startedAt, endedAt, workedMinutes: 200, messages: 90,
    reportDate: reportDateOfShift({ startedAt: startedAt.getTime(), endedAt: endedAt.getTime() }),
    pages: [{ pageLabel: "page-a", activeMinutes: 150, messages: 90, salesFrom: startedAt.toISOString() }], pauses: [],
  };
}

const sync = (computed: ShiftRowFacts[], now: string) => syncShiftRows(app.db, {
  endedAfter: msk("2026-11-09 00:00"),
  now: msk(now),
  plan: (existing) => planShiftRows({ existing, computed, from: msk("2026-11-10 00:00") }),
});

describe("the one rule's shadow tables", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "chatter-a", role: "chatter" }, { source: "cli" });
    chatter = await fixtureUserId(app, "chatter-a");
  }, 120_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  it("keeps a shift's id from the minute it is seen, through its close and a start that moved, with a trace", async (context) => {
    if (!testDb) return context.skip();
    expect(await sync([facts("2026-11-11 16:00", "2026-11-11 18:00", "going")], "2026-11-11 18:00")).toMatchObject({ opened: 1, traced: 1 });
    const [opened] = await listShiftRows(app.db, { from: msk("2026-11-11 00:00"), to: msk("2026-11-12 00:00") });
    expect(opened).toMatchObject({ state: "going", reportDate: "2026-11-11" });
    // The end moves while it goes: the same row, nothing traced.
    expect(await sync([facts("2026-11-11 16:00", "2026-11-11 19:00", "going")], "2026-11-11 19:00")).toMatchObject({ opened: 0, updated: 1, traced: 0 });
    // A look-in before it joined it, and it closed.
    expect(await sync([facts("2026-11-11 15:10", "2026-11-12 00:05")], "2026-11-12 01:30")).toMatchObject({ opened: 0, updated: 1, traced: 1 });
    const rows = await listShiftRows(app.db, { from: msk("2026-11-11 00:00"), to: msk("2026-11-12 00:00") });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: opened!.id, state: "closed", startedAt: msk("2026-11-11 15:10"), endedAt: msk("2026-11-12 00:05") });
    const trace = await q("select change, before ->> 'startedAt' as was from shift_changes where shift_id = $1 order by id", [opened!.id]);
    expect(trace.rows.map((row) => row.change)).toEqual(["opened", "closed"]);
    // The old address by person and start resolves, the start it had before too.
    expect((await findShiftRowAt(app.db, { userId: chatter, at: msk("2026-11-11 16:00") }))?.id).toBe(opened!.id);
    expect((await findShiftRowAt(app.db, { userId: chatter, at: msk("2026-11-11 15:10") }))?.id).toBe(opened!.id);
    // Nothing changed: nothing written.
    expect(await sync([facts("2026-11-11 15:10", "2026-11-12 00:05")], "2026-11-12 02:00")).toEqual({ opened: 0, updated: 0, traced: 0, merged: 0, dropped: 0 });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("merges two rows into the older id and resolves the merged one's address to it", async (context) => {
    if (!testDb) return context.skip();
    await sync([facts("2026-11-13 08:00", "2026-11-13 10:30"), facts("2026-11-13 11:40", "2026-11-13 16:00")], "2026-11-13 18:00");
    const [morning, noon] = await listShiftRows(app.db, { from: msk("2026-11-13 00:00"), to: msk("2026-11-14 00:00") });
    expect(await sync([facts("2026-11-13 08:00", "2026-11-13 16:00")], "2026-11-13 19:00")).toMatchObject({ merged: 1, updated: 1 });
    expect((await findShiftRowAt(app.db, { userId: chatter, at: msk("2026-11-13 11:40") }))?.id).toBe(morning!.id);
    const merged = await q("select state, merged_into from shifts where id = $1", [noon!.id]);
    expect({ state: merged.rows[0].state, into: Number(merged.rows[0].merged_into) }).toEqual({ state: "merged", into: morning!.id });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("writes a sale's home once, and again only when it changed", async (context) => {
    if (!testDb) return context.skip();
    const model = await createModel(app.db, { slug: "homes", name: "Homes" });
    const page = (await createOnlyFansPage(app.db, { modelId: model!.id, label: "homes-of" }))!.id;
    const row: SaleHomeRow = {
      transactionId: 9_000_001, pageId: page, occurredAt: msk("2026-11-11 17:00"), netMills: 31_200, home: "waiting", reason: "ppv_sender_waiting",
      pot: null, waitsUntil: msk("2026-11-18 17:00"), shares: [], ruleVersion: "test",
    };
    expect(await upsertSaleHomes(app.db, [row], msk("2026-11-11 18:00"))).toBe(1);
    expect(await upsertSaleHomes(app.db, [row], msk("2026-11-11 19:00"))).toBe(0);
    const landed: SaleHomeRow = {
      ...row, home: "shift", reason: "ppv_sender_next_shift", waitsUntil: null,
      shares: [{ userId: chatter, workRef: `${chatter}:2026-11-12T05:00:00.000Z`, shiftId: null, percent: 100, mills: 31_200 }],
    };
    expect(await upsertSaleHomes(app.db, [landed], msk("2026-11-12 09:00"))).toBe(1);
    const [stored] = await listSaleHomes(app.db, { from: msk("2026-11-11 00:00"), to: msk("2026-11-12 00:00") });
    expect(stored).toMatchObject({ home: "shift", reason: "ppv_sender_next_shift", shares: landed.shares, computedAt: msk("2026-11-12 09:00") });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("keeps the screens' switch off until a date is set", async (context) => {
    if (!testDb) return context.skip();
    expect((await readSaleRuleSwitch(app.db)).screensFrom).toBeNull();
    await setSaleRuleSwitch(app.db, { screensFrom: "2026-11-16", setBy: "owner", at: msk("2026-11-12 12:00") });
    expect(await readSaleRuleSwitch(app.db)).toMatchObject({ screensFrom: "2026-11-16", setBy: "owner" });
    await setSaleRuleSwitch(app.db, { screensFrom: null, setBy: "owner", at: msk("2026-11-12 12:05") });
    expect((await readSaleRuleSwitch(app.db)).screensFrom).toBeNull();
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
