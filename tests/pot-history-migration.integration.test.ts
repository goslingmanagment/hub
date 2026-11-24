import { resolve } from "node:path";
import { expect, it } from "vitest";

import {
  createFanslyPage, createModel, listWorkingPagesOnDay, listWorkingPeopleOnDay, placeSaleHomeChanges,
} from "@agency_hub_core/db";
import { runMigrations } from "../packages/db/src/migrate-runner.ts";
import { setPotsFromSwitch } from "../apps/runtime/src/services/pots.ts";
import { startIntegrationTestDatabase } from "./helpers/db.ts";

it("preserves legacy staffing and issued cursors while migrating a populated database", async (context) => {
  const db = await startIntegrationTestDatabase({ through: "0443_workboard_pots.sql" });
  if (!db) return context.skip();
  try {
    const model = (await createModel(db.db, { slug: "synthetic-history", name: "Synthetic history" }))!;
    const page = (await createFanslyPage(db.db, { modelId: model.id, label: "synthetic-history" }))!;
    const person = Number((await db.pool.query(`insert into people(code, display_name, role, state)
      values ('synthetic-hire', 'Synthetic hire', 'chatter', 'working') returning id`)).rows[0]!.id);
    await db.pool.query(`insert into people(code, display_name, role, state, left_on)
      values ('synthetic-former', 'Synthetic former worker', 'chatter', 'left', '2025-12-01')`);
    await db.pool.query(`insert into person_working_pages(person_id, page_id, position, added_at)
      values ($1, $2, 0, '2026-12-20')`, [person, page.id]);
    await db.pool.query(`insert into audit_events(source, event_type, metadata, created_at) values
      ('cli', 'person.created', '{"code":"synthetic-hire","state":"invited"}', '2026-11-30T12:00Z'),
      ('cli', 'person.updated', '{"code":"synthetic-hire","state":"working"}', '2026-12-15T12:00Z')`);
    await db.pool.query(`insert into sale_home_changes(transaction_id, page_id, is_test, op, seq)
      values (1, $1, false, 'retract', 73)`, [page.id]);
    const client = await db.pool.connect();
    try {
      await runMigrations({ db: client, migrationsDir: resolve("packages/db/migrations") });
    } finally {
      client.release();
    }
    expect(await listWorkingPagesOnDay(db.db, [person], "2026-12-01")).toEqual([{ personId: person, pageId: page.id }]);
    expect(await listWorkingPeopleOnDay(db.db, "live", "2026-12-01")).toHaveLength(0);
    expect((await listWorkingPeopleOnDay(db.db, "live", "2026-12-15")).map((p) => p.id)).toEqual([person]);
    await db.pool.query("delete from sale_home_changes where seq = 73");
    await db.pool.query(`insert into sale_home_changes(transaction_id, page_id, is_test, op)
      values (2, $1, false, 'retract')`, [page.id]);
    await placeSaleHomeChanges(db.db);
    expect(Number((await db.pool.query("select seq from sale_home_changes where transaction_id = 2")).rows[0]!.seq)).toBeGreaterThan(73);

    const set = (potsFrom: string | null) => setPotsFromSwitch(db.db, { potsFrom, setBy: "fixture", at: new Date() });
    const distribution = async (code: string, modelId: number, pageId: number) => {
      const pot = (await db.pool.query(`insert into pots(code, name, model_id, page_ids, opens_on, participants_mode, formula)
        values ($1, $1, $2, array[$3]::bigint[], '2026-12-01', 'listed', '{"kind":"equal"}') returning id`, [code, modelId, pageId])).rows[0]!;
      return (await db.pool.query(`insert into pot_distributions(pot_id, day, formula, base_mills, lines)
        values ($1, '2026-12-02', '{"kind":"equal"}', 1, '[]') returning id`, [pot.id])).rows[0]!.id;
    };
    const testModel = (await db.pool.query("insert into models(slug, name, is_test) values ('synthetic-test', 'Synthetic test', true) returning id")).rows[0]!;
    const testPage = (await createFanslyPage(db.db, { modelId: Number(testModel.id), label: "synthetic-test" }))!;
    await distribution("synthetic-test", Number(testModel.id), testPage.id);
    expect((await set(null)).potsFrom).toBeNull();
    await set("2026-12-01");
    const live = await distribution("synthetic-live", model.id, page.id);
    await db.pool.query("update pot_distributions set reversed_at = now(), reversed_reason = 'fixture' where id = $1", [live]);
    await expect(set("2026-12-03")).rejects.toMatchObject({ statusCode: 409, reason: "distributions_exist" });
  } finally {
    await db.stop();
  }
}, 120_000);
