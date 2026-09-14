import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listObservationsForReplay } from "@agency_hub_core/db";

import { startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

type ReplayInput = Parameters<typeof listObservationsForReplay>[1];
interface Statement { text: string; values: unknown[] }
interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  "Heap Fetches"?: number;
  Plans?: PlanNode[];
}

let harness: StartedTestDatabase;
beforeAll(async () => { harness = await startTestDatabase(); }, 120_000);
afterAll(async () => { await harness?.stop(); });

// The old repository SELECT is the oracle, including its unrestricted []/null
// semantics. Keep its full projection so EXPLAIN sees the original heap cost.
function legacyStatement(input: ReplayInput): Statement {
  const values: unknown[] = [];
  const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
  const conditions = [`o.parse_version < ${bind(input.belowParseVersion)}`];
  if (input.observationId !== undefined) conditions.push(`o.id = ${bind(input.observationId)}`);
  if (input.atLeastParseVersion !== undefined) conditions.push(`o.parse_version >= ${bind(input.atLeastParseVersion)}`);
  if (input.source !== undefined) conditions.push(`o.source = ${bind(input.source)}`);
  if (input.kinds?.length) conditions.push(`o.kind in (${input.kinds.map(bind).join(", ")})`);
  if (input.accountId != null) conditions.push(`o.account_id = ${bind(input.accountId)}`);
  if (input.accountIds !== undefined) conditions.push(input.accountIds.length === 0
    ? "false" : `o.account_id in (${input.accountIds.map(bind).join(", ")})`);
  if (input.from) conditions.push(`o.received_at >= ${bind(input.from)}`);
  if (input.to) conditions.push(`o.received_at < ${bind(input.to)}`);
  if (input.afterId != null) conditions.push(`o.id > ${bind(input.afterId)}`);
  return { values, text: `
    select o.id::text as id, o.source, o.producer, o.platform, o.account_id,
           o.native_account_ref, o.kind, o.payload, o.observed_at,
           o.received_at, o.parse_version,
           to_char(o.payload_bucket_month, 'YYYY-MM-DD') as payload_bucket_month,
           o.payload_object_id::text as payload_object_id
    from observations o
    where ${conditions.join(" and ")}
    order by o.id asc
    limit ${bind(input.limit ?? 200)}
  ` };
}

async function captureReplay(input: ReplayInput) {
  const pool = harness.pool as unknown as {
    query: (config: unknown, values?: unknown) => Promise<unknown>;
  };
  const original = pool.query.bind(pool);
  const statements: Statement[] = [];
  pool.query = (config, values) => {
    if (typeof config === "string") {
      statements.push({ text: config, values: (values as unknown[]) ?? [] });
    } else if (config && typeof (config as { text?: unknown }).text === "string") {
      const query = config as { text: string; values?: unknown[] };
      statements.push({ text: query.text, values: (values as unknown[]) ?? query.values ?? [] });
    }
    return original(config, values);
  };
  try {
    const rows = await listObservationsForReplay(harness.db, input);
    expect(statements).toHaveLength(1);
    return { rows, statement: statements[0]! };
  } finally {
    pool.query = original;
  }
}

async function expectLegacyRows(input: ReplayInput) {
  const actual = await captureReplay(input);
  const legacy = legacyStatement(input);
  const expected = await harness.pool.query(legacy.text, legacy.values);
  expect(actual.rows).toEqual(expected.rows.map(row => ({
    id: Number(row.id), source: row.source, producer: row.producer,
    platform: row.platform, accountId: row.account_id == null ? null : Number(row.account_id),
    nativeAccountRef: row.native_account_ref, kind: row.kind, payload: row.payload,
    observedAt: row.observed_at, receivedAt: row.received_at, parseVersion: row.parse_version,
    payloadRef: row.payload_object_id == null ? null : {
      bucketMonth: row.payload_bucket_month, objectId: Number(row.payload_object_id),
    },
  })));
  return actual;
}

function flatten(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(flatten)];
}

