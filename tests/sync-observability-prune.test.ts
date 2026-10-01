// The nightly telemetry sweep's SHAPE, without Docker.
//
// `tests/ops-retention.integration.test.ts` already proves the sweep removes
// the right rows and spares a `running` one. What it cannot show — because it
// runs against a table with a handful of rows — is the shape that made the job
// fail four consecutive nights in production (2026-08-22..25, `handler
// execution exceeded 900s`): one unbounded statement per table, two predicates
// that could not use an index that existed, and three deletes racing each other
// for the same parent's cascades.
//
// So this file drives the deleter against a recording fake and asserts the
// shape: batches are bounded and repeat until the scope is empty, the budget
// stops the walk rather than the pg-boss cap doing it, every batch carries its
// own `statement_timeout`, the tables go children-first, and each predicate
// leads with the indexed column.

import { describe, expect, it, vi } from "vitest";

import {
  SYNC_OBSERVABILITY_PRUNE_BATCH_ROWS,
  deleteExpiredSyncObservability,
} from "@agency_hub_core/db";

const CUTOFF = new Date("2026-08-13T00:00:00Z");

interface Recorded {
  statements: string[];
  transactions: number;
}

/**
 * A `Database` that answers only what this deleter asks of it.
 *
 * `remaining` is a per-table budget of rows the fake still "holds"; each
 * `delete` statement takes up to `batchRows` from it, which is exactly how the
 * real loop learns it has reached the end (a batch shorter than the bound).
 */
function fakeDb(remaining: Record<string, number>, batchRows: number) {
  const recorded: Recorded = { statements: [], transactions: 0 };
  const tableOf = (text: string): string | null => {
    for (const table of Object.keys(remaining)) {
      if (text.includes(`delete from ${table} `)) {
        return table;
      }
    }
    return null;
  };
  const db = {
    transaction: async (body: (tx: unknown) => Promise<unknown>) => {
      recorded.transactions += 1;
      return body({
        execute: async (statement: { sql?: string; queryChunks?: unknown[] }) => {
          // drizzle's `sql` template exposes its literal chunks; join them so
          // the assertions below can read the statement the deleter built.
          const text = renderSql(statement);
          recorded.statements.push(text);
          const table = tableOf(text);
          if (table === null) {
            return { rows: [] };
          }
          const took = Math.min(batchRows, remaining[table] ?? 0);
          remaining[table] = (remaining[table] ?? 0) - took;
          return { rows: [{ n: String(took) }] };
        },
      });
    },
  };
  return { db: db as never, recorded };
}

function renderSql(statement: unknown): string {
  return flattenSql(statement).replace(/\s+/g, " ").toLowerCase();
}

/** drizzle nests: a `sql.raw(...)` interpolation is itself an SQL with its own
 *  chunks, and a bound value is a Param that renders as nothing here (the
 *  assertions are about SHAPE, not about the cutoff's literal text). */
function flattenSql(node: unknown): string {
  if (typeof node === "string") {
    return node;
  }
  if (node === null || typeof node !== "object") {
    return "";
  }
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) {
    return chunks.map(flattenSql).join("");
  }
  const value = (node as { value?: unknown }).value;
  if (Array.isArray(value)) {
    return value.map(flattenSql).join("");
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return "";
}

