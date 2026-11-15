import type { Command } from "commander";

import { createDb, createPool } from "@agency_hub_core/db";

import { chattersByPerson, shiftRowsOf, teamShiftJobs } from "./chatter-numbers.ts";
import { readOnlyConnectionString } from "./sale-rule-cli.ts";
import { checkLine, compareShiftNumbers, memoryStore, refreshShiftNumbers, tableStore, SHIFT_NUMBERS_CHECK_DAYS } from "./shift-numbers.ts";

const DAY_MS = 86_400_000;

/**
 * `shift-numbers:check` — the shadow check of the stored shift numbers (shift-numbers.ts), read-only: every closed
 * shift of the last days counted live against its row, and how long the team's read takes live and from the rows.
 * `--memory` first fills the rows in memory with the same function the job writes with (a database without the table,
 * or one that may not be written, such as production through the read-only probe).
 */
export function registerShiftNumbersCommands(program: Command): void {
  program
    .command("shift-numbers:check")
    .description("Stored shift numbers against the live count, and the team read's time live and from the rows (read-only)")
    .option("--days <n>", "the window, days back from now", String(SHIFT_NUMBERS_CHECK_DAYS))
    .option("--memory", "fill the rows in memory first (the table is not read)")
    .option("--json", "the result as JSON")
    .action(async (options) => {
      const url = process.env.DATABASE_URL;
      if (url === undefined || url === "") throw new Error("DATABASE_URL is not set");
      const days = Number(options.days);
      if (!Number.isInteger(days) || days < 1 || days > 31) throw new Error("--days: 1 to 31");
      const report = await checkShiftNumbersReadOnly(url, { days, memory: options.memory === true });
      if (options.json === true) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(report.line);
        console.log(`team read of ${days} days, ${report.shifts} shifts: live ${report.teamReadLiveMs} ms, from the rows ${report.teamReadFromRowsMs} ms`
          + (report.rowsFillMs === null ? "" : `; rows filled in memory in ${report.rowsFillMs} ms`));
      }
    });
}

/** The check on a read-only session of `url` (the CLI, and the production probe). */
export async function checkShiftNumbersReadOnly(url: string, input: { days: number; memory: boolean }) {
  const { days } = input;
  const pool = createPool(readOnlyConnectionString(url), { applicationName: "hub-shift-numbers-check" });
  try {
    const check = await pool.query<{ default_transaction_read_only: string }>("show default_transaction_read_only");
    if (check.rows[0]?.default_transaction_read_only !== "on") throw new Error("the session is not read-only: refusing to run");
    const app = { db: createDb(pool) };
    const now = new Date();
    const from = new Date(now.getTime() - days * DAY_MS);
    const store = input.memory ? memoryStore() : tableStore(app.db);

    // Before: the team's read of the window counted live, as with the switch off.
    const liveStart = Date.now();
    const found = await teamShiftJobs(app, { from, to: now, now, scope: "all" });
    const liveRows = await shiftRowsOf(app, found, { fromTable: false });
    await chattersByPerson(app, found.jobs, liveRows.map((row) => row!));
    const liveMs = Date.now() - liveStart;

    let fillMs: number | null = null;
    if (input.memory) {
      const fillStart = Date.now();
      await refreshShiftNumbers(app, { from, now, store });
      fillMs = Date.now() - fillStart;
    }

    // After: the same read from the rows (the switch on): only going shifts and shifts without a fresh row are counted.
    const tableStart = Date.now();
    const again = await teamShiftJobs(app, { from, to: now, now: new Date(), scope: "all" });
    const tableRows = await shiftRowsOf(app, again, { fromTable: true, store });
    await chattersByPerson(app, again.jobs, tableRows.map((row) => row!));
    const tableMs = Date.now() - tableStart;

    const result = await compareShiftNumbers(app, { from, now: new Date(), store });
    const report = { days, shifts: found.jobs.length, ...result, teamReadLiveMs: liveMs, rowsFillMs: fillMs, teamReadFromRowsMs: tableMs, line: checkLine(result) };
    return report;
  } finally {
    await pool.end();
  }
}