function heapVisits(plan: PlanNode): number {
  return flatten(plan).reduce((sum, node) => {
    if (!node["Relation Name"]?.startsWith("observations_")) return sum;
    return sum + (node["Node Type"] === "Index Only Scan"
      ? node["Heap Fetches"] ?? 0
      : ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) * (node["Actual Loops"] ?? 0));
  }, 0);
}

async function explain(statement: Statement): Promise<PlanNode> {
  const result = await harness.pool.query<{ "QUERY PLAN": { Plan: PlanNode }[] }>(
    `explain (analyze, buffers, format json) ${statement.text}`, statement.values,
  );
  return result.rows[0]!["QUERY PLAN"][0]!.Plan;
}

async function seedReplayFixture() {
  await harness.pool.query("truncate observations");
  await harness.pool.query(`
    insert into observations (id, source, producer, platform, account_id,
      native_account_ref, kind, payload, payload_hash, idempotency_key,
      observed_at, received_at, parse_version, payload_bucket_month, payload_object_id)
    overriding system value values
      (9, 'pull', 'fixture', 'fansly', null, 'native-a', 'test-a', '{"n":9}', '\\x00', 'nine',
        null, '2026-09-01', -2147483648, null, null),
      (10, 'pull', 'fixture', 'onlyfans', 7, 'native-b', 'test-b', null, '\\x00', 'ten',
        '2026-08-02', '2026-08-03', -7, '2026-08-01', 123),
      (100, 'pull', 'fixture', 'fansly', 8, 'native-c', 'test-a', '{"n":100}', '\\x00', 'hundred',
        '2026-09-01', '2026-09-02', 0, null, null),
      (101, 'pull', 'fixture', 'fansly', 7, 'native-d', 'test-b', '{"n":101}', '\\x00', 'one-oh-one',
        null, '2026-08-01', 1000000, null, null),
      (1000, 'command_result', 'fixture', null, null, null, 'test-a', '{"n":1000}', '\\x00', 'thousand',
        null, '2026-09-01', 0, null, null),
      (1001, 'pull', 'fixture', 'fansly', null, null, 'other-kind', '{"n":1001}', '\\x00', 'one-oh-oh-one',
        null, '2026-09-01', 2147483647, null, null)
  `);
}

