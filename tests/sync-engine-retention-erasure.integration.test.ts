import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  consumeSyncMediaHandoff,
  createFanslyPage,
  createModel,
  deleteExpiredSyncEngineTelemetry,
  deleteExpiredSyncMediaHandoff,
  ensureSyncPage,
  setPageHold,
  setResourceHold,
  storeSyncMediaHandoff,
  type Database,
} from "@agency_hub_core/db";

import { executeErasure, planErasure } from "../apps/runtime/src/services/erasure/index.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

// Fansly Sync Engine core state (0228), the parts other subsystems own: the
// migration's seed and grants, the nightly telemetry retention, and the
// erasure inventory (page scope) and fan scope (design §2.9).

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

async function query<T extends Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await testDb!.pool.query<T>(text, values)).rows;
}

async function seedPage(label: string): Promise<number> {
  const model = await createModel(db(), { slug: `model-${label}`, name: label });
  const page = await createFanslyPage(db(), { modelId: model!.id, label });
  await ensureSyncPage(db(), { pageId: page!.id });
  return page!.id;
}

/** jsonb columns get their JSON text; Dates and scalars pass through. */
function sqlValue(value: unknown): unknown {
  return value !== null && typeof value === "object" && !(value instanceof Date) ? JSON.stringify(value) : value;
}

async function insertWork(pageId: number, fields: Record<string, unknown>): Promise<number> {
  const row = {
    page_id: pageId,
    resource: "dm-messages.head",
    subject: "",
    kind: "trigger",
    class: "urgent",
    ...fields,
  };
  const columns = Object.keys(row);
  const values = Object.values(row).map(sqlValue);
  const rows = await query<{ id: string }>(
    `insert into sync_work (${columns.join(", ")}) values (${columns.map((_, index) => `$${index + 1}`).join(", ")}) returning id::text`,
    values,
  );
  return Number(rows[0]!.id);
}

async function insertAttempt(pageId: number, fields: Record<string, unknown>): Promise<number> {
  const row = {
    page_id: pageId,
    resource: "dm-messages.head",
    subject: "",
    class: "urgent",
    owner_generation: 1,
    setting_ms: 2_000,
    jitter_u: 0.1,
    pause_ms: 2_200,
    operation: "messages.page",
    request: { path: "/api/v1/message", query: {} },
    ...fields,
  };
  const columns = Object.keys(row);
  const values = Object.values(row).map(sqlValue);
  const rows = await query<{ id: string }>(
    `insert into sync_attempts (${columns.join(", ")}) values (${columns.map((_, index) => `$${index + 1}`).join(", ")}) returning id::text`,
    values,
  );
  return Number(rows[0]!.id);
}

async function insertHistoryRequest(pageId: number, items: number): Promise<number> {
  const rows = await query<{ id: string }>(
    `insert into history_requests (request_ref, page_id, requester_kind, idempotency_key, request_fingerprint, depth_kind,
            reason_sha256, reason_length, items_total, estimate_at_submit)
     values (gen_random_uuid(), $1, 'owner_cli', gen_random_uuid(), repeat('a', 64), 'all', repeat('b', 64), 4, $2, '{}')
     returning id::text`,
    [pageId, items],
  );
  return Number(rows[0]!.id);
}

