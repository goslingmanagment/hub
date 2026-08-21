// WP-F0(c)(ii) / §9.3 — the permanent erasure column-shape ratchet.
//
// THE GAP IT CLOSES. The Stage 28.4 erasure module's only AUTOMATIC guard
// enumerates non-cascade foreign keys to `fans` and fails on an unmapped one
// (`erasure/index.ts`, FAN_FK_CURATED). Every fan reference this initiative
// adds — order buyers, message-offer fans, and later likers, comment authors,
// notification correlation refs — is a TEXT platform ref with NO foreign key.
// The FK guard is structurally blind to all of them.
//
// The precedent proves it is not hypothetical: `tip_sender_platform_user_id`
// on `creator_post_tips` had to be hand-added to the erasure inventory,
// because nothing would have noticed its absence. An unlisted table
// UNDER-ERASES SILENTLY — a fan asks to be forgotten, the run reports success,
// and their purchases stay.
//
// So: discover the fan-ref-shaped columns from `information_schema` at run
// time and require each one to be either a fan-scope erasure target or an
// explicitly justified allowlist entry. A new fan-ref column lands untargeted
// ⇒ this fails at the PR that introduces it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFanslyPage, createModel } from "@agency_hub_core/db";

import { planErasure } from "../apps/runtime/src/services/erasure/index.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

/**
 * The shapes a fan reference takes in this schema. `%…%` is deliberate: a
 * column called `original_buyer_platform_user_id` is the same fact under a
 * different name and must not slip past a `=` match.
 */
const FAN_REF_COLUMN_PATTERNS = [
  "%buyer_platform_user_id%",
  "%liker_platform_user_id%",
  "%fan_platform_user_id%",
  "%sender_platform_user_id%",
  "author_ref",
  "correlation_ref",
];

/**
 * Columns whose table is NOT a fan-scope erasure target, each with the one line
 * that says why that is lawful. An entry here is a claim a reviewer can check —
 * "no fan reference survives here" — not a way to make the test go green.
 */
const JUSTIFIED_NON_TARGETS = new Map<string, string>([
  [
    "ofapi_spend_projection_events.fan_platform_user_id",
    "PRE-EXISTING GAP, surfaced by this ratchet at its introduction and recorded "
    + "rather than silently fixed: migration 0036's shadow/audit projection carries a fan "
    + "ref and is in no erasure plan. Backlog item — it is out of WP-F0's scope to change "
    + "the erasure surface of an unrelated OFAPI table, and listing it here is what stops "
    + "it from being invisible.",
  ],
]);

/** Erasure targets carry only a TABLE name, so the ratchet is table-scoped: a
 *  table in the plan is assumed to erase every fan ref it holds, which the
 *  per-table integration coverage in erasure.integration.test.ts checks. */
function tableOf(column: string): string {
  return column.slice(0, column.lastIndexOf("."));
}

describe("erasure column-shape ratchet (§9.3)", () => {
  it("targets every fan-ref-shaped column in the schema, or justifies the exception", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await resetIntegrationDatabase(testDb.pool);

    const discovered = (await testDb.pool.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name
         from information_schema.columns
        where table_schema = 'public'
          and (${
        FAN_REF_COLUMN_PATTERNS.map((_, index) => `column_name like $${index + 1}`).join(" or ")
      })
        order by table_name, column_name`,
      FAN_REF_COLUMN_PATTERNS,
    )).rows.map((row) => `${row.table_name}.${row.column_name}`);

    // Non-vacuous: the discovery must actually see the columns this package
    // added, or a broken query would make the ratchet pass by finding nothing.
    expect(discovered).toContain("media_orders.buyer_platform_user_id");
    expect(discovered).toContain("message_media_offers.fan_platform_user_id");
    expect(discovered.length).toBeGreaterThan(4);

    // A plan for a fan nobody has ever seen still enumerates every target the
    // module would touch — which is exactly the inventory under test.
    const model = await createModel(testDb.db, { slug: "ratchet", name: "Ratchet" });
    if (!model) {
      throw new Error("Expected the ratchet test model to be created");
    }
    const page = await createFanslyPage(testDb.db, { modelId: model.id, label: "ratchet-page" });
    if (!page) {
      throw new Error("Expected the ratchet test page to be created");
    }
    const plan = await planErasure(
      { db: testDb.db, pool: testDb.pool, config: {}, logger: {} } as never,
      { scopeType: "fan", platform: "fansly", fanRef: "fan-ratchet-probe" },
    );
    const targeted = new Set(plan.targets.map((target) => target.target));

    const untargeted = discovered.filter((column) =>
      !targeted.has(tableOf(column)) && !JUSTIFIED_NON_TARGETS.has(column)
    );
    expect(
      untargeted,
      "fan-ref columns with no erasure target and no justification — an unlisted table "
        + "UNDER-ERASES SILENTLY",
    ).toEqual([]);

    // Orphan check: a justification for a column that no longer exists, or for
    // one that IS now targeted, is stale and must be deleted rather than left
    // to make the list look more considered than it is.
    for (const [column, justification] of JUSTIFIED_NON_TARGETS) {
      expect(discovered, `${column}: justified but not present in the schema`).toContain(column);
      expect(targeted.has(tableOf(column)), `${column}: justified AND targeted — stale entry`)
        .toBe(false);
      expect(justification.length, `${column}: justification too thin`).toBeGreaterThan(60);
    }
  });

  it("names the WP-F0 media-plane tables as fan-scope targets", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await resetIntegrationDatabase(testDb.pool);
    const model = await createModel(testDb.db, { slug: "ratchet2", name: "Ratchet2" });
    if (!model) {
      throw new Error("Expected the ratchet test model to be created");
    }
    const page = await createFanslyPage(testDb.db, { modelId: model.id, label: "ratchet-page-2" });
    if (!page) {
      throw new Error("Expected the ratchet test page to be created");
    }

    const plan = await planErasure(
      { db: testDb.db, pool: testDb.pool, config: {}, logger: {} } as never,
      { scopeType: "fan", platform: "fansly", fanRef: "fan-ratchet-probe" },
    );
    const targeted = plan.targets.filter((target) => target.plane === "hot")
      .map((target) => target.target);
    // media_orders says WHO bought WHAT for HOW MUCH; message_media_offers says
    // what was offered in the fan's conversation. Both carry a TEXT fan ref
    // with no FK, so only this list keeps them reachable.
    expect(targeted).toContain("media_orders");
    expect(targeted).toContain("message_media_offers");
    // The precedent that proves the FK guard cannot find these on its own.
    expect(targeted).toContain("creator_post_tips");
  });
});
