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

function heapVisits(plan: PlanNode, relationPrefix = "observations_"): number {
  return flatten(plan).reduce((sum, node) => {
    if (!node["Relation Name"]?.startsWith(relationPrefix)) return sum;
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

// A populated head: the family has pending capture, so the old existence probe
// let the id-ordered page walk every month's primary key. July is correlated
// capture the head must never read: each predicate (pull, floor-a, version 0)
// is common on its own, but no row carries all three. The family's own pending
// capture is five September rows; ids leave a gap below them for late commits.
const FLOOR_INPUT = { belowParseVersion: 1, source: "pull", kinds: ["floor-a", "floor-b"] };
const FLOOR_PENDING_IDS = [300051, 300052, 300053, 300054, 300055];

async function seedFloorFixture(parsedVersion = 1) {
  // The test cluster commits asynchronously, and vacuum cannot mark a page
  // all-visible before the inserting commit is flushed. Commit this seed
  // synchronously so the vacuum below leaves July all-visible, as an old
  // month is on prod.
  const seed = await harness.pool.connect();
  try {
    await seed.query("set synchronous_commit = on");
    await seed.query("truncate observations");
    await seed.query(`
      insert into observations (id, source, producer, kind, payload, payload_hash,
        idempotency_key, received_at, parse_version) overriding system value
      select n, case n % 3 when 2 then 'webhook' else 'pull' end, 'replay-floor',
        case n % 3 when 1 then 'floor-other' else 'floor-a' end,
        jsonb_build_object('fixture', n), '\\x00'::bytea, 'replay-floor-' || n,
        '2026-07-01'::timestamptz + n * interval '15 seconds',
        case n % 3 when 0 then $1::int else 0 end
      from generate_series(1, 120000) n
    `, [parsedVersion]);
    await seed.query(`
      insert into observations (id, source, producer, kind, payload, payload_hash,
        idempotency_key, received_at, parse_version) overriding system value
      select 300000 + n, 'pull', 'replay-floor', 'floor-a',
        jsonb_build_object('fixture', 300000 + n), '\\x00'::bytea, 'replay-floor-' || (300000 + n),
        '2026-09-20'::timestamptz + n * interval '1 minute',
        case when n > 50 then 0 else $1::int end
      from generate_series(1, 55) n
    `, [parsedVersion]);
    // Child statistics are fresh; the partitioned parent has never been
    // analyzed, as on prod.
    await seed.query("vacuum (analyze) observations_2026_07, observations_2026_09");
  } finally {
    await seed.query("reset synchronous_commit");
    seed.release();
  }
}

async function insertFloorRow(
  client: { query: (text: string, values: unknown[]) => Promise<unknown> },
  row: { id: number; receivedAt: string; parseVersion: number },
) {
  await client.query(`
    insert into observations (id, source, producer, kind, payload, payload_hash,
      idempotency_key, received_at, parse_version) overriding system value
    values ($1, 'pull', 'replay-floor', 'floor-a', jsonb_build_object('fixture', $1::bigint),
      '\\x00'::bytea, 'replay-floor-' || $1, $2, $3)
  `, [row.id, row.receivedAt, row.parseVersion]);
}

describe("observation replay at a populated scan head", () => {
  it("a populated head reads no month older than its oldest pending capture", async () => {
    await seedFloorFixture();
    const head = await expectLegacyRows(FLOOR_INPUT);
    expect(head.rows.map(row => row.id)).toEqual(FLOOR_PENDING_IDS);
    // The fixture reproduces the defect: the old page walks July's heap.
    expect(heapVisits(await explain(legacyStatement(FLOOR_INPUT)), "observations_2026_07"))
      .toBeGreaterThanOrEqual(50_000);
    const plan = await explain(head.statement);
    expect(heapVisits(plan, "observations_2026_07")).toBe(0);
    expect(heapVisits(plan)).toBeLessThan(1_000);
  }, 120_000);

  it("a capture left unparsed holds the floor at its own month; no fixed window", async () => {
    await seedFloorFixture();
    await insertFloorRow(harness.pool, { id: 150000, receivedAt: "2026-07-20Z", parseVersion: 0 });
    const head = await expectLegacyRows(FLOOR_INPUT);
    expect(head.rows.map(row => row.id)).toEqual([150000, ...FLOOR_PENDING_IDS]);
    expect(heapVisits(await explain(head.statement), "observations_2026_07")).toBeGreaterThan(0);
    // A two-day ceiling below the fixture's "now" would drop the stuck row.
    const fixtureNow = new Date("2026-09-21Z").getTime();
    const ceiling = await listObservationsForReplay(harness.db, {
      ...FLOOR_INPUT, from: new Date(fixtureNow - 2 * 24 * 60 * 60 * 1000),
    });
    expect(ceiling.map(row => row.id)).toEqual(FLOOR_PENDING_IDS);
    expect(ceiling.map(row => row.id)).not.toEqual(head.rows.map(row => row.id));
  }, 120_000);

  it("a late commit with an older date and a smaller id is seen by the next head", async () => {
    await seedFloorFixture();
    const late = await harness.pool.connect();
    try {
      await late.query("begin");
      await insertFloorRow(late, { id: 200000, receivedAt: "2026-08-15Z", parseVersion: 0 });
      const before = await expectLegacyRows(FLOOR_INPUT);
      expect(before.rows.map(row => row.id)).toEqual(FLOOR_PENDING_IDS);
      await late.query("commit");
    } catch (error) {
      await late.query("rollback");
      throw error;
    } finally {
      late.release();
    }
    const after = await expectLegacyRows(FLOOR_INPUT);
    expect(after.rows.map(row => row.id)).toEqual([200000, ...FLOOR_PENDING_IDS]);
    const pastIt = await expectLegacyRows({ ...FLOOR_INPUT, afterId: 200000 });
    expect(pastIt.rows.map(row => row.id)).toEqual(FLOOR_PENDING_IDS);
  }, 120_000);

  it("the replay pass floor ignores capture below its version range", async () => {
    await seedFloorFixture(2);
    await insertFloorRow(harness.pool, { id: 150000, receivedAt: "2026-07-20Z", parseVersion: 0 });
    await insertFloorRow(harness.pool, { id: 300100, receivedAt: "2026-09-21Z", parseVersion: 1 });
    const input = { ...FLOOR_INPUT, belowParseVersion: 2, atLeastParseVersion: 1 };
    const head = await expectLegacyRows(input);
    expect(head.rows.map(row => row.id)).toEqual([300100]);
    expect(heapVisits(await explain(head.statement), "observations_2026_07")).toBe(0);
  }, 120_000);

  it("bounds only the kind-scoped head; the kind-free head keeps its existence probe", async () => {
    const bounded = (await expectLegacyRows(FLOOR_INPUT)).statement.text.replace(/\s+/g, " ");
    expect(bounded).toContain("replay_floor");
    expect(bounded).toContain("o.received_at >= (select received_at from replay_floor)");
    expect(bounded).not.toContain("replay_pending");
    for (const input of [
      { belowParseVersion: 1, source: "command_result" },
      { belowParseVersion: 1, source: "command_result", kinds: [] },
    ]) {
      const text = (await expectLegacyRows(input)).statement.text.replace(/\s+/g, " ");
      expect(text).toContain("exists (select 1 from replay_pending)");
      expect(text).toContain("order by o.kind, o.received_at");
      expect(text).not.toContain("replay_floor");
    }
  });
});