async function insertHistoryItem(requestId: number, pageId: number, ordinal: number, fields: Record<string, unknown>): Promise<number> {
  const row = { request_id: requestId, page_id: pageId, ordinal, state: "queued", ...fields };
  const columns = Object.keys(row);
  const values = Object.values(row).map(sqlValue);
  const rows = await query<{ id: string }>(
    `insert into history_request_items (${columns.join(", ")}) values (${columns.map((_, index) => `$${index + 1}`).join(", ")}) returning id::text`,
    values,
  );
  return Number(rows[0]!.id);
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function insertDescription(pageId: number, ref: string, fan: string | null): Promise<number> {
  const rows = await query<{ id: string }>(
    `insert into ai_media_descriptions (page_id, platform, media_ref, variant, media_kind, sender_role, fan_platform_user_id, status)
     values ($1, 'fansly', $2, 'full', 'photo', $3, $4, 'pending') returning id::text`,
    [pageId, ref, fan === null ? "model" : "fan", fan],
  );
  return Number(rows[0]!.id);
}

describe("the media handoff buffer (0234, owner decision №17)", () => {
  it("stores bytes for a description that exists, hands them over once, and expires what nobody consumed", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("handoff");
    const description = await insertDescription(pageId, "m-1", null);
    const bytes = Buffer.from([0xff, 0xd8, 0x00, 0x01]);
    const stored = await storeSyncMediaHandoff(db(), { pageId, descriptionId: description, workId: 7, contentType: "image/jpeg", bytes });
    expect(stored).toMatchObject({ byteCount: 4 });
    expect(stored!.expiresAt.getTime() - Date.now()).toBeGreaterThan(DAY_MS - 60_000);
    // Nothing for a description that is gone (or another page's).
    expect(await storeSyncMediaHandoff(db(), { pageId, descriptionId: description + 999, workId: 7, contentType: null, bytes })).toBeNull();
    // Another description's read finds nothing; the right one consumes it once.
    expect(await consumeSyncMediaHandoff(db(), { pageId, descriptionId: description + 1, handoffId: stored!.id })).toBeNull();
    expect(await consumeSyncMediaHandoff(db(), { pageId, descriptionId: description, handoffId: stored!.id }))
      .toMatchObject({ bytes, contentType: "image/jpeg" });
    expect(await consumeSyncMediaHandoff(db(), { pageId, descriptionId: description, handoffId: stored!.id })).toBeNull();

    const fresh = await storeSyncMediaHandoff(db(), { pageId, descriptionId: description, workId: 8, contentType: null, bytes });
    const stale = await storeSyncMediaHandoff(db(), { pageId, descriptionId: description, workId: 9, contentType: null, bytes });
    await query("update sync_media_handoff set created_at = created_at - interval '2 days', expires_at = expires_at - interval '2 days' where id = $1", [stale!.id]);
    expect(await consumeSyncMediaHandoff(db(), { pageId, descriptionId: description, handoffId: stale!.id })).toBeNull();
    expect(await deleteExpiredSyncMediaHandoff(db())).toBe(1);
    expect((await query<{ id: string }>("select id::text from sync_media_handoff")).map((row) => Number(row.id))).toEqual([fresh!.id]);
  });
});

describe("the 0228 migration", () => {
  it("seeds every existing Fansly page in mode off, grants the read role, and merges demand in SQL", async (context) => {
    if (!testDb) return context.skip();
    const partial = await startIntegrationTestDatabase({ through: "0225_fansly_page_send_guards.sql" });
    if (!partial) return context.skip();
    try {
      await partial.pool.query("insert into models (slug, name) values ('seed-model', 'Seed')");
      await partial.pool.query(`insert into pages (model_id, platform, label)
        select id, 'fansly', 'seed-fansly' from models where slug = 'seed-model'`);
      await partial.pool.query(`insert into pages (model_id, platform, label)
        select id, 'onlyfans', 'seed-onlyfans' from models where slug = 'seed-model'`);
      const { runMigrations } = await import("../packages/db/src/migrate-runner.ts");
      const client = await partial.pool.connect();
      try {
        await runMigrations({
          db: client,
          migrationsDir: path.resolve("packages/db/migrations"),
          through: "0228_sync_engine_core.sql",
        });
      } finally {
        client.release();
      }
      const seeded = await partial.pool.query(`
        select p.label, sp.mode, sp.mode_changed_by, sp.owner_generation::int as generation, sp.cycle_pos
          from sync_pages sp join pages p on p.id = sp.page_id`);
      expect(seeded.rows).toEqual([
        { label: "seed-fansly", mode: "off", mode_changed_by: "migration:0228", generation: 0, cycle_pos: 0 },
      ]);
      const grants = await partial.pool.query(`
        select has_table_privilege('read_only', 'sync_pages', 'select') as pages,
               has_table_privilege('read_only', 'sync_attempts', 'select') as attempts,
               has_column_privilege('read_only', 'sync_work', 'demand', 'select') as work_demand,
               has_column_privilege('read_only', 'sync_work', 'secret_params', 'select') as work_secret`);
      expect(grants.rows[0]).toEqual({ pages: true, attempts: true, work_demand: true, work_secret: false });

      const merged = await partial.pool.query(`
        select sync_work_merge_demand('{"messageIds":["a","b"],"reasons":["ws"]}'::jsonb,
                                      '{"messageIds":["b","c"],"txIds":["t"],"reasons":["ws","poll"]}'::jsonb) as d`);
      expect(merged.rows[0].d).toEqual({ messageIds: ["a", "b", "c"], txIds: ["t"], reasons: ["ws", "poll"], overflow: false });
      const overflow = await partial.pool.query(`
        select sync_work_merge_demand(
          jsonb_build_object('txIds', (select jsonb_agg('t' || n) from generate_series(1, 199) n)),
          '{"txIds":["x","y"]}'::jsonb) as d`);
      expect(overflow.rows[0].d.txIds).toHaveLength(200);
      expect(overflow.rows[0].d.txIds.at(-1)).toBe("x");
      expect(overflow.rows[0].d.overflow).toBe(true);
    } finally {
      await partial.stop();
    }
  }, 120_000);
});

