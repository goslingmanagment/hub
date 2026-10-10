import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ensureObservationPartitions,
  insertObservation,
  listObservationsForReplay,
} from "@agency_hub_core/db";

import { PgDialect } from "../packages/db/node_modules/drizzle-orm/pg-core/index.js";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

// listObservationsForReplay at the head of a sweep pass (afterId null) finds
// the pending rows through the health-floor index and pages them by id; only
// past REPLAY_PENDING_HEAD_LIMIT does it walk the primary key. Its page must be
// exactly what the plain id-ordered lookup returns. On prod the walk read 3.56 M
// rows to find one, ~17 times a minute.

type ReplayInput = Parameters<typeof listObservationsForReplay>[1];

const SOURCE = "pull";
const KINDS = ["head-a", "head-b"];

let harness: StartedTestDatabase;
let sequence = 0;

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) {
    throw new Error("Docker-backed Postgres is required for this integration test");
  }
  harness = started;
  await ensureObservationPartitions(harness.db, { now: new Date("2026-08-01T00:00:00.000Z"), monthsAhead: 3 });

  // The bulk a walk would read: consumed rows of the family's own kinds.
  for (let index = 0; index < 60; index += 1) {
    const month = ["2026-08-1", "2026-09-1", "2026-10-1"][index % 3]!;
    await journal(KINDS[index % 2]!, `${month}${index % 10}T10:00:00.000Z`, 6);
  }
  // Pending rows, inserted out of received_at order on purpose: ids follow
  // insertion, so the page must be ordered by id, not by arrival.
  await journal("head-a", "2026-10-02T10:00:00.000Z", 0);
  await journal("head-b", "2026-09-15T10:00:00.000Z", 0);
  await journal("head-a", "2026-08-20T10:00:00.000Z", 1);
  await journal("head-b", "2026-10-03T10:00:00.000Z", 2);
  await journal("head-c", "2026-10-04T10:00:00.000Z", 0); // a kind outside the family
  await journal("head-a", "2026-09-01T10:00:00.000Z", -1); // negative versions stay eligible
  await journal("result", "2026-09-20T10:00:00.000Z", 0, "command_result");
  await journal("head-a", "2026-08-05T10:00:00.000Z", 0); // newest id, oldest arrival
  for (let index = 0; index < 20; index += 1) {
    await journal(KINDS[index % 2]!, "2026-10-09T10:00:00.000Z", 6);
  }
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

async function journal(kind: string, receivedAt: string, parseVersion: number, source = SOURCE) {
  sequence += 1;
  const payload = { n: sequence };
  const inserted = await insertObservation(harness.db, {
    source: source as never,
    producer: "replay-head-test",
    platform: "fansly",
    kind,
    payload,
    payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
    idempotencyKey: `replay-head-test:${sequence}`,
    receivedAt: new Date(receivedAt),
  });
  await harness.pool.query(
    "update observations set parse_version = $1 where id = $2 and received_at = $3",
    [parseVersion, inserted.observationId, inserted.receivedAt],
  );
}

/** The page the plain id-ordered lookup returns: the oracle. */
async function oracle(input: ReplayInput): Promise<number[]> {
  const params: unknown[] = [input.belowParseVersion];
  let where = "o.parse_version < $1";
  if (input.atLeastParseVersion !== undefined) {
    params.push(input.atLeastParseVersion);
    where += ` and o.parse_version >= $${params.length}`;
  }
  if (input.source !== undefined) {
    params.push(input.source);
    where += ` and o.source = $${params.length}`;
  }
  if (input.kinds !== undefined && input.kinds.length > 0) {
    params.push(input.kinds);
    where += ` and o.kind = any($${params.length}::text[])`;
  }
  params.push(input.limit ?? 200);
  const result = await harness.pool.query<{ id: string }>(
    `select o.id::text as id from observations o where ${where} order by o.id limit $${params.length}`,
    params,
  );
  return result.rows.map((row) => Number(row.id));
}

async function page(input: ReplayInput): Promise<number[]> {
  return (await listObservationsForReplay(harness.db, input)).map((row) => row.id);
}