describe("observation replay at a caught-up scan head", () => {
  it("avoids the legacy empty-family heap walk while preserving a populated webhook head", async () => {
    // Correlated production shape: many unparsed webhooks, but the selected
    // pull/command families are already caught up. Child statistics are fresh;
    // the partitioned parent has never been analyzed, as on the affected VPS.
    await harness.pool.query(`
      insert into observations (source, producer, platform, kind, payload,
        payload_hash, idempotency_key, received_at, parse_version)
      select case n % 4 when 0 then 'webhook' when 3 then 'command_result' else 'pull' end,
        'replay-plan', 'onlyfans',
        case n % 4 when 0 then 'messages.received' when 1 then 'account_stats'
          when 2 then 'notifications' else 'command.settled' end,
        jsonb_build_object('fixture', n), '\\x00'::bytea, 'replay-plan-' || n,
        '2026-09-01'::timestamptz + (n % 2000000) * interval '1 second',
        case n % 4 when 0 then 0 when 1 then 2 else 1 end
      from generate_series(1, 240000) n
    `);
    await harness.pool.query("analyze observations_2026_09");
    for (const input of [
      { belowParseVersion: 1, source: "command_result" },
      { belowParseVersion: 2, source: "pull", kinds: ["account_stats", "tracking_links"] },
    ]) {
      const { rows, statement } = await captureReplay(input);
      expect(rows).toEqual([]);
      const oldPlan = await explain(legacyStatement(input));
      const newPlan = await explain(statement);
      expect(heapVisits(oldPlan)).toBeGreaterThanOrEqual(240000);
      expect(heapVisits(newPlan)).toBeLessThan(200);
      expect(flatten(newPlan).some(node => node["Index Name"]?.endsWith("_health_floor_idx")
        && (node["Actual Loops"] ?? 0) > 0)).toBe(true);
    }
    const pending = await expectLegacyRows({
      belowParseVersion: 5, source: "webhook", kinds: ["messages.received", "messages.sent"],
    });
    expect(pending.rows).toHaveLength(200);
    // The added existence probe must not turn a cheap 200-row head into a
    // walk of the 60,000-row pending corpus or a full filter-and-sort pass.
    expect(heapVisits(await explain(pending.statement))).toBeLessThan(1500);
  }, 120_000);

  it("preserves negative/sparse versions, numeric id order, payloads and time bounds", async () => {
    await seedReplayFixture();
    const broad = { belowParseVersion: 1000001, source: "pull", kinds: ["test-a", "test-b"] };
    expect((await expectLegacyRows(broad)).rows.map(row => row.id)).toEqual([9, 10, 100, 101]);
    expect((await expectLegacyRows({ ...broad, belowParseVersion: 0 })).rows.map(row => row.id))
      .toEqual([9, 10]);
    expect((await expectLegacyRows({ ...broad, atLeastParseVersion: -7 })).rows.map(row => row.id))
      .toEqual([10, 100, 101]);
    expect((await expectLegacyRows({ ...broad, from: new Date("2026-08-03Z"), to: new Date("2026-09-02Z") }))
      .rows.map(row => row.id)).toEqual([9, 10]);
    for (const input of [
      { ...broad, kinds: ["test-b", "test-a", "test-a"] },
      { ...broad, belowParseVersion: 2147483647 },
      { ...broad, belowParseVersion: -2147483648 },
      { ...broad, atLeastParseVersion: 1000001 },
      { ...broad, kinds: [] },
      { belowParseVersion: 1000001, source: "pull" },
      { ...broad, accountId: null },
      { ...broad, limit: 0 },
      { ...broad, limit: 2 },
      { ...broad, from: new Date("2026-10-01Z") },
    ]) await expectLegacyRows(input);
  });

  it("keeps the original selector for exact, deep, account/time-scoped and source-free calls", async () => {
    await seedReplayFixture();
    const broad = { belowParseVersion: 1000001, source: "pull", kinds: ["test-a", "test-b"] };
    for (const input of [
      { ...broad, observationId: 10 },
      { ...broad, afterId: 0 },
      { ...broad, afterId: 10 },
      { ...broad, accountId: 7 },
      { ...broad, accountIds: [7, 8] },
      { ...broad, accountIds: [] },
      { ...broad, accountId: 7, accountIds: [8] },
      { belowParseVersion: broad.belowParseVersion, kinds: broad.kinds },
      { ...broad, from: new Date("2026-08-03Z") },
      { ...broad, to: new Date("2026-09-02Z") },
      { belowParseVersion: 5, source: "command_result", from: new Date("2026-09-01Z") },
    ]) {
      const { statement } = await expectLegacyRows(input);
      const legacy = legacyStatement(input);
      expect(statement.text.replace(/\s+/g, " ").trim())
        .toBe(legacy.text.replace(/\s+/g, " ").trim());
      expect(statement.values).toEqual(legacy.values);
    }
  });

  it("discovers newly eligible capture after an empty result without caching or stamping", async () => {
    const input = { belowParseVersion: 5, source: "webhook", kinds: ["fresh-kind"] };
    expect((await captureReplay(input)).rows).toEqual([]);
    await harness.pool.query(`
      insert into observations (source, producer, kind, payload, payload_hash, idempotency_key, received_at)
      values ('webhook', 'fixture', 'fresh-kind', '{"fresh":true}', '\\x00', 'new-after-empty', '2026-09-12')
    `);
    const pending = await expectLegacyRows(input);
    expect(pending.rows).toHaveLength(1);
    expect(pending.rows[0]).toMatchObject({ parseVersion: 0, payload: { fresh: true } });
    expect((await captureReplay(input)).rows).toEqual(pending.rows);
  });
});