describe("engine telemetry retention", () => {
  it("expires closed work and terminal non-evidence attempts, keeping open, evidence and unfinished rows", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("retention");
    const old = new Date(Date.now() - 40 * DAY_MS);
    const recent = new Date(Date.now() - DAY_MS);
    const work = {
      oldDone: await insertWork(pageId, { subject: "a", state: "done", closed_at: old, created_at: old }),
      oldSuperseded: await insertWork(pageId, { subject: "b", shadow: true, state: "superseded", closed_at: old }),
      recentDone: await insertWork(pageId, { subject: "c", state: "done", closed_at: recent }),
      oldOpen: await insertWork(pageId, { subject: "d", created_at: old, due_at: old }),
      oldQuarantined: await insertWork(pageId, { subject: "e", state: "quarantined", created_at: old }),
      oldRunning: await insertWork(pageId, { subject: "f", state: "running", created_at: old }),
    };
    const attempts = {
      oldResponse: await insertAttempt(pageId, { admitted_at: old, completed_at: old, outcome: "response", apply_state: "applied" }),
      oldShadow: await insertAttempt(pageId, {
        shadow: true, admitted_at: old, completed_at: old, outcome: "shadow", send_mark: "shadow", apply_state: "skipped",
      }),
      oldAborted: await insertAttempt(pageId, { admitted_at: old, completed_at: old, outcome: "aborted_before_send" }),
      oldEvidence: await insertAttempt(pageId, {
        admitted_at: old, completed_at: old, outcome: "response", apply_state: "applied", evidence: true,
      }),
      oldAdmitted: await insertAttempt(pageId, { admitted_at: old }),
      oldSent: await insertAttempt(pageId, { admitted_at: old, outcome: "sent", sent_at: old }),
      oldCaptured: await insertAttempt(pageId, {
        admitted_at: old, completed_at: old, outcome: "response", apply_state: "captured",
        observation_id: 1, observation_received_at: old,
      }),
      oldDeferred: await insertAttempt(pageId, { admitted_at: old, completed_at: old, outcome: "response", apply_state: "deferred" }),
      oldQuarantined: await insertAttempt(pageId, { admitted_at: old, completed_at: old, outcome: "response", apply_state: "quarantined" }),
      lateCompletion: await insertAttempt(pageId, { admitted_at: old, completed_at: recent, outcome: "unknown" }),
      recent: await insertAttempt(pageId, { admitted_at: recent, completed_at: recent, outcome: "response", apply_state: "applied" }),
    };
    const cutoff = new Date(Date.now() - 30 * DAY_MS);

    const starved = await deleteExpiredSyncEngineTelemetry(db(), cutoff, { budgetMs: 0 });
    expect(starved).toMatchObject({ deletedWork: 0, deletedAttempts: 0, budgetExhausted: true });

    const result = await deleteExpiredSyncEngineTelemetry(db(), cutoff, { batchRows: 1 });
    expect(result).toMatchObject({ deletedWork: 2, deletedAttempts: 3, budgetExhausted: false });
    expect(result.steps.map((step) => [step.table, step.batches])).toEqual([["sync_work", 3], ["sync_attempts", 4]]);

    const leftWork = new Set((await query<{ id: string }>("select id::text from sync_work")).map((row) => Number(row.id)));
    expect([...leftWork].sort((a, b) => a - b)).toEqual(
      [work.recentDone, work.oldOpen, work.oldQuarantined, work.oldRunning].sort((a, b) => a - b),
    );
    const leftAttempts = new Set((await query<{ id: string }>("select id::text from sync_attempts")).map((row) => Number(row.id)));
    expect([...leftAttempts].sort((a, b) => a - b)).toEqual([
      attempts.oldEvidence, attempts.oldAdmitted, attempts.oldSent, attempts.oldCaptured, attempts.oldDeferred,
      attempts.oldQuarantined, attempts.lateCompletion, attempts.recent,
    ].sort((a, b) => a - b));
  });
});