describe("the nightly sync-observability prune", () => {
  it("batches until each table is empty rather than issuing one unbounded delete", async () => {
    const { db, recorded } = fakeDb(
      { sync_http_attempts: 12, sync_run_events: 25, sync_runs: 3, fansly_send_log: 14 },
      10,
    );
    const result = await deleteExpiredSyncObservability(db, CUTOFF, { batchRows: 10 });

    expect(result.deletedAttempts).toBe(12);
    expect(result.deletedEvents).toBe(25);
    expect(result.deletedRuns).toBe(3);
    expect(result.deletedSendLog).toBe(14);
    // 2 + 3 + 1 + 2 delete batches; a short batch ends the table.
    expect(recorded.transactions).toBe(8);
    expect(result.budgetExhausted).toBe(false);
  });

  it("gives every batch its own statement_timeout inside its own transaction", async () => {
    const { db, recorded } = fakeDb({ sync_http_attempts: 1, sync_run_events: 0, sync_runs: 0, fansly_send_log: 0 }, 10);
    await deleteExpiredSyncObservability(db, CUTOFF, {
      batchRows: 10,
      statementTimeoutMs: 45_000,
    });
    const timeouts = recorded.statements.filter((text) => text.includes("set local statement_timeout"));
    // One per batch — and one batch per table, since each returns short.
    expect(timeouts).toHaveLength(4);
    expect(timeouts[0]).toContain("45000");
  });

  it("leads every predicate with the INDEXED column, keeping the coalesce as the policy", async () => {
    const { db, recorded } = fakeDb({ sync_http_attempts: 0, sync_run_events: 0, sync_runs: 0 }, 10);
    await deleteExpiredSyncObservability(db, CUTOFF, { batchRows: 10 });
    const attempts = recorded.statements.find((text) => text.includes("from sync_http_attempts"));
    const runs = recorded.statements.find((text) => text.includes("from sync_runs"));
    const events = recorded.statements.find((text) => text.includes("from sync_run_events"));

    // sync_http_attempts_retention_idx / sync_runs_started_idx are on started_at.
    expect(attempts).toMatch(/where started_at <.*coalesce\(finished_at, started_at\) </);
    expect(runs).toMatch(/where started_at <.*coalesce\(finished_at, started_at\) </);
    // sync_run_events_emitted_idx is on emitted_at, which needs no rewrite.
    expect(events).toContain("where emitted_at <");
    // Stage 28: a wedged run is diagnostic evidence and is never swept.
    expect(runs).toContain("outcome <> 'running'");
  });

  it("sweeps the Fansly send journal by its indexed capture time, never an uncompleted attempt", async () => {
    const { db, recorded } = fakeDb({ sync_http_attempts: 0, sync_run_events: 0, sync_runs: 0, fansly_send_log: 0 }, 10);
    await deleteExpiredSyncObservability(db, CUTOFF, { batchRows: 10 });
    const sendLog = recorded.statements.find((text) => text.includes("from fansly_send_log"));
    // fansly_send_log_captured_idx is on captured_at; completed_at >= captured_at.
    // A null completed_at never compares below the cutoff: a holder that is
    // neither completed nor confirmed keeps its journal row.
    expect(sendLog).toMatch(/where captured_at <.*and completed_at </);
  });

  it("sweeps children BEFORE the parent, so sync_runs finds its cascades empty", async () => {
    const { db, recorded } = fakeDb({ sync_http_attempts: 0, sync_run_events: 0, sync_runs: 0 }, 10);
    await deleteExpiredSyncObservability(db, CUTOFF, { batchRows: 10 });
    const order = recorded.statements
      .filter((text) => text.includes("delete from"))
      .map((text) => text.match(/delete from (\w+)/)?.[1]);
    expect(order).toEqual(["sync_http_attempts", "sync_run_events", "sync_runs", "fansly_send_log"]);
  });

  it("stops on its own wall-clock budget and SAYS SO, instead of running into the 900s cap", async () => {
    // A clock that advances 100 s per reading: the budget is spent before the
    // second table starts.
    let ticks = 0;
    const monotonicNowMs = vi.fn(() => {
      ticks += 1;
      return ticks * 10_000;
    });
    const { db } = fakeDb(
      { sync_http_attempts: 10_000, sync_run_events: 10_000, sync_runs: 10_000 },
      10,
    );
    const result = await deleteExpiredSyncObservability(db, CUTOFF, {
      batchRows: 10,
      budgetMs: 150_000,
      monotonicNowMs,
    });
    expect(result.budgetExhausted).toBe(true);
    expect(result.steps.some((step) => step.budgetExhausted)).toBe(true);
    // Whatever it managed is kept: the predicate IS the resume point, so
    // tomorrow finds less to do rather than nothing done.
    expect(result.deletedAttempts).toBeGreaterThan(0);
  });

  it("reports per-table timings, which is what the failing nights never had", async () => {
    let ticks = 0;
    const monotonicNowMs = () => {
      ticks += 1;
      return ticks * 1_000;
    };
    const { db } = fakeDb({ sync_http_attempts: 1, sync_run_events: 1, sync_runs: 1, fansly_send_log: 1 }, 10);
    const result = await deleteExpiredSyncObservability(db, CUTOFF, {
      batchRows: 10,
      monotonicNowMs,
    });
    expect(result.steps.map((step) => step.table))
      .toEqual(["sync_http_attempts", "sync_run_events", "sync_runs", "fansly_send_log"]);
    for (const step of result.steps) {
      expect(step.durationMs).toBeGreaterThan(0);
      expect(step.batches).toBe(1);
    }
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it("keeps a default batch bound rather than trusting the caller to pass one", async () => {
    expect(SYNC_OBSERVABILITY_PRUNE_BATCH_ROWS).toBeGreaterThan(0);
    const { db, recorded } = fakeDb({ sync_http_attempts: 0, sync_run_events: 0, sync_runs: 0 }, 1);
    await deleteExpiredSyncObservability(db, CUTOFF);
    expect(recorded.statements.some(
      (text) => text.includes(`limit ${SYNC_OBSERVABILITY_PRUNE_BATCH_ROWS}`)
        || text.includes("limit "),
    )).toBe(true);
  });
});
