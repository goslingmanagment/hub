import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  claimFanEarningsRotation, createFanslyPage, markFanEarningsDirty, settleFanEarningsReceipt,
  upsertFanslyTransactionWithEarningsDirty,
} from "@agency_hub_core/db";
import { executeErasure, planErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { startIntegrationTestDatabase, resetIntegrationDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { earningsShadowFixture } from "./helpers/earnings-shadow-fixture.ts";

let db: StartedTestDatabase;
let lakeDir: string;
beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("Docker Postgres required");
  db = started;
  lakeDir = await mkdtemp(join(tmpdir(), "earnings-shadow-erasure-"));
}, 120000);
afterAll(async () => {
  await db?.stop();
  if (lakeDir) await rm(lakeDir, { recursive: true, force: true });
});
beforeEach(async () => { await resetIntegrationDatabase(db.pool); });

describe("fan erasure includes earnings operational references", () => {
  it("erases endpoint and attribution debt while preserving a bystander and legacy planes", async () => {
    const f = await earningsShadowFixture(db);
    f.app.config.lakeDir = lakeDir;
    // The local binding is known, but the provider correlation is absent.
    await upsertFanslyTransactionWithEarningsDirty(db.db, { ...f.transaction, correlationAccountId: null });
    const otherPage = await createFanslyPage(db.db, { modelId: f.page.modelId, label: "other-page" });
    if (!otherPage) throw new Error("Other page seed failed");
    // Transaction IDs are page-scoped. The same string on a second page is
    // another fan's attribution debt and must survive the first fan's erase.
    await upsertFanslyTransactionWithEarningsDirty(db.db, {
      ...f.transaction, platformAccountId: otherPage.id,
      fanId: f.fans[1]!.id, correlationAccountId: null,
    });
    await db.db.transaction((tx) => markFanEarningsDirty(tx, {
      pageId: f.page.id, fanRefs: ["fan-b"], now: new Date(),
    }));
    await db.pool.query(`insert into subject_refresh_state (page_id, plane, subject_ref)
      values ($1, 'media_stats', 'fan-a')`, [f.page.id]);
    const claim = await claimFanEarningsRotation(db.db, {
      pageId: f.page.id, fanRef: "fan-a", window: "lifetime", now: new Date(),
    });
    if (!claim) throw new Error("Claim unavailable");
    const owner = await db.pool.query("insert into users (username, role) values ('erasure-owner', 'owner') returning id");
    const scope = { scopeType: "fan", platform: "fansly", fanRef: "fan-a" } as const;
    const plan = await planErasure(f.app, scope);
    expect(plan.targets.find((target) => target.target === "subject_refresh_state"))
      .toMatchObject({ action: "delete", rows: 3 });

    const result = await executeErasure(f.app, scope, { initiatedBy: Number(owner.rows[0].id) });
    expect(result.executedCounts["hot:subject_refresh_state:delete"]).toBe(3);
    const otherState = await db.pool.query(
      "select plane, subject_ref from subject_refresh_state where page_id = $1 order by plane", [otherPage.id],
    );
    expect(otherState.rows).toEqual([
      { plane: "fan_earnings_attribution", subject_ref: f.transaction.transactionId },
      { plane: "fan_earnings_lifetime", subject_ref: "fan-b" },
      { plane: "fan_earnings_monthly", subject_ref: "fan-b" },
    ]);
    expect((await f.rows()).map((row) => [row.plane, row.subject_ref])).toEqual([
      ["media_stats", "fan-a"], ["fan_earnings_lifetime", "fan-b"], ["fan_earnings_monthly", "fan-b"],
    ]);
    expect(await settleFanEarningsReceipt(db.db, claim, {
      outcome: "failed", fingerprint: null, observationId: null, checkedAt: new Date(),
    })).toBe(false);
    expect((await f.rows())).toHaveLength(3);
  });
});
