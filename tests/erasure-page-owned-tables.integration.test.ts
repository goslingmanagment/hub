// R2 — page-erasure schema ratchet.
//
// A page erasure preserves the `pages` catalog row, so neither RESTRICT nor
// CASCADE FKs can make page-owned rows disappear for it. Every direct child of
// `pages` therefore needs a named hot-plan target. Discover the real schema so
// a later lane cannot add a table and forget the static erasure inventory.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFanslyPage, createModel } from "@agency_hub_core/db";

import {
  PAGE_ERASURE_TABLE_EXCLUSIONS,
  planErasure,
} from "../apps/runtime/src/services/erasure/index.ts";
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

describe("page erasure schema inventory (R2)", () => {
  it("targets every table with a direct FK to pages, including all 30 endpoints-cover tables", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await resetIntegrationDatabase(testDb.pool);

    const model = await createModel(testDb.db, {
      slug: "page-erasure-ratchet",
      name: "Page erasure ratchet",
    });
    const page = model
      ? await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: "page-erasure-ratchet-page",
      })
      : undefined;
    if (!page) {
      throw new Error("Expected the page-erasure ratchet page to be created");
    }

    const children = (await testDb.pool.query<{ table_name: string }>(
      `select distinct con.conrelid::regclass::text as table_name
         from pg_constraint con
        where con.contype = 'f'
          and con.confrelid = 'pages'::regclass
        order by table_name`,
    )).rows.map((row) => row.table_name);

    const plan = await planErasure(
      { db: testDb.db, pool: testDb.pool, config: {}, logger: {} } as never,
      { scopeType: "page", pageLabel: page.label },
    );
    const targets = new Set(
      plan.targets.filter((target) => target.plane === "hot").map((target) => target.target),
    );
    const exclusions = new Map(
      PAGE_ERASURE_TABLE_EXCLUSIONS.map((entry) => [entry.table, entry.reason]),
    );

    // Non-vacuous pins for the initiative and the pre-existing post projection.
    expect(children).toContain("creator_media");
    expect(children).toContain("capture_coverage");
    expect(children).toContain("page_payout_methods");
    expect(children).toContain("creator_posts");

    for (const [table, reason] of exclusions) {
      expect(children, `${table}: excluded but it has no direct pages FK`).toContain(table);
      expect(reason.length, `${table}: exclusion needs a reviewable justification`).toBeGreaterThan(80);
    }
    const untargeted = children.filter((table) => !targets.has(table) && !exclusions.has(table));
    expect(
      untargeted,
      "page-owned tables missing from page erasure: the pages row is preserved, so no FK "
        + "action can erase them implicitly. Add each to the inventory or give it an explicit, "
        + "reviewable exclusion",
    ).toEqual([]);
  });
});
