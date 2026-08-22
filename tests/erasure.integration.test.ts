import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  createOrGetOfapiCommand,
  ERASURE_EXECUTION_PROTOCOL,
  insertErasureLog,
} from "@agency_hub_core/db";

import {
  erasureScopeRef,
  executeErasure,
  planErasure,
  withErasureExecutionLock,
} from "../apps/runtime/src/services/erasure/index.ts";
import { rebuildFanEarningsProjection } from "../apps/runtime/src/services/projections/fan-earnings.ts";
import {
  TIERED_TABLES,
  ndjsonToParquet as ndjsonFileToParquet,
  readParquetIds,
} from "../apps/runtime/src/services/tiering/index.ts";
import {
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

// Stage 28 Task 4 — the synthetic-fan erasure drill. Fan A (the target) and
// fan B (the bystander) share a page; A's facts are spread across every
// plane the erasure must reach: hot relational tables, attached ledger
// partitions, a detached-but-parked partition in tiered_pending_drop, and
// Parquet lake files. One shared observation carries BOTH fans' lineage —
// it must survive and be reported, not silently kept or wrongly deleted.
const FAN_A = "111000111";
const FAN_B = "222000222";

let testDb: StartedTestDatabase | null = null;
let lakeDir = "";
let pageId = 0;
let fanAId = 0;
let fanBId = 0;
let ownerId = 0;
const scope = { scopeType: "fan", platform: "onlyfans", fanRef: FAN_A } as const;

function appStub() {
  return {
    db: testDb!.db,
    pool: testDb!.pool,
    config: { lakeDir } as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

async function one<T>(text: string, params: unknown[] = []): Promise<T> {
  const { rows } = await testDb!.pool.query(text, params);
  return rows[0] as T;
}

async function count(text: string, params: unknown[] = []): Promise<number> {
  const row = await one<{ n: string }>(`select count(*)::text as n from ${text}`, params);
  return Number(row.n);
}

async function ndjsonToParquet(
  docs: Array<Record<string, unknown>>,
  parquetPath: string,
  columns: Record<string, string>,
): Promise<void> {
  const scratch = path.join(lakeDir, `seed-${path.basename(parquetPath)}.ndjson`);
  await writeFile(scratch, docs.map((doc) => JSON.stringify(doc)).join("\n") + "\n");
  await ndjsonFileToParquet(scratch, parquetPath, columns);
  await rm(scratch);
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function seedObservation(input: {
  kind: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  parseVersion?: number;
}): Promise<number> {
  const row = await one<{ id: string }>(
    `insert into observations (source, producer, platform, account_id, kind, payload,
                               payload_hash, idempotency_key, observed_at, received_at, parse_version)
     values ('webhook', 'ofapi:webhook', 'onlyfans', $1, $2, $3::jsonb, sha256($4::bytea), $4,
             now(), now(), $5)
     returning id::text as id`,
    [pageId, input.kind, JSON.stringify(input.payload), input.idempotencyKey, input.parseVersion ?? 1],
  );
  await testDb!.pool.query(
    `insert into observation_keys (source, idempotency_key, observation_id, received_at)
     values ('webhook', $1, $2, now())`,
    [input.idempotencyKey, Number(row.id)],
  );
  return Number(row.id);
}

async function seedEvent(input: {
  seq: number;
  type: string;
  fanRef: string | null;
  conversationRef: string | null;
  observationId: number;
}): Promise<number> {
  const dedup = `drill:${input.seq}`;
  const row = await one<{ id: string }>(
    `insert into domain_events (account_id, account_seq, type, occurred_at, fan_identity_ref,
                                conversation_ref, data, schema_version, observation_id, dedup_key)
     values ($1, $2, $3, now(), $4, $5, '{}'::jsonb, 1, $6, $7)
     returning id::text as id`,
    [pageId, input.seq, input.type, input.fanRef, input.conversationRef, input.observationId, dedup],
  );
  await testDb!.pool.query(
    `insert into domain_event_keys (account_id, dedup_key, event_id, occurred_at)
     values ($1, $2, $3, now())`,
    [pageId, dedup, Number(row.id)],
  );
  return Number(row.id);
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  lakeDir = await mkdtemp(path.join(tmpdir(), "kernel-erasure-"));
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
  if (lakeDir) {
    await rm(lakeDir, { recursive: true, force: true });
  }
});

describe("erasure drill (Stage 28 Task 4)", () => {
  it("erases the synthetic fan from every plane; the bystander and shared lineage survive", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const db = testDb.db;

    // ── Seed: catalog, identities, per-fan hot rows.
    const model = await createModel(db, { slug: "erasure-model", name: "Erasure Model" });
    if (!model) {
      throw new Error("Failed to seed erasure model");
    }
    const page = await createOnlyFansPage(db, { modelId: model.id, label: "erasure-of" });
    if (!page) {
      throw new Error("Failed to seed erasure page");
    }
    pageId = page.id;
    ownerId = Number((await one<{ id: string }>(
      `insert into users (username, role) values ('erasure-owner', 'owner') returning id::text as id`,
    )).id);

    for (const [ref, name] of [[FAN_A, "Fan A"], [FAN_B, "Fan B"]] as const) {
      await testDb.pool.query(
        `insert into fans (platform, platform_user_id, username, display_name)
         values ('onlyfans', $1, $2, $2)`,
        [ref, name],
      );
    }
    fanAId = Number((await one<{ id: string }>(
      `select id::text as id from fans where platform_user_id = $1`, [FAN_A],
    )).id);
    fanBId = Number((await one<{ id: string }>(
      `select id::text as id from fans where platform_user_id = $1`, [FAN_B],
    )).id);

    for (const fanId of [fanAId, fanBId]) {
      await testDb.pool.query(
        `insert into page_fans (fan_id, platform_account_id) values ($1, $2)`,
        [fanId, pageId],
      );
    }
    await testDb.pool.query(
      `insert into fan_notes (fan_id, platform_account_id, body) values ($1, $2, 'whale, be gentle')`,
      [fanAId, pageId],
    );
    // RESTRICT FK to fans — the erasure must clear this BEFORE the fans row.
    await testDb.pool.query(
      `insert into fan_earnings_stats (account_id, fan_id, "window", gross_mills, observed_at, source_event_id)
       values ($1, $2, 'lifetime', 250000, now(), 1)`,
      [pageId, fanAId],
    );

    // DM thread + messages for both fans; a classifier verdict quoting A.
    for (const [fanId, ref] of [[fanAId, FAN_A], [fanBId, FAN_B]] as const) {
      await testDb.pool.query(
        `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id)
         values ($1, $2, $3)`,
        [pageId, fanId, ref],
      );
      const thread = await one<{ id: string }>(
        `select id::text as id from page_dm_threads where platform_conversation_id = $1`, [ref],
      );
      await testDb.pool.query(
        `insert into page_dm_messages (conversation_id, platform_account_id, platform_message_id,
                                       sender_platform_user_id, sender_role, created_at, content)
         values ($1, $2, $3, $4, 'fan', now(), 'hey')`,
        [Number(thread.id), pageId, `msg-${ref}`, ref],
      );
      await testDb.pool.query(
        `insert into wb_closing_cache (platform_account_id, platform_message_id, content_hash,
                                       needs_reply, layer, reason)
         values ($1, $2, 'h', true, 'l2', 'fan asked about customs')`,
        [pageId, `msg-${ref}`],
      );
    }

    // Archive rows: received-from-A, sent-to-A (conversation only), and B's.
    for (const [ref, native, mine] of [
      [FAN_A, FAN_A, false],
      [FAN_A, null, true],
      [FAN_B, FAN_B, false],
    ] as const) {
      await testDb.pool.query(
        `insert into message_archive (account_id, platform, conversation_ref, message_ref,
                                      fan_native_id, is_sent_by_me, occurred_at, text_plain)
         values ($1, 'onlyfans', $2, $3, $4, $5, now(), 'archived text')`,
        [pageId, ref, `arch-${ref}-${mine ? "out" : "in"}`, native, mine],
      );
    }
    await testDb.pool.query(
      `insert into dm_message_archive (platform, platform_account_id, ofapi_account_id,
         platform_conversation_id, fan_platform_user_id, platform_message_id, source,
         source_event_type, source_idempotency_key, source_journal_id, source_received_at,
         retain_until)
       values ('onlyfans', $1, 'acct_erasure1', $2, $2, 'dm-1', 'webhook',
               'messages.received', 'idem-dm-1', 1, now(), now() + interval '10 years')`,
      [pageId, FAN_A],
    );
    await createOrGetOfapiCommand(db, {
      id: randomUUID(),
      clientCommandId: randomUUID(),
      pageId,
      chatterUserId: ownerId,
      ofapiAccountId: "acct_erasure1",
      conversationId: FAN_A,
      kind: "send_text_message_v1",
      payload: { text: "our side of the conversation" },
      payloadHash: "b".repeat(64),
    });

    // Transactions: A's is anonymized (money stays), B's untouched.
    for (const [fanId, ref, txn] of [[fanAId, FAN_A, "txn-a"], [fanBId, FAN_B, "txn-b"]] as const) {
      await testDb.pool.query(
        `insert into transactions (platform_account_id, fan_id, transaction_id, correlation_account_id,
           sender_id, raw_type, canonical_type, transaction_state, raw_status, gross_amount_mills,
           source_destination_amount_mills, creator_net_amount_mills, occurred_at, source)
         values ($1, $2, $3, $4, $4, 'tip', 'tip', 'posted', 'done', 10000, 10000, 8000, now(), 'ofapi:webhook')`,
        [pageId, fanId, txn, ref],
      );
    }

    // Restricted AI generations (Stage 29). A's coach/recap row uses the
    // CANONICAL shape (conversation_ref = groupId, fan_ref = A) — reachable
    // only via fan_ref (Blocker 1); a legacy A row keyed by conversation_ref =
    // A must still go; B's row (any shape) must survive. An acceptance event
    // resolves through A's canonical generation and cascades with it.
    for (const [genRef, convRef, fanRef] of [
      ["gen-a-canonical", "group-A", FAN_A],
      ["gen-a-legacy", FAN_A, null],
      ["gen-b-canonical", "group-B", FAN_B],
    ] as const) {
      await testDb.pool.query(
        `insert into ai_generation_content (generation_ref, feature, model, provider,
           page_id, conversation_ref, fan_ref, prompt_blocks, completion, params)
         values ($1, 'coach-chat', 'm', 'anthropic', $2, $3, $4, '[]'::jsonb, 'answer', '{}'::jsonb)`,
        [genRef, pageId, convRef, fanRef],
      );
    }
    await testDb.pool.query(
      `insert into ai_acceptance_events (generation_ref, lifecycle, occurred_at)
       values ('gen-a-canonical', 'shown', now())`,
    );

    // ── Ledger (hot): exclusive, shared, payload-only, and bystander rows.
    const obsExclusive = await seedObservation({
      kind: "messages.received",
      payload: { user_id: FAN_A, text: "hello" },
      idempotencyKey: "obs-exclusive",
    });
    const obsShared = await seedObservation({
      kind: "fans.batch",
      payload: { users: [FAN_A, FAN_B] },
      idempotencyKey: "obs-shared",
    });
    const obsPayloadOnly = await seedObservation({
      kind: "users.typing",
      payload: { user_id: FAN_A },
      idempotencyKey: "obs-typing",
      parseVersion: 0,
    });
    const obsBystander = await seedObservation({
      kind: "messages.received",
      payload: { user_id: FAN_B, text: "hi" },
      idempotencyKey: "obs-bystander",
    });
    await seedEvent({ seq: 1, type: "message.received", fanRef: FAN_A, conversationRef: FAN_A, observationId: obsExclusive });
    await seedEvent({ seq: 2, type: "fan.seen", fanRef: FAN_A, conversationRef: null, observationId: obsShared });
    await seedEvent({ seq: 3, type: "fan.seen", fanRef: FAN_B, conversationRef: null, observationId: obsShared });
    await seedEvent({ seq: 4, type: "message.received", fanRef: FAN_B, conversationRef: FAN_B, observationId: obsBystander });
    await testDb.pool.query(
      `insert into domain_event_seq (account_id, next_seq) values ($1, 5)
       on conflict (account_id) do update set next_seq = 5`,
      [pageId],
    );

    // ── Ledger (parked): a detached partition the parent DELETE can't reach.
    await testDb.pool.query(`create schema if not exists tiered_pending_drop`);
    await testDb.pool.query(
      `create table tiered_pending_drop.domain_events_2024_02 (like domain_events including all)`,
    );
    await testDb.pool.query(
      `create table tiered_pending_drop.observations_2024_02 (like observations including all)`,
    );
    await testDb.pool.query(
      `insert into tiered_pending_drop.observations_2024_02
         (id, source, producer, platform, account_id, kind, payload, payload_hash,
          idempotency_key, received_at, parse_version)
       overriding system value
       select v.id, 'webhook', 'ofapi:webhook', 'onlyfans', $1, 'messages.received',
              v.payload::jsonb, sha256(v.key::bytea), v.key, now(), 1
       from (values (7001, '{"user_id": "${FAN_A}"}', 'parked-a'),
                    (7002, '{"user_id": "${FAN_B}"}', 'parked-b')) as v(id, payload, key)`,
      [pageId],
    );
    await testDb.pool.query(
      `insert into tiered_pending_drop.domain_events_2024_02
         (id, account_id, account_seq, type, occurred_at, fan_identity_ref, data,
          schema_version, observation_id, dedup_key)
       overriding system value
       select v.id, $1, v.seq, 'message.received', now(), v.ref, '{}'::jsonb, 1, v.obs, v.dedup
       from (values (6001, 101, '${FAN_A}', 7001, 'parked:1'),
                    (6002, 102, '${FAN_B}', 7002, 'parked:2')) as v(id, seq, ref, obs, dedup)`,
      [pageId],
    );

    // ── Lake: Parquet + manifests for both ledgers, A and B rows in each.
    const eventSpec = TIERED_TABLES.find((spec) => spec.table === "domain_events")!;
    const obsSpec = TIERED_TABLES.find((spec) => spec.table === "observations")!;
    const eventsDir = path.join(lakeDir, "ledger", "domain_events", "2024");
    const obsDir = path.join(lakeDir, "capture", "observations", "2024");
    await mkdir(eventsDir, { recursive: true });
    await mkdir(obsDir, { recursive: true });

    const lakeEventRow = (id: number, ref: string, obs: number) => ({
      id,
      account_id: pageId,
      account_seq: id,
      type: "message.received",
      occurred_at: "2024-01-10T00:00:00Z",
      fan_identity_ref: ref,
      conversation_ref: ref,
      message_ref: null,
      transaction_ref: null,
      data: {},
      schema_version: 1,
      observation_id: obs,
      dedup_key: `lake:${id}`,
      created_at: "2024-01-10T00:00:00Z",
    });
    const lakeObsRow = (id: number, ref: string) => ({
      id,
      source: "webhook",
      producer: "ofapi:webhook",
      platform: "onlyfans",
      account_id: pageId,
      native_account_ref: null,
      kind: "messages.received",
      payload: { user_id: ref },
      payload_hash: "00",
      idempotency_key: `lake-${id}`,
      observed_at: "2024-01-10T00:00:00Z",
      received_at: "2024-01-10T00:00:00Z",
      actor_principal_id: null,
      parse_version: 1,
    });
    await ndjsonToParquet(
      [lakeEventRow(8001, FAN_A, 9001), lakeEventRow(8002, FAN_B, 9002)],
      path.join(eventsDir, "01.parquet"),
      eventSpec.columns,
    );
    await ndjsonToParquet(
      [lakeObsRow(9001, FAN_A), lakeObsRow(9002, FAN_B)],
      path.join(obsDir, "01.parquet"),
      obsSpec.columns,
    );
    for (const [dir, table, lo, hi] of [
      [eventsDir, "domain_events", 8001, 8002],
      [obsDir, "observations", 9001, 9002],
    ] as const) {
      await writeFile(path.join(dir, "01.manifest.json"), JSON.stringify({
        table,
        partition: `${table}_2024_01`,
        rowCount: 2,
        restrictedRowCount: 0,
        minId: lo,
        maxId: hi,
        sha256: await sha256File(path.join(dir, "01.parquet")),
        restrictedSha256: null,
        exportedAt: "2024-02-01T00:00:00Z",
      }, null, 2));
    }

    // ── Dry run: the plan sees every plane; the shared observation is
    // reported, not targeted.
    const plan = await planErasure(appStub(), scope);
    expect(plan.scopeRef).toBe(erasureScopeRef(scope));
    expect(plan.sharedObservations).toBe(1);
    const planRows = new Map(plan.targets.map((target) => [
      `${target.plane}:${target.target}:${target.action}`,
      target.rows,
    ]));
    expect(planRows.get("hot:page_dm_threads:delete")).toBe(1);
    expect(planRows.get("hot:page_dm_messages:cascade")).toBe(1);
    expect(planRows.get("hot:wb_closing_cache:delete")).toBe(1);
    expect(planRows.get("hot:fan_earnings_stats:delete")).toBe(1);
    expect(planRows.get("hot:message_archive:delete")).toBe(2); // in + out
    expect(planRows.get("hot:dm_message_archive:delete")).toBe(1);
    expect(planRows.get("hot:ofapi_commands:delete")).toBe(1);
    // A's canonical (via fan_ref) + legacy (via conversation_ref) generations;
    // B's survives. The acceptance event resolves through A's generations.
    expect(planRows.get("hot:ai_generation_content:delete")).toBe(2);
    expect(planRows.get("hot:ai_acceptance_events:delete")).toBe(1);
    expect(planRows.get("hot:transactions:anonymize")).toBe(1);
    expect(planRows.get("hot:fan_notes:cascade")).toBe(1);
    expect(planRows.get("hot:page_fans:cascade")).toBe(1);
    expect(planRows.get("hot:fans:delete")).toBe(1);
    expect(planRows.get("ledger:domain_events:delete")).toBe(2); // e1 + e2
    expect(planRows.get("ledger:observations:delete")).toBe(2); // exclusive + payload-only
    expect(planRows.get("ledger:tiered_pending_drop.domain_events_2024_02:delete")).toBe(1);
    expect(planRows.get("ledger:tiered_pending_drop.observations_2024_02:delete")).toBe(1);
    expect(planRows.get("ledger:domain_event_keys:delete")).toBe(2);
    expect(planRows.get("ledger:observation_keys:delete")).toBe(2);
    expect(planRows.get("lake:ledger/domain_events/2024/01.parquet:rewrite")).toBe(1);
    expect(planRows.get("lake:capture/observations/2024/01.parquet:rewrite")).toBe(1);

    // ── Execute. Nothing changed between plan and execute, so the executed
    // counts must equal the dry-run plan exactly.
    const result = await executeErasure(appStub(), scope, { initiatedBy: ownerId });
    for (const [key, rows] of planRows) {
      expect(result.executedCounts[key], key).toBe(rows);
    }

    // Hot: A gone with cascades; B intact.
    expect(await count(`fans where id = ${fanAId}`)).toBe(0);
    expect(await count(`fans where id = ${fanBId}`)).toBe(1);
    expect(await count(`fan_notes`)).toBe(0);
    expect(await count(`fan_earnings_stats`)).toBe(0);
    expect(await count(`page_fans`)).toBe(1);
    expect(await count(`page_dm_threads`)).toBe(1);
    expect(await count(`page_dm_messages`)).toBe(1);
    expect(await count(`wb_closing_cache where platform_message_id = 'msg-${FAN_A}'`)).toBe(0);
    expect(await count(`wb_closing_cache where platform_message_id = 'msg-${FAN_B}'`)).toBe(1);
    expect(await count(`message_archive where fan_native_id = '${FAN_A}' or conversation_ref = '${FAN_A}'`)).toBe(0);
    expect(await count(`message_archive`)).toBe(1);
    expect(await count(`dm_message_archive`)).toBe(0);
    expect(await count(`ofapi_commands`)).toBe(0);

    // AI generations: A gone via BOTH fan_ref (canonical) and conversation_ref
    // (legacy); its acceptance event cascaded; B's canonical row survives.
    expect(await count(`ai_generation_content where fan_ref = '${FAN_A}'`)).toBe(0);
    expect(await count(`ai_generation_content where conversation_ref = '${FAN_A}'`)).toBe(0);
    expect(await count(`ai_generation_content where fan_ref = '${FAN_B}'`)).toBe(1);
    expect(await count(`ai_acceptance_events`)).toBe(0);
    // P1-1 (the case the report demanded, named explicitly): the CANONICAL shape
    // — conversation_ref = a groupId that is NOT the fan, fan_ref = the fan — is
    // deleted, reachable ONLY via fan_ref. This is exactly the row the writer now
    // persists for coach-chat / short recaps on Fansly (fanRef required), so a
    // fan's erasure provably reaches it and its groupId conversation_ref is gone.
    expect(await count(`ai_generation_content where generation_ref = 'gen-a-canonical'`)).toBe(0);
    expect(await count(`ai_generation_content where conversation_ref = 'group-A'`)).toBe(0);
    expect(await count(`ai_generation_content where conversation_ref = 'group-B'`)).toBe(1);

    // A's transaction survives — anonymized; B's untouched.
    const txnA = await one<Record<string, unknown>>(
      `select fan_id, correlation_account_id, sender_id, gross_amount_mills::text as gross
       from transactions where transaction_id = 'txn-a'`,
    );
    expect(txnA).toMatchObject({
      fan_id: null,
      correlation_account_id: null,
      sender_id: null,
      gross: "10000",
    });
    const txnB = await one<{ fan_id: string }>(
      `select fan_id::text as fan_id from transactions where transaction_id = 'txn-b'`,
    );
    expect(Number(txnB.fan_id)).toBe(fanBId);

    // Ledger: A's events gone everywhere; the SHARED observation survives.
    expect(await count(`domain_events where fan_identity_ref = '${FAN_A}'`)).toBe(0);
    expect(await count(`domain_events`)).toBe(2); // e3 (B on shared) + e4
    expect(await count(`observations where id = ${obsExclusive}`)).toBe(0);
    expect(await count(`observations where id = ${obsPayloadOnly}`)).toBe(0);
    expect(await count(`observations where id = ${obsShared}`)).toBe(1);
    expect(await count(`observations where id = ${obsBystander}`)).toBe(1);
    expect(await count(`domain_event_keys`)).toBe(2);
    expect(await count(`observation_keys where observation_id in (${obsExclusive}, ${obsPayloadOnly})`)).toBe(0);
    expect(await count(`tiered_pending_drop.domain_events_2024_02`)).toBe(1);
    expect(await count(`tiered_pending_drop.observations_2024_02`)).toBe(1);
    expect(await count(`tiered_pending_drop.observations_2024_02 where id = 7002`)).toBe(1);

    // Lake: files rewritten in place — A filtered out, manifests re-stamped
    // with fresh counts, checksums, and an erasure record.
    expect(await readParquetIds(path.join(eventsDir, "01.parquet"))).toEqual([8002]);
    expect(await readParquetIds(path.join(obsDir, "01.parquet"))).toEqual([9002]);
    for (const dir of [eventsDir, obsDir]) {
      const manifest = JSON.parse(await readFile(path.join(dir, "01.manifest.json"), "utf8"));
      expect(manifest.rowCount).toBe(1);
      expect(manifest.sha256).toBe(await sha256File(path.join(dir, "01.parquet")));
      expect(manifest.erasures).toHaveLength(1);
      expect(manifest.erasures[0]).toMatchObject({
        scopeRef: plan.scopeRef,
        removedRows: 1,
      });
    }

    // Tombstone + audit: the log row completed with counts; the audit event
    // and its operator observation exist and are unreachable by a re-run
    // (account_id NULL).
    const log = await one<{ dry_run: boolean; executed_counts: Record<string, number>; completed: boolean }>(
      `select dry_run, executed_counts, completed_at is not null as completed
       from erasure_log where id = ${result.logId}`,
    );
    expect(log.dry_run).toBe(false);
    expect(log.completed).toBe(true);
    expect(log.executed_counts["hot:fans:delete"]).toBe(1);
    expect(log.executed_counts.sharedObservationsKept).toBe(1);
    expect(await count(
      `audit_events where event_type = 'erasure.executed' and actor_user_id = ${ownerId}`,
    )).toBe(1);
    expect(await count(
      `observations where source = 'operator' and kind = 'erasure.executed' and account_id is null`,
    )).toBe(1);

    // ── Idempotent re-run: converges to zero everywhere.
    const rerun = await executeErasure(appStub(), scope, { initiatedBy: ownerId });
    for (const value of Object.values(rerun.executedCounts)) {
      expect(value).toBe(0);
    }
    expect(rerun.plan.targets.filter((target) => target.plane === "lake")).toHaveLength(0);

    // ── Non-resurrection: replaying projections over what remains cannot
    // bring the fan back (the source facts are gone).
    await rebuildFanEarningsProjection(appStub());
    expect(await count(`fans where platform_user_id = '${FAN_A}'`)).toBe(0);
    expect(await count(`fan_earnings_stats`)).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("non-resurrection fence (PR4): swept journal rows and readthrough observations cannot recreate erased rows; new facts still flow", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { setPageOfapiAccountId, insertObservation, tombstoneDmMessageArchive } =
      await import("@agency_hub_core/db");
    const { sweepOfapiDmColdArchives, runOfapiDmColdArchiveForSettledRow } =
      await import("../apps/runtime/src/services/ofapi-dm-archive.ts");
    const { sweepOfapiDmProjections } =
      await import("../apps/runtime/src/services/ofapi-dm-projection.ts");
    const { runOfapiDmReadthroughReconcile } =
      await import("../apps/runtime/src/services/ofapi-dm-readthrough.ts");
    const { OFAPI_READTHROUGH_OBSERVATION_KIND } =
      await import("../apps/runtime/src/services/health-floors.ts");

    const FAN_F = "444000444";
    const model = await createModel(testDb.db, { slug: "fence", name: "Fence" });
    const page = model
      ? await createOnlyFansPage(testDb.db, { modelId: model.id, label: "fence-of" })
      : undefined;
    if (!page) {
      throw new Error("Failed to seed fence page");
    }
    await setPageOfapiAccountId(testDb.db, { pageId: page.id, ofapiAccountId: "acct_fence" });
    const operator = await one<{ id: string }>(
      `insert into users (username, role) values ('fence-owner', 'owner') returning id::text as id`,
    );

    const fenceStub = () => ({
      db: testDb!.db,
      config: {
        lakeDir,
        ofapiDmColdArchiveEnabled: true,
        ofapiDmColdArchiveRetentionDays: 36500,
        ofapiDmProjectionEnabled: true,
        ofapiDmReadthroughReconcileEnabled: true,
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    }) as never;

    const messagePayload = (id: number, createdAt: string) => ({
      event: "messages.received",
      account_id: "acct_fence",
      payload: {
        id,
        text: `<p>msg ${id}</p>`,
        createdAt,
        fromUser: { id: Number(FAN_F), username: "fencefan", name: "Fence Fan" },
      },
    });
    const seedJournalRow = async (input: {
      key: string;
      messageId: number;
      createdAt: string;
      archiveStatus: string;
      projectionStatus: string;
      archiveAttempts?: number;
    }) => {
      const row = await one<{ id: string }>(
        `insert into ofapi_webhook_events
           (idempotency_key, event_type, ofapi_account_id, platform_account_id, payload,
            status, archive_status, archive_attempts, projection_status, received_at, processed_at)
         values ($1, 'messages.received', 'acct_fence', $2, $3::jsonb,
                 'processed', $4, $5, $6, now(), now())
         returning id::text as id`,
        [
          input.key,
          page.id,
          JSON.stringify(messagePayload(input.messageId, input.createdAt)),
          input.archiveStatus,
          input.archiveAttempts ?? 0,
          input.projectionStatus,
        ],
      );
      return Number(row.id);
    };

    // Pre-erasure facts across all three journal states the spec names:
    // settle-path 'none' (claimed pending then run), sweep-retryable
    // 'failed', and 'already-claimed' pending — all retained (the journal is
    // never an erasure target) and all replayable.
    const settleId = await seedJournalRow({
      key: "fence-settle", messageId: 40001, createdAt: "2026-07-01T10:00:00+00:00",
      archiveStatus: "none", projectionStatus: "pending",
    });
    const failedId = await seedJournalRow({
      key: "fence-failed", messageId: 40002, createdAt: "2026-07-01T10:01:00+00:00",
      archiveStatus: "failed", projectionStatus: "failed", archiveAttempts: 1,
    });
    const claimedId = await seedJournalRow({
      key: "fence-claimed", messageId: 40007, createdAt: "2026-07-01T10:05:00+00:00",
      archiveStatus: "pending", projectionStatus: "pending",
    });
    // An unprojected v2 readthrough observation seeded BEFORE the erasure —
    // the envelope's conversationRef is the load-bearing ref-match handle.
    const preObs = await insertObservation(testDb.db, {
      source: "readthrough",
      producer: "read-gateway",
      platform: "onlyfans",
      accountId: page.id,
      kind: OFAPI_READTHROUGH_OBSERVATION_KIND,
      payload: {
        ofapiAccountId: "acct_fence",
        chatId: FAN_F,
        conversationRef: FAN_F,
        cursors: {},
        body: { data: [{ id: 40003, text: "old rest", isSentByMe: false, createdAt: "2026-07-01T10:02:00+00:00" }] },
      },
      payloadHash: Buffer.alloc(32),
      idempotencyKey: "fence-rt-pre",
    });

    const erased = await executeErasure(
      appStub(),
      { scopeType: "fan", platform: "onlyfans", fanRef: FAN_F },
      { initiatedBy: Number(operator.id) },
    );
    expect(erased.plan.resolvedPageIds).toContain(page.id);
    // The pre-erasure v2 observation was reached via the payload ref-match.
    expect(await count(`observations where id = ${preObs.observationId}`)).toBe(0);
    // WAIVER (pre-existing, owner decision pending — not silently inherited):
    // ofapi_webhook_events.payload is NOT an erasure target anywhere.
    expect(await count(`ofapi_webhook_events where id in (${settleId}, ${failedId}, ${claimedId})`)).toBe(3);

    // Settle path replays the 'none' row; the sweeps replay the rest —
    // the fence terminates all of them.
    await runOfapiDmColdArchiveForSettledRow(fenceStub(), {
      id: settleId,
      idempotencyKey: "fence-settle",
      eventType: "messages.received",
      ofapiAccountId: "acct_fence",
      payload: messagePayload(40001, "2026-07-01T10:00:00+00:00") as never,
      fanoutSeq: null,
      receivedAt: new Date(),
      archiveStatus: "none",
      archiveAttempts: 0,
    });
    await sweepOfapiDmColdArchives(fenceStub());
    await sweepOfapiDmProjections(fenceStub());
    expect(await count(
      `dm_message_archive where fan_platform_user_id = '${FAN_F}' or platform_conversation_id = '${FAN_F}'`,
    )).toBe(0);
    expect(await count(`page_dm_threads t where t.platform_conversation_id = '${FAN_F}'`)).toBe(0);
    const settleRow = await one<{ archive_status: string; archive_error: string; projection_status: string; projection_error: string }>(
      `select archive_status, archive_error, projection_status, projection_error
       from ofapi_webhook_events where id = ${settleId}`,
    );
    expect(settleRow).toMatchObject({
      archive_status: "skipped",
      archive_error: "erasure_fenced",
      projection_status: "skipped",
      projection_error: "erasure_fenced",
    });
    const failedRow = await one<{ archive_status: string; archive_error: string }>(
      `select archive_status, archive_error from ofapi_webhook_events where id = ${failedId}`,
    );
    expect(failedRow).toMatchObject({ archive_status: "skipped", archive_error: "erasure_fenced" });
    // Already-claimed rows are another worker's business: untouched, and
    // still nothing resurrected.
    const claimedRow = await one<{ archive_status: string }>(
      `select archive_status from ofapi_webhook_events where id = ${claimedId}`,
    );
    expect(claimedRow).toMatchObject({ archive_status: "pending" });

    // A v2 readthrough RE-capture of pre-erasure material (post-erasure
    // observation, old createdAt) drops fenced items but still stamps —
    // the backlog floor never latches over rows that can never project.
    const postObs = await insertObservation(testDb.db, {
      source: "readthrough",
      producer: "read-gateway",
      platform: "onlyfans",
      accountId: page.id,
      kind: OFAPI_READTHROUGH_OBSERVATION_KIND,
      payload: {
        ofapiAccountId: "acct_fence",
        chatId: FAN_F,
        conversationRef: FAN_F,
        cursors: {},
        body: { data: [{ id: 40004, text: "old rest again", isSentByMe: false, createdAt: "2026-07-01T10:03:00+00:00" }] },
      },
      payloadHash: Buffer.alloc(32),
      idempotencyKey: "fence-rt-post",
    });
    const reconcile = await runOfapiDmReadthroughReconcile(fenceStub());
    expect(reconcile.drops).toBe(1);
    expect(reconcile.stamped).toBe(1);
    expect(await count(`dm_message_archive where platform_message_id = '40004'`)).toBe(0);
    const { OFAPI_READTHROUGH_HEALTH_FLOOR } =
      await import("../apps/runtime/src/services/health-floors.ts");
    const stampedObs = await one<{ parse_version: number }>(
      `select parse_version from observations where id = ${postObs.observationId}`,
    );
    expect(stampedObs.parse_version).toBe(OFAPI_READTHROUGH_HEALTH_FLOOR.version);

    // Tombstone-first-then-REST: the delete webhook carries no fan refs, so
    // the stub is UNREACHABLE by fan-scope predicates in both stores — the
    // DOCUMENTED CONTENTLESS SURVIVOR (message id only, no content). The
    // waiver stands only WITH the fence: the REST hydration that would give
    // it content is blocked.
    const stub = await tombstoneDmMessageArchive(testDb.db, {
      platform: "onlyfans",
      platformAccountId: page.id,
      ofapiAccountId: "acct_fence",
      platformMessageId: "40005",
      deletedAt: new Date(),
      source: "webhook",
      sourceEventType: "messages.deleted",
      sourceIdempotencyKey: "fence-del-40005",
      sourceJournalId: settleId,
      sourceReceivedAt: new Date(),
      retentionPolicy: "default",
      retainUntil: new Date("2126-01-01T00:00:00Z"),
    });
    expect(stub.status).toBe("written");
    await insertObservation(testDb.db, {
      source: "readthrough",
      producer: "read-gateway",
      platform: "onlyfans",
      accountId: page.id,
      kind: OFAPI_READTHROUGH_OBSERVATION_KIND,
      payload: {
        ofapiAccountId: "acct_fence",
        chatId: FAN_F,
        conversationRef: FAN_F,
        cursors: {},
        body: { data: [{ id: 40005, text: "content for the stub", isSentByMe: true, createdAt: "2026-07-01T10:04:00+00:00" }] },
      },
      payloadHash: Buffer.alloc(32),
      idempotencyKey: "fence-rt-stub",
    });
    const hydrate = await runOfapiDmReadthroughReconcile(fenceStub());
    expect(hydrate.drops).toBe(1);
    const survivor = await one<{ text_plain: string; created_null: boolean; deleted: boolean }>(
      `select text_plain, message_created_at is null as created_null, deleted_at is not null as deleted
       from dm_message_archive where platform_message_id = '40005'`,
    );
    expect(survivor).toMatchObject({ text_plain: "", created_null: true, deleted: true });

    // MATERIAL-TIME-BOUNDED (owner 2026-07-10): a NEW message from the
    // still-active erased fan — createdAt AFTER the erasure — flows
    // normally (DP-7 preserved; the fence cleans the PAST, not the fan).
    const freshCreatedAt = new Date(Date.now() + 1000).toISOString();
    await seedJournalRow({
      key: "fence-fresh", messageId: 40006, createdAt: freshCreatedAt,
      archiveStatus: "failed", projectionStatus: "none",
    });
    await sweepOfapiDmColdArchives(fenceStub());
    expect(await count(`dm_message_archive where platform_message_id = '40006' and deleted_at is null`)).toBe(1);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("fence survives a page rename, and fan erasure reaches REST-only/command-only/webhook-then-REST rows", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const {
      setPageOfapiAccountId,
      upsertDmMessageArchive,
      upsertDmMessageArchiveFromReadthrough,
    } = await import("@agency_hub_core/db");
    const { sweepOfapiDmColdArchives } =
      await import("../apps/runtime/src/services/ofapi-dm-archive.ts");

    const FAN_R = "555000555";
    const model = await createModel(testDb.db, { slug: "fence2", name: "Fence 2" });
    const page = model
      ? await createOnlyFansPage(testDb.db, { modelId: model.id, label: "fence-of-2" })
      : undefined;
    if (!page) {
      throw new Error("Failed to seed fence page 2");
    }
    await setPageOfapiAccountId(testDb.db, { pageId: page.id, ofapiAccountId: "acct_fence2" });
    const operator = await one<{ id: string }>(
      `insert into users (username, role) values ('fence-owner-2', 'owner') returning id::text as id`,
    );
    const fenceStub = () => ({
      db: testDb!.db,
      config: {
        lakeDir,
        ofapiDmColdArchiveEnabled: true,
        ofapiDmColdArchiveRetentionDays: 36500,
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    }) as never;

    // Rows sourced three ways: REST-only (source_journal_id NULL, refs
    // filled by the upsert — that fill is what makes fan-scope erasure
    // reach them), command-only, and webhook-then-REST.
    const restOnly = await upsertDmMessageArchiveFromReadthrough(testDb.db, {
      platform: "onlyfans",
      platformAccountId: page.id,
      ofapiAccountId: "acct_fence2",
      platformConversationId: FAN_R,
      fanPlatformUserId: FAN_R,
      platformMessageId: "50001",
      senderPlatformUserId: FAN_R,
      senderRole: "fan",
      isSentByMe: false,
      messageCreatedAt: new Date("2026-07-01T09:00:00Z"),
      textPlain: "rest only",
      isTip: false,
      tipAmountMills: 0n,
      mediaMetadata: [],
      observationId: 424242,
      observationReceivedAt: new Date("2026-07-01T09:00:01Z"),
      retentionPolicy: "default",
      retainUntil: new Date("2126-01-01T00:00:00Z"),
    });
    expect(restOnly.status).toBe("written");
    const commandOnly = await upsertDmMessageArchive(testDb.db, {
      platform: "onlyfans",
      platformAccountId: page.id,
      ofapiAccountId: "acct_fence2",
      platformConversationId: FAN_R,
      fanPlatformUserId: FAN_R,
      platformMessageId: "50002",
      senderPlatformUserId: null,
      senderRole: "model",
      isSentByMe: true,
      messageCreatedAt: new Date("2026-07-01T09:01:00Z"),
      textPlain: "command send",
      isTip: false,
      tipAmountMills: 0n,
      source: "command",
      sourceEventType: "messages.sent",
      sourceIdempotencyKey: "fence2-cmd-50002",
      sourceJournalId: 1,
      sourceReceivedAt: new Date("2026-07-01T09:01:01Z"),
      rawShapeVersion: "ofapi-message-v1",
      mediaMetadata: [],
      retentionPolicy: "default",
      retainUntil: new Date("2126-01-01T00:00:00Z"),
    });
    expect(commandOnly.status).toBe("written");
    const webhookRow = await upsertDmMessageArchive(testDb.db, {
      platform: "onlyfans",
      platformAccountId: page.id,
      ofapiAccountId: "acct_fence2",
      platformConversationId: FAN_R,
      fanPlatformUserId: FAN_R,
      platformMessageId: "50003",
      senderPlatformUserId: FAN_R,
      senderRole: "fan",
      isSentByMe: false,
      messageCreatedAt: new Date("2026-07-01T09:02:00Z"),
      textPlain: "webhook then rest",
      isTip: false,
      tipAmountMills: 0n,
      source: "webhook",
      sourceEventType: "messages.received",
      sourceIdempotencyKey: "fence2-wh-50003",
      sourceJournalId: 1,
      sourceReceivedAt: new Date("2026-07-01T09:02:01Z"),
      rawShapeVersion: "ofapi-message-v1",
      mediaMetadata: [],
      retentionPolicy: "default",
      retainUntil: new Date("2126-01-01T00:00:00Z"),
    });
    expect(webhookRow.status).toBe("written");
    const restAdvance = await upsertDmMessageArchiveFromReadthrough(testDb.db, {
      platform: "onlyfans",
      platformAccountId: page.id,
      ofapiAccountId: "acct_fence2",
      platformConversationId: FAN_R,
      fanPlatformUserId: FAN_R,
      platformMessageId: "50003",
      senderPlatformUserId: FAN_R,
      senderRole: "fan",
      isSentByMe: false,
      messageCreatedAt: new Date("2026-07-01T09:02:00Z"),
      textPlain: "webhook then rest",
      priceMills: 2000n,
      isTip: false,
      tipAmountMills: 0n,
      mediaMetadata: [],
      observationId: 424243,
      observationReceivedAt: new Date("2026-07-01T09:02:30Z"),
      retentionPolicy: "default",
      retainUntil: new Date("2126-01-01T00:00:00Z"),
    });
    expect(restAdvance.status).toBe("written");

    // Fan-scope erasure reaches all three sourcing shapes.
    await executeErasure(
      appStub(),
      { scopeType: "fan", platform: "onlyfans", fanRef: FAN_R },
      { initiatedBy: Number(operator.id) },
    );
    expect(await count(
      `dm_message_archive where fan_platform_user_id = '${FAN_R}' or platform_conversation_id = '${FAN_R}'`,
    )).toBe(0);

    // PAGE-scope erasure, then a rename: scope_ref is label-based and now
    // stale, but the fence matches the RESOLVED page ids in the plan.
    await one<{ id: string }>(
      `insert into ofapi_webhook_events
         (idempotency_key, event_type, ofapi_account_id, platform_account_id, payload,
          status, archive_status, projection_status, received_at, processed_at)
       values ('fence2-replay', 'messages.received', 'acct_fence2', $1, $2::jsonb,
               'processed', 'failed', 'none', now(), now())
       returning id::text as id`,
      [
        page.id,
        JSON.stringify({
          event: "messages.received",
          account_id: "acct_fence2",
          payload: {
            id: 50009,
            text: "<p>pre-erasure fact</p>",
            createdAt: "2026-07-01T09:03:00+00:00",
            fromUser: { id: Number(FAN_R) },
          },
        }),
      ],
    );
    await executeErasure(
      appStub(),
      { scopeType: "page", pageLabel: "fence-of-2" },
      { initiatedBy: Number(operator.id) },
    );
    await testDb.pool.query("update pages set label = 'fence-renamed' where id = $1", [page.id]);
    await sweepOfapiDmColdArchives(fenceStub());
    expect(await count(`dm_message_archive where platform_message_id = '50009'`)).toBe(0);
    const replayed = await one<{ archive_status: string; archive_error: string }>(
      `select archive_status, archive_error from ofapi_webhook_events where idempotency_key = 'fence2-replay'`,
    );
    expect(replayed).toMatchObject({ archive_status: "skipped", archive_error: "erasure_fenced" });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("fan erasure reaches REST-material lineage observations even when the payload text match misses (Wave 2)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { setPageOfapiAccountId, insertObservation, upsertDmMessageArchiveFromReadthrough } =
      await import("@agency_hub_core/db");
    const FAN_L = "666500666";
    const model = await createModel(testDb.db, { slug: "lineage", name: "Lineage" });
    const page = model
      ? await createOnlyFansPage(testDb.db, { modelId: model.id, label: "lineage-of" })
      : undefined;
    if (!page) {
      throw new Error("Failed to seed lineage page");
    }
    await setPageOfapiAccountId(testDb.db, { pageId: page.id, ofapiAccountId: "acct_lineage" });
    const operator = await one<{ id: string }>(
      `insert into users (username, role) values ('lineage-owner', 'owner') returning id::text as id`,
    );

    // An observation whose PAYLOAD does NOT contain the fan ref anywhere —
    // only rest_material_observation_id links it to the fan's row.
    const opaque = await insertObservation(testDb.db, {
      source: "readthrough",
      producer: "read-gateway",
      platform: "onlyfans",
      accountId: page.id,
      kind: "ofapi_gateway_chat_messages_v2",
      payload: { note: "opaque envelope, no fan ref in text" },
      payloadHash: Buffer.alloc(32),
      idempotencyKey: "lineage-opaque-1",
    });
    const written = await upsertDmMessageArchiveFromReadthrough(testDb.db, {
      platform: "onlyfans",
      platformAccountId: page.id,
      ofapiAccountId: "acct_lineage",
      platformConversationId: FAN_L,
      fanPlatformUserId: FAN_L,
      platformMessageId: "60001",
      senderPlatformUserId: FAN_L,
      senderRole: "fan",
      isSentByMe: false,
      messageCreatedAt: new Date("2026-07-03T09:00:00Z"),
      textPlain: "lineage message",
      isTip: false,
      tipAmountMills: 0n,
      mediaMetadata: [],
      observationId: opaque.observationId,
      observationReceivedAt: opaque.receivedAt,
      retentionPolicy: "default",
      retainUntil: new Date("2126-01-01T00:00:00Z"),
    });
    expect(written.status).toBe("written");

    await executeErasure(
      appStub(),
      { scopeType: "fan", platform: "onlyfans", fanRef: FAN_L },
      { initiatedBy: Number(operator.id) },
    );
    expect(await count(`dm_message_archive where fan_platform_user_id = '${FAN_L}'`)).toBe(0);
    // The opaque observation is gone via the rest-material lineage arm.
    expect(await count(`observations where id = ${opaque.observationId}`)).toBe(0);
    expect(await count(`observation_keys where observation_id = ${opaque.observationId}`)).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("page-scope erasure purges the page's secret/config rows (decision #118)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // Soft delete (#72) deliberately keeps page_credentials/egress_endpoints
    // for undelete; erasure is the one-way door and must purge them — before
    // #118 the encrypted secrets were present-but-unpurgeable forever.
    const model = await createModel(testDb.db, { slug: "erasure-118", name: "Erasure 118" });
    const page = model
      ? await createOnlyFansPage(testDb.db, { modelId: model.id, label: "erasure-118-page" })
      : undefined;
    if (!page) {
      throw new Error("Failed to seed #118 page");
    }
    await testDb.pool.query(
      `insert into page_credentials (platform_account_id, encrypted_session, key_version)
       values ($1, 'enc:drill-session', 1)`,
      [page.id],
    );
    await testDb.pool.query(
      `insert into egress_endpoints (platform_account_id, url)
       values ($1, 'socks5://proxy.example:1080')`,
      [page.id],
    );
    await testDb.pool.query(
      `insert into fans (platform, platform_user_id, username, display_name)
       values ('onlyfans', '333000333', 'Fan C', 'Fan C')`,
    );
    await testDb.pool.query(
      `insert into page_fans (fan_id, platform_account_id)
       select id, $1 from fans where platform_user_id = '333000333'`,
      [page.id],
    );
    const operator = await one<{ id: string }>(
      `insert into users (username, role) values ('erasure-118-owner', 'owner') returning id::text as id`,
    );

    const result = await executeErasure(
      appStub(),
      { scopeType: "page", pageLabel: "erasure-118-page" },
      { initiatedBy: Number(operator.id) },
    );
    expect(result.executedCounts["hot:page_credentials:delete"], "page_credentials target").toBe(1);
    expect(result.executedCounts["hot:egress_endpoints:delete"], "egress_endpoints target").toBe(1);
    expect(await count(`page_credentials where platform_account_id = ${page.id}`)).toBe(0);
    expect(await count(`egress_endpoints where platform_account_id = ${page.id}`)).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("page-scope erasure purges the page's voice notes (audio + metadata) and voice profile (0109)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // The voice-notes lane (migration 0109) is page-scoped: voice_notes carries
    // synthesized audio bytes, the source conversation ref, the chatter's user id
    // and provider metadata, and page_voice_profiles holds the page's voice
    // config. Neither rides a cascade when erasure keeps the pages catalog row
    // (voice_notes REFERENCES pages WITHOUT cascade; page_voice_profiles cascades
    // pages, which erasure preserves), so both are explicit page-hot targets.
    // This drill proves the stored audio and the profile are gone afterwards.
    const model = await createModel(testDb.db, { slug: "erasure-voice", name: "Erasure Voice" });
    const page = model
      ? await createOnlyFansPage(testDb.db, { modelId: model.id, label: "erasure-voice-page" })
      : undefined;
    if (!page) {
      throw new Error("Failed to seed voice erasure page");
    }
    const operator = await one<{ id: string }>(
      `insert into users (username, role) values ('erasure-voice-owner', 'owner') returning id::text as id`,
    );

    await testDb.pool.query(
      `insert into page_voice_profiles (platform_account_id, voice_id) values ($1, 'voice-erasure')`,
      [page.id],
    );
    // A completed note with real audio bytes — the row an erasure must reach.
    await testDb.pool.query(
      `insert into voice_notes (
         user_id, platform_account_id, conversation_ref, source_generation_ref,
         client_request_id, request_hash, script_chars, original_script_sha256,
         final_script_sha256, script_edited, profile_voice_id, profile_model,
         profile_settings, profile_output_format, profile_version, state, billed,
         billed_chars, audio_bytes, audio_sha256, audio_bytes_len)
       values (7373, $1, 'conv-erase', 'gen-erase', $2, 'hash-erase', 120, $3, $3, false,
               'voice-erasure', 'eleven_v3', '{}'::jsonb, 'mp3_44100_128', 1, 'completed',
               true, 120, $4, $5, 13)`,
      [page.id, randomUUID(), "a".repeat(64), Buffer.from("audio-payload"), "c".repeat(64)],
    );
    // Precondition: the audio really is present, so a zero-count afterwards means
    // it was purged (not merely never seeded).
    expect(await count(`voice_notes where platform_account_id = ${page.id} and audio_bytes is not null`)).toBe(1);
    expect(await count(`page_voice_profiles where platform_account_id = ${page.id}`)).toBe(1);

    const result = await executeErasure(
      appStub(),
      { scopeType: "page", pageLabel: "erasure-voice-page" },
      { initiatedBy: Number(operator.id) },
    );
    expect(result.executedCounts["hot:voice_notes:delete"], "voice_notes target").toBe(1);
    expect(result.executedCounts["hot:page_voice_profiles:delete"], "page_voice_profiles target").toBe(1);
    expect(await count(`voice_notes where platform_account_id = ${page.id}`)).toBe(0);
    expect(await count(`page_voice_profiles where platform_account_id = ${page.id}`)).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("page-scope erasure purges the page's link-stat runs and snapshots (0111)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // Link-stats lane (migration 0111): both tables are page-scoped with
    // RESTRICT FKs, so neither rides a cascade when erasure keeps the pages
    // catalog row — both are explicit page-hot targets (snapshots before runs).
    const model = await createModel(testDb.db, { slug: "erasure-links", name: "Erasure Links" });
    const page = model
      ? await createOnlyFansPage(testDb.db, { modelId: model.id, label: "erasure-links-page" })
      : undefined;
    if (!page) {
      throw new Error("Failed to seed link-stats erasure page");
    }
    const operator = await one<{ id: string }>(
      `insert into users (username, role) values ('erasure-links-owner', 'owner') returning id::text as id`,
    );

    const run = await one<{ id: string }>(
      `insert into page_link_stat_runs (
         platform_account_id, link_kind, status, pulled_at, api_pages, raw_items, written_rows)
       values ($1, 'tracking', 'complete', now(), 1, 1, 1) returning id::text as id`,
      [page.id],
    );
    await testDb.pool.query(
      `insert into page_link_stat_snapshots (
         run_id, platform_account_id, link_kind, platform_link_id, name, url,
         clicks_count, subscribers_count)
       values ($1, $2, 'tracking', '42', 'reddit_rsr', 'https://onlyfans.com/x/c1', 10, 2)`,
      [run.id, page.id],
    );
    expect(await count(`page_link_stat_snapshots where platform_account_id = ${page.id}`)).toBe(1);
    expect(await count(`page_link_stat_runs where platform_account_id = ${page.id}`)).toBe(1);

    const result = await executeErasure(
      appStub(),
      { scopeType: "page", pageLabel: "erasure-links-page" },
      { initiatedBy: Number(operator.id) },
    );
    expect(
      result.executedCounts["hot:page_link_stat_snapshots:delete"],
      "page_link_stat_snapshots target",
    ).toBe(1);
    expect(
      result.executedCounts["hot:page_link_stat_runs:delete"],
      "page_link_stat_runs target",
    ).toBe(1);
    expect(await count(`page_link_stat_snapshots where platform_account_id = ${page.id}`)).toBe(0);
    expect(await count(`page_link_stat_runs where platform_account_id = ${page.id}`)).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("fan-scope erasure purges the fan's voice notes (audio + metadata); a co-resident different fan's note survives (0109)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // Fan-scope erasure must reach voice_notes the same way it reaches
    // ai_generation_content: keyed platform_account_id ∈ pageIds AND
    // conversation_ref = fanRef. A voice_note carries up to 2 MiB of rendered
    // audio addressed to that fan plus a source_generation_ref into an
    // ai_generation_content row this same erasure deletes — and it has NO FK to
    // `fans`, so the unmapped-FK guard cannot catch the omission. This drill pins
    // the explicit fan-hot target: the erased fan's note (row AND audio) is gone,
    // while a co-resident DIFFERENT fan's note on the same page survives — proving
    // conversation_ref selectivity, not merely page scope.
    const TARGET_FAN = "909000909";
    const OTHER_FAN = "808000808";
    const model = await createModel(testDb.db, { slug: "erasure-voice-fan", name: "Erasure Voice Fan" });
    const page = model
      ? await createOnlyFansPage(testDb.db, { modelId: model.id, label: "erasure-voice-fan-page" })
      : undefined;
    if (!page) {
      throw new Error("Failed to seed voice fan erasure page");
    }
    const operator = await one<{ id: string }>(
      `insert into users (username, role) values ('erasure-voice-fan-owner', 'owner') returning id::text as id`,
    );

    const seedNote = async (conversationRef: string) => {
      await testDb!.pool.query(
        `insert into voice_notes (
           user_id, platform_account_id, conversation_ref, source_generation_ref,
           client_request_id, request_hash, script_chars, original_script_sha256,
           final_script_sha256, script_edited, profile_voice_id, profile_model,
           profile_settings, profile_output_format, profile_version, state, billed,
           billed_chars, audio_bytes, audio_sha256, audio_bytes_len)
         values (7474, $1, $2, 'gen-' || $2, $3, 'hash-' || $2, 120, $4, $4, false,
                 'voice-erasure', 'eleven_v3', '{}'::jsonb, 'mp3_44100_128', 1, 'completed',
                 true, 120, $5, $6, 13)`,
        [page.id, conversationRef, randomUUID(), "a".repeat(64), Buffer.from("audio-payload"), "c".repeat(64)],
      );
    };
    await seedNote(TARGET_FAN);
    await seedNote(OTHER_FAN);

    // Precondition: both notes present WITH audio, so a zero afterwards means the
    // row was purged (not merely never seeded).
    expect(await count(`voice_notes where platform_account_id = ${page.id} and audio_bytes is not null`)).toBe(2);

    const result = await executeErasure(
      appStub(),
      { scopeType: "fan", platform: "onlyfans", fanRef: TARGET_FAN },
      { initiatedBy: Number(operator.id) },
    );
    expect(result.executedCounts["hot:voice_notes:delete"], "voice_notes fan target").toBe(1);
    // The target fan's note — its row and its audio bytes — is gone…
    expect(await count(`voice_notes where conversation_ref = '${TARGET_FAN}'`)).toBe(0);
    // …and the OTHER fan's note (same page) survives, audio intact.
    expect(await count(`voice_notes where conversation_ref = '${OTHER_FAN}' and audio_bytes is not null`)).toBe(1);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("fan-scope erasure purges Fansly voice and AI rows keyed by the messaging GROUP id (0109 / A49)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // On Fansly the extension may write conversation_ref as the messaging GROUP
    // id (item.groupId) — a DIFFERENT id space than the fan's partnerAccountId
    // fanRef (recorded law A49). A predicate matching conversation_ref = fanRef
    // alone would leave the group-ref'd audio behind. The fan-hot target resolves
    // the fan's group ids from page_dm_threads (the sync table linking
    // groupId ↔ partnerAccountId ↔ fan) and scopes voice notes to fanRef OR those
    // group ids. This drill pins that: the target fan's note (conversation_ref =
    // HIS group id) is erased, while a co-resident DIFFERENT fan's note (keyed by
    // the OTHER fan's group id) on the same page survives.
    const TARGET_PARTNER = "700700700"; // partnerAccountId == fanRef
    const TARGET_GROUP = "9001900190019"; // item.groupId (the conversation_ref)
    const OTHER_PARTNER = "600600600";
    const OTHER_GROUP = "8002800280028";
    const model = await createModel(testDb.db, {
      slug: "erasure-voice-fansly",
      name: "Erasure Voice Fansly",
    });
    const page = model
      ? await createFanslyPage(testDb.db, { modelId: model.id, label: "erasure-voice-fansly-page" })
      : undefined;
    if (!page) {
      throw new Error("Failed to seed Fansly voice fan erasure page");
    }
    const operator = await one<{ id: string }>(
      `insert into users (username, role) values ('erasure-voice-fansly-owner', 'owner') returning id::text as id`,
    );

    // Fans + per-fan page_dm_thread carrying the groupId↔partner linkage.
    const fanIds = new Map<string, number>();
    for (const [partner, group] of [[TARGET_PARTNER, TARGET_GROUP], [OTHER_PARTNER, OTHER_GROUP]] as const) {
      await testDb.pool.query(
        `insert into fans (platform, platform_user_id, username, display_name)
         values ('fansly', $1, $1, $1)`,
        [partner],
      );
      const fan = await one<{ id: string }>(
        `select id::text as id from fans where platform = 'fansly' and platform_user_id = $1`,
        [partner],
      );
      fanIds.set(partner, Number(fan.id));
      await testDb.pool.query(
        `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id)
         values ($1, $2, $3, $4)`,
        [page.id, Number(fan.id), group, partner],
      );
    }

    const seedNote = async (conversationRef: string) => {
      await testDb!.pool.query(
        `insert into voice_notes (
           user_id, platform_account_id, conversation_ref, source_generation_ref,
           client_request_id, request_hash, script_chars, original_script_sha256,
           final_script_sha256, script_edited, profile_voice_id, profile_model,
           profile_settings, profile_output_format, profile_version, state, billed,
           billed_chars, audio_bytes, audio_sha256, audio_bytes_len)
         values (7575, $1, $2, 'gen-' || $2, $3, 'hash-' || $2, 120, $4, $4, false,
                 'voice-erasure', 'eleven_v3', '{}'::jsonb, 'mp3_44100_128', 1, 'completed',
                 true, 120, $5, $6, 13)`,
        [page.id, conversationRef, randomUUID(), "a".repeat(64), Buffer.from("audio-payload"), "c".repeat(64)],
      );
    };
    // Both notes are keyed by the GROUP id (the Fansly conversation_ref), NOT the
    // partner id — the whole point of the defect.
    await seedNote(TARGET_GROUP);
    await seedNote(OTHER_GROUP);

    // Exact Fansly tip notes are another sensitive, group-keyed materialization
    // without a fan FK. Seed the target and a co-resident bystander so the fan
    // predicate must use sender/group evidence without widening to page scope.
    for (const [tipId, conversationRef, senderRef, note] of [
      ["tip-context-target", TARGET_GROUP, TARGET_PARTNER, "erase this exact note"],
      ["tip-context-other", OTHER_GROUP, OTHER_PARTNER, "keep this bystander note"],
    ] as const) {
      await testDb.pool.query(
        `insert into transaction_tip_contexts (
           account_id, platform, platform_tip_id, captured_conversation_ref,
           tip_message_text, tip_message_captured_at, tip_amount_mills,
           occurred_at, sender_platform_user_id, receiver_platform_user_id,
           source_raw_payload_id, captured_at, provenance
         ) values (
           $1, 'fansly', $2, $3, $4, now(), 10000,
           now(), $5, 'creator-fansly', null, now(), 'fansly_dm_tip_sidecar'
         )`,
        [page.id, tipId, conversationRef, note, senderRef],
      );
    }
    for (const [tipId, postId, senderRef, note, sourceId] of [
      ["post-tip-target", "post-target", TARGET_PARTNER, "erase this post tip note", 91],
      ["post-tip-other", "post-other", OTHER_PARTNER, "keep this post tip note", 92],
    ] as const) {
      await testDb.pool.query(
        `insert into creator_post_tips (
           account_id, platform, platform_post_id, platform_tip_id,
           tip_sender_platform_user_id, post_tip_amount_mills, occurred_at,
           receiver_transaction_ref, sender_transaction_ref, tip_goal_ref,
           tip_message_text, first_observed_at, last_observed_at, content_hash,
           source_event_id, source_observation_id, source_account_seq
         ) values (
           $1, 'fansly', $2, $3, $4, 10000, now(), null, null, null,
           $5, now(), now(), $6, $7, $7, $7
         )`,
        [page.id, postId, tipId, senderRef, note, "d".repeat(64), sourceId],
      );
    }

    // Pre-fix and unresolved-fan generations can also be keyed only by the
    // Fansly GROUP id, with no separate fan_ref. Fan erasure must resolve the
    // same page_dm_threads linkage used for voice notes. Seed a bystander row
    // and acceptance event too, proving the predicate remains fan-selective.
    for (const [generationRef, conversationRef] of [
      ["gen-fansly-group-target", TARGET_GROUP],
      ["gen-fansly-group-other", OTHER_GROUP],
    ] as const) {
      await testDb.pool.query(
        `insert into ai_generation_content (generation_ref, feature, model, provider,
           page_id, conversation_ref, fan_ref, prompt_blocks, completion, params)
         values ($1, 'fan-summary', 'm', 'anthropic', $2, $3, null,
                 '[]'::jsonb, 'recap', '{}'::jsonb)`,
        [generationRef, page.id, conversationRef],
      );
      await testDb.pool.query(
        `insert into ai_acceptance_events (generation_ref, lifecycle, occurred_at)
         values ($1, 'shown', now())`,
        [generationRef],
      );
    }

    expect(await count(`voice_notes where platform_account_id = ${page.id} and audio_bytes is not null`)).toBe(2);
    expect(await count(`ai_generation_content where page_id = ${page.id}`)).toBe(2);
    expect(await count(`ai_acceptance_events`)).toBe(2);

    const fanScope = {
      scopeType: "fan",
      platform: "fansly",
      fanRef: TARGET_PARTNER,
    } as const;
    const plan = await planErasure(appStub(), fanScope);
    expect(plan.targets.find((target) =>
      target.plane === "hot" && target.target === "transaction_tip_contexts"
    )).toMatchObject({ action: "delete", rows: 1 });
    expect(plan.targets.find((target) =>
      target.plane === "hot" && target.target === "creator_post_tips"
    )).toMatchObject({ action: "delete", rows: 1 });

    const result = await executeErasure(
      appStub(),
      fanScope,
      { initiatedBy: Number(operator.id) },
    );
    // The group-ref'd note for the target fan is erased via the resolved group id…
    expect(result.executedCounts["hot:voice_notes:delete"], "fansly voice_notes fan target").toBe(1);
    expect(await count(`voice_notes where conversation_ref = '${TARGET_GROUP}'`)).toBe(0);
    // …and the OTHER fan's group-ref'd note survives, audio intact.
    expect(await count(`voice_notes where conversation_ref = '${OTHER_GROUP}' and audio_bytes is not null`)).toBe(1);
    expect(result.executedCounts["hot:ai_generation_content:delete"], "fansly AI generation fan target").toBe(1);
    expect(result.executedCounts["hot:ai_acceptance_events:delete"], "fansly AI acceptance fan target").toBe(1);
    expect(await count(`ai_generation_content where generation_ref = 'gen-fansly-group-target'`)).toBe(0);
    expect(await count(`ai_generation_content where generation_ref = 'gen-fansly-group-other'`)).toBe(1);
    expect(await count(`ai_acceptance_events`)).toBe(1);
    expect(
      result.executedCounts["hot:transaction_tip_contexts:delete"],
      "Fansly transaction tip context target",
    ).toBe(1);
    expect(await count(
      `transaction_tip_contexts where platform_tip_id = 'tip-context-target'`,
    )).toBe(0);
    expect(await count(
      `transaction_tip_contexts where platform_tip_id = 'tip-context-other'`,
    )).toBe(1);
    expect(result.executedCounts["hot:creator_post_tips:delete"]).toBe(1);
    expect(await count(`creator_post_tips where platform_tip_id = 'post-tip-target'`)).toBe(0);
    expect(await count(`creator_post_tips where platform_tip_id = 'post-tip-other'`)).toBe(1);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("fan-scope erasure purges the fan's media_orders and message_media_offers rows; another fan's survive (0130 / §9.3)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // §9.3's second half. The column-shape ratchet proves the two WP-F0(b)
    // tables are NAMED as fan-scope targets; naming is not erasing. Both carry
    // a TEXT fan ref with NO foreign key to `fans`, so nothing but the explicit
    // predicate reaches them, and a predicate that silently matches nothing
    // looks exactly like a predicate that works: the run reports success and
    // the fan's purchases stay. This drill deletes REAL rows.
    const TARGET_BUYER = "770770770"; // partnerAccountId == fanRef
    const TARGET_GROUP = "9101910191019"; // item.groupId (the conversation_ref)
    const OTHER_BUYER = "660660660";
    const OTHER_GROUP = "8202820282028";
    const model = await createModel(testDb.db, {
      slug: "erasure-media-plane",
      name: "Erasure Media Plane",
    });
    const page = model
      ? await createFanslyPage(testDb.db, { modelId: model.id, label: "erasure-media-plane-page" })
      : undefined;
    if (!page) {
      throw new Error("Failed to seed media-plane fan erasure page");
    }
    const operator = await one<{ id: string }>(
      `insert into users (username, role) values ('erasure-media-plane-owner', 'owner') returning id::text as id`,
    );

    // Fans + the per-fan page_dm_thread carrying the groupId↔partner linkage,
    // which is what lets the offer predicate reach a group-keyed row (A49).
    for (const [partner, group] of [[TARGET_BUYER, TARGET_GROUP], [OTHER_BUYER, OTHER_GROUP]] as const) {
      await testDb.pool.query(
        `insert into fans (platform, platform_user_id, username, display_name)
         values ('fansly', $1, $1, $1)`,
        [partner],
      );
      const fan = await one<{ id: string }>(
        `select id::text as id from fans where platform = 'fansly' and platform_user_id = $1`,
        [partner],
      );
      await testDb.pool.query(
        `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id)
         values ($1, $2, $3, $4)`,
        [page.id, Number(fan.id), group, partner],
      );
    }

    const HASH = "e".repeat(64); // media_orders_content_hash_check
    const seedOrder = async (mediaOfferRef: string, buyerRef: string) => {
      await testDb!.pool.query(
        `insert into media_orders (
           page_id, platform, media_offer_ref, buyer_platform_user_id, occurred_at,
           order_ref, bundle_ref, order_type, price_mills, conversation_ref, message_ref,
           first_observed_at, last_observed_at, content_hash,
           source_event_id, source_observation_id, source_account_seq
         ) values ($1, 'fansly', $2, $3, now(), null, null, 1, 25000, null, null,
                   now(), now(), $4, 4101, 4101, 4101)`,
        [page.id, mediaOfferRef, buyerRef, HASH],
      );
    };
    await seedOrder("media-order-target", TARGET_BUYER);
    await seedOrder("media-order-other", OTHER_BUYER);

    const seedOffer = async (
      messageRef: string,
      fanRef: string | null,
      conversationRef: string,
    ) => {
      await testDb!.pool.query(
        `insert into message_media_offers (
           page_id, platform, message_ref, offer_ordinal, media_offer_ref, bundle_ref,
           conversation_ref, fan_platform_user_id, message_created_at, offer_type,
           mime_type, duration_ms, price_mills, purchase_state, order_ref,
           first_observed_at, last_observed_at, content_hash,
           source_event_id, source_observation_id, source_account_seq
         ) values ($1, 'fansly', $2, 0, $2 || '-media', null,
                   $3, $4, now(), 1, 'video/mp4', 1000, 25000, 'purchased', null,
                   now(), now(), $5, 4102, 4102, 4102)`,
        [page.id, messageRef, conversationRef, fanRef, HASH],
      );
    };
    // Reached by the fan ref…
    await seedOffer("offer-target-fan", TARGET_BUYER, TARGET_GROUP);
    // …and, with fan_platform_user_id NULL, only by the resolved GROUP id — the
    // A49 id-space split that a fanRef-only predicate would leave behind.
    await seedOffer("offer-target-group", null, TARGET_GROUP);
    await seedOffer("offer-other-fan", OTHER_BUYER, OTHER_GROUP);

    expect(await count(`media_orders where page_id = ${page.id}`)).toBe(2);
    expect(await count(`message_media_offers where page_id = ${page.id}`)).toBe(3);

    const fanScope = { scopeType: "fan", platform: "fansly", fanRef: TARGET_BUYER } as const;
    const plan = await planErasure(appStub(), fanScope);
    expect(plan.targets.find((target) =>
      target.plane === "hot" && target.target === "media_orders"
    )).toMatchObject({ action: "delete", rows: 1 });
    expect(plan.targets.find((target) =>
      target.plane === "hot" && target.target === "message_media_offers"
    )).toMatchObject({ action: "delete", rows: 2 });

    const result = await executeErasure(
      appStub(),
      fanScope,
      { initiatedBy: Number(operator.id) },
    );
    expect(result.executedCounts["hot:media_orders:delete"], "media_orders fan target").toBe(1);
    expect(await count(`media_orders where media_offer_ref = 'media-order-target'`)).toBe(0);
    expect(await count(`media_orders where media_offer_ref = 'media-order-other'`)).toBe(1);

    expect(
      result.executedCounts["hot:message_media_offers:delete"],
      "message_media_offers fan target (fan-ref row + group-ref row)",
    ).toBe(2);
    expect(await count(`message_media_offers where message_ref = 'offer-target-fan'`)).toBe(0);
    expect(await count(`message_media_offers where message_ref = 'offer-target-group'`)).toBe(0);
    // The bystander fan's offer on the same page survives, untouched.
    expect(await count(`message_media_offers where message_ref = 'offer-other-fan'`)).toBe(1);
    expect(await count(
      `message_media_offers where fan_platform_user_id = '${OTHER_BUYER}'`,
    )).toBe(1);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("fan-scope erasure purges the fan's notification and like rows; another fan's survive (0134 / §9.3)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // §9.3's second half for WP-F2. The column-shape ratchet proves both
    // columns are NAMED as fan-scope targets; naming is not erasing. Both are
    // TEXT refs with NO foreign key to `fans`, so nothing but the explicit
    // predicate reaches them — and a predicate that silently matches nothing
    // looks exactly like a predicate that works. This drill deletes REAL rows.
    //
    // `post_likes` is EMPTY on Fansly today ([E4]) and the OF webhook is its
    // only writer, which is precisely why the drill seeds it by hand: a table
    // that arrives populated a year from now arrives with an untested
    // predicate, and by then nobody remembers to write one.
    const TARGET_FAN = "551551551";
    const OTHER_FAN = "442442442";
    const CREATOR_POST = "0009888888888888"; // a correlation ref that is NOT a fan
    const model = await createModel(testDb.db, {
      slug: "erasure-engagement",
      name: "Erasure Engagement",
    });
    const page = model
      ? await createFanslyPage(testDb.db, { modelId: model.id, label: "erasure-engagement-page" })
      : undefined;
    if (!page) {
      throw new Error("Failed to seed engagement fan erasure page");
    }
    const operator = await one<{ id: string }>(
      `insert into users (username, role) values ('erasure-engagement-owner', 'owner') returning id::text as id`,
    );
    for (const partner of [TARGET_FAN, OTHER_FAN]) {
      await testDb.pool.query(
        `insert into fans (platform, platform_user_id, username, display_name)
         values ('fansly', $1, $1, $1)`,
        [partner],
      );
    }

    const HASH = "f".repeat(64);
    const seedNotification = async (ref: string, correlation: string, typeCode: number) => {
      await testDb!.pool.query(
        `insert into platform_notifications (
           page_id, platform, notification_ref, type_code, correlation_ref,
           correlation_group_ref, metadata, occurred_at, acknowledged_at,
           first_observed_at, last_observed_at, content_hash,
           source_event_id, source_observation_id, source_account_seq
         ) values ($1, 'fansly', $2, $3, $4, null, '{}'::jsonb, now(), null,
                   now(), now(), $5, 5101, 5101, 5101)`,
        [page.id, ref, typeCode, correlation, HASH],
      );
    };
    // The fan bought something: the correlation ref IS the fan.
    await seedNotification("notif-target-purchase", TARGET_FAN, 2007);
    await seedNotification("notif-target-follow", TARGET_FAN, 3003);
    // A bystander fan on the same page.
    await seedNotification("notif-other", OTHER_FAN, 2007);
    // The creator's OWN content: an engagement notification whose correlation
    // ref is a post id, not a fan. Erasing a fan must not delete it.
    await seedNotification("notif-creator-post", CREATOR_POST, 1004);

    const seedLike = async (subjectRef: string, liker: string) => {
      await testDb!.pool.query(
        `insert into post_likes (
           page_id, platform, subject_kind, subject_ref, liker_platform_user_id,
           state, occurred_at, notification_ref, discovered_via,
           first_observed_at, last_observed_at, content_hash,
           source_event_id, source_observation_id, source_account_seq
         ) values ($1, 'onlyfans', 'post', $2, $3, 'active', now(), null, 'ofapi_webhook',
                   now(), now(), $4, 5102, 5102, 5102)`,
        [page.id, subjectRef, liker, HASH],
      );
    };
    await seedLike("post-alpha", TARGET_FAN);
    await seedLike("post-beta", TARGET_FAN);
    await seedLike("post-alpha", OTHER_FAN);

    expect(await count(`platform_notifications where page_id = ${page.id}`)).toBe(4);
    expect(await count(`post_likes where page_id = ${page.id}`)).toBe(3);

    const fanScope = { scopeType: "fan", platform: "fansly", fanRef: TARGET_FAN } as const;
    const plan = await planErasure(appStub(), fanScope);
    expect(plan.targets.find((target) =>
      target.plane === "hot" && target.target === "platform_notifications"
    )).toMatchObject({ action: "delete", rows: 2 });
    expect(plan.targets.find((target) =>
      target.plane === "hot" && target.target === "post_likes"
    )).toMatchObject({ action: "delete", rows: 2 });

    const result = await executeErasure(
      appStub(),
      fanScope,
      { initiatedBy: Number(operator.id) },
    );
    expect(
      result.executedCounts["hot:platform_notifications:delete"],
      "platform_notifications fan target",
    ).toBe(2);
    expect(await count(
      `platform_notifications where notification_ref = 'notif-target-purchase'`,
    )).toBe(0);
    expect(await count(`platform_notifications where notification_ref = 'notif-target-follow'`))
      .toBe(0);
    // The bystander's row on the same page survives, untouched.
    expect(await count(`platform_notifications where notification_ref = 'notif-other'`)).toBe(1);
    // …and so does the CREATOR's own content. A correlation ref is a fan on the
    // codes that name one, and a post id on the codes that do not; a predicate
    // that deleted both would erase the page's own history to forget a fan.
    expect(await count(`platform_notifications where notification_ref = 'notif-creator-post'`))
      .toBe(1);

    expect(result.executedCounts["hot:post_likes:delete"], "post_likes fan target").toBe(2);
    expect(await count(`post_likes where liker_platform_user_id = '${TARGET_FAN}'`)).toBe(0);
    expect(await count(`post_likes where liker_platform_user_id = '${OTHER_FAN}'`)).toBe(1);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("page and model erasure purge sensitive tip projections by resolved page id", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const suffix = randomUUID();
    const modelSlug = `erasure-tip-context-${suffix}`;
    const model = await createModel(testDb.db, {
      slug: modelSlug,
      name: "Erasure Tip Context",
    });
    if (!model) {
      throw new Error("Failed to seed tip-context erasure model");
    }
    const firstLabel = `erasure-tip-context-first-${suffix}`;
    const secondLabel = `erasure-tip-context-second-${suffix}`;
    const firstPage = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: firstLabel,
    });
    const secondPage = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: secondLabel,
    });
    if (!firstPage || !secondPage) {
      throw new Error("Failed to seed tip-context erasure pages");
    }
    const operator = await one<{ id: string }>(
      `insert into users (username, role) values ($1, 'owner') returning id::text as id`,
      [`erasure-tip-context-owner-${suffix}`],
    );
    for (const [page, tipId] of [
      [firstPage, `tip-context-page-${suffix}`],
      [secondPage, `tip-context-model-${suffix}`],
    ] as const) {
      await testDb.pool.query(
        `insert into transaction_tip_contexts (
           account_id, platform, platform_tip_id, captured_conversation_ref,
           tip_message_text, tip_message_captured_at, tip_amount_mills,
           occurred_at, sender_platform_user_id, receiver_platform_user_id,
           source_raw_payload_id, captured_at, provenance
         ) values (
           $1, 'fansly', $2, 'group-page-model', 'sensitive note', now(), 10000,
           now(), 'fan-page-model', 'creator-page-model', null, now(),
           'fansly_dm_tip_sidecar'
         )`,
        [page.id, tipId],
      );
      await testDb.pool.query(
        `insert into creator_post_tips (
           account_id, platform, platform_post_id, platform_tip_id,
           tip_sender_platform_user_id, post_tip_amount_mills, occurred_at,
           receiver_transaction_ref, sender_transaction_ref, tip_goal_ref,
           tip_message_text, first_observed_at, last_observed_at, content_hash,
           source_event_id, source_observation_id, source_account_seq
         ) values (
           $1, 'fansly', 'post-' || $2, 'post-' || $2, 'fan-page-model',
           10000, now(), null, null, null, 'sensitive post tip note',
           now(), now(), $3, $1, $1, $1
         )`,
        [page.id, tipId, "e".repeat(64)],
      );
    }

    const pageScope = { scopeType: "page", pageLabel: firstLabel } as const;
    const pagePlan = await planErasure(appStub(), pageScope);
    expect(pagePlan.targets.find((target) =>
      target.plane === "hot" && target.target === "transaction_tip_contexts"
    )).toMatchObject({ action: "delete", rows: 1 });
    expect(pagePlan.targets.find((target) =>
      target.plane === "hot" && target.target === "creator_post_tips"
    )).toMatchObject({ action: "delete", rows: 1 });
    const pageResult = await executeErasure(
      appStub(),
      pageScope,
      { initiatedBy: Number(operator.id) },
    );
    expect(pageResult.executedCounts["hot:transaction_tip_contexts:delete"]).toBe(1);
    expect(pageResult.executedCounts["hot:creator_post_tips:delete"]).toBe(1);
    expect(await count(`transaction_tip_contexts where account_id = ${firstPage.id}`)).toBe(0);
    expect(await count(`transaction_tip_contexts where account_id = ${secondPage.id}`)).toBe(1);
    expect(await count(`creator_post_tips where account_id = ${firstPage.id}`)).toBe(0);
    expect(await count(`creator_post_tips where account_id = ${secondPage.id}`)).toBe(1);

    const modelScope = { scopeType: "model", modelSlug } as const;
    const modelPlan = await planErasure(appStub(), modelScope);
    expect(modelPlan.targets.find((target) =>
      target.plane === "hot" && target.target === "transaction_tip_contexts"
    )).toMatchObject({ action: "delete", rows: 1 });
    expect(modelPlan.targets.find((target) =>
      target.plane === "hot" && target.target === "creator_post_tips"
    )).toMatchObject({ action: "delete", rows: 1 });
    const modelResult = await executeErasure(
      appStub(),
      modelScope,
      { initiatedBy: Number(operator.id) },
    );
    expect(modelResult.executedCounts["hot:transaction_tip_contexts:delete"]).toBe(1);
    expect(modelResult.executedCounts["hot:creator_post_tips:delete"]).toBe(1);
    expect(await count(`transaction_tip_contexts where account_id = ${secondPage.id}`)).toBe(0);
    expect(await count(`creator_post_tips where account_id = ${secondPage.id}`)).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a converged retry supersedes every unresolved attempt for only the same scope", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const model = await createModel(testDb.db, {
      slug: `erasure-retry-${randomUUID()}`,
      name: "Erasure Retry",
    });
    if (!model) {
      throw new Error("Failed to seed erasure retry model");
    }
    const pageLabel = `erasure-retry-${randomUUID()}`;
    const page = await createOnlyFansPage(testDb.db, { modelId: model.id, label: pageLabel });
    if (!page) {
      throw new Error("Failed to seed erasure retry page");
    }
    const operator = await one<{ id: string }>(
      `insert into users (username, role) values ($1, 'owner') returning id::text as id`,
      [`erasure-retry-${randomUUID()}`],
    );
    const scopeRef = `page:${pageLabel}`;
    const oldAttempts = await Promise.all([1, 2].map(() => insertErasureLog(testDb!.db, {
      scopeType: "page",
      scopeRef,
      initiatedBy: Number(operator.id),
      dryRun: false,
      plan: { scopeRef, resolvedPageIds: [page.id] },
      executionProtocol: ERASURE_EXECUTION_PROTOCOL,
    })));
    const reusedSelectorAttempt = await insertErasureLog(testDb.db, {
      scopeType: "page",
      scopeRef,
      initiatedBy: Number(operator.id),
      dryRun: false,
      plan: { scopeRef, resolvedPageIds: [page.id + 1] },
      executionProtocol: ERASURE_EXECUTION_PROTOCOL,
    });
    const preCutoverAttempt = await insertErasureLog(testDb.db, {
      scopeType: "page",
      scopeRef,
      initiatedBy: Number(operator.id),
      dryRun: false,
      plan: { scopeRef, resolvedPageIds: [page.id] },
    });
    const unrelated = await insertErasureLog(testDb.db, {
      scopeType: "page",
      scopeRef: `page:unrelated-${randomUUID()}`,
      initiatedBy: Number(operator.id),
      dryRun: false,
      plan: { scopeRef: "unrelated", resolvedPageIds: [] },
    });

    const result = await executeErasure(
      appStub(),
      { scopeType: "page", pageLabel },
      { initiatedBy: Number(operator.id) },
    );
    const { rows } = await testDb.pool.query<{
      id: string;
      resolution_kind: string | null;
      superseded_by_id: string | null;
    }>(
      `select id::text, resolution_kind, superseded_by_id::text
       from erasure_log where id = any($1::bigint[]) order by id`,
      [[
        ...oldAttempts.map((row) => row.id),
        reusedSelectorAttempt.id,
        preCutoverAttempt.id,
        unrelated.id,
        result.logId,
      ]],
    );
    const byId = new Map(rows.map((row) => [Number(row.id), row]));
    for (const old of oldAttempts) {
      expect(byId.get(old.id)).toMatchObject({
        resolution_kind: "superseded",
        superseded_by_id: String(result.logId),
      });
    }
    expect(byId.get(result.logId)).toMatchObject({
      resolution_kind: "completed",
      superseded_by_id: null,
    });
    expect(byId.get(unrelated.id)).toMatchObject({
      resolution_kind: null,
      superseded_by_id: null,
    });
    expect(byId.get(reusedSelectorAttempt.id)).toMatchObject({
      resolution_kind: null,
      superseded_by_id: null,
    });
    expect(byId.get(preCutoverAttempt.id)).toMatchObject({
      resolution_kind: null,
      superseded_by_id: null,
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("the global execution lock serializes distinct erasure scopes across lake rewrites", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstEnteredPromise = new Promise<void>((resolve) => { firstEntered = resolve; });
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = withErasureExecutionLock(appStub(), async () => {
      firstEntered();
      await holdFirst;
    });
    await firstEnteredPromise;

    let otherScopeEntered = false;
    const otherScope = withErasureExecutionLock(appStub(), async () => {
      otherScopeEntered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(otherScopeEntered).toBe(false);

    releaseFirst();
    await Promise.all([first, otherScope]);
    expect(otherScopeEntered).toBe(true);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