const CASES: Array<[string, ReplayInput]> = [
  ["the unparsed pass", { belowParseVersion: 1, source: SOURCE, kinds: KINDS }],
  ["the unparsed pass, a short page", { belowParseVersion: 1, source: SOURCE, kinds: KINDS, limit: 2 }],
  ["the replay pass", { belowParseVersion: 6, atLeastParseVersion: 1, source: SOURCE, kinds: KINDS }],
  ["a family without a split pass", { belowParseVersion: 6, source: SOURCE, kinds: KINDS }],
  ["a kinds:null family", { belowParseVersion: 1, source: "command_result" }],
  ["a caught-up family", { belowParseVersion: 1, source: SOURCE, kinds: ["head-z"] }],
];

describe("listObservationsForReplay at the head of a pass", () => {
  it.each(CASES)("returns the plain lookup's page: %s", async (_name, input) => {
    expect(await page(input)).toEqual(await oracle(input));
  });

  it("returns pending rows by id, not by arrival", async () => {
    const rows = await listObservationsForReplay(harness.db, { belowParseVersion: 1, source: SOURCE, kinds: KINDS });
    expect(rows.map((row) => row.parseVersion)).toEqual([0, 0, -1, 0]);
    expect(rows.map((row) => row.kind)).toEqual(["head-a", "head-b", "head-a", "head-a"]);
    // The last one arrived first: the walk and this page both put it last.
    expect(rows[3]!.receivedAt.toISOString()).toBe("2026-08-05T10:00:00.000Z");
  });

  it("walks by id past the pending-head limit, with the same page", async () => {
    for (const [, input] of CASES) {
      for (const pendingHeadLimit of [1, 2, 3, 4]) {
        expect(await page({ ...input, pendingHeadLimit }), JSON.stringify({ ...input, pendingHeadLimit }))
          .toEqual(await oracle(input));
      }
    }
  });

  it("does not run the walk while the pending rows fit the limit", async () => {
    const walked = async (input: ReplayInput) => {
      const dialect = new PgDialect();
      const rendered: Array<{ sql: string; params: unknown[] }> = [];
      await listObservationsForReplay({
        execute: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
          rendered.push(dialect.sqlToQuery(query));
          return { rows: [] };
        },
      } as never, input);
      // A few hundred rows plan as sequential scans; with those off, each
      // path takes the index it takes on a full journal.
      const client = await harness.pool.connect();
      let plan: { rows: Array<{ "QUERY PLAN": unknown }> };
      try {
        await client.query("begin");
        await client.query("set local enable_seqscan = off");
        plan = await client.query(`explain (analyze, format json) ${rendered[0]!.sql}`, rendered[0]!.params);
        await client.query("rollback");
      } finally {
        client.release();
      }
      // The page is a union: the head's rows, then the walk. Every journal scan
      // under the walk's arm (the second member) must stay unexecuted.
      const top = (plan.rows[0]!["QUERY PLAN"] as Array<{ Plan: Record<string, unknown> }>)[0]!.Plan;
      const children = (node: Record<string, unknown>) => (node.Plans as Array<Record<string, unknown>> | undefined) ?? [];
      const union = children(top).find((child) => child["Parent Relationship"] === "Outer")!;
      const walkArm = children(union).filter((child) => child["Parent Relationship"] === "Member")[1]!;
      const loops: number[] = [];
      const visit = (node: Record<string, unknown>) => {
        if (String(node["Relation Name"] ?? "").startsWith("observations")) loops.push(Number(node["Actual Loops"]));
        for (const child of children(node)) {
          if (child["Parent Relationship"] !== "InitPlan") visit(child);
        }
      };
      visit(walkArm);
      return loops;
    };
    const input: ReplayInput = { belowParseVersion: 6, source: SOURCE, kinds: KINDS };
    const head = await walked(input);
    expect(head.length).toBeGreaterThan(0);
    expect(head.every((loops) => loops === 0)).toBe(true);
    // Past the limit the same statement does walk: the detector sees it.
    const walk = await walked({ ...input, pendingHeadLimit: 2 });
    expect(walk.some((loops) => loops > 0)).toBe(true);
  });
});
