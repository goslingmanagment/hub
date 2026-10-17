import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listObservationsForReplay } from "@agency_hub_core/db";
import { startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

// Audit-only query experiment. Does not edit the repository implementation.
// The real repository query remains the oracle for both semantics and plans.
type Input = Parameters<typeof listObservationsForReplay>[1];
type Statement = { text: string; values: unknown[] };
let harness: StartedTestDatabase;
beforeAll(async () => { harness = await startTestDatabase(); }, 120_000);
afterAll(async () => { await harness?.stop(); });

async function capture(input: Input) {
  const pool = harness.pool as unknown as { query: (query: unknown, values?: unknown) => Promise<unknown> };
  const original = pool.query.bind(pool);
  const statements: Statement[] = [];
  pool.query = (query, values) => {
    if (typeof query === "string") statements.push({ text: query, values: (values as unknown[]) ?? [] });
    else if (query && typeof (query as Statement).text === "string") {
      const q = query as Statement;
      statements.push({ text: q.text, values: (values as unknown[]) ?? q.values ?? [] });
    }
    return original(query, values);
  };
  try {
    const rows = await listObservationsForReplay(harness.db, input);
    expect(statements).toHaveLength(1);
    return { rows, statement: statements[0]! };
  } finally { pool.query = original; }
}

function prototype(statement: Statement, input: Input): Statement {
  // Keep exact/deep/account/time/source-free and kind-free queries unchanged.
  // In particular: no bound is carried over a separate statement snapshot.
  if (!input.kinds?.length || !statement.text.includes("replay_pending as materialized")) return statement;
  let text = statement.text.replace(
    /replay_pending as materialized \(\s*select 1\s*from replay_versions/,
    "replay_prefix_minima as materialized (select pending_prefix.received_at from replay_versions",
  ).replace("select 1 from observations o", "select o.received_at from observations o")
    .replace(/\) pending_prefix\s*limit 1\s*\)/,
      ") pending_prefix), replay_floor as materialized (select min(received_at) as from_at from replay_prefix_minima)")
    .replace("and exists (select 1 from replay_pending)",
      "and o.received_at >= (select from_at from replay_floor)");
  expect(text).not.toContain("replay_pending");
  expect(text).toContain("min(received_at)");
  return { text, values: statement.values };
}

async function compare(input: Input) {
  const current = await capture(input);
  const changed = prototype(current.statement, input);
  const result = await harness.pool.query(changed.text, changed.values);
  expect(result.rows.map(row => Number(row.id))).toEqual(current.rows.map(row => row.id));
  expect(result.rows.map(row => row.payload)).toEqual(current.rows.map(row => row.payload));
  return { ...current, changed };
}

async function seedSemantics() {
  await harness.pool.query("truncate observations");
  await harness.pool.query(`
    insert into observations (id, source, producer, kind, payload, payload_hash,
      idempotency_key, received_at, parse_version) overriding system value values
      (9, 'pull', 'audit', 'audit-a', '{"n":9}', '\\x00', 'nine', '2026-10-08', -2147483648),
      (10, 'pull', 'audit', 'audit-b', '{"n":10}', '\\x00', 'ten', '2026-08-01', -7),
      (100, 'pull', 'audit', 'audit-a', '{"n":100}', '\\x00', 'hundred', '2026-10-07', 0),
      (101, 'pull', 'audit', 'audit-b', '{"n":101}', '\\x00', 'one-oh-one', '2026-09-01', 1000000),
      (103, 'command_result', 'audit', 'audit-a', '{"n":103}', '\\x00', 'other-source', '2026-08-01', 0),
      (104, 'pull', 'audit', 'other-kind', '{"n":104}', '\\x00', 'other-kind', '2026-08-01', 0),
      (105, 'pull', 'audit', 'audit-a', '{"n":105}', '\\x00', 'terminal', '2026-08-01', 2147483647)
  `);
}

describe("audit: bound a populated replay head without changing eligible facts", () => {
  it("matches the production selector for sparse/negative versions, mixed dates and replay bumps", async () => {
    await seedSemantics();
    const broad = { belowParseVersion: 1000001, source: "pull", kinds: ["audit-a", "audit-b"] };
    for (const extra of [
      {}, { belowParseVersion: 1 }, { belowParseVersion: 6 },
      { belowParseVersion: 0 }, { belowParseVersion: -2147483648 },
      { belowParseVersion: 2147483647 }, { atLeastParseVersion: -7 },
      { atLeastParseVersion: 1000001 }, { kinds: ["audit-b", "audit-a", "audit-a"] },
      { kinds: ["absent"] }, { limit: 0 }, { limit: 1 }, { limit: 2 },
    ]) await compare({ ...broad, ...extra });
    expect((await capture(broad)).rows.map(row => row.id)).toEqual([9, 10, 100, 101]);
  });

  it("leaves deep/exact/account/time/kind-free scopes unchanged and sees later old captures", async () => {
    await seedSemantics();
    const broad = { belowParseVersion: 1000001, source: "pull", kinds: ["audit-a", "audit-b"] };
    for (const extra of [
      { afterId: 10 }, { observationId: 10 }, { accountId: 7 }, { accountIds: [] },
      { from: new Date("2026-09-01Z") }, { to: new Date("2026-10-01Z") }, { kinds: [] },
    ]) {
      const { statement, changed } = await compare({ ...broad, ...extra });
      expect(changed).toEqual(statement);
    }
    await harness.pool.query(`insert into observations (id, source, producer, kind, payload,
      payload_hash, idempotency_key, received_at, parse_version) overriding system value
      values (999, 'pull', 'audit', 'audit-a', '{}', '\\x00', 'late-old', '2026-08-03', 0)`);
    const later = await compare({ ...broad, afterId: 101 });
    expect(later.rows.map(row => row.id)).toEqual([999]);
  });

  it("refutes using only the first pending prefix or a fixed recent window as a safe floor", async () => {
    await seedSemantics();
    const input = { belowParseVersion: 1, source: "pull", kinds: ["audit-a", "audit-b"] };
    const { rows, changed } = await compare(input);
    const bad = changed.text.replace("select min(received_at) as from_at from replay_prefix_minima",
      "select received_at as from_at from replay_prefix_minima limit 1");
    const result = await harness.pool.query(bad, changed.values);
    expect(result.rows.map(row => Number(row.id))).not.toEqual(rows.map(row => row.id));
    expect((await capture({ ...input, from: new Date("2026-10-01Z") })).rows.map(row => row.id))
      .not.toEqual(rows.map(row => row.id));
  });
});
