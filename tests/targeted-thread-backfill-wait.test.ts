import { describe, expect, it } from "vitest";

import {
  TARGETED_BACKFILL_EXPIRE_SECONDS,
  targetedThreadBackfillWaitBudget,
  waitForTargetedThreadBackfillJob,
  type TargetedThreadBackfillJobStatus,
} from "../apps/runtime/src/services/sync/targeted-thread-backfill.ts";

function status(state: string, output: unknown = null): TargetedThreadBackfillJobStatus {
  return { state, output, startedOn: null, completedOn: null };
}

/** A fake pgboss.job read: one scripted row per poll, the last one repeats. */
function scriptedRead(rows: Array<TargetedThreadBackfillJobStatus | null>) {
  let reads = 0;
  return {
    read: async () => {
      const row = rows[Math.min(reads, rows.length - 1)] ?? null;
      reads += 1;
      return row;
    },
    reads: () => reads,
  };
}

describe("waitForTargetedThreadBackfillJob", () => {
  it("reports each state change once and returns the terminal row", async () => {
    const output = { outcome: "completed", requests: 1 };
    const job = scriptedRead([
      status("created"),
      status("created"),
      status("active"),
      status("active"),
      status("completed", output),
    ]);
    const seen: string[] = [];
    const sleeps: number[] = [];

    const waited = await waitForTargetedThreadBackfillJob({
      read: job.read,
      timeoutMs: 60_000,
      pollMs: 2_000,
      onState: (row) => seen.push(row.state),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(waited).toEqual({ status: status("completed", output), timedOut: false });
    expect(seen).toEqual(["created", "active", "completed"]);
    expect(job.reads()).toBe(5);
    expect(sleeps).toEqual([2_000, 2_000, 2_000, 2_000]);
  });

  it.each(["failed", "cancelled"])("stops on a %s job", async (state) => {
    const job = scriptedRead([status("active"), status(state, { message: "boom" })]);

    const waited = await waitForTargetedThreadBackfillJob({
      read: job.read,
      timeoutMs: 60_000,
      pollMs: 10,
      sleep: async () => {},
    });

    expect(waited).toEqual({ status: status(state, { message: "boom" }), timedOut: false });
  });

  it("returns a missing job at once instead of polling until the timeout", async () => {
    const job = scriptedRead([null]);

    const waited = await waitForTargetedThreadBackfillJob({
      read: job.read,
      timeoutMs: 60_000,
      pollMs: 10,
      sleep: async () => {},
    });

    expect(waited).toEqual({ status: null, timedOut: false });
    expect(job.reads()).toBe(1);
  });

  it("times out with the last state it saw while the job is still running", async () => {
    const job = scriptedRead([status("active")]);
    let now = 0;

    const waited = await waitForTargetedThreadBackfillJob({
      read: job.read,
      timeoutMs: 10_000,
      pollMs: 2_000,
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    });

    expect(waited).toEqual({ status: status("active"), timedOut: true });
    // One read at t=0 and one after every 2 s poll up to the 10 s deadline.
    expect(job.reads()).toBe(6);
  });

  it("gives a job that starts late its full run budget from the moment it goes active", async () => {
    // pg-boss counts expire_seconds from started_on, not from enqueue: a job
    // queued 15 min behind other pages' jobs may still run for its full 20.
    let now = 0;
    const minute = 60_000;
    const read = async () => {
      if (now < 15 * minute) {
        return status("created");
      }
      if (now < 30 * minute) {
        return status("active");
      }
      return status("completed", { outcome: "completed" });
    };

    const waited = await waitForTargetedThreadBackfillJob({
      read,
      timeoutMs: 20 * minute,
      activeBudgetMs: 21 * minute,
      pollMs: 2_000,
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    });

    expect(waited).toEqual({ status: status("completed", { outcome: "completed" }), timedOut: false });
  });

  it("still times out a job that stays queued past the queue budget", async () => {
    let now = 0;
    const job = scriptedRead([status("created")]);

    const waited = await waitForTargetedThreadBackfillJob({
      read: job.read,
      timeoutMs: 10_000,
      activeBudgetMs: 60_000,
      pollMs: 2_000,
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    });

    expect(waited).toEqual({ status: status("created"), timedOut: true });
    expect(job.reads()).toBe(6);
  });
});

describe("targetedThreadBackfillWaitBudget", () => {
  it("follows a bare --wait to the job's end: queue time, then the full expiry once running", () => {
    expect(targetedThreadBackfillWaitBudget(true)).toEqual({
      timeoutMs: TARGETED_BACKFILL_EXPIRE_SECONDS * 1000,
      activeBudgetMs: (TARGETED_BACKFILL_EXPIRE_SECONDS + 90) * 1000,
    });
  });

  it("treats an explicit number of seconds as a hard cap from enqueue", () => {
    expect(targetedThreadBackfillWaitBudget(30)).toEqual({ timeoutMs: 30_000 });
  });
});