describe("erasure of the engine's state (design §2.9)", () => {
  const FAN = "300100200300400500";
  // Contains FAN as a prefix: a different fan, never matched.
  const OTHER_FAN = `${FAN}7`;

  async function withEraser<T>(body: (app: never, operatorId: number) => Promise<T>): Promise<T> {
    const operator = await query<{ id: string }>("insert into users (username, role) values ('sync-erasure-owner', 'owner') returning id::text");
    const lakeDir = await mkdtemp(path.join(tmpdir(), "sync-engine-erasure-"));
    try {
      const app = {
        db: testDb!.db,
        pool: testDb!.pool,
        config: { lakeDir },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      } as never;
      return await body(app, Number(operator[0]!.id));
    } finally {
      await rm(lakeDir, { recursive: true, force: true });
    }
  }

  it("a fan erasure removes the fan's work and attempts by subject and by the ids inside their parameters", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("erase-fan");
    await query(
      `insert into page_dm_threads (platform_account_id, platform_conversation_id, partner_platform_user_id)
       values ($1, 'group-fan', $2), ($1, 'group-other', $3)`,
      [pageId, FAN, OTHER_FAN],
    );
    const erased = [
      await insertWork(pageId, { subject: "group-fan" }),
      await insertWork(pageId, { resource: "fan-profiles.probe", subject: FAN, class: "planned" }),
      await insertWork(pageId, { resource: "fan-profiles.lookup", kind: "goal", class: "planned", params: { ids: `111,${FAN},222` } }),
      await insertWork(pageId, { resource: "fan-earnings.roster", kind: "goal", class: "planned", subject: "x", cursor: { after: FAN } }),
      await insertWork(pageId, { resource: "account.verify", subject: "y", result: { fans: [FAN] } }),
    ];
    const kept = [
      await insertWork(pageId, { subject: "group-other" }),
      await insertWork(pageId, { resource: "fan-profiles.probe", subject: OTHER_FAN, class: "planned" }),
      await insertWork(pageId, { resource: "fan-profiles.lookup", kind: "goal", class: "planned", subject: "z", params: { ids: OTHER_FAN } }),
    ];
    const erasedAttempts = [
      await insertAttempt(pageId, { subject: "group-fan", evidence: true, outcome: "response" }),
      await insertAttempt(pageId, {
        resource: "fan-profiles.lookup", operation: "account.by_ids", request: { path: "/api/v1/account", query: { ids: `${FAN},999` } },
      }),
      await insertAttempt(pageId, {
        resource: "fan-earnings.roster", operation: "earnings.by_fan", request: { path: "/x", query: { correlationAccountId: FAN } },
      }),
    ];
    const keptAttempts = [
      await insertAttempt(pageId, { subject: "group-other", evidence: true }),
      await insertAttempt(pageId, { resource: "fan-profiles.lookup", request: { query: { ids: `${OTHER_FAN},1` } } }),
    ];

    await withEraser(async (app, operatorId) => {
      const scope = { scopeType: "fan" as const, platform: "fansly" as const, fanRef: FAN };
      const plan = await planErasure(app, scope);
      const targets = new Map(plan.targets.map((target) => [`${target.plane}:${target.target}:${target.action}`, target.rows]));
      expect(targets.get("hot:sync_work:delete")).toBe(erased.length);
      expect(targets.get("hot:sync_attempts:delete")).toBe(erasedAttempts.length);
      const result = await executeErasure(app, scope, { initiatedBy: operatorId });
      expect(result.executedCounts["hot:sync_work:delete"]).toBe(erased.length);
      expect(result.executedCounts["hot:sync_attempts:delete"]).toBe(erasedAttempts.length);
    });
    const leftWork = (await query<{ id: string }>("select id::text from sync_work order by id")).map((row) => Number(row.id));
    expect(leftWork).toEqual(kept);
    const leftAttempts = (await query<{ id: string }>("select id::text from sync_attempts order by id")).map((row) => Number(row.id));
    expect(leftAttempts).toEqual(keptAttempts);
    // The page's engine row is not fan material.
    expect(await query("select page_id::int from sync_pages")).toEqual([{ page_id: pageId }]);
  });

  it("a fan erasure removes the fan's history request items — by fan id, by chat, by chat link — and no other fan's", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("erase-history");
    const request = await insertHistoryRequest(pageId, 6);
    // A request whose last open fan is the erased one: nothing else would
    // ever settle it (its chat's work goes with the fan) — the erasure does.
    const lastOpen = await insertHistoryRequest(pageId, 2);
    await insertHistoryItem(lastOpen, pageId, 0, { input_kind: "conversation_ref", input_ref: "group-fan", conversation_ref: "group-fan" });
    await insertHistoryItem(lastOpen, pageId, 1, {
      input_kind: "fan_platform_user_id", input_ref: OTHER_FAN, fan_platform_user_id: OTHER_FAN, state: "ready",
      satisfied_by: "already_satisfied",
    });
    const erased = [
      await insertHistoryItem(request, pageId, 0, { input_kind: "fan_platform_user_id", input_ref: FAN, fan_platform_user_id: FAN }),
      await insertHistoryItem(request, pageId, 1, { input_kind: "conversation_ref", input_ref: "group-fan", conversation_ref: "group-fan" }),
      await insertHistoryItem(request, pageId, 2, {
        input_kind: "chat_url", input_ref: `https://fansly.com/messages/${FAN}`, state: "refused", refusal: "not_found",
      }),
    ];
    const kept = [
      await insertHistoryItem(request, pageId, 3, { input_kind: "fan_platform_user_id", input_ref: OTHER_FAN, fan_platform_user_id: OTHER_FAN }),
      await insertHistoryItem(request, pageId, 4, { input_kind: "conversation_ref", input_ref: "group-other", conversation_ref: "group-other" }),
    ];
    await query(
      `insert into page_dm_threads (platform_account_id, platform_conversation_id, partner_platform_user_id)
       values ($1, 'group-fan', $2), ($1, 'group-other', $3)`,
      [pageId, FAN, OTHER_FAN],
    );
    await withEraser(async (app, operatorId) => {
      const scope = { scopeType: "fan" as const, platform: "fansly" as const, fanRef: FAN };
      const plan = await planErasure(app, scope);
      const targets = new Map(plan.targets.map((target) => [`${target.plane}:${target.target}:${target.action}`, target.rows]));
      expect(targets.get("hot:history_request_items:delete")).toBe(erased.length + 1);
      const result = await executeErasure(app, scope, { initiatedBy: operatorId });
      expect(result.executedCounts["hot:history_request_items:delete"]).toBe(erased.length + 1);
    });
    expect((await query<{ id: string }>(
      "select id::text from history_request_items where request_id = $1 order by id", [request])).map((row) => Number(row.id)))
      .toEqual(kept);
    // The requests keep only digests and counts: they stay, settled again —
    // one still has open fans of other chats, the other none left (done).
    expect(await query(
      `select id::int, state, items_terminal, done_at is not null as "doneAt" from history_requests order by id`,
    )).toEqual([
      { id: request, state: "open", items_terminal: 0, doneAt: false },
      { id: lastOpen, state: "done", items_terminal: 1, doneAt: true },
    ]);
  });

  it("a fan erasure takes the fan's chats before their work rows, as a history intake does: the two never deadlock", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("erase-order");
    const thread = await query<{ id: string }>(
      `insert into page_dm_threads (platform_account_id, platform_conversation_id, partner_platform_user_id)
       values ($1, $2, $2) returning id::text`,
      [pageId, FAN],
    );
    const threadId = Number(thread[0]!.id);
    const workId = await insertWork(pageId, { resource: "dm-messages.history", subject: FAN, kind: "goal", class: "requests" });
    const attemptId = await insertAttempt(pageId, { subject: FAN });
    const waiters = async () => (await query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`))[0]!.n;
    const waitFor = async (n: number) => {
      for (let attempt = 0; attempt < 250 && await waiters() < n; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await waiters()).toBeGreaterThanOrEqual(n);
    };
    const code = (error: unknown): string => String((error as { code?: unknown; cause?: { code?: unknown } }).code
      ?? (error as { cause?: { code?: unknown } }).cause?.code ?? error);

    // A blocker on the fan's attempt row parks the erasure inside its run
    // (after the work target); an intake-ordered transaction then takes the
    // chat (`for key share`, as the fans' foreign key does) and the chat's
    // work. Were the erasure to reach the chat only when it deletes it, after
    // the work, each would wait for the other.
    const blocker = await testDb.pool.connect();
    const intake = await testDb.pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query("select id from sync_attempts where id = $1 for update", [attemptId]);
      const erasure = withEraser((app, operatorId) => executeErasure(app, { scopeType: "fan", platform: "fansly", fanRef: FAN }, {
        initiatedBy: operatorId,
      })).then(() => "ok", code);
      await waitFor(1);
      await intake.query("begin");
      const intakeOrder = (async () => {
        await intake.query("select id from page_dm_threads where id = $1 for key share", [threadId]);
        await intake.query("select id from sync_work where id = $1 for update", [workId]);
        await intake.query("commit");
        return "ok";
      })().catch(async (error: unknown) => {
        await intake.query("rollback");
        return code(error);
      });
      await waitFor(2);
      await blocker.query("commit");
      expect(await Promise.all([erasure, intakeOrder])).toEqual(["ok", "ok"]);
    } finally {
      blocker.release();
      intake.release();
    }
    expect(await query("select id from sync_work")).toEqual([]);
    expect(await query("select id from page_dm_threads")).toEqual([]);
  });

  it("a fan erasure removes the chat files of the fan's descriptions still waiting in the media handoff, and no other's", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("erase-fan-media");
    const bytes = Buffer.from("jpeg");
    const fans = await insertDescription(pageId, "m-fan", FAN);
    const others = await insertDescription(pageId, "m-other", OTHER_FAN);
    const creators = await insertDescription(pageId, "m-model", null);
    for (const description of [fans, others, creators]) {
      await storeSyncMediaHandoff(db(), { pageId, descriptionId: description, workId: 1, contentType: null, bytes });
    }
    await withEraser(async (app, operatorId) => {
      const scope = { scopeType: "fan" as const, platform: "fansly" as const, fanRef: FAN };
      const plan = await planErasure(app, scope);
      const targets = new Map(plan.targets.map((target) => [`${target.plane}:${target.target}:${target.action}`, target.rows]));
      expect(targets.get("hot:sync_media_handoff:delete")).toBe(1);
      const result = await executeErasure(app, scope, { initiatedBy: operatorId });
      expect(result.executedCounts["hot:sync_media_handoff:delete"]).toBe(1);
    });
    const left = await query<{ description_id: string }>("select description_id::text from sync_media_handoff order by description_id");
    expect(left.map((row) => Number(row.description_id))).toEqual([others, creators]);
  });

  it("a page erasure removes the page's engine row, work and attempts, and only that page's", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("erase-page");
    const other = await seedPage("erase-page-other");
    for (const page of [pageId, other]) {
      await insertWork(page, { subject: "g" });
      await insertAttempt(page, { evidence: true });
      const description = await insertDescription(page, `m-${page}`, null);
      await storeSyncMediaHandoff(db(), { pageId: page, descriptionId: description, workId: 1, contentType: null, bytes: Buffer.from("x") });
      const request = await insertHistoryRequest(page, 1);
      await insertHistoryItem(request, page, 0, { input_kind: "conversation_ref", input_ref: "g", conversation_ref: "g" });
      // Its hold set: a credentials hold and a breaker.
      await setPageHold(db(), { pageId: page, kind: "auth", until: "infinity", detail: { credentialsGeneration: "gen-a" } });
      await setResourceHold(db(), { pageId: page, file: "transactions", hold: { until: new Date(Date.now() + 60_000), step: 1 } });
    }
    await withEraser(async (app, operatorId) => {
      const scope = { scopeType: "page" as const, pageLabel: "erase-page" };
      const plan = await planErasure(app, scope);
      const targets = new Map(plan.targets.map((target) => [`${target.plane}:${target.target}:${target.action}`, target.rows]));
      expect(targets.get("hot:sync_pages:delete")).toBe(1);
      expect(targets.get("hot:sync_holds:delete")).toBe(2);
      expect(targets.get("hot:sync_work:delete")).toBe(1);
      expect(targets.get("hot:sync_attempts:delete")).toBe(1);
      await executeErasure(app, scope, { initiatedBy: operatorId });
    });
    for (const table of ["sync_pages", "sync_work", "sync_attempts", "history_requests", "history_request_items", "sync_media_handoff"]) {
      expect(await query(`select page_id::int from ${table}`), table).toEqual([{ page_id: other }]);
    }
    expect(await query("select page_id::int, kind from sync_holds order by kind")).toEqual([
      { page_id: other, kind: "auth" },
      { page_id: other, kind: "resource_breaker" },
    ]);
  });
});
